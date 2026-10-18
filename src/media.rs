//! On-demand gallery previews. Encoded files survive restarts; one worker limits decoding.
use image::{ImageDecoder, ImageEncoder, ImageReader};
use serde::Serialize;
use std::{collections::HashMap, sync::Mutex, time::SystemTime};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const MAX_EDGE: u32 = 800;
const LARGE_PIXELS: u64 = 8_000_000;
const LARGE_BYTES: u64 = 8 * 1024 * 1024;

const METADATA_CACHE_LIMIT: usize = 2048;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub struct Dimensions {
    pub width: u32,
    pub height: u32,
}

#[derive(Default)]
pub struct MetadataService {
    cache: Mutex<HashMap<PathBuf, (u64, SystemTime, Option<Dimensions>)>>,
}

impl MetadataService {
    pub fn dimensions(&self, path: &Path) -> Option<Dimensions> {
        let metadata = fs::metadata(path).ok()?;
        let modified = metadata.modified().ok()?;
        if let Some((_, _, dimensions)) = self
            .cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(path)
            .filter(|(size, time, _)| *size == metadata.len() && *time == modified)
        {
            return *dimensions;
        }
        let dimensions = read_dimensions(path);
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if cache.len() >= METADATA_CACHE_LIMIT {
            cache.clear();
        }
        cache.insert(path.to_path_buf(), (metadata.len(), modified, dimensions));
        dimensions
    }
}

fn read_dimensions(path: &Path) -> Option<Dimensions> {
    if is_video(path) || is_heif(path) {
        let output = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=s=x:p=0",
            ])
            .arg(crate::client_path(path))
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        let value = String::from_utf8(output.stdout).ok()?;
        let (width, height) = value.trim().split_once('x')?;
        return dimensions(width.parse().ok()?, height.parse().ok()?);
    }
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("svg"))
    {
        return svg_dimensions(path);
    }
    let mut decoder = ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?
        .into_decoder()
        .ok()?;
    let orientation = decoder.orientation().ok()?;
    let (mut width, mut height) = decoder.dimensions();
    if matches!(
        orientation,
        image::metadata::Orientation::Rotate90
            | image::metadata::Orientation::Rotate270
            | image::metadata::Orientation::Rotate90FlipH
            | image::metadata::Orientation::Rotate270FlipH
    ) {
        std::mem::swap(&mut width, &mut height);
    }
    dimensions(width, height)
}

fn dimensions(width: u32, height: u32) -> Option<Dimensions> {
    (width > 0 && height > 0).then_some(Dimensions { width, height })
}

fn svg_dimensions(path: &Path) -> Option<Dimensions> {
    use std::io::Read;
    let mut bytes = Vec::with_capacity(4096);
    fs::File::open(path)
        .ok()?
        .take(64 * 1024)
        .read_to_end(&mut bytes)
        .ok()?;
    let source = std::str::from_utf8(&bytes).ok()?;
    let start = source.find("<svg")? + 4;
    let tag = &source[start..start + source[start..].find('>')?];
    let mut width = None;
    let mut height = None;
    let mut view_box = None;
    let mut rest = tag;
    while !rest.is_empty() {
        rest = rest.trim_start();
        let key_end = rest
            .find(|ch: char| ch.is_whitespace() || ch == '=')
            .unwrap_or(rest.len());
        if key_end == 0 {
            rest = &rest[1..];
            continue;
        }
        let key = &rest[..key_end];
        rest = rest[key_end..].trim_start();
        if !rest.starts_with('=') {
            continue;
        }
        rest = rest[1..].trim_start();
        let quote = *rest.as_bytes().first()?;
        if quote != b'"' && quote != b'\'' {
            continue;
        }
        rest = &rest[1..];
        let value_end = rest.find(quote as char)?;
        let value = &rest[..value_end];
        let number = || {
            let end = value
                .find(|ch: char| {
                    !(ch.is_ascii_digit() || matches!(ch, '.' | '+' | '-' | 'e' | 'E'))
                })
                .unwrap_or(value.len());
            value[..end]
                .parse::<f64>()
                .ok()
                .filter(|number| number.is_finite() && *number > 0.0)
        };
        match key {
            "width" => width = number(),
            "height" => height = number(),
            "viewBox" => {
                let parts = value
                    .split([',', ' '])
                    .filter(|part| !part.is_empty())
                    .filter_map(|part| part.parse::<f64>().ok())
                    .collect::<Vec<_>>();
                if parts.len() == 4 && parts[2] > 0.0 && parts[3] > 0.0 {
                    view_box = Some((parts[2], parts[3]));
                }
            }
            _ => {}
        }
        rest = &rest[value_end + 1..];
    }
    let (width, height) = match (width, height, view_box) {
        (Some(width), Some(height), _) => (width, height),
        (Some(width), None, Some((_, view_height))) => (width, view_height),
        (None, Some(height), Some((view_width, _))) => (view_width, height),
        (_, _, Some((width, height))) => (width, height),
        (Some(width), None, None) => (width, width * 0.5),
        (None, Some(height), None) => (height * 2.0, height),
        _ => (300.0, 150.0),
    };
    dimensions(
        width.round().clamp(1.0, u32::MAX as f64) as u32,
        height.round().clamp(1.0, u32::MAX as f64) as u32,
    )
}

pub fn is_video(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()).is_some_and(|s| {
        matches!(
            s.to_ascii_lowercase().as_str(),
            "mp4" | "m4v" | "webm" | "ogv"
        )
    })
}

pub fn thumbnail(path: &Path, data: &Path) -> Result<PathBuf, String> {
    generate(path, data, false).map_err(|e| e.to_string())
}

pub fn is_heif(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| matches!(s.to_ascii_lowercase().as_str(), "heic" | "heif"))
}

pub fn preview(path: &Path, data: &Path) -> Result<PathBuf, String> {
    if !is_heif(path) {
        return Ok(path.to_path_buf());
    }
    generate(path, data, true).map_err(|e| e.to_string())
}

fn generate(path: &Path, data: &Path, full: bool) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let metadata = fs::metadata(path)?;
    let key = typst::utils::hash128(&(
        "gallery-v1",
        path,
        metadata.len(),
        metadata.modified()?,
        MAX_EDGE,
        full,
    ));
    let folder = data.join("thumbnails");
    let mut cached = folder.join(format!("{key:032x}.png"));
    for extension in ["png", "jpg"] {
        let candidate = cached.with_extension(extension);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    let video = is_video(path);
    let reader = if video || is_heif(path) {
        None
    } else {
        let reader = ImageReader::open(path)?.with_guessed_format()?;
        // Keep browser-native formats that this build cannot decode usable.
        let dimensions = match image::image_dimensions(path) {
            Ok(dimensions) => dimensions,
            Err(_) => return Ok(path.to_path_buf()),
        };
        if u64::from(dimensions.0) * u64::from(dimensions.1) <= LARGE_PIXELS
            && metadata.len() <= LARGE_BYTES
        {
            return Ok(path.to_path_buf());
        }
        Some(reader)
    };
    fs::create_dir_all(&folder)?;
    let temporary = cached.with_extension("tmp");
    let result: Result<(), Box<dyn std::error::Error>> = (|| {
        if let Some(mut reader) = reader {
            let mut limits = image::Limits::default();
            limits.max_alloc = Some(512 * 1024 * 1024);
            reader.limits(limits);
            let mut decoder = reader.into_decoder()?;
            let orientation = image::ImageDecoder::orientation(&mut decoder)?;
            let mut decoded = image::DynamicImage::from_decoder(decoder)?;
            decoded.apply_orientation(orientation);
            let preview = decoded.thumbnail(
                MAX_EDGE.min(decoded.width()),
                MAX_EDGE.min(decoded.height()),
            );
            let out = fs::File::create(&temporary)?;
            if preview.color().has_alpha() {
                let preview = preview.to_rgba8();
                image::codecs::png::PngEncoder::new(out).write_image(
                    preview.as_raw(),
                    preview.width(),
                    preview.height(),
                    image::ExtendedColorType::Rgba8,
                )?;
            } else {
                cached.set_extension("jpg");
                image::codecs::jpeg::JpegEncoder::new_with_quality(out, 80)
                    .encode_image(&preview)?;
            }
        } else {
            cached.set_extension("jpg");
            let mut command = Command::new("ffmpeg");
            command
                .args(["-nostdin", "-v", "error", "-threads", "1", "-i"])
                .arg(crate::client_path(path));
            if !full {
                command.args([
                    "-vf",
                    "scale=w='min(800,iw)':h='min(800,ih)':force_original_aspect_ratio=decrease",
                ]);
            }
            let status = command
                .args([
                    "-frames:v",
                    "1",
                    "-an",
                    "-threads",
                    "1",
                    "-f",
                    "image2",
                    "-c:v",
                    "mjpeg",
                    "-q:v",
                    "3",
                    "-y",
                ])
                .arg(crate::client_path(&temporary))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()?;
            if !status.success() {
                return Err(if video {
                    "Could not extract video cover"
                } else {
                    "Could not decode HEIC/HEIF. Use FFmpeg 8.1 or newer with HEVC support."
                }
                .into());
            }
        }
        fs::rename(&temporary, &cached)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(cached)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn byte_threshold_creates_jpeg_without_upscaling_and_revision_changes_cache() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("photo.jpg");
        let data = dir.path().join("data");
        image::RgbImage::new(40, 20).save(&source).unwrap();
        fs::OpenOptions::new()
            .append(true)
            .open(&source)
            .unwrap()
            .write_all(&vec![0; LARGE_BYTES as usize])
            .unwrap();
        let first = thumbnail(&source, &data).unwrap();
        assert_ne!(first, source);
        assert_eq!(first.extension().unwrap(), "jpg");
        assert_eq!(image::image_dimensions(&first).unwrap(), (40, 20));
        fs::OpenOptions::new()
            .append(true)
            .open(&source)
            .unwrap()
            .write_all(&[0])
            .unwrap();
        assert_ne!(thumbnail(&source, &data).unwrap(), first);
    }

    #[test]
    fn large_image_is_cached_and_small_image_passes_through() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("large.png");
        image::RgbaImage::new(3000, 3000).save(&source).unwrap();
        let data = dir.path().join("data");
        let preview = thumbnail(&source, &data).unwrap();
        assert_eq!(image::image_dimensions(&preview).unwrap(), (800, 800));
        let modified = fs::metadata(&preview).unwrap().modified().unwrap();
        assert_eq!(thumbnail(&source, &data).unwrap(), preview);
        assert_eq!(
            fs::metadata(&preview).unwrap().modified().unwrap(),
            modified
        );
        image::RgbaImage::new(20, 10).save(&source).unwrap();
        assert_eq!(thumbnail(&source, &data).unwrap(), source);
    }

    #[test]
    fn metadata_service_reads_raster_and_svg_dimensions_and_refreshes_cache() {
        let dir = tempfile::tempdir().unwrap();
        let raster = dir.path().join("photo.png");
        image::RgbImage::new(40, 20).save(&raster).unwrap();
        let service = MetadataService::default();
        assert_eq!(
            service.dimensions(&raster),
            Some(Dimensions {
                width: 40,
                height: 20
            })
        );
        image::RgbImage::new(20, 40).save(&raster).unwrap();
        assert_eq!(
            service.dimensions(&raster),
            Some(Dimensions {
                width: 20,
                height: 40
            })
        );

        let svg = dir.path().join("vector.svg");
        fs::write(
            &svg,
            r#"<svg viewBox="0 0 640 480" xmlns="http://www.w3.org/2000/svg"></svg>"#,
        )
        .unwrap();
        assert_eq!(
            service.dimensions(&svg),
            Some(Dimensions {
                width: 640,
                height: 480
            })
        );
    }
}
