//! Media HTTP transport: validation, worker dispatch and range-capable file responses.
use crate::{AppState, checked_library_path, json_error, modified_rfc3339, worker_error};
use axum::{
    Json,
    body::Body,
    extract::{OriginalUri, Query, Request, State},
    http::{HeaderValue, StatusCode, Uri, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub(crate) async fn file(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<MediaQuery>,
    request: Request,
) -> Response {
    let root = state.root_for_uri(uri.path());
    let path = match checked_library_path(&root, &query.path, &state.data_directory) {
        Ok(path) => path,
        Err((status, message)) => return json_error(status, message).into_response(),
    };
    let policy = cache_policy(&path, query.v.as_deref());
    serve_media_path(path, request, policy).await
}

fn cache_policy(source: &Path, version: Option<&str>) -> &'static str {
    if version.is_some_and(|version| !version.is_empty() && version == modified_rfc3339(source)) {
        "private, max-age=31536000, immutable"
    } else {
        "private, no-cache"
    }
}

async fn serve_media_path(path: PathBuf, request: Request, policy: &'static str) -> Response {
    match tower_http::services::ServeFile::new(path)
        .try_call(request)
        .await
    {
        Ok(response) => {
            let mut response = response.map(Body::new);
            if response.status().is_success() || response.status() == StatusCode::NOT_MODIFIED {
                response
                    .headers_mut()
                    .insert(CACHE_CONTROL, HeaderValue::from_static(policy));
            }
            response
        }
        Err(error) => {
            json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct MediaDimensionsRequest {
    paths: Vec<String>,
    #[serde(default, rename = "includeCaptureTime")]
    include_capture_time: bool,
}

#[derive(Serialize)]
struct MediaDimensionsResponse {
    dimensions: std::collections::HashMap<String, Option<super::Dimensions>>,
    #[serde(rename = "capturedAt")]
    captured_at: std::collections::HashMap<String, Option<i64>>,
}

pub(crate) async fn dimensions(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Json(request): Json<MediaDimensionsRequest>,
) -> Response {
    if request.paths.len() > 512 {
        return json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "At most 512 media paths are allowed",
        )
        .into_response();
    }
    let root = state.root_for_uri(uri.path());
    let private = state.data_directory.clone();
    let mut paths = Vec::with_capacity(request.paths.len());
    for value in request.paths {
        let path = match checked_library_path(&root, &value, &private) {
            Ok(path) => path,
            Err((status, message)) => return json_error(status, message).into_response(),
        };
        if !path.is_file() {
            return json_error(StatusCode::BAD_REQUEST, "Media path is not a file").into_response();
        }
        paths.push((value, path));
    }
    let metadata = state.media_metadata.clone();
    match state
        .media_workers
        .run(move || {
            let mut dimensions = std::collections::HashMap::new();
            let mut captured_at = std::collections::HashMap::new();
            for (key, path) in paths {
                if request.include_capture_time
                    && !super::is_video(&path)
                    && !path
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("svg"))
                {
                    let value = metadata.image_metadata(&path);
                    captured_at.insert(key.clone(), value.captured_at);
                    dimensions.insert(key, value.dimensions);
                } else {
                    captured_at.insert(key.clone(), None);
                    dimensions.insert(key, metadata.dimensions(&path));
                }
            }
            MediaDimensionsResponse {
                dimensions,
                captured_at,
            }
        })
        .await
    {
        Ok(response) => Json(response).into_response(),
        Err(error) => worker_error(error),
    }
}

#[derive(Deserialize)]
pub(crate) struct MediaQuery {
    path: String,
    v: Option<String>,
}

pub(crate) async fn thumbnail(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<MediaQuery>,
    request: Request,
) -> Response {
    render(state, uri, query, request, false).await
}

pub(crate) async fn preview(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<MediaQuery>,
    request: Request,
) -> Response {
    render(state, uri, query, request, true).await
}

async fn render(
    state: AppState,
    uri: Uri,
    query: MediaQuery,
    request: Request,
    full: bool,
) -> Response {
    let root = state.root_for_uri(uri.path());
    let path = match checked_library_path(&root, &query.path, &state.data_directory) {
        Ok(path) => path,
        Err((status, message)) => return json_error(status, message).into_response(),
    };
    let data = state.data_directory.clone();
    let source = path.clone();
    match state
        .media_workers
        .run(move || {
            if full {
                super::preview(&path, &data)
            } else {
                super::thumbnail(&path, &data)
            }
        })
        .await
    {
        Ok(Ok(path)) => {
            let policy = cache_policy(&source, query.v.as_deref());
            serve_media_path(path, request, policy).await
        }
        Ok(Err(message)) => json_error(StatusCode::UNPROCESSABLE_ENTITY, message).into_response(),
        Err(error) => worker_error(error),
    }
}

pub(crate) async fn metadata(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<MediaQuery>,
) -> Response {
    let root = state.root_for_uri(uri.path());
    let path = match checked_library_path(&root, &query.path, &state.data_directory) {
        Ok(path) if super::is_video(&path) && path.is_file() => path,
        Ok(_) => return json_error(StatusCode::BAD_REQUEST, "Not a video file").into_response(),
        Err((status, message)) => return json_error(status, message).into_response(),
    };
    let metadata = state.media_metadata.clone();
    match state
        .media_workers
        .run(move || metadata.video_metadata(&path))
        .await
    {
        Ok(value) => Json(value).into_response(),
        Err(error) => worker_error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn versioned_media_remains_cacheable_for_ranges_and_revalidation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.mp4");
        std::fs::write(&path, b"abcdef").unwrap();
        let version = modified_rfc3339(&path);
        let policy = cache_policy(&path, Some(&version));
        assert!(policy.contains("immutable"));
        assert_eq!(cache_policy(&path, None), "private, no-cache");
        assert_eq!(
            cache_policy(&path, Some("old-version")),
            "private, no-cache"
        );

        let request = Request::builder()
            .uri("/media")
            .header("range", "bytes=1-3")
            .body(Body::empty())
            .unwrap();
        let response = serve_media_path(path.clone(), request, policy).await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[CACHE_CONTROL], policy);
        assert_eq!(response.headers()["content-range"], "bytes 1-3/6");
        let last_modified = response.headers()["last-modified"].clone();
        let body = axum::body::to_bytes(response.into_body(), 100)
            .await
            .unwrap();
        assert_eq!(body.as_ref(), b"bcd");

        let request = Request::builder()
            .uri("/media")
            .header("if-modified-since", last_modified)
            .body(Body::empty())
            .unwrap();
        let response = serve_media_path(path, request, policy).await;
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(response.headers()[CACHE_CONTROL], policy);
    }
}
