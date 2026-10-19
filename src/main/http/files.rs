use super::*;

pub(super) async fn git_status(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> impl IntoResponse {
    let root = state.root_for_uri(uri.path());
    let result = tokio::task::spawn_blocking(move || git::status(&root)).await;
    match result {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
        Err(error) => {
            json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
        }
    }
}

pub(super) async fn git_diff(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<GitDiffQuery>,
) -> impl IntoResponse {
    let root = state.root_for_uri(uri.path());
    let scope = query.scope.unwrap_or_else(|| "all".into());
    let result = tokio::task::spawn_blocking(move || git::diff(&root, &query.path, &scope)).await;
    match result {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => json_error(StatusCode::BAD_REQUEST, error).into_response(),
        Err(error) => {
            json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
        }
    }
}

pub(super) async fn search(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Query(params): Query<search::SearchParams>,
) -> Response {
    let root = state.root_for_uri(uri.path());
    let service = state.search.clone();
    let bookmarks = state
        .repository_for_uri(uri.path())
        .map(|repo| {
            repo.bookmarks
                .into_iter()
                .map(|item| item.path)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let private = state.data_directory.clone();
    match tokio::task::spawn_blocking(move || {
        service.search_with_private(&root, params, Some(&bookmarks), Some(&private))
    })
    .await
    {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => {
            let status = if error == search::SEARCH_EXPIRED {
                StatusCode::GONE
            } else {
                StatusCode::BAD_REQUEST
            };
            json_error(status, error).into_response()
        }
        Err(error) => {
            json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
        }
    }
}

pub(super) async fn asset(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<PathQuery>,
) -> Response {
    let root = state.root_for_uri(uri.path());
    let private = state.data_directory.clone();
    let path = match checked_library_path(&root, &query.path, &private) {
        Ok(path) => path,
        Err((status, message)) => return json_error(status, message).into_response(),
    };
    let mut file = match tokio::fs::File::open(&path).await {
        Ok(file) => file,
        Err(error) => return json_error(StatusCode::NOT_FOUND, error.to_string()).into_response(),
    };
    let metadata = match file.metadata().await {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return json_error(StatusCode::NOT_FOUND, "Asset not found").into_response(),
        Err(error) => return json_error(StatusCode::NOT_FOUND, error.to_string()).into_response(),
    };
    let mime = match media_type(&path, &mut file).await {
        Ok(mime) => mime,
        Err(error) => {
            return json_error(StatusCode::BAD_REQUEST, error.to_string()).into_response();
        }
    };
    let mut response = Response::new(Body::from_stream(stream_file(file)));
    let headers = response.headers_mut();
    headers.insert(axum::http::header::CONTENT_TYPE, mime.parse().unwrap());
    headers.insert(axum::http::header::CONTENT_LENGTH, metadata.len().into());
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        "no-store".parse().unwrap(),
    );
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    response
}
