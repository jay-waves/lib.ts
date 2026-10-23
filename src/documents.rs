//! Document metadata, source loading and preview compilation.
use crate::{
    AppState, PathQuery, checked_library_path, client_path, encode_query_component, file_kind,
    json_error, markdown, modified_rfc3339, pdf, pdf_error_status, resources, typst, worker,
    worker_error,
};
use axum::{
    Json,
    extract::{OriginalUri, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::Serialize;
use std::path::Path;

pub(super) fn read_document_source(path: &Path) -> Result<Vec<u8>, (StatusCode, String)> {
    use std::io::Read;
    const LIMIT: u64 = 16 * 1024 * 1024;
    let file =
        std::fs::File::open(path).map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    if file
        .metadata()
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?
        .len()
        > LIMIT
    {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "Document source exceeds 16 MiB".into(),
        ));
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    if bytes.len() as u64 > LIMIT {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "Document source exceeds 16 MiB".into(),
        ));
    }
    Ok(bytes)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentResponse {
    path: String,
    absolute_path: String,
    name: String,
    size: u64,
    modified: String,
    #[serde(flatten)]
    content: DocumentContent,
}

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum DocumentContent {
    Html {
        line_count: usize,
        source: String,
        url: String,
    },
    Image {
        mime: &'static str,
        format: String,
        url: String,
        preview: crate::media::ImagePreview,
    },
    Pdf {
        revision: String,
        outline: Vec<pdf::OutlineItem>,
        pages: Vec<DocumentPage>,
    },
    Binary {
        mime: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        format: Option<String>,
        url: String,
    },
    Markdown {
        line_count: usize,
        source: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        html: Option<String>,
    },
    Mermaid {
        line_count: usize,
        source: String,
    },
    Typst {
        line_count: usize,
        source: String,
        outline: Vec<typst::OutlineItem>,
        anchors: Vec<typst::SourceAnchor>,
        pages: Vec<DocumentPage>,
        compile: Option<TypstCompilation>,
    },
    Text {
        outline: Vec<crate::symbols::Symbol>,
        line_count: usize,
        source: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentPage {
    url: String,
    width: f64,
    height: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TypstCompilation {
    id: Option<String>,
    status: CompileStatus,
    diagnostics: Vec<typst::Diagnostic>,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum CompileStatus {
    Success,
    Failed,
}

// This response only stats and sniffs a bounded header, without rendering or
// media probing. Keep it off the document worker queue so slow previews cannot
// delay the page framework.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentInformation {
    path: String,
    absolute_path: String,
    name: String,
    size: u64,
    modified: String,
    #[serde(rename = "type")]
    kind: &'static str,
    mime: &'static str,
    format: String,
    media: Option<&'static str>,
    playable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<crate::media::ImagePreview>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) dimensions: Option<crate::media::Dimensions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) captured_at: Option<i64>,
}

pub(crate) fn inspect_document(
    root: &Path,
    requested_path: &str,
    private: &Path,
) -> Result<DocumentInformation, (StatusCode, String)> {
    let path = checked_library_path(root, requested_path, private)?;
    let metadata = path
        .metadata()
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    if metadata.is_dir() {
        return Ok(DocumentInformation {
            path: requested_path.to_owned(),
            absolute_path: client_path(&path),
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            size: 0,
            modified: modified_rfc3339(&path),
            kind: "directory",
            mime: "inode/directory",
            format: String::new(),
            media: None,
            playable: false,
            preview: None,
            dimensions: None,
            captured_at: None,
        });
    }
    if !metadata.is_file() {
        return Err((StatusCode::BAD_REQUEST, "Not a file".into()));
    }
    let detected = file_kind::from_path(&path)
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    let kind = if detected.mime == "text/html" && !detected.binary {
        "html"
    } else if detected.mime.starts_with("image/") {
        "image"
    } else if detected.mime == "application/pdf" {
        "pdf"
    } else if detected.binary {
        "binary"
    } else {
        match detected.format.as_str() {
            "md" | "markdown" => "markdown",
            "mmd" => "mermaid",
            "typ" => "typst",
            _ => "text",
        }
    };
    let media = if kind == "image" {
        Some("image")
    } else if kind == "binary"
        && (detected.mime.starts_with("video/") || crate::media::is_video(&path))
    {
        Some("video")
    } else {
        None
    };
    let playable = media == Some("video")
        && detected.mime != "video/mp2t"
        && matches!(
            detected.format.as_str(),
            "mp4" | "m4v" | "mov" | "webm" | "ogv" | "ogg"
        );
    Ok(DocumentInformation {
        path: requested_path.to_owned(),
        absolute_path: client_path(&path),
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        size: metadata.len(),
        modified: modified_rfc3339(&path),
        kind,
        mime: detected.mime,
        format: detected.format,
        media,
        playable,
        preview: (kind == "image").then(|| crate::media::image_preview(&path)),
        dimensions: None,
        captured_at: None,
    })
}

pub(super) async fn information(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<PathQuery>,
) -> impl IntoResponse {
    let root = state.root_for_uri(uri.path());
    let private = state.data_directory.clone();
    match tokio::task::spawn_blocking(move || inspect_document(&root, &query.path, &private)).await
    {
        Ok(Ok(info)) => Json(info).into_response(),
        Ok(Err((status, error))) => json_error(status, error).into_response(),
        Err(error) => {
            json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
        }
    }
}

pub(super) async fn document(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<PathQuery>,
) -> impl IntoResponse {
    let root = state.root_for_uri(uri.path());
    let compile_root = root.clone();
    let PathQuery {
        path: requested_path,
        view,
        theme,
    } = query;
    let compile = view.as_deref() != Some("raw");
    let pdf_renderer = state.rendering.pdf.clone();
    let private = state.data_directory.clone();
    let api_prefix = uri
        .path()
        .strip_suffix("/api/document")
        .unwrap_or("")
        .to_owned();
    let compile_prefix = api_prefix.clone();
    let result = state
        .document_workers
        .run_cancellable(0, move |cancellation| {
            load_document(
                &root,
                &requested_path,
                view.as_deref(),
                &private,
                &api_prefix,
                &pdf_renderer,
                &cancellation,
            )
        })
        .await;

    match result {
        Ok(Ok(response)) => {
            let should_compile =
                compile && matches!(&response.content, DocumentContent::Typst { .. });
            let response = if should_compile {
                compile_document(&state, &compile_root, response, compile_prefix, theme)
                    .await
                    .map_err(worker_error)
            } else {
                Ok(response)
            };
            match response {
                Ok(response) => Json(response).into_response(),
                Err(error) => error,
            }
        }
        Ok(Err((status, error))) => json_error(status, error).into_response(),
        Err(error) => worker_error(error),
    }
}

fn load_document(
    root: &Path,
    requested_path: &str,
    view: Option<&str>,
    private: &Path,
    api_prefix: &str,
    pdf_renderer: &pdf::NativePdfRenderer,
    cancellation: &resources::Cancellation,
) -> Result<DocumentResponse, (StatusCode, String)> {
    let info = inspect_document(root, requested_path, private)?;
    if info.kind == "directory" {
        return Err((StatusCode::BAD_REQUEST, "Not a file".into()));
    }
    let path = checked_library_path(root, requested_path, private)?;
    let mime = info.mime;

    let response = if info.kind == "html" {
        let source = String::from_utf8(read_document_source(&path)?)
            .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
        DocumentContent::Html {
            line_count: source.split('\n').count(),
            source,
            url: format!(
                "{api_prefix}/api/html?path={}",
                encode_query_component(requested_path)
            ),
        }
    } else if info.kind == "image" {
        let preview = crate::media::image_preview(&path);
        DocumentContent::Image {
            mime,
            format: info.format,
            preview,
            url: format!(
                "{api_prefix}/api/asset?path={}",
                encode_query_component(requested_path)
            ),
        }
    } else if info.kind == "pdf" {
        let revision =
            pdf::revision(&path).map_err(|error| (pdf_error_status(&error), error.to_string()))?;
        let info = pdf_renderer
            .document_cancellable(&path, &revision, cancellation)
            .map_err(|error| (pdf_error_status(&error), error.to_string()))?;
        let pages = info
            .pages
            .iter()
            .enumerate()
            .map(|(index, page)| DocumentPage {
                url: format!(
                    "{api_prefix}/api/pdf/page?path={}&page={}",
                    encode_query_component(requested_path),
                    index + 1
                ),
                width: page.width,
                height: page.height,
            })
            .collect();
        DocumentContent::Pdf {
            revision,
            outline: info.outline,
            pages,
        }
    } else if info.kind == "binary" {
        DocumentContent::Binary {
            mime,
            format: Some(info.format),
            url: format!(
                "{api_prefix}/api/asset?path={}",
                encode_query_component(requested_path)
            ),
        }
    } else {
        let bytes = read_document_source(&path)?;
        if !file_kind::is_text(&bytes) {
            DocumentContent::Binary {
                mime: "application/octet-stream",
                format: None,
                url: format!(
                    "{api_prefix}/api/asset?path={}",
                    encode_query_component(requested_path)
                ),
            }
        } else {
            let source = String::from_utf8(bytes).expect("validated UTF-8 document");
            let line_count = source.lines().count();
            match info.format.as_str() {
                "md" | "markdown" => {
                    let html = if view == Some("raw") {
                        None
                    } else {
                        Some(
                            markdown::render_markdown(&source, true)
                                .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?,
                        )
                    };
                    DocumentContent::Markdown {
                        line_count,
                        source,
                        html,
                    }
                }
                "mmd" => DocumentContent::Mermaid { line_count, source },
                "typ" => DocumentContent::Typst {
                    line_count,
                    source,
                    outline: Vec::new(),
                    anchors: Vec::new(),
                    pages: Vec::new(),
                    compile: None,
                },
                _ => DocumentContent::Text {
                    outline: crate::symbols::extract(&info.format, &source),
                    line_count,
                    source,
                },
            }
        }
    };
    Ok(DocumentResponse {
        path: requested_path.to_owned(),
        absolute_path: info.absolute_path,
        name: info.name,
        size: info.size,
        modified: info.modified,
        content: response,
    })
}

async fn compile_document(
    state: &AppState,
    root: &Path,
    mut response: DocumentResponse,
    api_prefix: String,
    theme: Option<String>,
) -> Result<DocumentResponse, worker::WorkerError> {
    let DocumentContent::Typst {
        source,
        outline,
        anchors,
        pages,
        compile,
        ..
    } = &mut response.content
    else {
        return Ok(response);
    };
    let request = typst::CompileRequest {
        path: response.absolute_path.clone(),
        source: source.clone(),
        theme,
    };
    match state.rendering.compile(root, request).await? {
        Ok(compiled) => {
            *outline = compiled.outline;
            *anchors = compiled.anchors;
            *pages = compiled
                .pages
                .iter()
                .enumerate()
                .map(|(index, page)| DocumentPage {
                    url: format!(
                        "{api_prefix}/api/typst/page?id={}&page={}",
                        compiled.id,
                        index + 1
                    ),
                    width: page.width,
                    height: page.height,
                })
                .collect();
            *compile = Some(TypstCompilation {
                id: Some(compiled.id),
                status: CompileStatus::Success,
                diagnostics: compiled.diagnostics,
            });
        }
        Err(typst::CompileError::Busy) => return Err(worker::WorkerError::Busy),
        Err(typst::CompileError::Cancelled) => return Err(worker::WorkerError::Stopped),
        Err(typst::CompileError::Diagnostics(diagnostics)) => {
            *compile = Some(TypstCompilation {
                id: None,
                status: CompileStatus::Failed,
                diagnostics,
            });
        }
        Err(typst::CompileError::Failed(error)) => {
            tracing::warn!(path = %response.path, error = %error, "Typst compilation failed");
            *compile = Some(TypstCompilation {
                id: None,
                status: CompileStatus::Failed,
                diagnostics: vec![typst::Diagnostic {
                    file: response.path.clone(),
                    severity: "error".into(),
                    message: error,
                    range: None,
                }],
            });
        }
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mermaid_files_return_source_for_both_views_without_markdown_rendering() {
        let root = tempfile::tempdir().unwrap();
        let private = tempfile::tempdir().unwrap();
        let source = "flowchart LR\n  A[开始] --> B[结束]\n";
        let path = "diagram.MMD";
        std::fs::write(root.path().join(path), source).unwrap();
        let info = inspect_document(root.path(), path, private.path()).unwrap();
        assert_eq!(info.kind, "mermaid");
        for view in ["raw", "preview"] {
            let document = load_document(
                root.path(),
                path,
                Some(view),
                private.path(),
                "",
                &pdf::NativePdfRenderer::default(),
                &resources::Cancellation::default(),
            )
            .unwrap();
            let value = serde_json::to_value(document).unwrap();
            assert_eq!(value["type"], "mermaid");
            assert_eq!(value["source"], source);
            assert_eq!(value["lineCount"], 2);
            assert!(value.get("html").is_none());
        }
    }

    #[test]
    fn image_documents_return_resource_policy_without_media_metadata() {
        let root = tempfile::tempdir().unwrap();
        let private = tempfile::tempdir().unwrap();
        image::RgbImage::new(2, 3)
            .save(root.path().join("photo.png"))
            .unwrap();
        // Even an unprobeable HEIF returns its conversion URL policy immediately.
        std::fs::write(root.path().join("photo.heic"), "").unwrap();
        for (path, preview) in [("photo.png", "original"), ("photo.heic", "converted")] {
            let document = load_document(
                root.path(),
                path,
                None,
                private.path(),
                "/notes",
                &pdf::NativePdfRenderer::default(),
                &resources::Cancellation::default(),
            )
            .unwrap();
            let value = serde_json::to_value(document).unwrap();
            assert_eq!(value["type"], "image");
            assert_eq!(value["preview"], preview);
            assert!(value.get("imageMetadata").is_none());
            assert!(value.get("videoMetadata").is_none());
        }
    }

    #[test]
    fn information_does_not_load_or_render_content() {
        let root = tempfile::tempdir().unwrap();
        let private = tempfile::tempdir().unwrap();
        // Deliberately incomplete PDF: information must not invoke a renderer.
        std::fs::write(root.path().join("sample.pdf"), b"%PDF-1.7\n").unwrap();
        let info = inspect_document(root.path(), "sample.pdf", private.path()).unwrap();
        let value = serde_json::to_value(info).unwrap();
        assert_eq!(value["type"], "pdf");
        assert_eq!(value["size"], 9);
        assert!(value.get("pages").is_none());
        assert!(value.get("source").is_none());

        // Source exceeding the preview limit still has immediately usable info.
        let file = std::fs::File::create(root.path().join("large.md")).unwrap();
        file.set_len(17 * 1024 * 1024).unwrap();
        let info = inspect_document(root.path(), "large.md", private.path()).unwrap();
        assert_eq!(info.size, 17 * 1024 * 1024);
    }

    #[test]
    fn information_identifies_content_and_directories() {
        let root = tempfile::tempdir().unwrap();
        let private = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("source.ts"), b"export const value = 1;").unwrap();
        let mut stream = vec![0xff; 188 * 4];
        for offset in (0..stream.len()).step_by(188) {
            stream[offset] = 0x47;
        }
        std::fs::write(root.path().join("video.ts"), stream).unwrap();
        assert_eq!(
            inspect_document(root.path(), "source.ts", private.path())
                .unwrap()
                .kind,
            "text"
        );
        assert_eq!(
            inspect_document(root.path(), "video.ts", private.path())
                .unwrap()
                .mime,
            "video/mp2t"
        );
        std::fs::create_dir(root.path().join("folder")).unwrap();
        assert_eq!(
            inspect_document(root.path(), "folder", private.path())
                .unwrap()
                .kind,
            "directory"
        );
        let video = inspect_document(root.path(), "video.ts", private.path()).unwrap();
        assert_eq!(video.media, Some("video"));
        assert!(!video.playable);
        std::fs::write(root.path().join("same.ts"), b"export const value = 1;").unwrap();
        assert_eq!(
            inspect_document(root.path(), "same.ts", private.path())
                .unwrap()
                .kind,
            "text"
        );
        image::RgbImage::new(2, 3)
            .save_with_format(root.path().join("same.ts"), image::ImageFormat::Png)
            .unwrap();
        let image = inspect_document(root.path(), "same.ts", private.path()).unwrap();
        assert_eq!(image.kind, "image");
        assert_eq!(image.media, Some("image"));
        assert!(image.preview.is_some());
        assert!(inspect_document(root.path(), "../outside", private.path()).is_err());
    }

    #[test]
    fn document_metadata_stays_flat_with_typed_content() {
        let response = DocumentResponse {
            path: "example.ts".into(),
            absolute_path: "/notes/example.ts".into(),
            name: "example.ts".into(),
            size: 0,
            modified: "2026-10-17T00:00:00Z".into(),
            content: DocumentContent::Text {
                outline: Vec::new(),
                line_count: 0,
                source: String::new(),
            },
        };
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            serde_json::json!({
                "path": "example.ts",
                "absolutePath": "/notes/example.ts",
                "name": "example.ts",
                "size": 0,
                "modified": "2026-10-17T00:00:00Z",
                "type": "text",
                "outline": [],
                "lineCount": 0,
                "source": "",
            })
        );
    }
}
