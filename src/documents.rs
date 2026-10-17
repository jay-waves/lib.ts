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
    let path = checked_library_path(&root, &requested_path, &private)?;
    if !path.is_file() {
        return Err((StatusCode::BAD_REQUEST, "Not a file".into()));
    }
    let metadata = path
        .metadata()
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    let size = metadata.len();
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let absolute_path = client_path(&path);
    let modified = modified_rfc3339(&path);
    let detected = file_kind::from_path(&path)
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    let mime = detected.mime;

    let response = if mime == "text/html" && !detected.binary {
        let source = String::from_utf8(read_document_source(&path)?)
            .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
        DocumentContent::Html {
            line_count: source.split('\n').count(),
            source,
            url: format!(
                "{api_prefix}/api/html?path={}",
                encode_query_component(&requested_path)
            ),
        }
    } else if mime.starts_with("image/") {
        DocumentContent::Image {
            mime,
            format: detected.format,
            url: format!(
                "{api_prefix}/api/asset?path={}",
                encode_query_component(&requested_path)
            ),
        }
    } else if mime == "application/pdf" {
        let revision =
            pdf::revision(&path).map_err(|error| (pdf_error_status(&error), error.to_string()))?;
        let info = pdf_renderer
            .document_cancellable(&path, &revision, &cancellation)
            .map_err(|error| (pdf_error_status(&error), error.to_string()))?;
        let pages = info
            .pages
            .iter()
            .enumerate()
            .map(|(index, page)| DocumentPage {
                url: format!(
                    "{api_prefix}/api/pdf/page?path={}&page={}",
                    encode_query_component(&requested_path),
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
    } else if detected.binary {
        DocumentContent::Binary {
            mime,
            format: Some(detected.format),
            url: format!(
                "{api_prefix}/api/asset?path={}",
                encode_query_component(&requested_path)
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
                    encode_query_component(&requested_path)
                ),
            }
        } else {
            let source = String::from_utf8(bytes).expect("validated UTF-8 document");
            let line_count = source.lines().count();
            match detected.format.as_str() {
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
                "typ" => DocumentContent::Typst {
                    line_count,
                    source,
                    outline: Vec::new(),
                    anchors: Vec::new(),
                    pages: Vec::new(),
                    compile: None,
                },
                _ => DocumentContent::Text {
                    outline: crate::symbols::extract(&detected.format, &source),
                    line_count,
                    source,
                },
            }
        }
    };
    Ok(DocumentResponse {
        path: requested_path.to_owned(),
        absolute_path,
        name,
        size,
        modified,
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
