//! Media metadata, cached previews and their HTTP endpoints.
pub(crate) mod http;
mod metadata;
mod probe;
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
    path.extension().and_then(|s| s.to_str()).is_some_and(|s| {
        matches!(
            s.to_ascii_lowercase().as_str(),
            "mp4" | "m4v" | "mov" | "webm" | "ogv"
        )
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
    fn recognizes_mov_as_video() {
        assert!(is_video(Path::new("live-photo.MOV")));
    }
}
