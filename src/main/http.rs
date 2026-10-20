use super::*;

#[path = "http/events.rs"]
mod events;
#[path = "http/fallback_routes.rs"]
mod fallback_routes;
#[path = "http/files.rs"]
mod files;
#[path = "http/library.rs"]
mod library;
#[path = "http/render.rs"]
mod render;
#[path = "http/repositories.rs"]
mod repositories;

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct TreeQuery {
    show_hidden: bool,
    path: String,
}

pub(super) fn build_router(state: AppState) -> Router {
    let repository_api = Router::new()
        .route("/tree", get(repositories::get_tree))
        .route("/", get(repositories::repository_metadata))
        .route("/use", axum::routing::post(repositories::use_repository))
        .route(
            "/bookmarks",
            get(repositories::list_bookmarks).put(repositories::set_bookmark),
        )
        .route(
            "/recent-files",
            get(repositories::get_recent_files)
                .post(repositories::add_recent_file)
                .delete(repositories::clear_recent_files),
        )
        .route(
            "/library/session-leases",
            axum::routing::post(library::session_leases),
        )
        .route(
            "/open-directory",
            axum::routing::post(library::open_directory),
        )
        .route("/git/status", get(files::git_status))
        .route("/git/diff", get(files::git_diff))
        .route("/search", get(files::search))
        .route("/document", get(documents::document))
        .route("/document/info", get(documents::information))
        .route("/library/events", get(events::library_events))
        .route("/library/tree-events", get(events::tree_events))
        .route("/html", get(html::html_document))
        .route("/html-resource/{token}/{*path}", get(html::html_resource))
        .route("/asset", get(files::asset))
        .route("/media/thumbnail", get(media::http::thumbnail))
        .route("/media/preview", get(media::http::preview))
        .route("/media/metadata", get(media::http::metadata))
        .route("/media/open", axum::routing::post(media::http::open))
        .route(
            "/media/dimensions",
            axum::routing::post(media::http::dimensions),
        )
        .route("/media", get(media::http::file))
        .route("/pdf/page", get(render::pdf_page))
        .route("/typst/page", get(render::typst_page))
        .with_state(state.clone());
    let global_api = Router::new()
        .route("/directories", get(repositories::directories))
        .route(
            "/repos",
            get(repositories::list_repositories).post(repositories::add_repository),
        )
        .route("/library/session", get(library::library_session))
        .route(
            "/library/activity",
            axum::routing::post(library::library_activity),
        )
        .route("/library/open", axum::routing::post(library::library_open))
        .with_state(state.clone());
    Router::new()
        .route("/", get(fallback_routes::index))
        .route(
            "/{repoId}/tree",
            get(fallback_routes::repository_tree_redirect),
        )
        .nest("/api", global_api)
        .nest("/{repoId}/api", repository_api)
        .nest_service(
            "/assets",
            ServeDir::new(state.dist.parent().unwrap_or(&state.dist).join("assets")),
        )
        .fallback(fallback_routes::fallback)
        .with_state(state.clone())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            fallback_routes::validate_repository_route,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            validate_access,
        ))
        .layer(axum::middleware::from_fn(fallback_routes::security_headers))
        .layer(TraceLayer::new_for_http())
}
