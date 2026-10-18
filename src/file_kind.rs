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
    let kind = infer::get(bytes)?;
    if kind.matcher_type() == infer::MatcherType::Text {
        return None;
    }
    let matches = match kind.extension() {
        // infer searches for `%PDF` anywhere in the first KiB, including prose
        // and code examples. Require a versioned header at the start instead.
        "pdf" => {
            bytes.starts_with(b"%PDF-")
                && matches!(bytes.get(5), Some(b'1' | b'2'))
                && bytes.get(6) == Some(&b'.')
                && bytes.get(7).is_some_and(u8::is_ascii_digit)
                && matches!(bytes.get(8), Some(b'\r' | b'\n'))
        }
        "ps" => bytes.starts_with(b"%!PS-Adobe-"),
        "rtf" => bytes.starts_with(b"{\\rtf") && bytes.get(5).is_some_and(u8::is_ascii_digit),
        "sqlite" => bytes.starts_with(b"SQLite format 3\0"),
        // Many matchers use short ASCII strings (GIF, MZ, BC, BZh, ...).
        // Without binary evidence these are just as likely to be ordinary
        // text. Keep text readable rather than trusting every such match.
        _ => binary_prefix(bytes),
    };
    matches.then_some(kind)
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
    // Require repeated transport packet sync bytes, not the .ts suffix shared
    // with TypeScript. Standard MPEG-TS packets contain 188 bytes.
    if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("ts"))
        && bytes.len() >= 188 * 3
        && (0..188)
            .any(|offset| (0..3).all(|packet| bytes.get(offset + packet * 188) == Some(&0x47)))
        && binary_prefix(bytes)
    {
        return FileType {
            mime: "video/mp2t",
            format: "ts".into(),
            binary: true,
        };
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_stream_is_distinct_from_typescript() {
        let mut bytes = vec![0xff; 188 * 4];
        for offset in (0..bytes.len()).step_by(188) {
            bytes[offset] = 0x47;
        }
        let kind = detect(Path::new("clip.TS"), &bytes);
        assert_eq!(kind.mime, "video/mp2t");
        assert!(kind.binary);
        assert_ne!(detect(Path::new("other.bin"), &bytes).mime, "video/mp2t");
        assert!(!detect(Path::new("source.ts"), b"export const value = 1;").binary);
        bytes[188] = 0;
        bytes[376] = 0;
        assert_ne!(detect(Path::new("broken.ts"), &bytes).mime, "video/mp2t");
    }

    #[test]
    fn ambiguous_signatures_do_not_promote_text_to_binary() {
        let tar_example = format!("{}ustar is the tar marker", " ".repeat(257));
        for source in [
            "GIF images explained",
            "GIF89a",
            "MZ executable header",
            "BC compiler notes",
            "BZh compression",
            "BZ3v1 compression",
            "CWS format",
            "MSCF archive",
            "Cr24 extension",
            "LZIP format",
            "070701 cpio header",
            "fLaC audio",
            "OggS audio",
            "-----BEGIN CERTIFICATE-----\nexample\n",
            "Documentation mentions %PDF-1.7\n",
            "%PDF is a marker",
            "%! ordinary text",
            "{\\rtf examples}",
            "<html><body>Markdown HTML</body></html>",
            "#!/bin/sh\necho hello\n",
            &tar_example,
        ] {
            for name in ["note.md", "note.markdown", "note.txt", "note.rs", "note"] {
                assert!(
                    !detect(Path::new(name), source.as_bytes()).binary,
                    "{name}: {source}"
                );
            }
            assert!(is_text(source.as_bytes()), "{source}");
        }
    }

    #[test]
    fn real_format_headers_still_override_text_extensions() {
        for (bytes, format) in [
            (&b"%PDF-1.7\n1 0 obj\n"[..], "pdf"),
            (&b"%!PS-Adobe-3.0\n"[..], "ps"),
            (&b"{\\rtf1\\ansi hello}"[..], "rtf"),
            (&b"GIF89a\x01\0\x01\0"[..], "gif"),
            (&b"MZ\0\0"[..], "exe"),
            (&b"PK\x03\x04\0\0"[..], "zip"),
            (&b"\x89PNG\r\n\x1a\n"[..], "png"),
        ] {
            let detected = detect(Path::new("note.md"), bytes);
            assert!(detected.binary, "{format}");
            assert_eq!(detected.format, format);
            assert!(!is_text(bytes), "{format}");
        }
    }

    #[test]
    fn prefix_boundary_and_full_text_validation_are_distinct() {
        let mut bytes = vec![b'a'; HEADER_BYTES - 1];
        bytes.extend_from_slice("中文".as_bytes());
        assert!(!detect(Path::new("note.md"), &bytes).binary);
        assert!(is_text(&bytes));
        bytes.push(0);
        assert!(!is_text(&bytes));
        assert!(detect(Path::new("note.md"), b"text\0data").binary);
        assert!(detect(Path::new("note.md"), b"text\xffdata").binary);
    }

    #[test]
    fn sqlite_documentation_is_text() {
        for name in ["sqlite.md", "sqlite.MARKDOWN", "sqlite.txt"] {
            for source in ["SQLite is a database.\n", "SQLite format 3\n", "SQLi"] {
                let detected = detect(Path::new(name), source.as_bytes());
                assert!(!detected.binary, "{name}: {source}");
                assert!(is_text(source.as_bytes()));
                if name.ends_with(".md") {
                    assert_eq!(detected.format, "md");
                }
            }
        }
    }

    #[test]
    fn sqlite_signature_takes_precedence_over_extension() {
        let bytes = b"SQLite format 3\0\x10\0";
        for name in ["data.db", "data.sqlite", "data.md", "data"] {
            let detected = detect(Path::new(name), bytes);
            assert!(detected.binary);
            assert_eq!(detected.format, "sqlite");
            assert_eq!(detected.mime, "application/vnd.sqlite3");
            assert!(!is_text(bytes));
        }
    }
}
