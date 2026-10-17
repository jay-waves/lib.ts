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

mod access;
mod documents;
mod file_kind;
mod git;
mod html;
mod markdown;
mod pdf;
mod reading;
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
    rendering: Arc<render::RenderService>,
    shutdown: tokio::sync::watch::Sender<bool>,
    html: html::Service,
    search: Arc<search::SearchService>,
    data_directory: Arc<PathBuf>,
    access: Arc<access::AccessPolicy>,
    trees: tree::Service,
    repositories: Arc<repositories::RepositoryStore>,
    reading: Arc<reading::ReadingStore>,
    runtime: Arc<RuntimeState>,
    base_url: Arc<String>,
}

/// Mutable coordination state shared by concurrent HTTP requests.
/// Long-lived services and configuration stay on `AppState`.
#[derive(Default)]
struct RuntimeState {
    leases: Mutex<HashMap<String, DocumentLease>>,
    library_events: Arc<LibraryEventHub>,
    file_watchers: Mutex<HashMap<FileWatchKey, tokio::sync::broadcast::Sender<FileWatchEvent>>>,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct FileWatchKey {
    document: PathBuf,
    assets: Vec<(PathBuf, String)>,
}

#[derive(Clone)]
struct FileWatchEvent {
    document_changed: bool,
    assets: Vec<String>,
}

#[derive(Clone, PartialEq, Eq)]
struct AssetSignature {
    requested: String,
    signature: Option<(u128, u64)>,
}

#[derive(Clone, PartialEq, Eq)]
struct FileWatchSnapshot {
    document: Option<(u128, u64)>,
    assets: Vec<AssetSignature>,
}

impl FileWatchSnapshot {
    fn capture(document: &Path, assets: &[(PathBuf, String)]) -> Self {
        Self {
            document: file_signature(document),
            assets: assets
                .iter()
                .map(|(path, requested)| AssetSignature {
                    requested: requested.clone(),
                    signature: file_signature(path),
                })
                .collect(),
        }
    }

    fn changes_since(&self, previous: &Self) -> Option<FileWatchEvent> {
        let document_changed = self.document != previous.document;
        let changed_assets = self
            .assets
            .iter()
            .zip(&previous.assets)
            .filter_map(|(current, previous)| {
                (current.signature != previous.signature).then(|| current.requested.clone())
            })
            .collect::<Vec<_>>();
        (document_changed || !changed_assets.is_empty()).then_some(FileWatchEvent {
            document_changed,
            assets: changed_assets,
        })
    }
}

#[derive(Debug)]
enum LeaseUpdateError {
    Busy,
    Poisoned,
}

#[derive(Debug)]
enum ClientStateError {
    Poisoned,
}

/// Owns active library sessions and routes document-open notifications.
#[derive(Default)]
struct LibraryEventHub {
    clients: Mutex<HashMap<String, LibraryClient>>,
}

impl RuntimeState {
    fn active_lease_paths(&self, now: Instant) -> HashSet<PathBuf> {
        let Ok(mut leases) = self.leases.lock() else {
            return HashSet::new();
        };
        leases.retain(|_, lease| lease.expires_at > now);
        leases
            .values()
            .flat_map(|lease| lease.paths.iter().cloned())
            .collect()
    }

    fn subscribe_file_events(
        self: &Arc<Self>,
        document: PathBuf,
        assets: Vec<(PathBuf, String)>,
    ) -> tokio::sync::broadcast::Receiver<FileWatchEvent> {
        let key = FileWatchKey {
            document: document.clone(),
            assets: assets.clone(),
        };
        let mut watchers = self
            .file_watchers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(sender) = watchers.get(&key) {
            return sender.subscribe();
        }
        let (sender, _) = tokio::sync::broadcast::channel(16);
        let receiver = sender.subscribe();
        watchers.insert(key.clone(), sender.clone());
        let runtime = self.clone();
        // Establish the baseline before returning the subscription. Changes
        // after the connected event must not become the task's initial state.
        let mut previous = FileWatchSnapshot::capture(&document, &assets);
        tokio::spawn(async move {
            let mut timer = tokio::time::interval(std::time::Duration::from_millis(500));
            loop {
                timer.tick().await;
                if sender.receiver_count() == 0 {
                    let mut watchers = runtime
                        .file_watchers
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    if watchers
                        .get(&key)
                        .is_some_and(|current| current.same_channel(&sender))
                    {
                        watchers.remove(&key);
                    }
                    break;
                }
                let current = FileWatchSnapshot::capture(&document, &assets);
                if let Some(event) = current.changes_since(&previous) {
                    let _ = sender.send(event);
                }
                previous = current;
            }
        });
        receiver
    }

    fn update_lease(
        &self,
        client: &str,
        version: Option<u64>,
        paths: Vec<PathBuf>,
    ) -> Result<(), LeaseUpdateError> {
        const MAX_CLIENTS: usize = 128;
        const LEASE_DURATION: std::time::Duration = std::time::Duration::from_secs(90);

        let now = Instant::now();
        let mut leases = self.leases.lock().map_err(|_| LeaseUpdateError::Poisoned)?;
        leases.retain(|_, lease| lease.expires_at > now);
        if leases.len() >= MAX_CLIENTS && !leases.contains_key(client) {
            return Err(LeaseUpdateError::Busy);
        }
        let stale = version
            .zip(leases.get(client).and_then(|lease| lease.version))
            .is_some_and(|(incoming, current)| incoming <= current);
        if stale {
            return Ok(());
        }
        if paths.is_empty() && version.is_none() {
            leases.remove(client);
        } else {
            leases.insert(
                client.to_owned(),
                DocumentLease {
                    version,
                    expires_at: now + LEASE_DURATION,
                    paths,
                },
            );
        }
        Ok(())
    }
}

impl LibraryEventHub {
    fn subscribe(
        self: &Arc<Self>,
        id: String,
        repo: String,
    ) -> Result<(mpsc::Receiver<LibraryOpenEvent>, LibraryClientGuard), ClientStateError> {
        let (sender, receiver) = mpsc::channel(16);
        self.clients
            .lock()
            .map_err(|_| ClientStateError::Poisoned)?
            .insert(
                id.clone(),
                LibraryClient {
                    repo,
                    last_activity: Instant::now(),
                    sender: sender.clone(),
                },
            );
        let guard = LibraryClientGuard {
            hub: self.clone(),
            id,
            sender,
        };
        Ok((receiver, guard))
    }

    fn dispatch_open(
        &self,
        event: &LibraryOpenEvent,
        repo_id: &str,
        repo_slug: &str,
    ) -> Result<bool, ClientStateError> {
        let mut clients = self
            .clients
            .lock()
            .map_err(|_| ClientStateError::Poisoned)?;
        let mut candidates = clients
            .iter()
            .map(|(id, client)| {
                (
                    id.clone(),
                    client.sender.clone(),
                    client.repo == repo_slug || client.repo == repo_id,
                    client.last_activity,
                )
            })
            .collect::<Vec<_>>();
        candidates.sort_by_key(|(_, _, same_repo, last_activity)| {
            (!same_repo, std::cmp::Reverse(*last_activity))
        });

        for (id, sender, _, _) in candidates {
            match sender.try_send(event.clone()) {
                Ok(()) => return Ok(true),
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    clients.remove(&id);
                }
                Err(mpsc::error::TrySendError::Full(_)) => {}
            }
        }
        Ok(false)
    }

    fn unregister(&self, id: &str, sender: &mpsc::Sender<LibraryOpenEvent>) {
        if let Ok(mut clients) = self.clients.lock()
            && clients
                .get(id)
                .is_some_and(|client| client.sender.same_channel(sender))
        {
            clients.remove(id);
        }
    }

    fn record_library_activity(&self, client_id: &str, now: Instant) -> bool {
        let Ok(mut clients) = self.clients.lock() else {
            return false;
        };
        let Some(client) = clients.get_mut(client_id) else {
            return false;
        };
        client.last_activity = now;
        true
    }
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

struct DocumentLease {
    version: Option<u64>,
    expires_at: Instant,
    paths: Vec<PathBuf>,
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

async fn media_type(path: &Path, file: &mut tokio::fs::File) -> io::Result<&'static str> {
    let mut prefix = Vec::with_capacity(file_kind::HEADER_BYTES);
    (&mut *file)
        .take(file_kind::HEADER_BYTES as u64)
        .read_to_end(&mut prefix)
        .await?;
    file.rewind().await?;
    Ok(file_kind::detect(path, &prefix).mime)
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
}

#[derive(Deserialize)]
struct ReadingPositionsRequest {
    positions: serde_json::Value,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryListing {
    path: String,
    name: String,
    parent: Option<String>,
    directories: Vec<DirectoryEntry>,
    hostname: String,
    root_path: String,
}

#[derive(Serialize)]
struct DirectoryEntry {
    name: String,
    path: String,
}

fn server_hostname() -> &'static str {
    static HOSTNAME: LazyLock<String> = LazyLock::new(|| {
        let name = std::env::var(if cfg!(windows) {
            "COMPUTERNAME"
        } else {
            "HOSTNAME"
        })
        .ok()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| std::fs::read_to_string("/proc/sys/kernel/hostname").ok())
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        })
        .unwrap_or_else(|| "Computer".into());
        name.trim().to_owned()
    });
    &HOSTNAME
}

fn machine_root_path() -> &'static str {
    if cfg!(windows) { "" } else { "/" }
}

fn browse_machine_root(data_directory: &Path) -> Result<DirectoryListing, (StatusCode, String)> {
    #[cfg(windows)]
    {
        let directories = (b'A'..=b'Z')
            .filter_map(|drive| {
                let path = PathBuf::from(format!("{}:/", drive as char));
                path.exists().then(|| DirectoryEntry {
                    name: format!("{}:", drive as char),
                    path: client_path(&path),
                })
            })
            .collect();
        let _ = data_directory;
        Ok(DirectoryListing {
            path: String::new(),
            name: server_hostname().into(),
            parent: None,
            directories,
            hostname: server_hostname().into(),
            root_path: String::new(),
        })
    }
    #[cfg(not(windows))]
    browse_directories(Some("/"), Path::new("/"), data_directory)
}

fn browse_directories(
    path: Option<&str>,
    initial_root: &Path,
    data_directory: &Path,
) -> Result<DirectoryListing, (StatusCode, String)> {
    let requested = path
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| initial_root.to_path_buf());
    let directory = requested.canonicalize().map_err(|error| {
        let status = if error.kind() == std::io::ErrorKind::NotFound {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::BAD_REQUEST
        };
        (status, error.to_string())
    })?;
    let private_directory = data_directory
        .canonicalize()
        .unwrap_or_else(|_| data_directory.to_path_buf());
    if !directory.is_dir() {
        return Err((StatusCode::BAD_REQUEST, "Not a directory".into()));
    }
    if directory.starts_with(&private_directory) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Application data is private".into(),
        ));
    }
    let mut directories = Vec::new();
    for item in std::fs::read_dir(&directory)
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?
    {
        let item = item.map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        if item
            .file_type()
            .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?
            .is_dir()
        {
            let candidate = item.path();
            if candidate.starts_with(&private_directory) {
                continue;
            }
            directories.push(DirectoryEntry {
                name,
                path: client_path(&candidate),
            });
        }
    }
    directories.sort_by_key(|directory| directory.name.to_lowercase());
    let parent = directory.parent().filter(|parent| *parent != directory);
    Ok(DirectoryListing {
        path: client_path(&directory),
        name: directory
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| directory.as_os_str().to_string_lossy().into_owned()),
        parent: parent.map(client_path),
        directories,
        hostname: server_hostname().into(),
        root_path: machine_root_path().into(),
    })
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

async fn get_tree(State(state): State<AppState>, OriginalUri(uri): OriginalUri) -> Response {
    let root = state.root_for_uri(uri.path());
    let entry = match state
        .trees
        .entry((*root).clone(), (*state.data_directory).clone())
    {
        Ok(entry) => entry,
        Err(error) => return json_error(StatusCode::SERVICE_UNAVAILABLE, error).into_response(),
    };
    match entry.snapshot().await {
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

async fn directories(
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

fn describe_repository(repo: &repositories::Repository) -> RepositoryMetadata {
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

async fn list_repositories(State(state): State<AppState>) -> Response {
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

async fn repository_metadata(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> Response {
    match state.repository_for_uri(uri.path()) {
        Some(repo) => Json(describe_repository(&repo)).into_response(),
        None => json_error(StatusCode::NOT_FOUND, "Repo not found").into_response(),
    }
}

async fn use_repository(
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

async fn list_bookmarks(State(state): State<AppState>, OriginalUri(uri): OriginalUri) -> Response {
    match state.repository_for_uri(uri.path()) {
        Some(repo) => Json(serde_json::json!({"bookmarks":repo.bookmarks})).into_response(),
        None => json_error(StatusCode::NOT_FOUND, "Repo not found").into_response(),
    }
}

async fn set_bookmark(
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
    match state
        .repositories
        .set_bookmark(&repo.id, &request.path, request.bookmarked)
    {
        Ok(bookmarks) => Json(serde_json::json!({"bookmarks":bookmarks})).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error).into_response(),
    }
}

async fn get_reading(State(state): State<AppState>, OriginalUri(uri): OriginalUri) -> Response {
    let Some(repo) = state.repository_for_uri(uri.path()) else {
        return json_error(StatusCode::NOT_FOUND, "Repo not found").into_response();
    };
    match state.reading.read(&repo.id) {
        Ok(value) => Json(value).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error).into_response(),
    }
}

async fn put_reading(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Json(request): Json<ReadingPositionsRequest>,
) -> Response {
    if let Err(response) = require_json_content_type(&headers) {
        return response;
    }
    let Some(repo) = state.repository_for_uri(uri.path()) else {
        return json_error(StatusCode::NOT_FOUND, "Repo not found").into_response();
    };
    match state.reading.save_positions(&repo.id, request.positions) {
        Ok(()) => Json(serde_json::json!({"ok":true})).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error).into_response(),
    }
}

async fn get_recent_files(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> Response {
    let Some(repo) = state.repository_for_uri(uri.path()) else {
        return json_error(StatusCode::NOT_FOUND, "Repo not found").into_response();
    };
    match state.reading.recent(&repo.id) {
        Ok(value) => Json(value).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error).into_response(),
    }
}

async fn add_recent_file(
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
    match state.reading.visit(&repo.id, &request.path) {
        Ok(()) => get_recent_files(State(state), OriginalUri(uri)).await,
        Err(error) => json_error(StatusCode::BAD_REQUEST, error).into_response(),
    }
}

async fn clear_recent_files(
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
    match state.reading.clear_recent(&repo.id) {
        Ok(value) => Json(value).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error).into_response(),
    }
}

async fn add_repository(
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

async fn session_leases(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Json(request): Json<LeaseRequest>,
) -> Response {
    if let Err(response) = require_json_content_type(&headers) {
        return response;
    }
    if !LEASE_CLIENT_RE.is_match(&request.client) || request.paths.len() > 64 {
        return json_error(StatusCode::BAD_REQUEST, "Invalid session lease").into_response();
    }
    let mut paths = Vec::new();
    for value in request.paths {
        match checked_library_path(
            &state.root_for_uri(uri.path()),
            &value,
            &state.data_directory,
        ) {
            Ok(path) => paths.push(path),
            Err((StatusCode::NOT_FOUND, _)) => {}
            Err((_, error)) => return json_error(StatusCode::BAD_REQUEST, error).into_response(),
        }
    }
    match state
        .runtime
        .update_lease(&request.client, request.version, paths)
    {
        Ok(()) => {}
        Err(LeaseUpdateError::Busy) => return worker_error(worker::WorkerError::Busy),
        Err(LeaseUpdateError::Poisoned) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Lease store lock poisoned",
            )
            .into_response();
        }
    }
    state.refresh_document_leases();
    Json(serde_json::json!({"ok":true})).into_response()
}

async fn library_session(
    State(state): State<AppState>,
    Query(query): Query<LibrarySessionQuery>,
) -> Response {
    let repo_exists = if query.repo.is_empty() {
        state.repository_for_uri("/").is_some()
    } else {
        state
            .repositories
            .find(&query.repo)
            .ok()
            .flatten()
            .is_some()
    };
    if !SESSION_CLIENT_RE.is_match(&query.client) || !repo_exists {
        return json_error(StatusCode::BAD_REQUEST, "Invalid library client").into_response();
    }
    let (receiver, guard) = match state
        .runtime
        .library_events
        .subscribe(query.client, query.repo)
    {
        Ok(subscription) => subscription,
        Err(ClientStateError::Poisoned) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Library session store unavailable",
            )
            .into_response();
        }
    };
    let connected = stream::once(async {
        Ok::<Event, Infallible>(Event::default().event("connected").data("{}"))
    });
    let events = stream::unfold(
        (
            receiver,
            tokio::time::interval(std::time::Duration::from_secs(15)),
            guard,
        ),
        |(mut receiver, mut ticker, guard)| async move {
            tokio::select! {
                value = receiver.recv() => match value {
                    Some(value) => {
                        let data = serde_json::to_string(&value)
                            .expect("library event serialization is infallible");
                        Some((Ok::<Event, Infallible>(Event::default().event("document-open").data(data)), (receiver, ticker, guard)))
                    },
                    None => None,
                },
                _ = ticker.tick() => Some((Ok::<Event, Infallible>(Event::default().event("ping").data("{}")), (receiver, ticker, guard))),
            }
        },
    );
    Sse::new(
        connected
            .chain(events)
            .take_until(wait_for_shutdown(state.shutdown.subscribe())),
    )
    .keep_alive(KeepAlive::default())
    .into_response()
}

async fn library_activity(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ClientRequest>,
) -> Response {
    if let Err(response) = require_json_content_type(&headers) {
        return response;
    }
    let active = state
        .runtime
        .library_events
        .record_library_activity(&request.client, Instant::now());
    Json(serde_json::json!({"ok":active})).into_response()
}

async fn library_open(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Json(request): Json<LibraryOpenRequest>,
) -> Response {
    if let Err(response) = require_json_content_type(&headers) {
        return response;
    }
    if request.line.is_some_and(|line| line < 1)
        || request
            .view
            .as_deref()
            .is_some_and(|view| !matches!(view, "preview" | "raw"))
    {
        return json_error(StatusCode::BAD_REQUEST, "Invalid source line or view").into_response();
    }
    let (repo, canonical_file) = match request.file.as_deref() {
        Some(file) => {
            let requested_file = Path::new(file);
            if !requested_file.is_absolute() {
                return json_error(StatusCode::BAD_REQUEST, "file must be an absolute path")
                    .into_response();
            }
            let Ok(canonical_file) = requested_file.canonicalize() else {
                return json_error(StatusCode::NOT_FOUND, "File not found").into_response();
            };
            let mut repos = match state.repositories.list() {
                Ok(repos) => repos,
                Err(error) => {
                    return json_error(StatusCode::INTERNAL_SERVER_ERROR, error).into_response();
                }
            };
            repos.sort_by_key(|repo| std::cmp::Reverse(repo.root.as_os_str().len()));
            let Some(repo) = repos
                .into_iter()
                .find(|repo| canonical_file.starts_with(&repo.root))
            else {
                return json_error(
                    StatusCode::NOT_FOUND,
                    "File does not belong to a registered repository",
                )
                .into_response();
            };
            (repo, Some(canonical_file))
        }
        None => {
            let repo = request
                .repo
                .as_deref()
                .and_then(|value| state.repositories.find(value).ok().flatten())
                .or_else(|| state.repository_for_uri(uri.path()));
            let Some(repo) = repo else {
                return json_error(StatusCode::NOT_FOUND, "Repo not found").into_response();
            };
            (repo, None)
        }
    };
    let root = repo.root.clone();
    let relative = match canonical_file {
        Some(file) => file
            .strip_prefix(&root)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/"),
        None => request.path.unwrap_or_default(),
    };
    let file = match checked_library_path(&root, &relative, &state.data_directory) {
        Ok(file) => file,
        Err((status, error)) => return json_error(status, error).into_response(),
    };
    if !file.is_file() {
        return json_error(StatusCode::BAD_REQUEST, "Not a file").into_response();
    }
    let relative = file
        .strip_prefix(&*root)
        .unwrap_or(&file)
        .to_string_lossy()
        .replace('\\', "/");
    let repo_slug = repo.slug.clone();
    let mut query = Vec::new();
    if let Some(line) = request.line {
        query.push(format!("line={line}"));
    }
    if let Some(view) = request.view.as_deref() {
        query.push(format!("view={view}"));
    }
    let url = format!(
        "/{}/tree/{}{}",
        encode_query_component(&repo_slug),
        encode_path(&relative),
        if query.is_empty() {
            String::new()
        } else {
            format!("?{}", query.join("&"))
        }
    );
    let payload = LibraryOpenEvent {
        repo: repo_slug,
        path: relative,
        line: request.line,
        view: request
            .view
            .or_else(|| request.line.map(|_| "raw".into()))
            .unwrap_or_else(|| "preview".into()),
        url: url.clone(),
    };
    match state
        .runtime
        .library_events
        .dispatch_open(&payload, &repo.id, &repo.slug)
    {
        Ok(true) => return Json(serde_json::json!({"reused":true,"url":url})).into_response(),
        Ok(false) => {}
        Err(ClientStateError::Poisoned) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Library session store unavailable",
            )
            .into_response();
        }
    }
    let browser_url = format!("{}{url}", state.base_url);
    #[cfg(target_os = "windows")]
    let launched = tokio::process::Command::new(
        std::env::var_os("SystemRoot")
            .or_else(|| std::env::var_os("WINDIR"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
            .join("explorer.exe"),
    )
    .arg(&browser_url)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn();
    #[cfg(target_os = "macos")]
    let launched = tokio::process::Command::new("open")
        .arg(&browser_url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let launched = tokio::process::Command::new("xdg-open")
        .arg(&browser_url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match launched {
        Ok(_child) => Json(serde_json::json!({"reused":false,"url":url})).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error":"Could not open browser","reused":false,"url":url})),
        )
            .into_response(),
    }
}

async fn open_directory(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Json(request): Json<OpenDirectoryRequest>,
) -> Response {
    let root = state.root_for_uri(uri.path());
    if let Err(response) = require_json_content_type(&headers) {
        return response;
    }
    let requested = request.path.unwrap_or_default();
    if requested.contains('\0') {
        return json_error(StatusCode::BAD_REQUEST, "Invalid directory path").into_response();
    }
    let candidate = root.join(if requested.is_empty() {
        "."
    } else {
        &requested
    });
    let directory = match candidate.canonicalize() {
        Ok(path) if path.starts_with(&*root) && !path.starts_with(&*state.data_directory) => path,
        Ok(_) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "Directory is outside the repository root",
            )
            .into_response();
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return json_error(StatusCode::NOT_FOUND, "Not found").into_response();
        }
        Err(error) => {
            return json_error(StatusCode::BAD_REQUEST, error.to_string()).into_response();
        }
    };
    if !directory.is_dir() {
        return json_error(StatusCode::BAD_REQUEST, "Not a directory").into_response();
    }
    #[cfg(target_os = "windows")]
    let result = tokio::process::Command::new("explorer.exe")
        .arg(dunce::simplified(&directory))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    #[cfg(target_os = "macos")]
    let result = tokio::process::Command::new("open")
        .arg(&directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = tokio::process::Command::new("xdg-open")
        .arg(&directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match result {
        Ok(_child) => Json(serde_json::json!({"ok":true})).into_response(),
        Err(error) => {
            let status = if error.kind() == std::io::ErrorKind::NotFound {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            };
            json_error(status, error.to_string()).into_response()
        }
    }
}

async fn git_status(
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

async fn git_diff(
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

async fn search(
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

async fn asset(
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

async fn library_events(State(state): State<AppState>, OriginalUri(uri): OriginalUri) -> Response {
    let query = match library_events_query(&uri) {
        Ok(query) => query,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error).into_response(),
    };
    let root = state.root_for_uri(uri.path());
    let private = state.data_directory.clone();
    let document = match checked_library_path(&root, &query.path, &private) {
        Ok(path) => path,
        Err((status, message)) => return json_error(status, message).into_response(),
    };
    let mut assets = Vec::new();
    for value in query.asset.into_iter().take(128) {
        if let Ok(path) = checked_library_path(&root, &value, &private) {
            if !assets.iter().any(|(existing, _)| existing == &path) {
                assets.push((path, value));
            }
        }
    }
    let receiver = state
        .runtime
        .subscribe_file_events(document.clone(), assets);
    let modified = modified_rfc3339(&document);
    let events: std::pin::Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>> =
        Box::pin(stream::unfold(
            (
                Some(receiver),
                true,
                Some(modified),
                VecDeque::<Event>::new(),
            ),
            |(mut receiver, mut initial, mut modified, mut pending)| async move {
                if initial {
                    initial = false;
                    let event = Event::default().event("connected").data(
                        serde_json::json!({"modified":modified.take().unwrap_or_default()})
                            .to_string(),
                    );
                    return Some((Ok(event), (receiver, initial, modified, pending)));
                }
                loop {
                    if let Some(event) = pending.pop_front() {
                        return Some((Ok(event), (receiver, initial, modified, pending)));
                    }
                    let current = receiver.as_mut()?.recv().await;
                    match current {
                        Ok(change) => {
                            if change.document_changed {
                                pending.push_back(Event::default().event("document").data("{}"));
                            }
                            if !change.assets.is_empty() {
                                pending.push_back(
                                    Event::default().event("assets").data(
                                        serde_json::json!({"paths":change.assets}).to_string(),
                                    ),
                                );
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            pending.push_back(Event::default().event("document").data("{}"));
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                    }
                }
            },
        ));
    Sse::new(events.take_until(wait_for_shutdown(state.shutdown.subscribe())))
        .keep_alive(
            KeepAlive::new()
                .interval(std::time::Duration::from_secs(15))
                .text("ping"),
        )
        .into_response()
}

async fn tree_events(State(state): State<AppState>, OriginalUri(uri): OriginalUri) -> Response {
    let root = state.root_for_uri(uri.path());
    let entry = match state
        .trees
        .entry((*root).clone(), (*state.data_directory).clone())
    {
        Ok(entry) => entry,
        Err(error) => return json_error(StatusCode::SERVICE_UNAVAILABLE, error).into_response(),
    };
    // Subscribe before reading the snapshot so initialization and concurrent
    // updates cannot leave a gap between the HTTP tree and event stream.
    let receiver = entry.subscribe();
    let snapshot = match entry.snapshot().await {
        Ok(snapshot) => snapshot,
        Err(error) => return json_error(StatusCode::SERVICE_UNAVAILABLE, error).into_response(),
    };
    let events = stream::unfold(
        (entry, receiver, true, snapshot.revision),
        |(entry, mut receiver, initial, mut revision)| async move {
            if initial {
                let data = serde_json::json!({"revision": revision.to_string()}).to_string();
                return Some((
                    Ok::<_, Infallible>(Event::default().event("connected").data(data)),
                    (entry, receiver, false, revision),
                ));
            }
            loop {
                let current = match receiver.recv().await {
                    Ok(tree::Event::Changed(current)) => current,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        match entry.snapshot().await {
                            Ok(snapshot) => snapshot.revision,
                            Err(_) => return None,
                        }
                    }
                    Ok(tree::Event::Removed)
                    | Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                };
                if current <= revision {
                    continue;
                }
                revision = current;
                return Some((
                    Ok(Event::default()
                        .event("tree")
                        .data(serde_json::json!({"revision":revision.to_string()}).to_string())),
                    (entry, receiver, false, revision),
                ));
            }
        },
    );
    Sse::new(events.take_until(wait_for_shutdown(state.shutdown.subscribe())))
        .keep_alive(
            KeepAlive::new()
                .interval(std::time::Duration::from_secs(15))
                .text("ping"),
        )
        .into_response()
}

async fn typst_page(
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

async fn pdf_page(
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

async fn frontend_page(state: &AppState) -> Response {
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

async fn index(State(state): State<AppState>) -> Response {
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

async fn repository_tree_redirect(
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

async fn fallback(State(state): State<AppState>, uri: Uri) -> impl IntoResponse {
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

async fn validate_repository_route(
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

async fn security_headers(request: Request, next: axum::middleware::Next) -> Response {
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(4)
        .enable_all()
        .build()?;
    runtime.block_on(run())
}

fn build_router(state: AppState) -> Router {
    let repository_api = Router::new()
        .route("/tree", get(get_tree))
        .route("/", get(repository_metadata))
        .route("/use", axum::routing::post(use_repository))
        .route("/bookmarks", get(list_bookmarks).put(set_bookmark))
        .route("/reading", get(get_reading).put(put_reading))
        .route(
            "/recent-files",
            get(get_recent_files)
                .post(add_recent_file)
                .delete(clear_recent_files),
        )
        .route(
            "/library/session-leases",
            axum::routing::post(session_leases),
        )
        .route("/open-directory", axum::routing::post(open_directory))
        .route("/git/status", get(git_status))
        .route("/git/diff", get(git_diff))
        .route("/search", get(search))
        .route("/document", get(documents::document))
        .route("/library/events", get(library_events))
        .route("/library/tree-events", get(tree_events))
        .route("/html", get(html::html_document))
        .route("/html-resource/{token}/{*path}", get(html::html_resource))
        .route("/asset", get(asset))
        .route("/pdf/page", get(pdf_page))
        .route("/typst/page", get(typst_page))
        .with_state(state.clone());
    let global_api = Router::new()
        .route("/directories", get(directories))
        .route("/repos", get(list_repositories).post(add_repository))
        .route("/library/session", get(library_session))
        .route("/library/activity", axum::routing::post(library_activity))
        .route("/library/open", axum::routing::post(library_open))
        .with_state(state.clone());
    Router::new()
        .route("/", get(index))
        .route("/{repoId}/tree", get(repository_tree_redirect))
        .nest("/api", global_api)
        .nest("/{repoId}/api", repository_api)
        .nest_service(
            "/assets",
            ServeDir::new(state.dist.parent().unwrap_or(&state.dist).join("assets")),
        )
        .fallback(fallback)
        .with_state(state.clone())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            validate_repository_route,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            validate_access,
        ))
        .layer(axum::middleware::from_fn(security_headers))
        .layer(TraceLayer::new_for_http())
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
    let state = AppState {
        document_workers: worker::WorkerPool::new("document", 1, 16),
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
        reading: Arc::new(reading::ReadingStore::new(data_directory.clone())),
        runtime: Arc::new(RuntimeState::default()),
        base_url,
    };
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
    let _ = maintenance.await;
    state.document_workers.shutdown().await;
    state.rendering.close().await;
    served?;
    Ok(())
}

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;
