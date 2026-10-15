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
    sync::atomic::{AtomicU64, Ordering},
    sync::{Arc, LazyLock, Mutex},
    time::Instant,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tower_http::{services::ServeDir, trace::TraceLayer};

static HTML_STRIP_ELEMENTS_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::RegexBuilder::new(
        r"(?is)<(?:iframe|frame|frameset|object|embed)\b[^>]*>.*?</(?:iframe|frame|frameset|object|embed)\s*>|<(?:iframe|frame|frameset|object|embed)\b[^>]*/?>|<base\b[^>]*>",
    )
    .build()
    .expect("static HTML sanitizing pattern is valid")
});
static HTML_META_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?is)<meta\b[^>]*>").expect("valid HTML meta pattern"));
static HTML_HTTP_EQUIV_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?i)\bhttp-equiv\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)"#)
        .expect("valid HTML http-equiv pattern")
});
static HTML_OPEN_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)<html\b[^>]*>").expect("valid HTML pattern"));
static HEAD_OPEN_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)<head\b[^>]*>").expect("valid HTML pattern"));
static HTML_ANCHOR_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?is)<a\b[^>]*>").expect("valid anchor pattern"));
static HTML_HREF_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?i)\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')"#).expect("valid href pattern")
});
static HTML_TARGET_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?i)\btarget\s*=\s*(?:"[^"]*"|'[^']*')"#).expect("valid target pattern")
});
static HTML_REL_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?i)\brel\s*=\s*(?:"([^"]*)"|'([^']*)')"#).expect("valid rel pattern")
});
static HTML_TAG_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)<html\b[^>]*>").expect("valid HTML pattern"));
static HTML_HOST_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9.\-:\[\]]+$").expect("valid host pattern"));
static HTML_RESOURCE_EXTENSION_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)^(css|js|mjs|png|jpe?g|gif|webp|avif|bmp|ico|svg|woff2?|ttf|otf|mp3|mp4|webm|ogg|wav)$")
        .expect("valid HTML resource extension pattern")
});

/// Format paths for APIs and external programs that may not accept Windows' verbatim prefix.
/// Keep canonical paths in their original form for filesystem access and security checks.
fn client_path(path: &Path) -> String {
    dunce::simplified(path).to_string_lossy().into_owned()
}

#[cfg(windows)]
#[test]
fn client_paths_use_compatible_windows_syntax() {
    assert_eq!(client_path(Path::new(r"\\?\C:\Users\jay")), r"C:\Users\jay");
    assert_eq!(
        client_path(Path::new(r"\\?\UNC\server\share\repo")),
        r"\\server\share\repo"
    );
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

mod file_kind;
mod git;
mod markdown;
mod pdf;
mod reading;
mod render;
mod repositories;
mod resources;
mod search;
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
    html_token: Arc<String>,
    search: Arc<search::SearchService>,
    data_directory: Arc<PathBuf>,
    leases: Arc<Mutex<HashMap<String, DocumentLease>>>,
    library_clients: Arc<Mutex<HashMap<String, LibraryClient>>>,
    trees: tree::Service,
    file_watchers:
        Arc<Mutex<HashMap<Vec<(PathBuf, String)>, tokio::sync::broadcast::Sender<FileWatchEvent>>>>,
    repositories: Arc<repositories::RepositoryStore>,
    reading: Arc<reading::ReadingStore>,
    cross_search: Arc<Mutex<HashMap<String, CrossSearchSnapshot>>>,
    base_url: Arc<String>,
}

#[derive(Clone)]
struct FileWatchEvent {
    document_changed: bool,
    assets: Vec<String>,
}

struct CrossSearchSnapshot {
    key: String,
    expires_at: Instant,
    files: Arc<Vec<serde_json::Value>>,
    facets: Arc<serde_json::Value>,
    truncated: bool,
    match_count: usize,
    bytes: usize,
}
static NEXT_CROSS_SEARCH_ID: AtomicU64 = AtomicU64::new(1);

impl AppState {
    fn refresh_document_leases(&self) {
        let now = Instant::now();
        let active = if let Ok(mut leases) = self.leases.lock() {
            leases.retain(|_, lease| lease.expires_at > now);
            leases
                .values()
                .flat_map(|lease| lease.paths.iter().cloned())
                .collect::<HashSet<_>>()
        } else {
            HashSet::new()
        };
        self.rendering.set_active_paths(active);
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
        let parts = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
        if parts.len() >= 2 && parts[1] == "api" {
            if let Some(repo) = decode_url_segment(parts[0])
                .and_then(|value| self.repositories.find(&value).ok().flatten())
            {
                return Arc::new(repo.root);
            }
        }
        self.default_repository()
            .map(|repo| Arc::new(repo.root))
            .unwrap_or_else(|| self.root.clone())
    }

    fn search_for_root(&self, root: &Path) -> Arc<search::SearchService> {
        let _ = root;
        self.search.clone()
    }

    fn subscribe_file_events(
        &self,
        document: PathBuf,
        assets: Vec<(PathBuf, String)>,
        signatures: Vec<Option<(u128, u64)>>,
    ) -> tokio::sync::broadcast::Receiver<FileWatchEvent> {
        let mut key = Vec::with_capacity(assets.len() + 1);
        key.push((document.clone(), String::new()));
        key.extend(assets.iter().cloned());
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
        let watcher_map = self.file_watchers.clone();
        tokio::spawn(async move {
            let mut signatures = signatures;
            let mut timer = tokio::time::interval(std::time::Duration::from_millis(500));
            loop {
                timer.tick().await;
                if sender.receiver_count() == 0 {
                    let mut watchers = watcher_map
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
                let current = std::iter::once(file_signature(&document))
                    .chain(assets.iter().map(|(path, _)| file_signature(path)))
                    .collect::<Vec<_>>();
                let document_changed = current.first() != signatures.first();
                let changed_assets = assets
                    .iter()
                    .zip(current.iter().skip(1))
                    .zip(signatures.iter().skip(1))
                    .filter_map(|(((_, requested), now), before)| {
                        (now != before).then(|| requested.clone())
                    })
                    .collect::<Vec<_>>();
                signatures = current;
                if document_changed || !changed_assets.is_empty() {
                    let _ = sender.send(FileWatchEvent {
                        document_changed,
                        assets: changed_assets,
                    });
                }
            }
        });
        receiver
    }
}

#[derive(Clone)]
struct LibraryClient {
    repo: String,
    last_activity: Instant,
    sender: mpsc::Sender<serde_json::Value>,
}

struct LibraryClientGuard {
    clients: Arc<Mutex<HashMap<String, LibraryClient>>>,
    id: String,
    sender: mpsc::Sender<serde_json::Value>,
}

impl Drop for LibraryClientGuard {
    fn drop(&mut self) {
        if let Ok(mut clients) = self.clients.lock() {
            if clients
                .get(&self.id)
                .is_some_and(|client| client.sender.same_channel(&self.sender))
            {
                clients.remove(&self.id);
            }
        }
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

fn new_capability_token() -> Result<String, std::io::Error> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(std::io::Error::other)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
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

fn html_resources_base(api_prefix: &str, token: &str, path: &str) -> String {
    let directory = path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("");
    let relative = if directory.is_empty() {
        String::new()
    } else {
        format!("{}/", encode_path(directory))
    };
    format!("{api_prefix}/api/html-resource/{token}/{relative}")
}

fn html_preview(source: &str, base: &str, document_url: &str) -> String {
    let source = HTML_STRIP_ELEMENTS_RE.replace_all(source, "");
    let source = HTML_META_RE.replace_all(&source, |captures: &regex::Captures<'_>| {
        if HTML_HTTP_EQUIV_RE.is_match(&captures[0]) {
            String::new()
        } else {
            captures[0].to_owned()
        }
    });
    let base_tag = format!(
        "<base href=\"{}\">",
        base.replace('&', "&amp;").replace('"', "&quot;")
    );
    let no_scroll = "<style>html,body{scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}</style>";
    let image_style = include_str!("../shared/image-theme.css");
    let injection = format!("{base_tag}{no_scroll}<style>{image_style}</style>");
    let output = if let Some(found) = HEAD_OPEN_RE.find(&source) {
        let mut value = source.to_string();
        value.insert_str(found.end(), &injection);
        value
    } else if let Some(found) = HTML_OPEN_RE.find(&source) {
        let mut value = source.to_string();
        value.insert_str(found.end(), &format!("<head>{injection}</head>"));
        value
    } else {
        format!("<head>{injection}</head>{source}")
    };
    let output = HTML_ANCHOR_RE.replace_all(&output, |captures: &regex::Captures<'_>| {
        let mut tag = captures[0].to_owned();
        let Some(found) = HTML_HREF_RE.captures(&tag) else {
            return tag;
        };
        let value = found
            .get(1)
            .or_else(|| found.get(2))
            .map(|value| value.as_str())
            .unwrap_or_default();
        if let Some(fragment) = value.strip_prefix('#') {
            let replacement = format!(
                "href=\"{}#{}\"",
                document_url.replace('&', "&amp;"),
                fragment
            );
            tag = HTML_HREF_RE.replace(&tag, replacement).into_owned();
        } else if value
            .get(..7)
            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("http://"))
            || value
                .get(..8)
                .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://"))
        {
            if HTML_TARGET_RE.is_match(&tag) {
                tag = HTML_TARGET_RE
                    .replace(&tag, "target=\"_blank\"")
                    .into_owned();
            } else {
                tag.insert_str(tag.len() - 1, " target=\"_blank\"");
            }
            if let Some(existing) = HTML_REL_RE.captures(&tag) {
                let values = existing
                    .get(1)
                    .or_else(|| existing.get(2))
                    .map(|value| value.as_str())
                    .unwrap_or_default();
                let mut values = values
                    .split_ascii_whitespace()
                    .map(str::to_owned)
                    .collect::<std::collections::HashSet<_>>();
                values.remove("opener");
                values.insert("noopener".into());
                values.insert("noreferrer".into());
                tag = HTML_REL_RE
                    .replace(
                        &tag,
                        format!(
                            "rel=\"{}\"",
                            values.into_iter().collect::<Vec<_>>().join(" ")
                        ),
                    )
                    .into_owned();
            } else {
                tag.insert_str(tag.len() - 1, " rel=\"noopener noreferrer\"");
            }
        }
        tag
    });
    HTML_TAG_RE
        .replace(&output, |captures: &regex::Captures<'_>| {
            let tag = &captures[0];
            if tag.to_ascii_lowercase().contains("data-dim-images") {
                tag.to_owned()
            } else {
                tag.replacen('>', " data-dim-images>", 1)
            }
        })
        .into_owned()
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
    path: Option<serde_json::Value>,
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

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CrossSearchQuery {
    q: String,
    repo: Option<String>,
    #[serde(rename = "currentRepo")]
    current_repo: Option<String>,
    #[serde(rename = "currentFile")]
    current_file: Option<String>,
    search_id: Option<String>,
    offset: Option<usize>,
    lang: Option<String>,
    language: Option<String>,
    path: Option<String>,
    scope: Option<String>,
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

fn browse_directories(
    path: Option<&str>,
    initial_root: &Path,
    data_directory: &Path,
) -> Result<serde_json::Value, (StatusCode, String)> {
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
            directories.push(serde_json::json!({"name":name, "path":client_path(&candidate)}));
        }
    }
    directories.sort_by(|left, right| {
        left["name"]
            .as_str()
            .unwrap_or_default()
            .to_lowercase()
            .cmp(&right["name"].as_str().unwrap_or_default().to_lowercase())
    });
    let parent = directory.parent().filter(|parent| *parent != directory);
    #[cfg(windows)]
    let drives = (b'A'..=b'Z')
        .filter_map(|drive| {
            let path = PathBuf::from(format!("{}:/", drive as char));
            path.exists()
                .then(|| serde_json::json!({"name":client_path(&path), "path":client_path(&path)}))
        })
        .collect::<Vec<_>>();
    #[cfg(not(windows))]
    let drives = vec![serde_json::json!({"name":"/", "path":"/"})];
    Ok(
        serde_json::json!({"path":client_path(&directory), "name":directory.file_name().map(|name| name.to_string_lossy()).unwrap_or_else(|| directory.as_os_str().to_string_lossy()),
        "parent":parent.map(client_path), "directories":directories, "drives":drives}),
    )
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
    match browse_directories(
        query.path.as_deref(),
        &state.service_root,
        &state.data_directory,
    ) {
        Ok(value) => Json(value).into_response(),
        Err((status, error)) => json_error(status, error).into_response(),
    }
}

fn describe_repository(repo: &repositories::Repository) -> serde_json::Value {
    let segment = encode_query_component(&repo.slug);
    let mut result = serde_json::json!({
        "id": repo.id,
        "slug": repo.slug,
        "name": repo.name,
        "root": client_path(&repo.root),
        "createdAt": repo.created_at,
        "url": format!("/{segment}/tree/"),
        "apiUrl": format!("/{segment}/api")
    });
    if let Some(last_used_at) = &repo.last_used_at {
        result["lastUsedAt"] = last_used_at.clone().into();
    }
    result
}

async fn list_repositories(State(state): State<AppState>) -> Response {
    if let Err(error) = state.repositories.prune_missing() {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error).into_response();
    }
    match state.repositories.list() {
        Ok(repos) => {
            let default_id = state.default_repository().map(|repo| repo.id);
            Json(serde_json::json!({"repos":repos.iter().map(describe_repository).collect::<Vec<_>>(),"defaultRepoId":default_id})).into_response()
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
    if !headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
    {
        return json_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        )
        .into_response();
    }
    if let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        let host = headers
            .get(axum::http::header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        let scheme = headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            .filter(|value| matches!(*value, "http" | "https"))
            .unwrap_or("http");
        if origin != format!("{scheme}://{host}") {
            return json_error(
                StatusCode::FORBIDDEN,
                "Cross-origin registration is forbidden",
            )
            .into_response();
        }
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
    if !headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
    {
        return json_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        )
        .into_response();
    }
    if let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        let host = headers
            .get(axum::http::header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        let scheme = headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            .filter(|value| matches!(*value, "http" | "https"))
            .unwrap_or("http");
        if origin != format!("{scheme}://{host}") {
            return json_error(StatusCode::FORBIDDEN, "Cross-origin request is forbidden")
                .into_response();
        }
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
    if !headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
    {
        return json_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        )
        .into_response();
    }
    if let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        let host = headers
            .get(axum::http::header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        let scheme = headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            .filter(|value| matches!(*value, "http" | "https"))
            .unwrap_or("http");
        if origin != format!("{scheme}://{host}") {
            return json_error(StatusCode::FORBIDDEN, "Cross-origin request forbidden")
                .into_response();
        }
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
    if !headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
    {
        return json_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        )
        .into_response();
    }
    if let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        let host = headers
            .get(axum::http::header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        let scheme = headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            .filter(|value| matches!(*value, "http" | "https"))
            .unwrap_or("http");
        if origin != format!("{scheme}://{host}") {
            return json_error(StatusCode::FORBIDDEN, "Cross-origin request forbidden")
                .into_response();
        }
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
    if !headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
    {
        return json_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        )
        .into_response();
    }
    if let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        let host = headers
            .get(axum::http::header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        let scheme = headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            .filter(|value| matches!(*value, "http" | "https"))
            .unwrap_or("http");
        if origin != format!("{scheme}://{host}") {
            return json_error(StatusCode::FORBIDDEN, "Cross-origin request forbidden")
                .into_response();
        }
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
    if !headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
    {
        return json_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        )
        .into_response();
    }
    if let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        let host = headers
            .get(axum::http::header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        let scheme = headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            .filter(|value| matches!(*value, "http" | "https"))
            .unwrap_or("http");
        if origin != format!("{scheme}://{host}") {
            return json_error(
                StatusCode::FORBIDDEN,
                "Cross-origin registration is forbidden",
            )
            .into_response();
        }
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
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        let scheme = headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            .filter(|value| matches!(*value, "http" | "https"))
            .unwrap_or("http");
        if origin != format!("{scheme}://{host}") {
            return json_error(StatusCode::FORBIDDEN, "Cross-origin retention is forbidden")
                .into_response();
        }
    }
    if !headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
    {
        return json_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        )
        .into_response();
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
    let mut leases = match state.leases.lock() {
        Ok(leases) => leases,
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Lease store lock poisoned",
            )
            .into_response();
        }
    };
    leases.retain(|_, lease| lease.expires_at > Instant::now());
    if leases.len() >= 128 && !leases.contains_key(&request.client) {
        return worker_error(worker::WorkerError::Busy);
    }
    if let Some(existing) = leases.get(&request.client) {
        if request.version.is_some()
            && existing.version.is_some()
            && request.version <= existing.version
        {
            drop(leases);
            state.refresh_document_leases();
            return Json(serde_json::json!({"ok":true})).into_response();
        }
    }
    if paths.is_empty() && request.version.is_none() {
        leases.remove(&request.client);
    } else {
        leases.insert(
            request.client,
            DocumentLease {
                version: request.version,
                expires_at: Instant::now() + std::time::Duration::from_secs(90),
                paths,
            },
        );
    }
    drop(leases);
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
    let (sender, receiver) = mpsc::channel(16);
    if let Ok(mut clients) = state.library_clients.lock() {
        clients.insert(
            query.client.clone(),
            LibraryClient {
                repo: query.repo,
                last_activity: Instant::now(),
                sender: sender.clone(),
            },
        );
    } else {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Library session store unavailable",
        )
        .into_response();
    }
    let connected = stream::once(async {
        Ok::<Event, Infallible>(Event::default().event("connected").data("{}"))
    });
    let guard = LibraryClientGuard {
        clients: state.library_clients.clone(),
        id: query.client,
        sender,
    };
    let events = stream::unfold(
        (
            receiver,
            tokio::time::interval(std::time::Duration::from_secs(15)),
            guard,
        ),
        |(mut receiver, mut ticker, guard)| async move {
            tokio::select! {
                value = receiver.recv() => match value {
                    Some(value) => Some((Ok::<Event, Infallible>(Event::default().event("document-open").data(value.to_string())), (receiver, ticker, guard))),
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
    if !headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
    {
        return json_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        )
        .into_response();
    }
    if let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        let host = headers
            .get(axum::http::header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        let scheme = headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            .filter(|value| matches!(*value, "http" | "https"))
            .unwrap_or("http");
        if origin != format!("{scheme}://{host}") {
            return json_error(StatusCode::FORBIDDEN, "Cross-origin request forbidden")
                .into_response();
        }
    }
    let active = state
        .library_clients
        .lock()
        .ok()
        .and_then(|mut clients| {
            let client = clients.get_mut(&request.client)?;
            client.last_activity = Instant::now();
            Some(())
        })
        .is_some();
    Json(serde_json::json!({"ok":active})).into_response()
}

async fn library_open(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Json(request): Json<LibraryOpenRequest>,
) -> Response {
    if !headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
    {
        return json_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        )
        .into_response();
    }
    if let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        let host = headers
            .get(axum::http::header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        let scheme = headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            .filter(|value| matches!(*value, "http" | "https"))
            .unwrap_or("http");
        if origin != format!("{scheme}://{host}") {
            return json_error(StatusCode::FORBIDDEN, "Cross-origin request forbidden")
                .into_response();
        }
    }
    if request.line.is_some_and(|line| line < 1)
        || request
            .view
            .as_deref()
            .is_some_and(|view| !matches!(view, "preview" | "raw"))
    {
        return json_error(StatusCode::BAD_REQUEST, "Invalid source line or view").into_response();
    }
    let repo = if let Some(file) = request.file.as_deref() {
        if !Path::new(file).is_absolute() {
            return json_error(StatusCode::BAD_REQUEST, "file must be an absolute path")
                .into_response();
        }
        let Some(file) = Path::new(file).canonicalize().ok() else {
            return json_error(StatusCode::NOT_FOUND, "File not found").into_response();
        };
        let mut repos = match state.repositories.list() {
            Ok(repos) => repos,
            Err(error) => {
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, error).into_response();
            }
        };
        repos.sort_by_key(|repo| std::cmp::Reverse(repo.root.as_os_str().len()));
        match repos.into_iter().find(|repo| file.starts_with(&repo.root)) {
            Some(repo) => repo,
            None => {
                return json_error(
                    StatusCode::NOT_FOUND,
                    "File does not belong to a registered repository",
                )
                .into_response();
            }
        }
    } else {
        match request
            .repo
            .as_deref()
            .and_then(|value| state.repositories.find(value).ok().flatten())
            .or_else(|| state.repository_for_uri(uri.path()))
        {
            Some(repo) => repo,
            None => return json_error(StatusCode::NOT_FOUND, "Repo not found").into_response(),
        }
    };
    let root = repo.root.clone();
    let relative = if let Some(file) = request.file.as_deref() {
        let canonical = match Path::new(file).canonicalize() {
            Ok(file) => file,
            Err(_) => return json_error(StatusCode::NOT_FOUND, "File not found").into_response(),
        };
        canonical
            .strip_prefix(&root)
            .unwrap_or(&canonical)
            .to_string_lossy()
            .replace('\\', "/")
    } else {
        request.path.unwrap_or_default()
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
    let payload = serde_json::json!({"repo":repo_slug,"path":relative,"line":request.line,"view":request.view.or_else(|| request.line.map(|_| "raw".into())).unwrap_or_else(|| "preview".into()),"url":url});
    let mut clients = match state.library_clients.lock() {
        Ok(clients) => clients,
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Library session store unavailable",
            )
            .into_response();
        }
    };
    let mut candidates = clients
        .iter()
        .map(|(id, client)| {
            (
                id.clone(),
                client.sender.clone(),
                client.repo == repo.slug || client.repo == repo.id,
                client.last_activity,
            )
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| (right.2, right.3).cmp(&(left.2, left.3)));
    for (id, sender, _, _) in candidates {
        match sender.try_send(payload.clone()) {
            Ok(()) => return Json(serde_json::json!({"reused":true,"url":url})).into_response(),
            Err(mpsc::error::TrySendError::Closed(_)) => {
                clients.remove(&id);
            }
            Err(mpsc::error::TrySendError::Full(_)) => {}
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
    if !headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
    {
        return json_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        )
        .into_response();
    }
    if let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        let host = headers
            .get(axum::http::header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        let scheme = headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            .filter(|value| matches!(*value, "http" | "https"))
            .unwrap_or("http");
        if origin != format!("{scheme}://{host}") {
            return json_error(StatusCode::FORBIDDEN, "Cross-origin request forbidden")
                .into_response();
        }
    }
    let requested = match request.path {
        None => String::new(),
        Some(serde_json::Value::String(path)) => path,
        Some(_) => {
            return json_error(StatusCode::BAD_REQUEST, "Invalid directory path").into_response();
        }
    };
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
        .arg(dunce::simplified(&directory).as_ref())
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
    let service = state.search_for_root(&root);
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
        Ok(Err(error)) => json_error(StatusCode::BAD_REQUEST, error).into_response(),
        Err(error) => {
            json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
        }
    }
}

async fn search_repositories(
    State(state): State<AppState>,
    Query(query): Query<CrossSearchQuery>,
) -> Response {
    let selected = match query.repo.as_deref().unwrap_or("") {
        "*" => match state.repositories.list() {
            Ok(repos) => repos,
            Err(error) => {
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, error).into_response();
            }
        },
        "" => {
            let value = state.default_repository();
            value.into_iter().collect()
        }
        value => match state.repositories.find(value) {
            Ok(Some(repo)) => vec![repo],
            Ok(None) => return json_error(StatusCode::NOT_FOUND, "Repo not found").into_response(),
            Err(error) => {
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, error).into_response();
            }
        },
    };
    if selected.is_empty() {
        return json_error(StatusCode::NOT_FOUND, "Repo not found").into_response();
    }
    let key = serde_json::to_string(&(
        query.q.as_str(),
        query.repo.as_deref(),
        query.current_repo.as_deref(),
        query.current_file.as_deref(),
        query.lang.as_deref(),
        query.language.as_deref(),
        query.path.as_deref(),
        query.scope.as_deref(),
    ))
    .unwrap_or_default();
    let snapshot_id = query.search_id.clone().unwrap_or_default();
    let existing = if snapshot_id.is_empty() {
        None
    } else {
        match state.cross_search.lock() {
            Ok(mut cache) => {
                cache.retain(|_, item| item.expires_at > Instant::now());
                match cache.get(&snapshot_id) {
                    Some(item) if item.key == key => Some((
                        item.files.clone(),
                        item.facets.clone(),
                        item.truncated,
                        item.match_count,
                    )),
                    _ => {
                        return json_error(
                            StatusCode::BAD_REQUEST,
                            "Search expired. Run the search again.",
                        )
                        .into_response();
                    }
                }
            }
            Err(_) => {
                return json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Search cache lock poisoned",
                )
                .into_response();
            }
        }
    };
    let (files, facets, truncated, match_count, search_id) = if let Some((
        files,
        facets,
        truncated,
        matches,
    )) = existing
    {
        (files, facets, truncated, matches, snapshot_id)
    } else {
        let services = selected
            .into_iter()
            .map(|repo| (repo.clone(), state.search_for_root(&repo.root)))
            .collect::<Vec<_>>();
        let mut request = query.clone();
        let current_repo = query
            .current_repo
            .as_deref()
            .and_then(|value| state.repositories.find(value).ok().flatten())
            .or_else(|| {
                state
                    .repositories
                    .list()
                    .ok()
                    .and_then(|repos| repos.into_iter().find(|repo| repo.root == *state.root))
            });
        request.current_repo = current_repo.map(|repo| repo.id);
        let private = state.data_directory.clone();
        let result = tokio::task::spawn_blocking(move || -> Result<_, String> {
            let mut files = Vec::new();
            let mut language_counts = HashMap::<String, usize>::new();
            let mut path_counts = HashMap::<String, usize>::new();
            let mut truncated = false;
            let mut cached_bytes = 0usize;
            let mut match_count = 0usize;
            for (repo, service) in services {
                let mut search_id = None;
                let mut offset = 0;
                let mut first_page = true;
                loop {
                    let params = search::SearchParams { q: request.q.clone(), scope: request.scope.clone(), current_file: request.current_file.clone(), search_id: search_id.clone(), offset: Some(offset), lang: request.lang.clone(), language: request.language.clone(), path: request.path.clone() };
                    let bookmarks = repo.bookmarks.iter().map(|item| item.path.clone()).collect::<Vec<_>>();
                    let page = service.search_with_private(&repo.root, params, Some(&bookmarks), Some(&private))?;
                    search_id = page.get("searchId").and_then(|v| v.as_str()).map(str::to_owned);
                    truncated |= page.get("truncated").and_then(|v| v.as_bool()).unwrap_or(false);
                    if first_page { match_count += page.get("matchCount").and_then(|v|v.as_u64()).unwrap_or(0) as usize; }
                    if let Some(items) = page.get("files").and_then(|v| v.as_array()) {
                        for item in items {
                            let mut item = item.clone();
                            if let Some(object) = item.as_object_mut() { object.insert("repoId".into(), repo.id.clone().into()); object.insert("repoName".into(), repo.name.clone().into()); }
                            let size = item.to_string().len();
                            cached_bytes = cached_bytes.saturating_add(size);
                            if cached_bytes > 8 * 1024 * 1024 { return Err("Search result exceeds cache budget. Try a more specific query.".into()); }
                            files.push(item);
                        }
                    }
                    for (field, counts) in [("languages", &mut language_counts), ("paths", &mut path_counts)] {
                        if !first_page { continue; }
                        if let Some(items) = page.get("facets").and_then(|v| v.get(field)).and_then(|v| v.as_array()) {
                            for item in items { if let (Some(value), Some(count)) = (item.get("value").and_then(|v|v.as_str()), item.get("count").and_then(|v|v.as_u64())) { *counts.entry(value.to_owned()).or_default() += count as usize; } }
                        }
                    }
                    let Some(next) = page.get("nextOffset").and_then(|v| v.as_u64()) else { break; };
                    offset = next as usize;
                    first_page = false;
                }
            }
            let current_repo = request.current_repo.as_deref().unwrap_or_default();
            let current_file = request.current_file.as_deref().unwrap_or_default();
            files.sort_by(|a,b| {
                let preferred = |item: &serde_json::Value| item.get("repoId").and_then(|v|v.as_str()) == Some(current_repo) && item.get("path").and_then(|v|v.as_str()) == Some(current_file);
                (!preferred(a)).cmp(&(!preferred(b))).then_with(|| a["repoName"].as_str().cmp(&b["repoName"].as_str())).then_with(|| a["path"].as_str().cmp(&b["path"].as_str()))
            });
            let to_facets = |counts: HashMap<String,usize>| { let mut values = counts.into_iter().collect::<Vec<_>>(); values.sort_by(|a,b| b.1.cmp(&a.1).then_with(||a.0.cmp(&b.0))); serde_json::Value::Array(values.into_iter().map(|(value,count)|serde_json::json!({"value":value,"count":count})).collect()) };
            Ok((files, serde_json::json!({"languages":to_facets(language_counts),"paths":to_facets(path_counts)}), truncated, match_count))
        }).await;
        let (files, facets, truncated, match_count) = match result {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => return json_error(StatusCode::BAD_REQUEST, error).into_response(),
            Err(error) => {
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
                    .into_response();
            }
        };
        let files = Arc::new(files);
        let facets = Arc::new(facets);
        let id = format!(
            "{}-{}",
            std::process::id(),
            NEXT_CROSS_SEARCH_ID.fetch_add(1, Ordering::Relaxed)
        );
        if let Ok(mut cache) = state.cross_search.lock() {
            cache.retain(|_, item| item.expires_at > Instant::now());
            let bytes = files
                .iter()
                .map(|value| value.to_string().len())
                .sum::<usize>()
                + facets.to_string().len();
            while cache.values().map(|item| item.bytes).sum::<usize>() + bytes > 8 * 1024 * 1024 {
                let Some(oldest) = cache
                    .iter()
                    .min_by_key(|(_, item)| item.expires_at)
                    .map(|(key, _)| key.clone())
                else {
                    break;
                };
                cache.remove(&oldest);
            }
            cache.insert(
                id.clone(),
                CrossSearchSnapshot {
                    key,
                    expires_at: Instant::now() + std::time::Duration::from_secs(300),
                    files: files.clone(),
                    facets: facets.clone(),
                    truncated,
                    match_count,
                    bytes,
                },
            );
        }
        (files, facets, truncated, match_count, id)
    };
    let offset = query.offset.unwrap_or(0);
    let page = files
        .iter()
        .skip(offset)
        .take(20)
        .cloned()
        .collect::<Vec<_>>();
    let next = (offset + page.len() < files.len()).then_some(offset + page.len());
    Json(serde_json::json!({"searchId":search_id,"total":files.len(),"files":page,"truncated":truncated,"matchCount":match_count,"nextOffset":next,"facets":facets.as_ref()})).into_response()
}

fn read_document_source(path: &Path) -> Result<Vec<u8>, (StatusCode, String)> {
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

async fn document(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<PathQuery>,
) -> impl IntoResponse {
    let root = state.root_for_uri(uri.path());
    let compile_root = root.clone();
    let preview = query.view.as_deref() != Some("raw");
    let theme = query.theme.clone();
    let pdf_renderer = state.rendering.pdf.clone();
    let private = state.data_directory.clone();
    let api_prefix = uri
        .path()
        .strip_suffix("/api/document")
        .unwrap_or("")
        .to_owned();
    let compile_prefix = api_prefix.clone();
    let result = state.document_workers.run_cancellable(0, move |cancellation| -> Result<serde_json::Value, (StatusCode, String)> {
        let path = checked_library_path(&root, &query.path, &private)?;
        if !path.is_file() { return Err((StatusCode::BAD_REQUEST, "Not a file".into())); }
        let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let modified = modified_rfc3339(&path);
        let extension = path.extension().and_then(|extension| extension.to_str())
            .unwrap_or_default().to_ascii_lowercase();
        let file_size = path.metadata().map(|metadata| metadata.len()).unwrap_or_default();
        let detected = file_kind::from_path(&path)
            .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
        let mime = detected.mime;
        if mime == "text/html" && !detected.binary {
            let source = String::from_utf8(read_document_source(&path)?).map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
            return Ok(serde_json::json!({"type":"html", "path":query.path,
                "absolutePath":client_path(&path), "name":name, "size":file_size, "modified":modified,
                "lineCount":source.split('\n').count(), "source":source,
                "url":format!("{api_prefix}/api/html?path={}", encode_query_component(&query.path))}));
        }
        if mime.starts_with("image/") {
            return Ok(serde_json::json!({"type":"image", "path":query.path,
                "absolutePath":client_path(&path), "name":name, "size":file_size, "modified":modified,
                "mime":mime, "format":detected.format, "url":format!("{api_prefix}/api/asset?path={}", encode_query_component(&query.path))}));
        }
        if mime == "application/pdf" {
            let revision = pdf::revision(&path)
                .map_err(|error| (pdf_error_status(&error), error.to_string()))?;
            let info = pdf_renderer.document_cancellable(&path, &revision, &cancellation)
                .map_err(|error| (pdf_error_status(&error), error.to_string()))?;
            let pages = info.pages.iter().enumerate().map(|(index, page)| serde_json::json!({
                "url":format!("{api_prefix}/api/pdf/page?path={}&page={}",
                    encode_query_component(&query.path), index + 1),
                "width":page.width, "height":page.height
            })).collect::<Vec<_>>();
            return Ok(serde_json::json!({"type":"pdf", "path":query.path,
                "absolutePath":client_path(&path), "name":name, "size":path.metadata().map(|meta| meta.len()).unwrap_or_default(),
                "modified":modified, "revision":revision, "outline":info.outline, "pages":pages}));
        }
        if detected.binary {
            return Ok(serde_json::json!({"type":"binary", "path":query.path,
                "absolutePath":client_path(&path), "name":name, "size":file_size, "modified":modified,
                "mime":mime, "format":detected.format, "url":format!("{api_prefix}/api/asset?path={}", encode_query_component(&query.path))}));
        }
        let bytes = read_document_source(&path)?;
        if !file_kind::is_text(&bytes) {
            return Ok(serde_json::json!({"type":"binary", "path":query.path,
                "absolutePath":client_path(&path), "name":name, "size":file_size, "modified":modified,
                "mime":"application/octet-stream", "url":format!("{api_prefix}/api/asset?path={}", encode_query_component(&query.path))}));
        }
        let source = String::from_utf8(bytes).expect("validated UTF-8 document");
        let line_count = if source.is_empty() { 0 } else { source.lines().count() };
        if matches!(extension.as_str(), "md" | "markdown") {
            if query.view.as_deref() == Some("raw") {
                return Ok(serde_json::json!({"type":"markdown", "path":query.path,
                    "absolutePath":client_path(&path), "name":name, "size":source.len(),
                    "modified":modified, "lineCount":line_count, "source":source}));
            }
            let html = markdown::render_markdown(&source, true)
                .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
            return Ok(serde_json::json!({"type":"markdown", "path":query.path,
                "absolutePath":client_path(&path), "name":name, "size":source.len(),
                "modified":modified, "lineCount":line_count, "source":source, "html":html}));
        }
        if extension == "typ" {
            return Ok(serde_json::json!({"type":"typst", "path":query.path,
                "absolutePath":client_path(&path), "name":name, "size":source.len(), "modified":modified,
                "lineCount":line_count, "source":source, "outline":[], "anchors":[], "pages":[], "compile":null}));
        }
        Ok(serde_json::json!({"type":"text", "path":query.path, "absolutePath":client_path(&path),
            "name":name, "lineCount":line_count, "source":source}))
    }).await;
    match result {
        Ok(Ok(value)) if preview && value["type"] == "typst" => {
            match compile_document(&state, &compile_root, value, compile_prefix, theme).await {
                Ok(value) => Json(value).into_response(),
                Err(error) => worker_error(error),
            }
        }
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err((status, error))) => json_error(status, error).into_response(),
        Err(error) => worker_error(error),
    }
}

async fn compile_document(
    state: &AppState,
    root: &Path,
    mut value: serde_json::Value,
    api_prefix: String,
    theme: Option<String>,
) -> Result<serde_json::Value, worker::WorkerError> {
    let request = typst::CompileRequest {
        path: value["absolutePath"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        source: value["source"].as_str().unwrap_or_default().to_owned(),
        theme,
    };
    match state.rendering.compile(root, request).await? {
        Ok(compiled) => {
            value["outline"] = serde_json::json!(compiled.outline);
            value["anchors"] = serde_json::json!(compiled.anchors);
            value["pages"] = serde_json::json!(compiled.pages.iter().enumerate().map(|(index, page)| serde_json::json!({
                    "url":format!("{api_prefix}/api/typst/page?id={}&page={}", compiled.id, index + 1),
                    "width":page.width, "height":page.height,
                })).collect::<Vec<_>>());
            value["compile"] = serde_json::json!({"id":compiled.id, "status":"success", "diagnostics":compiled.diagnostics});
        }
        Err(typst::CompileError::Busy) => return Err(worker::WorkerError::Busy),
        Err(typst::CompileError::Cancelled) => return Err(worker::WorkerError::Stopped),
        Err(typst::CompileError::Failed(error)) => {
            tracing::warn!(path = %value["path"], error = %error, "Typst compilation failed");
            let diagnostics = serde_json::from_str::<Vec<typst::Diagnostic>>(&error)
                .unwrap_or_else(|_| {
                    vec![typst::Diagnostic {
                        file: value["path"].as_str().unwrap_or_default().to_owned(),
                        severity: "error".into(),
                        message: error,
                        range: None,
                    }]
                });
            value["compile"] =
                serde_json::json!({"id":null, "status":"failed", "diagnostics":diagnostics});
        }
    }
    Ok(value)
}

async fn html_document(
    State(state): State<AppState>,
    OriginalUri(original_uri): OriginalUri,
    Query(query): Query<PathQuery>,
    headers: HeaderMap,
) -> Response {
    let uri = original_uri;
    let root = state.root_for_uri(uri.path());
    let private = state.data_directory.clone();
    let token = state.html_token.clone();
    let api_prefix = uri
        .path()
        .strip_suffix("/api/html")
        .unwrap_or("")
        .to_owned();
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("localhost");
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .filter(|value| matches!(*value, "http" | "https"))
        .unwrap_or("http");
    let origin = format!("{scheme}://{host}");
    if !HTML_HOST_RE.is_match(host) {
        return json_error(StatusCode::BAD_REQUEST, "Invalid host header").into_response();
    }
    let resource_origin = origin.clone();
    let resource_api_prefix = api_prefix.clone();
    let resource_token = token.clone();
    let document_url = format!(
        "{origin}{api_prefix}/api/html?path={}",
        encode_query_component(&query.path)
    );
    let result = state
        .document_workers
        .run(move || -> Result<String, (StatusCode, String)> {
            let path = checked_library_path(&root, &query.path, &private)?;
            if !matches!(
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase()
                    .as_str(),
                "html" | "htm"
            ) {
                return Err((StatusCode::BAD_REQUEST, "Not an HTML document".into()));
            }
            let detected = file_kind::from_path(&path)
                .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
            if detected.mime != "text/html" || detected.binary {
                return Err((StatusCode::BAD_REQUEST, "Not an HTML document".into()));
            }
            let source = String::from_utf8(read_document_source(&path)?)
                .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
            let relative_base = html_resources_base(&api_prefix, &token, &query.path);
            let base = format!("{origin}{relative_base}");
            Ok(html_preview(&source, &base, &document_url))
        })
        .await;
    match result {
        Ok(Ok(body)) => {
            let resource_root = format!(
                "{resource_origin}{resource_api_prefix}/api/html-resource/{resource_token}/"
            );
            let csp = format!(
                "default-src 'none'; sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; script-src 'unsafe-inline' {resource_root}; style-src 'unsafe-inline' {resource_root}; img-src data: blob: {resource_root}; font-src data: {resource_root}; media-src {resource_root}; base-uri {resource_root}; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'"
            );
            let mut response = body.into_response();
            response.headers_mut().insert(
                axum::http::header::CONTENT_TYPE,
                "text/html; charset=utf-8".parse().unwrap(),
            );
            response.headers_mut().insert(
                axum::http::header::CACHE_CONTROL,
                "no-store".parse().unwrap(),
            );
            response
                .headers_mut()
                .insert("content-security-policy", csp.parse().unwrap());
            response
                .headers_mut()
                .insert("x-content-type-options", "nosniff".parse().unwrap());
            response
                .headers_mut()
                .insert("referrer-policy", "no-referrer".parse().unwrap());
            response
                .headers_mut()
                .insert("x-dns-prefetch-control", "off".parse().unwrap());
            response.headers_mut().insert(
                "permissions-policy",
                "camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=()"
                    .parse()
                    .unwrap(),
            );
            response
        }
        Ok(Err((status, error))) => json_error(status, error).into_response(),
        Err(error) => worker_error(error),
    }
}

async fn html_resource(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    AxumPath(params): AxumPath<HashMap<String, String>>,
) -> Response {
    let token = params.get("token").map(String::as_str).unwrap_or_default();
    let path = params.get("path").map(String::as_str).unwrap_or_default();
    if token != *state.html_token {
        return json_error(StatusCode::FORBIDDEN, "Invalid HTML resource capability")
            .into_response();
    }
    let root = state.root_for_uri(uri.path());
    let private = state.data_directory.clone();
    let file_path = match checked_library_path(&root, &path, &private) {
        Ok(path) => path,
        Err((status, message)) => return json_error(status, message).into_response(),
    };
    let extension = file_path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();
    if !HTML_RESOURCE_EXTENSION_RE.is_match(extension) {
        return json_error(StatusCode::FORBIDDEN, "Unsupported HTML resource").into_response();
    }
    let mut file = match tokio::fs::File::open(&file_path).await {
        Ok(file) => file,
        Err(error) => return json_error(StatusCode::NOT_FOUND, error.to_string()).into_response(),
    };
    let metadata = match file.metadata().await {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return json_error(StatusCode::NOT_FOUND, "Resource not found").into_response(),
        Err(error) => return json_error(StatusCode::NOT_FOUND, error.to_string()).into_response(),
    };
    let mime = match media_type(&file_path, &mut file).await {
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
    headers.insert("access-control-allow-origin", "*".parse().unwrap());
    headers.insert(
        "content-security-policy",
        "sandbox; default-src 'none'".parse().unwrap(),
    );
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    response
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
    let mut signatures = Vec::with_capacity(assets.len() + 1);
    signatures.push(file_signature(&document));
    signatures.extend(assets.iter().map(|(path, _)| file_signature(path)));
    let modified = modified_rfc3339(&document);
    let receiver = state.subscribe_file_events(document.clone(), assets, signatures);
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
    let requested_width = query.width.unwrap_or(1800.0);
    if !requested_width.is_finite() || requested_width <= 0.0 {
        return json_error(StatusCode::BAD_REQUEST, "Invalid page width").into_response();
    }
    // PDF pages are served as resolution-independent SVG in the native backend.
    // Keep the frontend's width contract (450px steps, bounded to 3600px) so
    // invalid and extreme requests behave like the former raster endpoint.
    let _target_width = (requested_width / 450.0).ceil().clamp(1.0, 8.0) * 450.0;
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
    if parts.first() == Some(&"api")
        && (parts.len() == 1
            || matches!(
                parts.get(1).copied(),
                Some("bookmarks" | "reading" | "recent-files" | "open-directory" | "use")
            ))
    {
        return json_error(StatusCode::NOT_FOUND, "Not found").into_response();
    }
    let page_route = parts.len() >= 2 && matches!(parts[1], "tree" | "search" | "git");
    if parts.len() >= 2 && (parts[1] == "api" || page_route) {
        if parts[1] == "api"
            && (matches!(
                parts.get(2).copied(),
                Some("repos" | "directories" | "search-repos")
            ) || (parts.get(2) == Some(&"library")
                && matches!(parts.get(3).copied(), Some("session" | "activity" | "open"))))
        {
            return json_error(StatusCode::NOT_FOUND, "Not found").into_response();
        }
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
    let api = Router::new()
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
        .route("/directories", get(directories))
        .route("/repos", get(list_repositories).post(add_repository))
        .route(
            "/library/session-leases",
            axum::routing::post(session_leases),
        )
        .route("/library/session", get(library_session))
        .route("/library/activity", axum::routing::post(library_activity))
        .route("/library/open", axum::routing::post(library_open))
        .route("/open-directory", axum::routing::post(open_directory))
        .route("/git/status", get(git_status))
        .route("/git/diff", get(git_diff))
        .route("/search", get(search))
        .route("/search-repos", get(search_repositories))
        .route("/document", get(document))
        .route("/library/events", get(library_events))
        .route("/library/tree-events", get(tree_events))
        .route("/html", get(html_document))
        .route("/html-resource/{token}/{*path}", get(html_resource))
        .route("/asset", get(asset))
        .route("/pdf/page", get(pdf_page))
        .route("/typst/page", get(typst_page))
        .with_state(state.clone());
    Router::new()
        .route("/", get(index))
        .route("/{repoId}/tree", get(repository_tree_redirect))
        .nest("/api", api.clone())
        .nest("/{repoId}/api", api)
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
        html_token: Arc::new(new_capability_token()?),
        search: Arc::new(search::SearchService::default()),
        data_directory: Arc::new(data_directory.clone()),
        leases: Arc::new(Mutex::new(HashMap::new())),
        library_clients: Arc::new(Mutex::new(HashMap::new())),
        trees: tree::Service::default(),
        file_watchers: Arc::new(Mutex::new(HashMap::new())),
        repositories,
        reading: Arc::new(reading::ReadingStore::new(data_directory.clone())),
        cross_search: Arc::new(Mutex::new(HashMap::new())),
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
mod tests {
    use super::*;

    #[tokio::test]
    async fn shutdown_ends_all_sse_streams_and_releases_session_registration() {
        let temporary = tempfile::tempdir().unwrap();
        let (state, slug) = test_state(&temporary);
        let app = build_router(state.clone());
        let paths = [
            format!("/{slug}/api/library/events?path=note.md"),
            format!("/{slug}/api/library/tree-events"),
            format!("/api/library/session?client=shutdown-client-1234&repo={slug}"),
        ];
        let mut streams = Vec::new();
        for path in paths {
            let response = request(&app, "GET", &path, None).await;
            assert_eq!(response.status(), StatusCode::OK);
            let mut stream = response.into_body().into_data_stream();
            tokio::time::timeout(std::time::Duration::from_secs(1), stream.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            streams.push(stream);
        }
        state.shutdown.send_replace(true);
        for mut stream in streams {
            assert!(
                tokio::time::timeout(std::time::Duration::from_secs(1), stream.next())
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        assert!(state.library_clients.lock().unwrap().is_empty());
        state.document_workers.shutdown().await;
        state.rendering.close().await;
    }
    use axum::{
        body::{Body, to_bytes},
        http::Request as HttpRequest,
    };
    use futures_util::TryStreamExt;
    use tower::ServiceExt;

    async fn request(
        app: &Router,
        method: &str,
        uri: &str,
        body: Option<serde_json::Value>,
    ) -> Response {
        let mut builder = HttpRequest::builder().method(method).uri(uri);
        let body = match body {
            Some(value) => {
                builder = builder.header("content-type", "application/json");
                Body::from(value.to_string())
            }
            None => Body::empty(),
        };
        app.clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap()
    }

    async fn json(response: Response) -> serde_json::Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn test_state(temporary: &tempfile::TempDir) -> (AppState, String) {
        let root = temporary.path().join("notes");
        let data = temporary.path().join("data");
        let web = temporary.path().join("dist/web");
        let assets = temporary.path().join("dist/assets");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&web).unwrap();
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(root.join("note.md"), "# Hello Rust\n\nneedle in markdown\n").unwrap();
        std::fs::write(
            root.join("sample.html"),
            "<html><head><base href=\"https://invalid.example/\"></head><body><script>window.ready=true</script><iframe src=\"https://invalid.example\"></iframe><link rel=\"stylesheet\" href=\"theme.css\"><a href=\"#section\">Jump</a></body></html>",
        )
        .unwrap();
        std::fs::write(root.join("theme.css"), "body { color: rebeccapurple; }").unwrap();
        std::fs::write(
            web.join("index.html"),
            "<!doctype html><main>library app</main>",
        )
        .unwrap();
        std::fs::write(assets.join("app.js"), "console.log('loaded')").unwrap();
        let repositories =
            Arc::new(repositories::RepositoryStore::open(&data, Some(&root)).unwrap());
        let repo = repositories.list().unwrap().remove(0);
        (
            AppState {
                root: Arc::new(root.clone()),
                service_root: Arc::new(root.clone()),
                dist: Arc::new(web),
                document_workers: worker::WorkerPool::new("document", 1, 16),
                rendering: Arc::new(render::RenderService::default()),
                shutdown: tokio::sync::watch::channel(false).0,
                html_token: Arc::new(new_capability_token().unwrap()),
                search: Arc::new(search::SearchService::default()),
                data_directory: Arc::new(data.clone()),
                leases: Arc::new(Mutex::new(HashMap::new())),
                library_clients: Arc::new(Mutex::new(HashMap::new())),
                trees: tree::Service::default(),
                file_watchers: Arc::new(Mutex::new(HashMap::new())),
                repositories,
                reading: Arc::new(reading::ReadingStore::new(data)),
                cross_search: Arc::new(Mutex::new(HashMap::new())),
                base_url: Arc::new("http://127.0.0.1:49191".into()),
            },
            repo.slug,
        )
    }

    fn minimal_pdf(width: usize, height: usize) -> Vec<u8> {
        let content = "BT /F1 14 Tf 24 48 Td (PDF preview) Tj ET";
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
            ),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
            format!(
                "<< /Length {} >>\nstream\n{content}\nendstream",
                content.len()
            ),
        ];
        let mut output = b"%PDF-1.4\n".to_vec();
        let mut offsets = vec![0usize];
        for (index, object) in objects.iter().enumerate() {
            offsets.push(output.len());
            output
                .extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
        }
        let xref = output.len();
        output.extend_from_slice(
            format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len()).as_bytes(),
        );
        for offset in offsets.iter().skip(1) {
            output.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        output.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                offsets.len()
            )
            .as_bytes(),
        );
        output
    }

    #[tokio::test]
    async fn html_raw_source_and_multiple_asset_watches_match_frontend_contract() {
        let temporary = tempfile::tempdir().unwrap();
        let (state, slug) = test_state(&temporary);
        let expected = std::fs::read_to_string(state.root.join("sample.html")).unwrap();
        let app = build_router(state.clone());
        let document = json(
            request(
                &app,
                "GET",
                &format!("/{slug}/api/document?path=sample.html&view=raw"),
                None,
            )
            .await,
        )
        .await;
        assert_eq!(document["source"], expected);
        assert_eq!(document["lineCount"], expected.split('\n').count());
        let response = request(
            &app,
            "GET",
            &format!("/{slug}/api/library/events?path=sample.html&asset=theme.css&asset=note.md"),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let watchers = state.file_watchers.lock().unwrap();
        let key = watchers.keys().next().unwrap();
        assert_eq!(key.len(), 3);
        assert_eq!(key[1].1, "theme.css");
        assert_eq!(key[2].1, "note.md");
    }

    #[tokio::test]
    async fn saturated_render_queue_returns_retryable_errors() {
        let temporary = tempfile::tempdir().unwrap();
        let (mut state, slug) = test_state(&temporary);
        state.document_workers = worker::WorkerPool::new("saturated", 1, 1);
        let pool = state.document_workers.clone();
        let (release, wait) = std::sync::mpsc::channel();
        let (started, ready) = tokio::sync::oneshot::channel();
        let running = tokio::spawn(async move {
            pool.run(move || {
                let _ = started.send(());
                wait.recv().unwrap();
            })
            .await
        });
        ready.await.unwrap();
        let pool = state.document_workers.clone();
        let mut queued = Box::pin(pool.run(|| ()));
        assert!(futures_util::poll!(&mut queued).is_pending());
        let app = build_router(state);
        for endpoint in ["document?path=note.md", "html?path=sample.html"] {
            let response = request(&app, "GET", &format!("/{slug}/api/{endpoint}"), None).await;
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(response.headers().get("retry-after").unwrap(), "1");
        }
        drop(queued);
        release.send(()).unwrap();
        running.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn file_stream_preserves_large_payloads_across_chunk_boundaries() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("payload.bin");
        let expected = (0..150_000)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        std::fs::write(&path, &expected).unwrap();
        let file = tokio::fs::File::open(path).await.unwrap();
        let chunks = stream_file(file).try_collect::<Vec<_>>().await.unwrap();
        let actual = chunks.into_iter().flatten().collect::<Vec<_>>();
        assert_eq!(actual, expected);
    }

    #[tokio::test]
    async fn content_detection_preserves_renamed_previews_assets_and_text_semantics() {
        let temporary = tempfile::tempdir().unwrap();
        let (state, slug) = test_state(&temporary);
        let root = state.default_repository().unwrap().root;
        let pdf = minimal_pdf(595, 842);
        let png = b"\x89PNG\r\n\x1a\n";
        std::fs::write(root.join("renamed.txt"), &pdf).unwrap();
        std::fs::write(root.join("picture.pdf"), png).unwrap();
        std::fs::write(root.join("archive.txt"), b"PK\x03\x04\0\0\0\0").unwrap();
        std::fs::write(root.join("inline.md"), "<div>needle</div>\n").unwrap();
        let app = build_router(state);

        let metadata = json(
            request(
                &app,
                "GET",
                &format!("/{slug}/api/document?path=renamed.txt"),
                None,
            )
            .await,
        )
        .await;
        assert_eq!(metadata["type"], "pdf");
        assert_eq!(metadata["pages"].as_array().unwrap().len(), 1);
        let page_url = metadata["pages"][0]["url"].as_str().unwrap();
        assert_eq!(
            request(&app, "GET", page_url, None).await.status(),
            StatusCode::OK
        );

        let image = json(
            request(
                &app,
                "GET",
                &format!("/{slug}/api/document?path=picture.pdf"),
                None,
            )
            .await,
        )
        .await;
        assert_eq!(image["type"], "image");
        assert_eq!(image["mime"], "image/png");
        assert_eq!(image["format"], "png");
        let asset = request(&app, "GET", image["url"].as_str().unwrap(), None).await;
        assert_eq!(asset.headers()["content-type"], "image/png");
        assert_eq!(
            &to_bytes(asset.into_body(), usize::MAX).await.unwrap()[..],
            png
        );

        let archive = json(
            request(
                &app,
                "GET",
                &format!("/{slug}/api/document?path=archive.txt"),
                None,
            )
            .await,
        )
        .await;
        assert_eq!(archive["type"], "binary");
        assert_eq!(archive["mime"], "application/zip");
        let markdown = json(
            request(
                &app,
                "GET",
                &format!("/{slug}/api/document?path=inline.md&view=raw"),
                None,
            )
            .await,
        )
        .await;
        assert_eq!(markdown["type"], "markdown");

        let search =
            json(request(&app, "GET", &format!("/{slug}/api/search?q=PDF-1"), None).await).await;
        assert_eq!(search["total"], 0);
    }

    #[tokio::test]
    async fn migrated_http_routes_match_frontend_repository_flows() {
        let temporary = tempfile::tempdir().unwrap();
        let (state, slug) = test_state(&temporary);
        let html_token = state.html_token.clone();
        let app = build_router(state.clone());

        let home = request(&app, "GET", "/", None).await;
        assert_eq!(home.status(), StatusCode::PERMANENT_REDIRECT);
        assert_eq!(
            home.headers().get("location").unwrap().to_str().unwrap(),
            format!("/{slug}/tree/")
        );

        let page = request(&app, "GET", &format!("/{slug}/tree/"), None).await;
        assert_eq!(page.status(), StatusCode::OK);
        assert!(
            String::from_utf8(
                to_bytes(page.into_body(), usize::MAX)
                    .await
                    .unwrap()
                    .to_vec()
            )
            .unwrap()
            .contains("library app")
        );
        let asset = request(&app, "GET", "/assets/app.js", None).await;
        assert_eq!(asset.status(), StatusCode::OK);

        let tree = json(request(&app, "GET", &format!("/{slug}/api/tree"), None).await).await;
        assert_eq!(tree["name"], "notes");
        assert_eq!(tree["children"][0]["path"], "note.md");
        let document = json(
            request(
                &app,
                "GET",
                &format!("/{slug}/api/document?path=note.md"),
                None,
            )
            .await,
        )
        .await;
        assert_eq!(document["type"], "markdown");
        assert!(
            document["html"]
                .as_str()
                .unwrap()
                .contains("needle in markdown")
        );
        let html = request(
            &app,
            "GET",
            &format!("/{slug}/api/html?path=sample.html"),
            None,
        )
        .await;
        assert_eq!(html.status(), StatusCode::OK);
        assert!(html.headers().contains_key("content-security-policy"));
        let html = String::from_utf8(
            to_bytes(html.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(html.contains("window.ready=true"));
        assert!(!html.contains("<iframe"));
        assert!(!html.contains("https://invalid.example/"));
        assert!(html.contains("#section"));
        let css = request(
            &app,
            "GET",
            &format!(
                "/{slug}/api/html-resource/{}/theme.css",
                html_token.as_str()
            ),
            None,
        )
        .await;
        assert_eq!(
            css.status(),
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&to_bytes(css.into_body(), usize::MAX).await.unwrap())
        );
        assert_eq!(css.headers().get("content-type").unwrap(), "text/css");
        let denied = request(
            &app,
            "GET",
            &format!("/{slug}/api/html-resource/not-a-token/theme.css"),
            None,
        )
        .await;
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        let search =
            json(request(&app, "GET", &format!("/{slug}/api/search?q=needle"), None).await).await;
        assert_eq!(search["files"][0]["path"], "note.md");

        let lease_uri = format!("/{slug}/api/library/session-leases");
        let lease = request(
            &app,
            "POST",
            &lease_uri,
            Some(serde_json::json!({
                "client":"reader-1", "paths":["note.md"], "version":1
            })),
        )
        .await;
        assert_eq!(lease.status(), StatusCode::OK);
        let stale_release = request(
            &app,
            "POST",
            &lease_uri,
            Some(serde_json::json!({
                "client":"reader-1", "paths":[], "version":1
            })),
        )
        .await;
        assert_eq!(stale_release.status(), StatusCode::OK);
        assert_eq!(state.leases.lock().unwrap()["reader-1"].paths.len(), 1);
        let invalid_lease = request(
            &app,
            "POST",
            &lease_uri,
            Some(serde_json::json!({
                "client":"reader-1", "paths":["../outside"], "version":2
            })),
        )
        .await;
        assert_eq!(invalid_lease.status(), StatusCode::BAD_REQUEST);
        assert_eq!(state.leases.lock().unwrap()["reader-1"].paths.len(), 1);
        let release = request(
            &app,
            "POST",
            &lease_uri,
            Some(serde_json::json!({
                "client":"reader-1", "paths":[], "version":2
            })),
        )
        .await;
        assert_eq!(release.status(), StatusCode::OK);
        assert!(state.leases.lock().unwrap()["reader-1"].paths.is_empty());

        let invalid = request(
            &app,
            "GET",
            &format!("/{slug}/api/document?path=../outside"),
            None,
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            request(&app, "GET", "/missing/api/tree", None)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );

        let bookmark = request(
            &app,
            "PUT",
            &format!("/{slug}/api/bookmarks"),
            Some(serde_json::json!({"path":"note.md","bookmarked":true})),
        )
        .await;
        assert_eq!(bookmark.status(), StatusCode::OK);
        assert_eq!(json(request(&app, "GET", &format!("/{slug}/api/bookmarks"), None).await).await["bookmarks"].as_array().unwrap().len(), 1);
        let positions = serde_json::json!({"positions":{"note.md":{"line":12,"view":"raw"}}});
        assert_eq!(
            request(
                &app,
                "PUT",
                &format!("/{slug}/api/reading"),
                Some(positions)
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            json(request(&app, "GET", &format!("/{slug}/api/reading"), None).await).await["note.md"]
                ["line"],
            12
        );
        let recent = request(
            &app,
            "POST",
            &format!("/{slug}/api/recent-files"),
            Some(serde_json::json!({"path":"note.md"})),
        )
        .await;
        assert_eq!(recent.status(), StatusCode::OK);
        assert_eq!(json(recent).await["recent"][0], "note.md");

        let cross_origin = HttpRequest::builder()
            .method("PUT")
            .uri(format!("/{slug}/api/bookmarks"))
            .header("content-type", "application/json")
            .header("origin", "https://attacker.example")
            .body(Body::from(r#"{"path":"note.md","bookmarked":false}"#))
            .unwrap();
        let rejected = app.clone().oneshot(cross_origin).await.unwrap();
        assert_eq!(rejected.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn pdf_document_reports_a_valid_modified_timestamp() {
        let temporary = tempfile::tempdir().unwrap();
        let (state, slug) = test_state(&temporary);
        std::fs::write(state.root.join("sample.pdf"), minimal_pdf(595, 842)).unwrap();
        let app = build_router(state);

        let response = request(
            &app,
            "GET",
            &format!("/{slug}/api/document?path=sample.pdf"),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let document = json(response).await;
        let modified = document["modified"].as_str().unwrap();
        assert!(
            time::OffsetDateTime::parse(modified, &time::format_description::well_known::Rfc3339)
                .is_ok()
        );
        let revision = document["revision"].as_str().unwrap();
        assert_ne!(revision, modified);
        assert_eq!(
            request(
                &app,
                "GET",
                &format!("/{slug}/api/pdf/page?path=sample.pdf&page=1&v={revision}&width=450"),
                None,
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            request(
                &app,
                "GET",
                &format!("/{slug}/api/pdf/page?path=sample.pdf&page=1&v=stale&width=450"),
                None,
            )
            .await
            .status(),
            StatusCode::GONE
        );
    }

    #[tokio::test]
    async fn document_and_asset_changes_are_both_emitted_by_library_events() {
        let temporary = tempfile::tempdir().unwrap();
        let (state, slug) = test_state(&temporary);
        let root = state.default_repository().unwrap().root;
        let app = build_router(state.clone());
        let mut streams = Vec::new();
        for _ in 0..2 {
            let response = request(
                &app,
                "GET",
                &format!("/{slug}/api/library/events?path=sample.html&asset=theme.css"),
                None,
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            streams.push(Box::pin(response.into_body().into_data_stream()));
        }
        assert_eq!(state.file_watchers.lock().unwrap().len(), 1);
        for stream in &mut streams {
            let mut body = String::new();
            while !body.contains("event: connected") {
                let chunk = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                body.push_str(&String::from_utf8_lossy(&chunk));
            }
        }
        std::fs::write(root.join("sample.html"), "<html>changed</html>").unwrap();
        std::fs::write(root.join("theme.css"), "body{color:blue}").unwrap();
        for stream in &mut streams {
            let mut body = String::new();
            while !body.contains("event: document") || !body.contains("event: assets") {
                let chunk = tokio::time::timeout(std::time::Duration::from_secs(3), stream.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                body.push_str(&String::from_utf8_lossy(&chunk));
            }
            assert!(body.contains("data: {\"paths\":[\"theme.css\"]}"));
        }
    }

    #[tokio::test]
    async fn cross_repository_search_keeps_facets_and_pagination_consistent() {
        let temporary = tempfile::tempdir().unwrap();
        let (state, _slug) = test_state(&temporary);
        let second_root = temporary.path().join("archive");
        std::fs::create_dir_all(&second_root).unwrap();
        for index in 0..24 {
            std::fs::write(
                second_root.join(format!("note-{index:02}.md")),
                "needle in archive\n",
            )
            .unwrap();
        }
        let app = build_router(state);
        let added = request(
            &app,
            "POST",
            "/api/repos",
            Some(serde_json::json!({"root":second_root})),
        )
        .await;
        assert_eq!(added.status(), StatusCode::CREATED);

        let first =
            json(request(&app, "GET", "/api/search-repos?q=needle&repo=*", None).await).await;
        assert_eq!(first["total"], 25);
        assert_eq!(first["files"].as_array().unwrap().len(), 20);
        assert_eq!(first["nextOffset"], 20);
        assert!(first["facets"]["languages"].is_array());
        assert!(
            first["files"]
                .as_array()
                .unwrap()
                .iter()
                .all(|file| file["repoId"].is_string() && file["repoName"].is_string())
        );
        let search_id = first["searchId"].as_str().unwrap();
        let second = json(
            request(
                &app,
                "GET",
                &format!("/api/search-repos?q=needle&repo=*&searchId={search_id}&offset=20"),
                None,
            )
            .await,
        )
        .await;
        assert_eq!(second["total"], 25);
        assert_eq!(second["files"].as_array().unwrap().len(), 5);
        assert!(second["nextOffset"].is_null());
        let expired = request(
            &app,
            "GET",
            &format!("/api/search-repos?q=other&repo=*&searchId={search_id}"),
            None,
        )
        .await;
        assert_eq!(expired.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn pdf_metadata_and_page_route_match_frontend_contract() {
        let temporary = tempfile::tempdir().unwrap();
        let (state, slug) = test_state(&temporary);
        let root = state.default_repository().unwrap().root;
        std::fs::write(root.join("sample.pdf"), minimal_pdf(595, 842)).unwrap();
        let app = build_router(state);
        let metadata = json(
            request(
                &app,
                "GET",
                &format!("/{slug}/api/document?path=sample.pdf"),
                None,
            )
            .await,
        )
        .await;
        assert_eq!(metadata["type"], "pdf");
        assert_eq!(metadata["pages"].as_array().unwrap().len(), 1);
        let page_url = metadata["pages"][0]["url"].as_str().unwrap();
        let page = request(
            &app,
            "GET",
            &format!(
                "{page_url}&v={}&width=2250",
                metadata["revision"].as_str().unwrap()
            ),
            None,
        )
        .await;
        assert_eq!(page.status(), StatusCode::OK);
        assert_eq!(
            page.headers().get("content-type").unwrap(),
            "image/svg+xml; charset=utf-8"
        );
        let svg = String::from_utf8(
            to_bytes(page.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(svg.contains("<svg"));
        let invalid_width = request(&app, "GET", &format!("{page_url}&width=0"), None).await;
        assert_eq!(invalid_width.status(), StatusCode::BAD_REQUEST);
        let stale = request(&app, "GET", &format!("{page_url}&v=stale"), None).await;
        assert_eq!(stale.status(), StatusCode::GONE);
    }

    #[tokio::test]
    async fn tree_event_scanning_is_shared_and_emits_after_changes() {
        let temporary = tempfile::tempdir().unwrap();
        let (state, slug) = test_state(&temporary);
        let root = state.default_repository().unwrap().root;
        let app = build_router(state.clone());
        let mut streams = Vec::new();
        for _ in 0..2 {
            let response = request(
                &app,
                "GET",
                &format!("/{slug}/api/library/tree-events"),
                None,
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            streams.push(Box::pin(response.into_body().into_data_stream()));
        }
        assert_eq!(state.trees.cached_roots(), 1);
        for stream in &mut streams {
            let mut handshake = String::new();
            while !handshake.contains("event: connected") {
                let chunk = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                handshake.push_str(&String::from_utf8_lossy(&chunk));
            }
        }
        std::fs::write(root.join("new-note.md"), "new").unwrap();
        for stream in &mut streams {
            let mut event = String::new();
            while !event.contains("event: tree") {
                let chunk = tokio::time::timeout(std::time::Duration::from_secs(3), stream.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                event.push_str(&String::from_utf8_lossy(&chunk));
            }
        }
        drop(streams);
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        assert_eq!(state.trees.cached_roots(), 1); // Reuse the idle cache on reconnect.
    }
}
