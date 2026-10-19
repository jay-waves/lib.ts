use super::*;

pub(super) async fn typst_page(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<TypstPageQuery>,
) -> Response {
    let root = state.root_for_uri(uri.path());
    let result = state
        .rendering
        .typst_page(&root, query.id, query.page)
        .await;
    match result {
        Ok(Ok(page)) if query.format.as_deref() == Some("json") => {
            Json(serde_json::json!({"svg":String::from_utf8_lossy(&page.svg),"links":page.links}))
                .into_response()
        }
        Ok(Ok(page)) => (
            [
                (
                    axum::http::header::CONTENT_TYPE,
                    "image/svg+xml; charset=utf-8",
                ),
                (axum::http::header::CACHE_CONTROL, "no-store"),
            ],
            page.svg,
        )
            .into_response(),
        Ok(Err(error)) => json_error(StatusCode::GONE, error).into_response(),
        Err(error) => worker_error(error),
    }
}

pub(super) async fn pdf_page(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<PdfPageQuery>,
) -> Response {
    if query
        .width
        .is_some_and(|width| !width.is_finite() || width <= 0.0)
    {
        return json_error(StatusCode::BAD_REQUEST, "Invalid page width").into_response();
    }
    // PDF pages are served as resolution-independent SVG in the native backend.
    // Keep rejecting invalid width hints while allowing the browser to size the SVG.
    let root = state.root_for_uri(uri.path());
    let private = state.data_directory.clone();
    let page_number = query.page;
    let checked = state
        .document_workers
        .run(move || {
            let path = checked_library_path(&root, &query.path, &private)?;
            if !path.is_file() {
                return Err((StatusCode::BAD_REQUEST, "Not a file".into()));
            }
            let detected = file_kind::from_path(&path)
                .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
            if detected.mime != "application/pdf" {
                return Err((StatusCode::BAD_REQUEST, "Not a PDF".into()));
            }
            let revision = pdf::revision(&path)
                .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
            Ok((path, query.v.unwrap_or(revision)))
        })
        .await;
    let (path, revision) = match checked {
        Ok(Ok(value)) => value,
        Ok(Err((status, error))) => return json_error(status, error).into_response(),
        Err(error) => return worker_error(error),
    };
    let result = state.rendering.pdf_page(path, revision, page_number).await;
    match result {
        Ok(Ok(svg)) => (
            [
                (
                    axum::http::header::CONTENT_TYPE,
                    "image/svg+xml; charset=utf-8",
                ),
                (axum::http::header::CACHE_CONTROL, "no-store"),
            ],
            svg,
        )
            .into_response(),
        Ok(Err(error)) => {
            if matches!(*error, pdf::PdfError::Busy) {
                return worker_error(worker::WorkerError::Busy);
            }
            json_error(pdf_error_status(&error), error.to_string()).into_response()
        }
        Err(error) => worker_error(error),
    }
}
