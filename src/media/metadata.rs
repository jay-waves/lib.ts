use super::{Dimensions, ImageMetadata, VideoMetadata, dimensions, is_heif, is_video, probe};
use image::{ImageDecoder, ImageReader};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::SystemTime,
};
const METADATA_CACHE_LIMIT: usize = 2048;

fn capture_time(exif: &exif::Exif) -> Option<i64> {
    use exif::{In, Tag, Value};
    let ascii = |tag| match &exif.get_field(tag, In::PRIMARY)?.value {
        Value::Ascii(values) => values.first().map(Vec::as_slice),
        _ => None,
    };
    let mut date = exif::DateTime::from_ascii(ascii(Tag::DateTimeOriginal)?).ok()?;
    if let Some(offset) = ascii(Tag::OffsetTimeOriginal) {
        date.parse_offset(offset).ok()?;
    }
    if let Some(subsec) = ascii(Tag::SubSecTimeOriginal) {
        let _ = date.parse_subsec(subsec);
    }
    let day =
        time::Date::from_calendar_date(date.year.into(), date.month.try_into().ok()?, date.day)
            .ok()?;
    let time = time::Time::from_hms_nano(
        date.hour,
        date.minute,
        date.second,
        date.nanosecond.unwrap_or(0),
    )
    .ok()?;
    // Interpret unzoned EXIF wall-clock values as UTC so sorting is independent of the host zone.
    let offset =
        time::UtcOffset::from_whole_seconds(i32::from(date.offset.unwrap_or(0)) * 60).ok()?;
    Some(
        (day.with_time(time)
            .assume_offset(offset)
            .unix_timestamp_nanos()
            / 1_000_000) as i64,
    )
}

#[cfg(test)]
fn image_metadata(path: &Path) -> ImageMetadata {
    read_image_metadata(path, read_dimensions(path))
}

fn read_image_metadata(path: &Path, mut size: Option<Dimensions>) -> ImageMetadata {
    use exif::{In, Tag, Value};
    let exif = fs::File::open(path).ok().and_then(|file| {
        exif::Reader::new()
            .continue_on_error(true)
            .read_from_container(&mut std::io::BufReader::new(file))
            .or_else(|error| error.distill_partial_result(|_| {}))
            .ok()
    });
    let mut summary = Vec::new();
    let captured_at = exif.as_ref().and_then(capture_time);
    if let Some(exif) = exif {
        let text = |tag| {
            let Value::Ascii(values) = &exif.get_field(tag, In::PRIMARY)?.value else {
                return None;
            };
            let value = String::from_utf8_lossy(values.first()?)
                .trim_matches('\0')
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            (!value.is_empty()).then(|| value.chars().take(120).collect::<String>())
        };
        let make = text(Tag::Make);
        let model = text(Tag::Model);
        if let Some(camera) = match (make, model) {
            (Some(make), Some(model))
                if !model.to_lowercase().starts_with(&make.to_lowercase()) =>
            {
                Some(format!("{make} {model}"))
            }
            (_, Some(model)) => Some(model),
            (make, None) => make,
        } {
            summary.push(camera);
        }
        for tag in [
            Tag::FocalLength,
            Tag::FNumber,
            Tag::ExposureTime,
            Tag::PhotographicSensitivity,
        ] {
            if let Some(field) = exif.get_field(tag, In::PRIMARY) {
                let value = field.display_value().with_unit(&exif).to_string();
                summary.push(if tag == Tag::PhotographicSensitivity {
                    format!("ISO {value}")
                } else {
                    value
                });
            }
        }
        if size.is_none() {
            let number = |tag| exif.get_field(tag, In::PRIMARY)?.value.get_uint(0);
            size = number(Tag::PixelXDimension)
                .zip(number(Tag::PixelYDimension))
                .or_else(|| number(Tag::ImageWidth).zip(number(Tag::ImageLength)))
                .and_then(|(width, height)| {
                    let rotated =
                        number(Tag::Orientation).is_some_and(|value| (5..=8).contains(&value));
                    if rotated {
                        dimensions(height, width)
                    } else {
                        dimensions(width, height)
                    }
                });
        }
    }
    ImageMetadata {
        dimensions: size,
        exif: summary,
        captured_at,
    }
}

type Cache<T> = Mutex<Option<lru::LruCache<PathBuf, (u64, SystemTime, T)>>>;

#[derive(Default)]
pub struct MetadataService {
    cache: Cache<Option<Dimensions>>,
    photos: Cache<ImageMetadata>,
    videos: Cache<VideoMetadata>,
}

fn cached<T: Clone + Default>(cache: &Cache<T>, path: &Path, read: impl FnOnce(&Path) -> T) -> T {
    let Ok(metadata) = fs::metadata(path) else {
        return T::default();
    };
    let Ok(modified) = metadata.modified() else {
        return read(path);
    };
    if let Some((_, _, value)) = cache
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_mut()
        .and_then(|cache| cache.get(path))
        .filter(|(size, time, _)| *size == metadata.len() && *time == modified)
    {
        return value.clone();
    }
    let value = read(path);
    cache
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get_or_insert_with(|| {
            lru::LruCache::new(std::num::NonZeroUsize::new(METADATA_CACHE_LIMIT).unwrap())
        })
        .put(
            path.to_path_buf(),
            (metadata.len(), modified, value.clone()),
        );
    value
}

impl MetadataService {
    pub fn image_metadata(&self, path: &Path) -> ImageMetadata {
        cached(&self.photos, path, |path| {
            read_image_metadata(path, self.dimensions(path))
        })
    }

    pub fn video_metadata(&self, path: &Path) -> VideoMetadata {
        cached(&self.videos, path, probe::video_metadata)
    }

    pub fn dimensions(&self, path: &Path) -> Option<Dimensions> {
        let metadata = fs::metadata(path).ok()?;
        let modified = metadata.modified().ok()?;
        if let Some((_, _, value)) = self
            .photos
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_mut()
            .and_then(|cache| cache.get(path))
            .filter(|(size, time, _)| *size == metadata.len() && *time == modified)
        {
            return value.dimensions;
        }
        if is_video(path) || is_heif(path) {
            return self.video_metadata(path).dimensions;
        }
        cached(&self.cache, path, read_dimensions)
    }
}

fn read_dimensions(path: &Path) -> Option<Dimensions> {
    if is_video(path) || is_heif(path) {
        return probe::video_metadata(path).dimensions;
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

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageEncoder;

    #[test]
    fn video_dimensions_and_details_share_a_versioned_cache() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.mp4");
        fs::write(&path, b"video").unwrap();
        let service = MetadataService::default();
        cached(&service.videos, &path, |_| VideoMetadata {
            dimensions: dimensions(1920, 1080),
            codec: Some("h264".into()),
            ..VideoMetadata::default()
        });
        assert_eq!(service.dimensions(&path), dimensions(1920, 1080));
        assert_eq!(service.video_metadata(&path).codec.as_deref(), Some("h264"));
        fs::write(&path, b"changed video").unwrap();
        cached(&service.videos, &path, |_| VideoMetadata {
            dimensions: dimensions(640, 480),
            ..VideoMetadata::default()
        });
        assert_eq!(service.dimensions(&path), dimensions(640, 480));
        assert!(service.video_metadata(&path).codec.is_none());
    }

    #[test]
    fn image_metadata_handles_missing_exif_and_invalid_images() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("photo.png");
        image::RgbImage::new(40, 20).save(&source).unwrap();
        let metadata = image_metadata(&source);
        assert_eq!(metadata.dimensions, dimensions(40, 20));
        assert!(metadata.exif.is_empty());
        assert!(metadata.captured_at.is_none());
        fs::write(&source, b"invalid image").unwrap();
        let metadata = image_metadata(&source);
        assert!(metadata.dimensions.is_none());
        assert!(metadata.exif.is_empty());
        assert!(metadata.captured_at.is_none());
    }

    #[test]
    fn capture_dates_validate_calendar_and_support_offsets_and_subseconds() {
        use exif::{Field, In, Tag, Value};
        let parse = |date: &str, offset: Option<&str>, subsec: Option<&str>| {
            let mut fields = vec![Field {
                tag: Tag::DateTimeOriginal,
                ifd_num: In::PRIMARY,
                value: Value::Ascii(vec![date.as_bytes().to_vec()]),
            }];
            for (tag, value) in [
                (Tag::OffsetTimeOriginal, offset),
                (Tag::SubSecTimeOriginal, subsec),
            ] {
                if let Some(value) = value {
                    fields.push(Field {
                        tag,
                        ifd_num: In::PRIMARY,
                        value: Value::Ascii(vec![value.as_bytes().to_vec()]),
                    });
                }
            }
            let mut writer = exif::experimental::Writer::new();
            for field in &fields {
                writer.push_field(field);
            }
            let mut bytes = std::io::Cursor::new(Vec::new());
            writer.write(&mut bytes, true).unwrap();
            capture_time(&exif::Reader::new().read_raw(bytes.into_inner()).unwrap())
        };
        assert_eq!(
            parse("1970:01:01 08:00:01", Some("+08:00"), Some("123456")),
            Some(1123)
        );
        assert_eq!(parse("1970:01:01 00:00:01", None, None), Some(1000));
        assert_eq!(parse("2026:02:30 12:00:00", None, None), None);
        assert_eq!(parse("0000:00:00 00:00:00", None, None), None);
        assert_eq!(parse("invalid", None, None), None);
    }

    #[test]
    fn photo_metadata_cache_reuses_results_and_invalidates_on_size_or_time_change() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("photo.bmp");
        let service = MetadataService::default();
        image::RgbImage::new(40, 20).save(&source).unwrap();
        assert_eq!(
            service.image_metadata(&source).dimensions,
            dimensions(40, 20)
        );
        assert_eq!(
            service.image_metadata(&source).dimensions,
            service.dimensions(&source)
        );
        assert_eq!(service.photos.lock().unwrap().as_ref().unwrap().len(), 1);
        let modified = fs::metadata(&source).unwrap().modified().unwrap();
        // Equal byte size, changed orientation and mtime.
        image::RgbImage::new(20, 40).save(&source).unwrap();
        fs::File::options()
            .write(true)
            .open(&source)
            .unwrap()
            .set_modified(modified + std::time::Duration::from_secs(2))
            .unwrap();
        assert_eq!(
            service.image_metadata(&source).dimensions,
            dimensions(20, 40)
        );
        let modified = fs::metadata(&source).unwrap().modified().unwrap();
        image::RgbImage::new(30, 10).save(&source).unwrap();
        fs::File::options()
            .write(true)
            .open(&source)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        assert_eq!(
            service.image_metadata(&source).dimensions,
            dimensions(30, 10)
        );
        fs::write(&source, b"invalid image").unwrap();
        assert!(service.image_metadata(&source).dimensions.is_none());
        assert!(service.image_metadata(&source).captured_at.is_none());
        assert!(service.dimensions(&source).is_none());
    }

    #[test]
    fn image_metadata_summarizes_exposure_and_respects_orientation() {
        use exif::{Field, In, Tag, Value};
        let fields = [
            (Tag::Make, Value::Ascii(vec![b"Example".to_vec()])),
            (Tag::Model, Value::Ascii(vec![b"Example Camera".to_vec()])),
            (Tag::Orientation, Value::Short(vec![6])),
            (Tag::FocalLength, Value::Rational(vec![(50, 1).into()])),
            (Tag::FNumber, Value::Rational(vec![(28, 10).into()])),
            (Tag::ExposureTime, Value::Rational(vec![(1, 125).into()])),
            (Tag::PhotographicSensitivity, Value::Short(vec![400])),
            (
                Tag::DateTimeOriginal,
                Value::Ascii(vec![b"2026:10:18 12:34:56".to_vec()]),
            ),
        ]
        .map(|(tag, value)| Field {
            tag,
            ifd_num: In::PRIMARY,
            value,
        });
        let mut writer = exif::experimental::Writer::new();
        for field in &fields {
            writer.push_field(field);
        }
        let mut exif = std::io::Cursor::new(Vec::new());
        writer.write(&mut exif, true).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("photo.png");
        let mut file = fs::File::create(&source).unwrap();
        let mut encoder = image::codecs::png::PngEncoder::new(&mut file);
        encoder.set_exif_metadata(exif.into_inner()).unwrap();
        encoder
            .write_image(
                &vec![0; 40 * 20 * 3],
                40,
                20,
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
        drop(file);
        let metadata = image_metadata(&source);
        assert_eq!(metadata.dimensions, dimensions(20, 40));
        let expected = time::OffsetDateTime::parse(
            "2026-10-18T12:34:56Z",
            &time::format_description::well_known::Rfc3339,
        )
        .unwrap();
        assert_eq!(metadata.captured_at, Some(expected.unix_timestamp() * 1000));
        assert_eq!(
            metadata.exif,
            ["Example Camera", "50 mm", "f/2.8", "1/125 s", "ISO 400"]
        );
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
