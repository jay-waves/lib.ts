//! On-demand gallery previews. Encoded files survive restarts; one worker limits decoding.
use image::{ImageEncoder, ImageReader};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const MAX_EDGE: u32 = 800;
const LARGE_PIXELS: u64 = 8_000_000;
const LARGE_BYTES: u64 = 8 * 1024 * 1024;

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
}
