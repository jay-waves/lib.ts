use super::{is_heif, is_video};
use image::{ImageEncoder, ImageReader};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

const MAX_EDGE: u32 = 800;
const LARGE_PIXELS: u64 = 8_000_000;
const LARGE_BYTES: u64 = 8 * 1024 * 1024;
static NEXT_TEMPORARY: AtomicU64 = AtomicU64::new(0);

fn ffmpeg_error_summary(stderr: &[u8]) -> String {
    const MAX_CHARS: usize = 1200;
    let summary = String::from_utf8_lossy(stderr)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(8)
        .collect::<Vec<_>>()
        .join(" | ");
    let truncated = summary.chars().count() > MAX_CHARS;
    let mut summary: String = summary.chars().take(MAX_CHARS).collect();
    if truncated {
        summary.push_str(" …");
    }
    if summary.is_empty() {
        "no diagnostic output".to_owned()
    } else {
        summary
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImagePreview {
    Original,
    Converted,
}

pub fn image_preview(path: &Path) -> ImagePreview {
    if is_heif(path) {
        ImagePreview::Converted
    } else {
        ImagePreview::Original
    }
}

fn original_thumbnail(bytes: u64, width: u32, height: u32) -> bool {
    bytes <= LARGE_BYTES && u64::from(width) * u64::from(height) <= LARGE_PIXELS
}

pub fn thumbnail(path: &Path, data: &Path) -> Result<PathBuf, String> {
    generate(path, data, false, time::OffsetDateTime::now_utc().date()).map_err(|e| e.to_string())
}

pub fn preview(path: &Path, data: &Path) -> Result<PathBuf, String> {
    if !is_heif(path) {
        return Ok(path.to_path_buf());
    }
    generate(path, data, true, time::OffsetDateTime::now_utc().date()).map_err(|e| e.to_string())
}

fn generate(
    path: &Path,
    data: &Path,
    full: bool,
    date: time::Date,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let metadata = fs::metadata(path)?;
    let key = typst::utils::hash128(&(
        "gallery-v1",
        path,
        metadata.len(),
        metadata.modified()?,
        MAX_EDGE,
        full,
    ));
    let [folder, previous] = super::cache::folders(data, date);
    let mut cached = folder.join(format!("{key:032x}.png"));
    for bucket in [&folder, &previous] {
        for extension in ["png", "jpg"] {
            let candidate = bucket.join(format!("{key:032x}.{extension}"));
            if candidate.is_file() {
                if bucket == &previous {
                    fs::create_dir_all(&folder)?;
                    let refreshed = cached.with_extension(extension);
                    match fs::rename(&candidate, &refreshed) {
                        Ok(()) => return Ok(refreshed),
                        Err(error) => {
                            tracing::warn!(%error, "Could not refresh weekly media cache")
                        }
                    }
                }
                return Ok(candidate);
            }
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
        if original_thumbnail(metadata.len(), dimensions.0, dimensions.1) {
            return Ok(path.to_path_buf());
        }
        Some(reader)
    };
    fs::create_dir_all(&folder)?;
    let temporary = cached.with_extension(format!(
        "{}-{}.tmp",
        std::process::id(),
        NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed)
    ));
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
                .args([
                    "-nostdin",
                    "-v",
                    "error",
                    "-threads",
                    "1",
                    "-filter_threads",
                    "1",
                    "-i",
                ])
                .arg(crate::client_path(path));
            if !full {
                command.args([
                    "-filter_complex",
                    "[0:v:0]scale=w='min(800,iw)':h='min(800,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2[thumbnail]",
                    "-map",
                    "[thumbnail]",
                ]);
            }
            command
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
                .stdout(Stdio::null());
            let output =
                super::process::run(&mut command, Duration::from_secs(30)).map_err(|error| {
                    tracing::warn!(%error, "FFmpeg thumbnail process failed");
                    error
                })?;
            if !output.status.success() {
                tracing::warn!(
                    error = %ffmpeg_error_summary(&output.stderr),
                    "FFmpeg failed to generate media thumbnail"
                );
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
    fn preview_policy_does_not_require_dimensions_or_metadata() {
        assert_eq!(
            image_preview(Path::new("photo.jpg")),
            ImagePreview::Original
        );
        assert_eq!(
            image_preview(Path::new("drawing.svg")),
            ImagePreview::Original
        );
        assert_eq!(
            image_preview(Path::new("photo.HEIC")),
            ImagePreview::Converted
        );
    }

    #[test]
    fn concurrent_cache_writers_publish_complete_images_without_temporary_files() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("photo.jpg");
        let data = dir.path().join("data");
        image::RgbImage::new(40, 20).save(&source).unwrap();
        fs::OpenOptions::new()
            .append(true)
            .open(&source)
            .unwrap()
            .set_len(LARGE_BYTES + 1)
            .unwrap();
        let barrier = std::sync::Barrier::new(4);
        let outputs = std::thread::scope(|scope| {
            let jobs: Vec<_> = (0..4)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        thumbnail(&source, &data).unwrap()
                    })
                })
                .collect();
            jobs.into_iter()
                .map(|job| job.join().unwrap())
                .collect::<Vec<_>>()
        });
        for output in &outputs {
            assert_eq!(output, &outputs[0]);
            assert_eq!(image::image_dimensions(output).unwrap(), (40, 20));
        }
        assert_eq!(
            fs::read_dir(outputs[0].parent().unwrap()).unwrap().count(),
            1
        );
    }

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
        let date = time::Date::from_calendar_date(2026, time::Month::October, 19).unwrap();
        let preview = generate(&source, &data, false, date).unwrap();
        let modified = fs::metadata(&preview).unwrap().modified().unwrap();
        assert_eq!(generate(&source, &data, false, date).unwrap(), preview);
        let next_week = date + time::Duration::weeks(1);
        let refreshed = generate(&source, &data, false, next_week).unwrap();
        assert_ne!(refreshed, preview);
        assert!(!preview.exists()); // Moving renews retention without keeping a second copy.
        assert_eq!(
            fs::metadata(&refreshed).unwrap().modified().unwrap(),
            modified
        );
        assert_eq!(
            generate(&source, &data, false, next_week).unwrap(),
            refreshed
        );
        let renewed = generate(&source, &data, false, date + time::Duration::weeks(3)).unwrap();
        assert_ne!(renewed, refreshed); // No visit for two weeks: regenerate.
        assert_eq!(image::image_dimensions(&renewed).unwrap(), (800, 800));
        image::RgbaImage::new(20, 10).save(&source).unwrap();
        assert_eq!(generate(&source, &data, false, date).unwrap(), source);
    }
}
