//! Media HTTP transport: validation, worker dispatch and range-capable file responses.
//! Mounted under each repository's /api/media: the base GET serves originals,
//! /thumbnail and /preview serve cached derivatives, /metadata reads details,
//! POST /dimensions batches versioned descriptors, and POST /open uses the host
//! desktop application. Metadata and conversion use separate bounded pools so
//! slow probes cannot occupy conversion workers. Batch results preserve input
//! order, while each file is scheduled independently.
use crate::{AppState, checked_library_path, json_error, modified_rfc3339, worker_error};
use axum::{
    Json,
    body::Body,
    extract::{OriginalUri, Query, Request, State},
    http::{HeaderValue, StatusCode, Uri, header::CACHE_CONTROL},
    response::{IntoResponse, Redirect, Response},
};
use futures_util::{FutureExt, StreamExt, TryStreamExt, stream};
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
    files: Vec<crate::documents::DocumentInformation>,
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
    let workers = &state.media_metadata_workers;
    let capture = request.include_capture_time;
    let jobs = stream::iter(paths.into_iter().enumerate()).map(|(index, (key, path))| {
        let root = root.clone();
        let private = private.clone();
        let metadata = metadata.clone();
        workers
            .run(move || {
                let before = crate::file_signature(&path);
                let Ok(mut info) = crate::documents::inspect_document(&root, &key, &private) else {
                    return None;
                };
                if capture
                    && !super::is_video(&path)
                    && !path
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("svg"))
                {
                    let value = metadata.image_metadata(&path);
                    info.captured_at = value.captured_at;
                    info.dimensions = value.dimensions;
                } else {
                    info.dimensions = metadata.dimensions(&path);
                }
                // Descriptions and dimensions must refer to the same file version.
                (before == crate::file_signature(&path)).then_some(info)
            })
            .map(move |result| result.map(|info| (index, info)))
    });
    // Submit individual files to the shared pool. A batch never occupies a
    // worker while waiting for other work, and cancellation drops queued jobs.
    match jobs
        .buffer_unordered(workers.parallelism())
        .try_collect::<Vec<_>>()
        .await
    {
        Ok(mut files) => {
            files.sort_unstable_by_key(|(index, _)| *index);
            Json(MediaDimensionsResponse {
                files: files.into_iter().filter_map(|(_, info)| info).collect(),
            })
            .into_response()
        }
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
    let key = (path.clone(), crate::file_signature(&path), full);
    let workers = state.media_workers.clone();
    match state
        .media_previews
        .run(key, async move {
            workers
                .run(move || {
                    if full {
                        super::preview(&path, &data)
                    } else {
                        super::thumbnail(&path, &data)
                    }
                })
                .await
        })
        .await
    {
        Ok(Ok(path)) => {
            let policy = cache_policy(&source, query.v.as_deref());
            if path == source {
                original_media_redirect(&uri, policy)
            } else {
                serve_media_path(path, request, policy).await
            }
        }
        Ok(Err(message)) => json_error(StatusCode::UNPROCESSABLE_ENTITY, message).into_response(),
        Err(error) => worker_error(error),
    }
}

// Small Gallery images and full previews share the original resource's cache key.
fn original_media_redirect(uri: &Uri, policy: &'static str) -> Response {
    let base = uri
        .path()
        .rsplit_once('/')
        .map_or(uri.path(), |(base, _)| base);
    let target = match uri.query() {
        Some(query) => format!("{base}?{query}"),
        None => base.to_owned(),
    };
    let mut response = Redirect::temporary(&target).into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static(policy));
    response
}

pub(crate) async fn metadata(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<MediaQuery>,
) -> Response {
    let root = state.root_for_uri(uri.path());
    let path = match checked_library_path(&root, &query.path, &state.data_directory) {
        Ok(path) if path.is_file() => path,
        Ok(_) => return json_error(StatusCode::BAD_REQUEST, "Not a media file").into_response(),
        Err((status, message)) => return json_error(status, message).into_response(),
    };
    let metadata = state.media_metadata.clone();
    match state
        .media_metadata_workers
        .run(move || {
            let before = crate::file_signature(&path);
            let modified = modified_rfc3339(&path);
            let value = read_metadata(&path, &metadata)?;
            if before != crate::file_signature(&path) {
                return Err("Media changed while reading metadata".to_owned());
            }
            Ok(serde_json::json!({ "path": query.path, "modified": modified, "media": value }))
        })
        .await
    {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(message)) => json_error(StatusCode::BAD_REQUEST, message).into_response(),
        Err(error) => worker_error(error),
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", content = "details", rename_all = "lowercase")]
enum MetadataResponse {
    Image(super::ImageMetadata),
    Video(super::VideoMetadata),
}

fn read_metadata(
    path: &Path,
    service: &super::MetadataService,
) -> Result<MetadataResponse, String> {
    let kind = crate::file_kind::from_path(path).map_err(|error| error.to_string())?;
    if kind.mime.starts_with("image/") {
        // SVG dimensions belong to the browser; do not parse it as raster/EXIF.
        Ok(MetadataResponse::Image(if kind.mime == "image/svg+xml" {
            super::ImageMetadata::default()
        } else {
            service.image_metadata(path)
        }))
    } else if kind.binary && (kind.mime.starts_with("video/") || super::is_video(path)) {
        Ok(MetadataResponse::Video(service.video_metadata(path)))
    } else {
        Err("Not an image or video file".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_gallery_images_redirect_to_the_versioned_original_cache_key() {
        let uri: Uri = "/notes/api/media/thumbnail?path=photos%2Fa+%26+b.jpg&v=version"
            .parse()
            .unwrap();
        let response = original_media_redirect(&uri, "private, max-age=31536000, immutable");
        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(
            response.headers()["location"],
            "/notes/api/media?path=photos%2Fa+%26+b.jpg&v=version"
        );
        assert_eq!(
            response.headers()[CACHE_CONTROL],
            "private, max-age=31536000, immutable"
        );
    }

    #[test]
    fn image_metadata_is_independent_and_source_files_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("photo.png");
        image::RgbImage::new(2, 3).save(&path).unwrap();
        let service = super::super::MetadataService::default();
        let value = serde_json::to_value(read_metadata(&path, &service).unwrap()).unwrap();
        assert_eq!(
            value["details"]["dimensions"],
            serde_json::json!({"width":2,"height":3})
        );
        assert_eq!(value["details"]["exif"], serde_json::json!([]));
        let svg = dir.path().join("drawing.svg");
        std::fs::write(&svg, "<svg/>").unwrap();
        let value = serde_json::to_value(read_metadata(&svg, &service).unwrap()).unwrap();
        assert!(value["details"].get("dimensions").is_none());
        let source = dir.path().join("source.ts");
        std::fs::write(&source, "export const value = 1;").unwrap();
        assert!(read_metadata(&source, &service).is_err());
    }

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

#[derive(Deserialize)]
pub(crate) struct OpenMediaRequest {
    path: String,
}

pub(crate) async fn open(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Json(request): Json<OpenMediaRequest>,
) -> Response {
    let root = state.root_for_uri(uri.path());
    let path = match checked_library_path(&root, &request.path, &state.data_directory) {
        Ok(path) if path.is_file() => path,
        Ok(_) => return json_error(StatusCode::BAD_REQUEST, "Not a file").into_response(),
        Err((status, message)) => return json_error(status, message).into_response(),
    };
    let source = path.clone();
    let allowed = state
        .media_workers
        .run(move || super::is_external_media(&source))
        .await;
    match allowed {
        Ok(true) => {}
        Ok(false) => {
            return json_error(StatusCode::BAD_REQUEST, "Not an image or video file")
                .into_response();
        }
        Err(error) => return worker_error(error),
    }
    match crate::platform::system_open::open(&path).await {
        Ok(()) => Json(serde_json::json!({"ok": true, "target": "server"})).into_response(),
        Err(error) => json_error(
            StatusCode::BAD_REQUEST,
            format!("Could not open system application: {error}"),
        )
        .into_response(),
    }
}
