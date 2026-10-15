//! Bounded content detection, with filename hints for text formats.
use std::{
    fs::File,
    io::{self, Read},
    path::Path,
};

pub const HEADER_BYTES: usize = 8 * 1024;
const BINARY_EXTENSIONS: &[&str] = &[
    "pdf", "zip", "gz", "7z", "rar", "tar", "xz", "bz2", "exe", "dll", "so", "dylib", "wasm",
    "node", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "tiff", "mp3", "mp4", "mov",
    "wav", "flac", "ogg", "woff", "woff2", "ttf", "otf", "doc", "docx", "xls", "xlsx", "ppt",
    "pptx", "epub", "sqlite", "db",
];

pub struct FileType {
    pub mime: &'static str,
    pub format: String,
    pub binary: bool,
}

fn signature(bytes: &[u8]) -> Option<infer::Type> {
    // Text signatures are ambiguous (e.g. HTML inside Markdown). Keep filename
    // semantics for these rather than promoting text to an executable format.
    infer::get(bytes).filter(|kind| kind.matcher_type() != infer::MatcherType::Text)
}

fn has_controls(bytes: &[u8]) -> bool {
    bytes
        .iter()
        .any(|byte| matches!(*byte, 0..=8 | 11..=12 | 14..=31))
}

fn binary_prefix(bytes: &[u8]) -> bool {
    has_controls(bytes)
        || std::str::from_utf8(bytes).is_err_and(|error| error.error_len().is_some())
}

pub fn has_binary_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| BINARY_EXTENSIONS.contains(&value.to_ascii_lowercase().as_str()))
}

pub fn detect(path: &Path, bytes: &[u8]) -> FileType {
    let bytes = &bytes[..bytes.len().min(HEADER_BYTES)];
    if let Some(kind) = signature(bytes) {
        return FileType {
            mime: kind.mime_type(),
            format: kind.extension().into(),
            binary: true,
        };
    }
    let invalid_text = binary_prefix(bytes);
    FileType {
        mime: if invalid_text {
            "application/octet-stream"
        } else {
            mime_guess::from_path(path)
                .first_raw()
                .unwrap_or("application/octet-stream")
        },
        format: path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase(),
        binary: invalid_text || has_binary_extension(path),
    }
}

pub fn from_path(path: &Path) -> io::Result<FileType> {
    let mut prefix = Vec::with_capacity(HEADER_BYTES);
    File::open(path)?
        .take(HEADER_BYTES as u64)
        .read_to_end(&mut prefix)?;
    Ok(detect(path, &prefix))
}

pub fn is_text(bytes: &[u8]) -> bool {
    !has_controls(bytes)
        && std::str::from_utf8(bytes).is_ok()
        && signature(&bytes[..bytes.len().min(HEADER_BYTES)]).is_none()
}
