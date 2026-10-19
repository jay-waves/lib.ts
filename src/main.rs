use axum::{
    Json, Router,
    body::Body,
    extract::{OriginalUri, Path as AxumPath, Query, Request, State},
    http::{HeaderMap, StatusCode, Uri},
    response::sse::{Event, KeepAlive, Sse},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{Stream, StreamExt, stream};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    convert::Infallible,
    io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, LazyLock, Mutex},
    time::Instant,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tower_http::{services::ServeDir, trace::TraceLayer};

/// Format paths for APIs and external programs that may not accept Windows' verbatim prefix.
/// Keep canonical paths in their original form for filesystem access and security checks.
fn client_path(path: &Path) -> String {
    dunce::simplified(path).to_string_lossy().into_owned()
}

static LEASE_CLIENT_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"^[A-Za-z0-9-]{1,64}$").expect("valid lease client pattern")
});
static SESSION_CLIENT_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[\w-]{16,80}$").expect("valid session client pattern"));

fn stream_file(
    file: tokio::fs::File,
) -> impl Stream<Item = Result<bytes::Bytes, io::Error>> + Send + 'static {
    stream::try_unfold(
        (file, vec![0; 64 * 1024]),
        |(mut file, mut buffer)| async move {
            let read = file.read(&mut buffer).await?;
            if read == 0 {
                Ok(None)
            } else {
                Ok(Some((
                    bytes::Bytes::copy_from_slice(&buffer[..read]),
                    (file, buffer),
                )))
            }
        },
    )
}

#[path = "main/runtime.rs"]
mod runtime;
use runtime::{ClientStateError, LeaseUpdateError, LibraryEventHub, RuntimeState};
mod platform;
use platform::{
    browse_directories, browse_machine_root, machine_root_path, server_hostname, system_open,
};

mod access;
mod documents;
mod file_history;
mod file_kind;
mod git;
mod html;
mod markdown;
mod media;
mod pdf;
mod render;
mod repositories;
mod resources;
mod search;
mod symbols;
mod tree;
mod typst;
mod worker;

#[derive(Clone)]
struct AppState {
    root: Arc<PathBuf>,
    service_root: Arc<PathBuf>,
    dist: Arc<PathBuf>,
    document_workers: worker::WorkerPool,
    media_workers: worker::WorkerPool,
    media_metadata_workers: worker::WorkerPool,
    media_metadata: Arc<media::MetadataService>,
    media_previews: Arc<media::PreviewFlights>,
    rendering: Arc<render::RenderService>,
    shutdown: tokio::sync::watch::Sender<bool>,
    html: html::Service,
    search: Arc<search::SearchService>,
    data_directory: Arc<PathBuf>,
    access: Arc<access::AccessPolicy>,
    trees: tree::Service,
    repositories: Arc<repositories::RepositoryStore>,
    file_history: Arc<file_history::FileHistory>,
    runtime: Arc<RuntimeState>,
    base_url: Arc<String>,
}

impl AppState {
    fn refresh_document_leases(&self) {
        self.rendering
            .set_active_paths(self.runtime.active_lease_paths(Instant::now()));
    }

    fn default_repository(&self) -> Option<repositories::Repository> {
        let repos = self.repositories.list().ok()?;
        if let Some(repo) = repos.iter().find(|repo| repo.root == *self.root) {
            return Some(repo.clone());
        }
        repos.into_iter().next()
    }

    fn repository_for_uri(&self, path: &str) -> Option<repositories::Repository> {
        let parts = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
        if parts.len() >= 2 && parts[1] == "api" {
            return decode_url_segment(parts[0])
                .and_then(|value| self.repositories.find(&value).ok().flatten());
        }
        self.default_repository()
    }

    fn root_for_uri(&self, path: &str) -> Arc<PathBuf> {
        self.repository_for_uri(path)
            .map(|repo| Arc::new(repo.root))
            .unwrap_or_else(|| self.root.clone())
    }
}

#[derive(Clone)]
struct LibraryClient {
    repo: String,
    last_activity: Instant,
    sender: mpsc::Sender<LibraryOpenEvent>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryOpenEvent {
    repo: String,
    path: String,
    line: Option<u64>,
    view: String,
    url: String,
}

struct LibraryClientGuard {
    hub: Arc<LibraryEventHub>,
    id: String,
    sender: mpsc::Sender<LibraryOpenEvent>,
}

impl Drop for LibraryClientGuard {
    fn drop(&mut self) {
        self.hub.unregister(&self.id, &self.sender);
    }
}

pub(crate) struct DocumentLease {
    pub(crate) version: Option<u64>,
    pub(crate) expires_at: Instant,
    pub(crate) paths: Vec<PathBuf>,
}

#[derive(Serialize)]
struct ApiError {
    error: String,
}

#[derive(Deserialize)]
struct PathQuery {
    path: String,
    view: Option<String>,
    theme: Option<String>,
}

#[derive(Deserialize)]
struct TypstPageQuery {
    id: String,
    page: usize,
    format: Option<String>,
}

#[derive(Deserialize)]
struct PdfPageQuery {
    path: String,
    page: usize,
    v: Option<String>,
    width: Option<f64>,
}

fn encode_query_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn encode_path(value: &str) -> String {
    value
        .split('/')
        .map(encode_query_component)
        .collect::<Vec<_>>()
        .join("/")
}

fn decode_url_segment(value: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(value.len());
    let input = value.as_bytes();
    let mut index = 0;
    while index < input.len() {
        if input[index] == b'%' {
            let hex = std::str::from_utf8(input.get(index + 1..index + 3)?).ok()?;
            bytes.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            bytes.push(input[index]);
            index += 1;
        }
    }
    String::from_utf8(bytes).ok()
}

async fn media_type(path: &Path, file: &mut tokio::fs::File) -> io::Result<String> {
    let mut prefix = Vec::with_capacity(file_kind::HEADER_BYTES);
    (&mut *file)
        .take(file_kind::HEADER_BYTES as u64)
        .read_to_end(&mut prefix)
        .await?;
    file.rewind().await?;
    let detected = file_kind::detect(path, &prefix);
    // Browsers may otherwise decode UTF-8 source files using a legacy encoding.
    Ok(if !detected.binary && detected.mime.starts_with("text/") {
        format!("{}; charset=utf-8", detected.mime)
    } else {
        detected.mime.to_owned()
    })
}

#[derive(Deserialize)]
struct GitDiffQuery {
    path: String,
    scope: Option<String>,
}

struct LibraryEventsQuery {
    path: String,
    asset: Vec<String>,
}

fn library_events_query(uri: &Uri) -> Result<LibraryEventsQuery, String> {
    // Decode pairs rather than a struct: serde_urlencoded rejects repeated
    // struct fields, while the browser sends one asset= parameter per resource.
    let Query(pairs) =
        Query::<Vec<(String, String)>>::try_from_uri(uri).map_err(|error| error.to_string())?;
    let mut path = None;
    let mut asset = Vec::new();
    for (key, value) in pairs {
        match key.as_str() {
            "path" if path.is_none() => path = Some(value),
            "path" => return Err("Duplicate document path".into()),
            "asset" => asset.push(value),
            _ => {}
        }
    }
    Ok(LibraryEventsQuery {
        path: path.ok_or("Missing document path")?,
        asset,
    })
}

#[derive(Deserialize)]
struct DirectoryQuery {
    path: Option<String>,
    #[serde(default)]
    root: bool,
}

#[derive(Deserialize)]
struct LeaseRequest {
    client: String,
    paths: Vec<String>,
    version: Option<u64>,
}

#[derive(Deserialize)]
struct LibrarySessionQuery {
    client: String,
    repo: String,
}

#[derive(Deserialize)]
struct ClientRequest {
    client: String,
}

#[derive(Deserialize)]
struct LibraryOpenRequest {
    file: Option<String>,
    repo: Option<String>,
    path: Option<String>,
    line: Option<u64>,
    view: Option<String>,
}

#[derive(Deserialize)]
struct OpenDirectoryRequest {
    path: Option<String>,
}

#[derive(Deserialize)]
struct AddRepositoryRequest {
    root: String,
    name: Option<String>,
}

#[derive(Deserialize)]
struct SetBookmarkRequest {
    path: String,
    bookmarked: bool,
    line: Option<u32>,
    page: Option<repositories::BookmarkPage>,
}

#[derive(Deserialize)]
struct RecentFileRequest {
    path: String,
}

fn file_signature(path: &Path) -> Option<(u128, u64)> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((modified, metadata.len()))
}

fn modified_rfc3339(path: &Path) -> String {
    file_signature(path)
        .and_then(|(nanos, _)| time::OffsetDateTime::from_unix_timestamp_nanos(nanos as i128).ok())
        .and_then(|date| {
            date.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_default()
}

fn pdf_error_status(error: &pdf::PdfError) -> StatusCode {
    match error {
        pdf::PdfError::PageNotFound => StatusCode::NOT_FOUND,
        pdf::PdfError::Changed => StatusCode::GONE,
        pdf::PdfError::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        pdf::PdfError::Busy => StatusCode::SERVICE_UNAVAILABLE,
        pdf::PdfError::Cancelled => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::BAD_REQUEST,
    }
}

fn worker_error(error: worker::WorkerError) -> Response {
    let busy = matches!(error, worker::WorkerError::Busy);
    let status = if busy {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    let mut response = json_error(status, error.to_string()).into_response();
    if busy {
        response
            .headers_mut()
            .insert("retry-after", "1".parse().unwrap());
    }
    response
}

fn json_error(status: StatusCode, message: impl Into<String>) -> impl IntoResponse {
    (
        status,
        Json(ApiError {
            error: message.into(),
        }),
    )
}

fn require_json_content_type(headers: &HeaderMap) -> Result<(), Response> {
    let is_json = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"));
    if is_json {
        Ok(())
    } else {
        Err(json_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        )
        .into_response())
    }
}

async fn validate_access(
    State(state): State<AppState>,
    request: Request,
    next: axum::middleware::Next,
) -> Response {
    if let Err(message) = state.access.check(request.headers(), request.method()) {
        return json_error(StatusCode::FORBIDDEN, message).into_response();
    }
    next.run(request).await
}

fn checked_path(root: &Path, value: &str) -> Result<PathBuf, (StatusCode, String)> {
    if value.is_empty() || value.contains('\0') {
        return Err((StatusCode::BAD_REQUEST, "Invalid path".into()));
    }
    let requested = root.join(value);
    let mut candidate = PathBuf::new();
    for component in requested.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                candidate.pop();
            }
            other => candidate.push(other.as_os_str()),
        }
    }
    if !candidate.starts_with(root) {
        return Err((
            StatusCode::BAD_REQUEST,
            "File is outside the repository root".into(),
        ));
    }
    let canonical = candidate.canonicalize().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            (StatusCode::NOT_FOUND, "Not found".into())
        } else {
            (StatusCode::BAD_REQUEST, error.to_string())
        }
    })?;
    if !canonical.starts_with(root) {
        return Err((
            StatusCode::BAD_REQUEST,
            "File is outside the repository root".into(),
        ));
    }
    Ok(canonical)
}

fn checked_library_path(
    root: &Path,
    value: &str,
    private: &Path,
) -> Result<PathBuf, (StatusCode, String)> {
    let path = checked_path(root, value)?;
    if path.starts_with(private) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Application data is private".into(),
        ));
    }
    Ok(path)
}

#[path = "main/http.rs"]
mod http;
use http::build_router;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(4)
        .enable_all()
        .build()?;
    runtime.block_on(run())
}

async fn wait_for_shutdown(mut receiver: tokio::sync::watch::Receiver<bool>) {
    if !*receiver.borrow_and_update() {
        let _ = receiver.changed().await;
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .compact()
        .with_target(false)
        .with_env_filter(filter)
        .try_init();
    let root_arg = std::env::args_os().nth(1).map(PathBuf::from);
    let initial_root = root_arg.as_deref().map(Path::canonicalize).transpose()?;
    let here = std::env::current_dir()?.canonicalize()?;
    let executable_directory = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    let app_directory = executable_directory
        .filter(|directory| directory.join("dist/web/index.html").is_file())
        .unwrap_or_else(|| here.clone());
    let dist = app_directory.join("dist");
    let web_dist = dist.join("web");
    let data_directory = std::env::var_os("LIBRARY_DATA_DIRECTORY")
        .map(PathBuf::from)
        .unwrap_or_else(|| app_directory.join("data"));
    let data_directory = if data_directory.is_absolute() {
        data_directory
    } else {
        app_directory.join(data_directory)
    };
    tree_sitter_language_pack::configure(&tree_sitter_language_pack::PackConfig {
        cache_dir: Some(data_directory.join("grammars")),
        ..Default::default()
    })?;
    let repositories = Arc::new(
        repositories::RepositoryStore::open(&data_directory, initial_root.as_deref())
            .map_err(std::io::Error::other)?,
    );
    let service_root = initial_root.clone().unwrap_or_else(|| here.clone());
    let root = initial_root
        .or_else(|| {
            repositories
                .list()
                .ok()
                .and_then(|repos| repos.first().map(|repo| repo.root.clone()))
        })
        .unwrap_or_else(|| service_root.clone());
    let port = std::env::var("NODE_PREVIEW_PORT")
        .or_else(|_| std::env::var("PREVIEW_PORT"))
        .unwrap_or_else(|_| "49191".into())
        .parse::<u16>()?;
    if port == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "NODE_PREVIEW_PORT must be an integer from 1 to 65535",
        )
        .into());
    }
    let bind_address = std::env::var("PREVIEW_BIND_ADDRESS")
        .unwrap_or_else(|_| "127.0.0.1".into())
        .parse::<std::net::IpAddr>()?;
    let base_url = Arc::new(
        std::env::var("PREVIEW_PUBLIC_URL")
            .unwrap_or_else(|_| format!("http://127.0.0.1:{port}"))
            .trim_end_matches('/')
            .to_owned(),
    );
    let media_parallelism = std::thread::available_parallelism().map_or(2, usize::from);
    let state = AppState {
        document_workers: worker::WorkerPool::new("document", 1, 16),
        media_workers: worker::WorkerPool::new("media", media_parallelism.clamp(2, 4), 256),
        media_metadata_workers: worker::WorkerPool::new(
            "media-metadata",
            media_parallelism.clamp(2, 8),
            256,
        ),
        media_metadata: Arc::new(media::MetadataService::default()),
        media_previews: Arc::new(media::PreviewFlights::default()),
        rendering: Arc::new(render::RenderService::default()),
        shutdown: tokio::sync::watch::channel(false).0,
        root: Arc::new(root),
        service_root: Arc::new(service_root),
        dist: Arc::new(web_dist),
        html: html::Service::new()?,
        search: Arc::new(search::SearchService::default()),
        data_directory: Arc::new(data_directory.clone()),
        access: Arc::new(
            access::AccessPolicy::load(&data_directory, server_hostname(), &base_url)
                .map_err(std::io::Error::other)?,
        ),
        trees: tree::Service::default(),
        repositories,
        file_history: Arc::new(file_history::FileHistory::new(data_directory.clone())),
        runtime: Arc::new(RuntimeState::default()),
        base_url,
    };
    let media_cache_maintenance = tokio::spawn(media::cache::maintain(data_directory.clone()));
    let lease_state = state.clone();
    let maintenance = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
        let mut idle_sweep = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            tokio::select! {
                _ = interval.tick() => lease_state.refresh_document_leases(),
                _ = idle_sweep.tick() => {
                    let sweep = lease_state.clone();
                    // Font/layout and comemo reclamation can be expensive.
                    // Keep it off the HTTP runtime threads too.
                    let _ = lease_state.document_workers.run(move || sweep.rendering.sweep()).await;
                },
            }
        }
    });
    let app = build_router(state.clone());
    let listener = TcpListener::bind(std::net::SocketAddr::new(bind_address, port)).await?;
    let base_url = state.base_url.as_str();
    tracing::info!(root = %state.root.display(), bind_address = %listener.local_addr()?, public_url = %base_url, "Rust backend listening");
    let default_repo = state.repository_for_uri("/");
    let library_url = default_repo
        .as_ref()
        .map(|repo| format!("{base_url}/{}/tree/", encode_query_component(&repo.slug)))
        .unwrap_or_else(|| format!("{base_url}/"));
    println!(
        "{}",
        serde_json::json!({"event":"ready","baseUrl":base_url,"root":client_path(&state.service_root),"repoId":default_repo.map(|repo|repo.id),"libraryUrl":library_url,"dataDirectory":client_path(&state.data_directory),"urls":{"library":library_url}})
    );
    let shutdown = state.shutdown.clone();
    let served = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            shutdown.send_replace(true);
        })
        .await;
    maintenance.abort();
    media_cache_maintenance.abort();
    let _ = maintenance.await;
    state.document_workers.shutdown().await;
    state.media_workers.shutdown().await;
    state.media_metadata_workers.shutdown().await;
    state.rendering.close().await;
    served?;
    Ok(())
}

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;
