use super::*;

pub(super) async fn frontend_page(state: &AppState) -> Response {
    let file = state.dist.join("index.html");
    match tokio::fs::read(file).await {
        Ok(bytes) => (
            [
                (axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (axum::http::header::CACHE_CONTROL, "no-store"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Build the frontend first: npm run build",
        )
        .into_response(),
    }
}

pub(super) async fn index(State(state): State<AppState>) -> Response {
    let _ = state.repositories.prune_missing();
    if let Some(repo) = state.default_repository() {
        return axum::response::Redirect::permanent(&format!(
            "/{}/tree/",
            encode_query_component(&repo.slug)
        ))
        .into_response();
    }
    frontend_page(&state).await
}

pub(super) async fn repository_tree_redirect(
    State(state): State<AppState>,
    AxumPath(repo_id): AxumPath<String>,
    uri: Uri,
) -> Response {
    let Some(repo) = state.repositories.find(&repo_id).ok().flatten() else {
        return json_error(StatusCode::NOT_FOUND, "Repo not found").into_response();
    };
    let query = uri
        .query()
        .map(|value| format!("?{value}"))
        .unwrap_or_default();
    axum::response::Redirect::permanent(&format!(
        "/{}/tree/{query}",
        encode_query_component(&repo.slug)
    ))
    .into_response()
}

pub(super) async fn fallback(State(state): State<AppState>, uri: Uri) -> impl IntoResponse {
    if uri.path().starts_with("/api/") || uri.path().split('/').nth(2) == Some("api") {
        return json_error(StatusCode::NOT_FOUND, "Not found").into_response();
    }
    let parts = uri
        .path()
        .trim_start_matches('/')
        .split('/')
        .collect::<Vec<_>>();
    if parts.len() >= 2 && matches!(parts[1], "tree" | "search" | "git") {
        return frontend_page(&state).await;
    }
    (StatusCode::NOT_FOUND, "Not found").into_response()
}

pub(super) async fn validate_repository_route(
    State(state): State<AppState>,
    request: Request,
    next: axum::middleware::Next,
) -> Response {
    let parts = request
        .uri()
        .path()
        .trim_start_matches('/')
        .split('/')
        .collect::<Vec<_>>();
    // Global API paths can contain page names such as /api/tree; the global
    // router owns their existence, rather than repository page validation.
    if parts.first() == Some(&"api") {
        return next.run(request).await;
    }
    let page_route = parts.len() >= 2 && matches!(parts[1], "tree" | "search" | "git");
    if parts.len() >= 2 && (parts[1] == "api" || page_route) {
        let repo = decode_url_segment(parts[0])
            .and_then(|value| state.repositories.find(&value).ok().flatten());
        if repo
            .as_ref()
            .is_none_or(|repo| !state.repositories.root_available(&repo.id))
        {
            let _ = state.repositories.prune_missing();
            return json_error(StatusCode::NOT_FOUND, "Repo not found").into_response();
        }
        if page_route && !(parts[1] == "tree" && parts.len() == 2) {
            if let Some(repo) = repo {
                let canonical = encode_query_component(&repo.slug);
                if parts[0] != canonical {
                    let suffix = request
                        .uri()
                        .path()
                        .strip_prefix(&format!("/{}", parts[0]))
                        .unwrap_or("");
                    let query = request
                        .uri()
                        .query()
                        .map(|value| format!("?{value}"))
                        .unwrap_or_default();
                    return axum::response::Redirect::permanent(&format!(
                        "/{canonical}{suffix}{query}"
                    ))
                    .into_response();
                }
            }
        }
    }
    next.run(request).await
}

pub(super) async fn security_headers(request: Request, next: axum::middleware::Next) -> Response {
    let is_api = request.uri().path().starts_with("/api/")
        || request.uri().path().split('/').nth(2) == Some("api");
    let mut response = next.run(request).await;
    if is_api
        && !response
            .headers()
            .contains_key(axum::http::header::CACHE_CONTROL)
    {
        response.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("no-store"),
        );
    }
    if !response.headers().contains_key("x-content-type-options") {
        response.headers_mut().insert(
            "x-content-type-options",
            axum::http::HeaderValue::from_static("nosniff"),
        );
    }
    if !response.headers().contains_key("referrer-policy") {
        response.headers_mut().insert(
            "referrer-policy",
            axum::http::HeaderValue::from_static("no-referrer"),
        );
    }
    response
}
