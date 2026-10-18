use super::{VideoMetadata, dimensions};
use std::{
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

pub fn video_metadata(path: &Path) -> VideoMetadata {
    let mut command = Command::new("ffprobe");
    command
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,bit_rate,codec_name:stream_side_data=rotation:format=duration,bit_rate",
            "-of",
            "json",
        ])
        .arg(crate::client_path(path))
        .stdout(Stdio::piped());
    // Only a few selected fields are captured, so the output fits in a pipe.
    let output = super::process::run(&mut command, Duration::from_secs(10));
    let Ok(output) = output else {
        return VideoMetadata::default();
    };
    if !output.status.success() {
        return VideoMetadata::default();
    }
    parse_metadata(&output.stdout)
}

fn parse_metadata(bytes: &[u8]) -> VideoMetadata {
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return VideoMetadata::default();
    };
    let stream = json
        .get("streams")
        .and_then(|value| value.as_array())
        .and_then(|streams| streams.first());
    let mut dimensions = stream
        .and_then(|stream| {
            Some((
                stream.get("width")?.as_u64()?,
                stream.get("height")?.as_u64()?,
            ))
        })
        .and_then(|(width, height)| {
            dimensions(u32::try_from(width).ok()?, u32::try_from(height).ok()?)
        });
    let rotation = stream
        .and_then(|stream| stream.get("side_data_list"))
        .and_then(|list| list.as_array())
        .and_then(|list| list.iter().find_map(|item| item.get("rotation")?.as_i64()))
        .unwrap_or(0);
    if rotation.rem_euclid(180) == 90 {
        if let Some(size) = &mut dimensions {
            std::mem::swap(&mut size.width, &mut size.height);
        }
    }
    let duration_seconds = json
        .get("format")
        .and_then(|format| format.get("duration"))
        .and_then(|value| {
            value
                .as_str()
                .and_then(|s| s.parse::<f64>().ok())
                .or_else(|| value.as_f64())
        })
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.round() as u64);
    let bitrate = stream
        .and_then(|stream| stream.get("bit_rate"))
        .and_then(|value| {
            value
                .as_str()
                .and_then(|s| s.parse::<u64>().ok())
                .or_else(|| value.as_u64())
        })
        .or_else(|| {
            json.get("format")
                .and_then(|format| format.get("bit_rate"))
                .and_then(|value| {
                    value
                        .as_str()
                        .and_then(|s| s.parse::<u64>().ok())
                        .or_else(|| value.as_u64())
                })
        })
        .filter(|value| *value > 0);
    let codec = stream
        .and_then(|stream| stream.get("codec_name"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    VideoMetadata {
        dimensions,
        duration_seconds,
        bitrate,
        codec,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stream_and_format_metadata_without_invoking_ffprobe() {
        let value = parse_metadata(br#"{"streams":[{"width":1920,"height":1080,"bit_rate":"1200000","codec_name":"h264"}],"format":{"duration":"12.6","bit_rate":"1400000"}}"#);
        assert_eq!(value.dimensions, dimensions(1920, 1080));
        assert_eq!(value.bitrate, Some(1_200_000));
        assert_eq!(value.duration_seconds, Some(13));
        assert_eq!(value.codec.as_deref(), Some("h264"));
        let value = parse_metadata(br#"{"streams":[{"width":0,"height":1080}],"format":{"duration":"NaN","bit_rate":9000}}"#);
        assert!(value.dimensions.is_none());
        assert!(value.duration_seconds.is_none());
        assert_eq!(value.bitrate, Some(9000));
        assert!(parse_metadata(b"invalid").dimensions.is_none());
        assert!(parse_metadata(b"{}").codec.is_none());
    }
    #[test]
    fn portrait_video_uses_display_orientation() {
        let value = parse_metadata(
            br#"{"streams":[{"width":1920,"height":1080,"side_data_list":[{"rotation":-90}]}]}"#,
        );
        assert_eq!(value.dimensions, dimensions(1080, 1920));
        let value = parse_metadata(
            br#"{"streams":[{"width":1920,"height":1080,"side_data_list":[{"rotation":180}]}]}"#,
        );
        assert_eq!(value.dimensions, dimensions(1920, 1080));
    }
}
