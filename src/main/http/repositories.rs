use super::*;

pub(super) async fn get_tree(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<TreeQuery>,
) -> Response {
    let root = state.root_for_uri(uri.path());
    let path = match checked_library_path(&root, &query.path, &state.data_directory) {
        Ok(path) if path.is_dir() => path,
        Ok(_) => return json_error(StatusCode::NOT_FOUND, "Directory not found").into_response(),
        Err((status, message)) => return json_error(status, message).into_response(),
    };
    let entry = match state.trees.entry(
        (*root).clone(),
        (*state.data_directory).clone(),
        query.show_hidden,
    ) {
        Ok(entry) => entry,
        Err(error) => return json_error(StatusCode::SERVICE_UNAVAILABLE, error).into_response(),
    };
    match entry.directory(&root, &path).await {
        Ok(snapshot) => {
            let mut response = (
                [
                    (axum::http::header::CONTENT_TYPE, "application/json"),
                    (axum::http::header::CACHE_CONTROL, "no-store"),
                ],
                snapshot.body,
            )
                .into_response();
            response.headers_mut().insert(
                "x-tree-revision",
                snapshot.revision.to_string().parse().unwrap(),
            );
            response
        }
        Err(error) => json_error(StatusCode::SERVICE_UNAVAILABLE, error).into_response(),
    }
}

pub(super) async fn directories(
    State(state): State<AppState>,
    Query(query): Query<DirectoryQuery>,
) -> Response {
    let listing = if query.root {
        browse_machine_root(&state.data_directory)
    } else {
        browse_directories(
            query.path.as_deref(),
            &state.service_root,
            &state.data_directory,
        )
    };
    match listing {
        Ok(value) => Json(value).into_response(),
        Err((status, error)) => json_error(status, error).into_response(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryMetadata {
    id: String,
    slug: String,
    name: String,
    root: String,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_used_at: Option<String>,
    url: String,
    api_url: String,
}

fn describe_repository(repo: &crate::repositories::Repository) -> RepositoryMetadata {
    let segment = encode_query_component(&repo.slug);
    RepositoryMetadata {
        id: repo.id.clone(),
        slug: repo.slug.clone(),
        name: repo.name.clone(),
        root: client_path(&repo.root),
        created_at: repo.created_at.clone(),
        last_used_at: repo.last_used_at.clone(),
        url: format!("/{segment}/tree/"),
        api_url: format!("/{segment}/api"),
    }
}

pub(super) async fn list_repositories(State(state): State<AppState>) -> Response {
    if let Err(error) = state.repositories.prune_missing() {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error).into_response();
    }
    match state.repositories.list() {
        Ok(repos) => {
            let default_id = state.default_repository().map(|repo| repo.id);
            #[derive(Serialize)]
            #[serde(rename_all = "camelCase")]
            struct RepositoryListResponse {
                repos: Vec<RepositoryMetadata>,
                default_repo_id: Option<String>,
            }
            Json(RepositoryListResponse {
                repos: repos.iter().map(describe_repository).collect(),
                default_repo_id: default_id,
            })
            .into_response()
        }
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
    }
}

pub(super) async fn repository_metadata(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> Response {
    match state.repository_for_uri(uri.path()) {
        Some(repo) => Json(describe_repository(&repo)).into_response(),
        None => json_error(StatusCode::NOT_FOUND, "Repo not found").into_response(),
    }
}

pub(super) async fn use_repository(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = require_json_content_type(&headers) {
        return response;
    }
    let Some(repo) = state.repository_for_uri(uri.path()) else {
        return json_error(StatusCode::NOT_FOUND, "Repo not found").into_response();
    };
    match state.repositories.touch(&repo.id) {
        Ok(Some(repo)) => Json(describe_repository(&repo)).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "Repo not found").into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
    }
}

pub(super) async fn list_bookmarks(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> Response {
    match state.repository_for_uri(uri.path()) {
        Some(repo) => Json(serde_json::json!({"bookmarks":repo.bookmarks})).into_response(),
        None => json_error(StatusCode::NOT_FOUND, "Repo not found").into_response(),
    }
}

pub(super) async fn set_bookmark(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Json(request): Json<SetBookmarkRequest>,
) -> Response {
    if let Err(response) = require_json_content_type(&headers) {
        return response;
    }
    let Some(repo) = state.repository_for_uri(uri.path()) else {
        return json_error(StatusCode::NOT_FOUND, "Repo not found").into_response();
    };
    if request.bookmarked {
        match checked_library_path(&repo.root, &request.path, &state.data_directory) {
            Ok(path) if path.is_file() => {}
            Ok(_) => {
                return json_error(StatusCode::BAD_REQUEST, "Only files can be bookmarked.")
                    .into_response();
            }
            Err((status, error)) => return json_error(status, error).into_response(),
        }
    }
    match state.repositories.set_position_bookmark(
        &repo.id,
        &request.path,
        request.bookmarked,
        request.line,
        request.page,
    ) {
        Ok(bookmarks) => Json(serde_json::json!({"bookmarks":bookmarks})).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error).into_response(),
    }
}

pub(super) async fn get_recent_files(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> Response {
    let Some(repo) = state.repository_for_uri(uri.path()) else {
        return json_error(StatusCode::NOT_FOUND, "Repo not found").into_response();
    };
    match state.file_history.recent(&repo.id) {
        Ok(value) => Json(value).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error).into_response(),
    }
}

pub(super) async fn add_recent_file(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Json(request): Json<RecentFileRequest>,
) -> Response {
    if let Err(response) = require_json_content_type(&headers) {
        return response;
    }
    let Some(repo) = state.repository_for_uri(uri.path()) else {
        return json_error(StatusCode::NOT_FOUND, "Repo not found").into_response();
    };
    match checked_library_path(&repo.root, &request.path, &state.data_directory) {
        Ok(path) if path.is_file() => {}
        Ok(_) => {
            return json_error(StatusCode::BAD_REQUEST, "Only files can be recorded.")
                .into_response();
        }
        Err((status, error)) => return json_error(status, error).into_response(),
    }
    match state.file_history.visit(&repo.id, &request.path) {
        Ok(()) => get_recent_files(State(state), OriginalUri(uri)).await,
        Err(error) => json_error(StatusCode::BAD_REQUEST, error).into_response(),
    }
}

pub(super) async fn clear_recent_files(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = require_json_content_type(&headers) {
        return response;
    }
    let Some(repo) = state.repository_for_uri(uri.path()) else {
        return json_error(StatusCode::NOT_FOUND, "Repo not found").into_response();
    };
    match state.file_history.clear_recent(&repo.id) {
        Ok(value) => Json(value).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error).into_response(),
    }
}

pub(super) async fn add_repository(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<AddRepositoryRequest>,
) -> Response {
    if let Err(response) = require_json_content_type(&headers) {
        return response;
    }
    match state
        .repositories
        .add(&request.root, request.name.as_deref())
    {
        Ok(repo) => (StatusCode::CREATED, Json(describe_repository(&repo))).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error).into_response(),
    }
}
