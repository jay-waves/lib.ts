//! Media metadata, cached previews and their HTTP endpoints.
pub(crate) mod cache;
pub(crate) mod http;
mod metadata;
mod probe;
mod process;
mod thumbnail;

pub use metadata::MetadataService;
use serde::Serialize;
use std::path::Path;
pub use thumbnail::{ImagePreview, image_preview, preview, thumbnail};

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub struct Dimensions {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<Dimensions>,
    exif: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captured_at: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<Dimensions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
}

fn dimensions(width: u32, height: u32) -> Option<Dimensions> {
    (width > 0 && height > 0).then_some(Dimensions { width, height })
}

pub fn is_video(path: &Path) -> bool {
    if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("ts"))
    {
        return crate::file_kind::from_path(path).is_ok_and(|kind| kind.mime == "video/mp2t");
    }
    path.extension().and_then(|s| s.to_str()).is_some_and(|s| {
        matches!(
            s.to_ascii_lowercase().as_str(),
            "mp4"
                | "m4v"
                | "mov"
                | "webm"
                | "ogv"
                | "mkv"
                | "avi"
                | "mpg"
                | "mpeg"
                | "mts"
                | "m2ts"
                | "flv"
                | "wmv"
                | "3gp"
                | "3g2"
        )
    })
}

// Reject TypeScript even when mime_guess labels its extension as video/mp2t.
pub fn is_external_media(path: &Path) -> bool {
    crate::file_kind::from_path(path).is_ok_and(|kind| {
        kind.mime.starts_with("image/")
            || (kind.binary
                && (kind.mime.starts_with("video/")
                    || (kind.mime == "application/octet-stream" && is_video(path))))
    })
}

pub fn is_heif(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| matches!(s.to_ascii_lowercase().as_str(), "heic" | "heif"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_open_accepts_media_but_rejects_source_and_executables() {
        let dir = tempfile::tempdir().unwrap();
        for (name, bytes, expected) in [
            ("photo.png", &b"\x89PNG\r\n\x1a\n"[..], true),
            (
                "vector.svg",
                &b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"[..],
                true,
            ),
            ("source.ts", &b"export const value = 1;"[..], false),
            ("program.mp4", &b"MZ\0\0"[..], false),
            ("archive.zip", &b"PK\x03\x04\0\0"[..], false),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            assert_eq!(is_external_media(&path), expected, "{name}");
        }
        let path = dir.path().join("clip.ts");
        let mut packets = vec![0xff; 188 * 4];
        for offset in (0..packets.len()).step_by(188) {
            packets[offset] = 0x47;
        }
        std::fs::write(&path, packets).unwrap();
        assert!(is_external_media(&path));
        assert!(is_video(&path));
    }

    #[test]
    fn recognizes_mov_as_video() {
        assert!(is_video(Path::new("live-photo.MOV")));
    }
}
