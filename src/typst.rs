//! Native Typst compilation and lazy per-page SVG export.
//!
//! A compiler instance is owned by the Typst worker/service. The HTTP layer
//! calls it from a dedicated bounded worker; this type serializes compilation and keeps a
//! small, bounded set of paged documents for subsequent page requests.

use crate::resources::{ByteCache, Cancellation};
use lru::LruCache;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration as StdDuration, Instant, SystemTime, UNIX_EPOCH},
};
use typst::{
    Library, LibraryExt, World, WorldExt,
    diag::{FileError, FileResult, Warned},
    foundations::{Bytes, Datetime, Dict, Duration, IntoValue, Str},
    syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot},
    text::{Font, FontBook},
    utils::LazyHash,
};
use typst_kit::{
    datetime::Time,
    downloader::SystemDownloader,
    files::{FileLoader, FileStore, FsRoot},
    fonts::{FontPath, FontStore},
    packages::SystemPackages,
};
use typst_layout::PagedDocument;

const DOCUMENT_LIMIT: usize = 3;
const SOURCE_BYTES_LIMIT: usize = 16 * 1024 * 1024;
const REVISION_GRACE: StdDuration = StdDuration::from_secs(15);
pub type PageCache = Arc<Mutex<ByteCache<(String, usize), RenderedPage>>>;

pub fn page_cache() -> PageCache {
    Arc::new(Mutex::new(ByteCache::new(
        64,
        16 * 1024 * 1024,
        StdDuration::from_secs(5 * 60),
    )))
}
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
// Share fonts across compilers without keeping a strong process-global owner.
// Idle compilers release their references after their last layout is evicted.
static FONTS: OnceLock<Mutex<Weak<FontStore>>> = OnceLock::new();

fn typst_font_store() -> Arc<FontStore> {
    let fonts = FONTS.get_or_init(|| Mutex::new(Weak::new()));
    let mut fonts = fonts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(store) = fonts.upgrade() {
        return store;
    }
    let store = Arc::new(build_typst_font_store());
    *fonts = Arc::downgrade(&store);
    store
}

// Keep native TTF/OTF inputs in fonts/manifest.json. Browser WOFF2 assets are
// separate: the native parser cannot decode webfont containers directly.
fn build_typst_font_store() -> FontStore {
    let explicit = std::env::var_os("TYPST_FONTS")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>());
    let base = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .filter(|directory| directory.join("fonts/manifest.json").is_file())
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    let requested = explicit.unwrap_or_else(|| {
        serde_json::from_str::<Vec<String>>(include_str!("../fonts/manifest.json"))
            .expect("bundled Typst font manifest is valid")
            .into_iter()
            .map(|name| base.join("fonts").join(name))
            .collect()
    });

    let mut directories = HashMap::<PathBuf, bool>::new();
    let mut files = HashSet::new();
    for path in requested {
        if path.is_dir() {
            if let Ok(path) = path.canonicalize() {
                directories.insert(path, true);
            }
        } else if path.is_file()
            && let (Ok(file), Some(parent)) = (path.canonicalize(), path.parent())
            && let Ok(parent) = parent.canonicalize()
        {
            files.insert(file);
            directories.entry(parent).or_insert(false);
        }
    }

    let mut store = FontStore::new();
    for (directory, include_all) in directories {
        for (font, info) in typst_kit::fonts::scan(&directory) {
            if !include_all && !files.contains(&font.path) {
                continue;
            }
            let alias = font
                .path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| {
                    if name.starts_with("SourceHanSerif") {
                        Some("Source Han Serif SC")
                    } else if name.starts_with("SourceHanSans") {
                        Some("Source Han Sans SC")
                    } else {
                        None
                    }
                })
                .map(|family| {
                    let mut alias = info.clone();
                    alias.family = family.into();
                    alias
                });
            let alias_font = alias.as_ref().map(|_| FontPath {
                path: font.path.clone(),
                index: font.index,
            });
            store.push((font, info));
            if let (Some(font), Some(info)) = (alias_font, alias) {
                // Mirror the old worker's Source Han CN -> SC family alias
                // without rewriting or retaining another copy of the font.
                store.push((font, info));
            }
        }
    }
    store
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileRequest {
    pub path: String,
    pub source: String,
    #[serde(default)]
    pub theme: Option<String>,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum CompileError {
    #[error("{0}")]
    Failed(String),
    #[error("Typst compilation failed")]
    Diagnostics(Vec<Diagnostic>),
    #[error("Typst resources are busy; close an unused reader and retry")]
    Busy,
    #[error("Typst request cancelled")]
    Cancelled,
}

impl From<String> for CompileError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

impl From<&str> for CompileError {
    fn from(message: &str) -> Self {
        Self::Failed(message.into())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub file: String,
    pub severity: String,
    pub message: String,
    pub range: Option<DiagnosticRange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticRange {
    pub start: DiagnosticPosition,
    pub end: DiagnosticPosition,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticPosition {
    pub line: usize,
    pub column: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct PageInfo {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineItem {
    pub name: String,
    pub level: usize,
    pub line: usize,
    pub position: Option<AnchorPosition>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnchorPosition {
    pub page: usize,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceAnchor {
    pub line: usize,
    pub page: usize,
    pub y: f64,
    pub absolute_y: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageLink {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
    // TODO: Typst's laid-out FrameItem::Link has no target/window metadata;
    // preserve `_blank` if a future Typst API exposes it.
}

#[derive(Clone)]
pub struct RenderedPage {
    pub svg: bytes::Bytes,
    pub links: Vec<PageLink>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResponse {
    pub id: String,
    pub pages: Vec<PageInfo>,
    pub diagnostics: Vec<Diagnostic>,
    pub outline: Vec<OutlineItem>,
    pub anchors: Vec<SourceAnchor>,
}

pub struct NativeTypstCompiler {
    root: PathBuf,
    compile_gate: Mutex<()>,
    state: Mutex<Documents>,
    fonts: Mutex<Option<Arc<FontStore>>>,
    pages: PageCache,
}

struct Documents {
    entries: LruCache<String, Entry>,
    compiled: HashMap<CompileKey, String>,
    active_paths: HashSet<PathBuf>,
    last_activity: Instant,
    generation: u64,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct CompileKey {
    path: PathBuf,
    theme: String,
    source_hash: u128,
}

struct Entry {
    path: PathBuf,
    document: Arc<PagedDocument>,
    theme: String,
    created: Instant,
    last_used: Instant,
    key: CompileKey,
    source: Arc<str>,
    response: CompileResponse,
    dependencies: Vec<Dependency>,
    dates: Vec<(Option<Duration>, Option<Datetime>)>,
    superseded_at: Option<Instant>,
}

fn remove_document(state: &mut Documents, pages: &PageCache, id: &str) {
    if let Some(entry) = state.entries.pop(id) {
        if state
            .compiled
            .get(&entry.key)
            .is_some_and(|cached| cached == id)
        {
            state.compiled.remove(&entry.key);
        }
    }
    if let Ok(mut pages) = pages.lock() {
        pages.retain(|(entry_id, _)| entry_id != id);
    }
}

// Keep at most two revisions per path/theme. Only the latest revision of an
// active document is pinned; old revisions cannot accumulate behind a lease.
fn trim_documents(state: &mut Documents, pages: &PageCache, protected: &str) {
    let mut versions = HashMap::<(PathBuf, String), Vec<(String, Instant)>>::new();
    for (id, entry) in state.entries.iter() {
        versions
            .entry((entry.path.clone(), entry.theme.clone()))
            .or_default()
            .push((id.clone(), entry.created));
    }
    let mut pinned = HashSet::new();
    let mut expired = Vec::new();
    for ((path, _), entries) in &mut versions {
        entries.sort_by_key(|(_, created)| *created);
        if state.active_paths.contains(path) {
            if let Some((id, _)) = entries.last() {
                pinned.insert(id.clone());
            }
        }
        expired.extend(
            entries
                .iter()
                .take(entries.len().saturating_sub(2))
                .map(|(id, _)| id.clone()),
        );
    }
    for id in expired {
        if id != protected {
            if state
                .entries
                .peek(&id)
                .is_some_and(|entry| Arc::strong_count(&entry.document) == 1)
            {
                remove_document(state, pages, &id);
            }
        }
    }
    while state.entries.len() > DOCUMENT_LIMIT {
        let victim = state
            .entries
            .iter()
            .rev()
            .find(|(id, entry)| {
                id.as_str() != protected
                    && !pinned.contains(*id)
                    && Arc::strong_count(&entry.document) == 1
                    && !entry
                        .superseded_at
                        .is_some_and(|at| at.elapsed() < REVISION_GRACE)
            })
            .map(|(id, _)| id.clone());
        let Some(id) = victim else { break };
        remove_document(state, pages, &id);
    }
}

impl NativeTypstCompiler {
    #[cfg(test)]
    #[allow(dead_code)] // Standalone lifecycle benchmark diagnostics.
    pub fn cache_usage(&self) -> (usize, usize, usize, usize) {
        let state = self.state.lock().unwrap();
        let (pages, bytes) = self.pages.lock().unwrap().usage();
        (
            state.entries.len(),
            state
                .entries
                .iter()
                .map(|(_, entry)| entry.source.len())
                .sum(),
            pages,
            bytes,
        )
    }
    #[cfg(test)]
    pub fn new(root: PathBuf) -> Self {
        Self::with_page_cache(root, page_cache())
    }

    pub fn with_page_cache(root: PathBuf, pages: PageCache) -> Self {
        Self {
            root,
            compile_gate: Mutex::new(()),
            fonts: Mutex::new(None),
            pages,
            state: Mutex::new(Documents {
                entries: LruCache::unbounded(),
                compiled: HashMap::new(),
                active_paths: HashSet::new(),
                last_activity: Instant::now(),
                generation: 0,
            }),
        }
    }

    pub fn has_active_documents(&self) -> bool {
        self.state
            .lock()
            .map(|state| !state.active_paths.is_empty())
            .unwrap_or(true)
    }

    pub fn set_active_paths(&self, paths: impl IntoIterator<Item = PathBuf>) {
        if let Ok(mut state) = self.state.lock() {
            state.active_paths = paths
                .into_iter()
                .filter(|path| {
                    path.starts_with(&self.root)
                        && path
                            .extension()
                            .and_then(|ext| ext.to_str())
                            .is_some_and(|ext| ext.eq_ignore_ascii_case("typ"))
                })
                .collect();
        }
    }

    /// Release idle document layouts and rendered SVGs while preserving any
    /// document currently pinned by a browser lease.
    pub fn evict_idle(&self, idle_for: StdDuration) -> bool {
        let Ok(_compile) = self.compile_gate.try_lock() else {
            return false;
        };
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let all_idle = state.last_activity.elapsed() >= idle_for;
        trim_documents(&mut state, &self.pages, "");
        let inactive = state
            .entries
            .iter()
            .filter(|(_, entry)| {
                Arc::strong_count(&entry.document) == 1
                    && match entry.superseded_at {
                        Some(at) => at.elapsed() >= REVISION_GRACE,
                        None => {
                            !state.active_paths.contains(&entry.path)
                                && entry.last_used.elapsed() >= idle_for
                        }
                    }
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in inactive {
            remove_document(&mut state, &self.pages, &id);
        }
        if state.entries.is_empty() {
            if let Ok(mut fonts) = self.fonts.lock() {
                fonts.take();
            }
        }
        if let Ok(mut pages) = self.pages.lock() {
            pages.prune();
        }
        all_idle
    }

    pub fn clear(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.generation = state.generation.wrapping_add(1);
            let ids = state
                .entries
                .iter()
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for id in ids {
                remove_document(&mut state, &self.pages, &id);
            }
            state.active_paths.clear();
        }
        if let Ok(mut fonts) = self.fonts.lock() {
            fonts.take();
        }
    }

    fn font_store(&self) -> Result<Arc<FontStore>, String> {
        let mut fonts = self
            .fonts
            .lock()
            .map_err(|_| "Typst font store lock poisoned".to_owned())?;
        if let Some(store) = fonts.as_ref() {
            return Ok(store.clone());
        }
        let store = typst_font_store();
        *fonts = Some(store.clone());
        Ok(store)
    }

    #[cfg(test)]
    pub fn compile(&self, request: CompileRequest) -> Result<CompileResponse, CompileError> {
        self.compile_cancellable(request, &Cancellation::default())
    }

    pub fn compile_cancellable(
        &self,
        request: CompileRequest,
        cancellation: &Cancellation,
    ) -> Result<CompileResponse, CompileError> {
        if cancellation.is_cancelled() {
            return Err(CompileError::Cancelled);
        }
        let _compile = self
            .compile_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let path = checked_typst_path(&self.root, &request.path)?;
        let theme = request
            .theme
            .as_deref()
            .filter(|value| *value == "dark")
            .unwrap_or("light");
        if let Ok(mut state) = self.state.lock() {
            state.last_activity = Instant::now();
        }
        let key = CompileKey {
            path: path.clone(),
            theme: theme.into(),
            source_hash: typst::utils::hash128(&request.source),
        };
        let candidate = {
            let state = self
                .state
                .lock()
                .map_err(|_| "Typst cache lock poisoned".to_owned())?;
            state.compiled.get(&key).and_then(|id| {
                state.entries.peek(id).map(|entry| {
                    (
                        id.clone(),
                        entry.source.clone(),
                        entry.dependencies.clone(),
                        entry.dates.clone(),
                    )
                })
            })
        };
        if let Some((id, source, dependencies, dates)) = candidate {
            let now = Time::system();
            if source.as_ref() == request.source
                && dependencies.iter().all(Dependency::unchanged)
                && dates
                    .iter()
                    .all(|(offset, date)| now.today(*offset) == *date)
            {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| "Typst cache lock poisoned".to_owned())?;
                for (other_id, entry) in state.entries.iter_mut() {
                    if other_id != &id
                        && entry.path == path
                        && entry.theme == theme
                        && entry.superseded_at.is_none()
                    {
                        entry.superseded_at = Some(Instant::now());
                    }
                }
                if let Some(entry) = state.entries.get_mut(&id) {
                    entry.last_used = Instant::now();
                    entry.created = Instant::now();
                    entry.superseded_at = None;
                    return Ok(entry.response.clone());
                }
            }
        }
        let generation = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Typst cache lock poisoned".to_owned())?;
            trim_documents(&mut state, &self.pages, "");
            // A fixed admission limit bounds lease-pinned layouts too. Existing
            // documents can still update by superseding their previous version.
            if state.entries.len() >= 32
                && !state
                    .entries
                    .iter()
                    .any(|(_, entry)| entry.path == path && entry.theme == theme)
            {
                return Err(CompileError::Busy);
            }
            loop {
                let source_bytes = state
                    .entries
                    .iter()
                    .map(|(_, entry)| entry.source.len())
                    .sum::<usize>();
                if source_bytes.saturating_add(request.source.len()) <= SOURCE_BYTES_LIMIT {
                    break;
                }
                let victim = state
                    .entries
                    .iter()
                    .rev()
                    .find(|(_, entry)| {
                        Arc::strong_count(&entry.document) == 1
                            && !(state.active_paths.contains(&entry.path)
                                && entry.superseded_at.is_none())
                            && !entry
                                .superseded_at
                                .is_some_and(|at| at.elapsed() < REVISION_GRACE)
                    })
                    .map(|(id, _)| id.clone());
                let Some(id) = victim else {
                    return Err(CompileError::Busy);
                };
                remove_document(&mut state, &self.pages, &id);
            }
            state.generation
        };
        let source: Arc<str> = Arc::from(request.source.as_str());
        let world = TypstWorld::new(&self.root, &path, request.source, theme, self.font_store()?)?;
        let Warned { output, warnings } = typst::compile::<PagedDocument>(&world);
        // Age unused comemo results during active use. The service also clears
        // the process-global cache after every root compiler has been idle.
        comemo::evict(30);
        let mut diagnostics = map_diagnostics(&world, warnings, "warning");
        let document = match output {
            Ok(document) => document,
            Err(errors) => {
                diagnostics.extend(map_diagnostics(&world, errors, "error"));
                return Err(CompileError::Diagnostics(diagnostics));
            }
        };
        let pages = document
            .pages()
            .iter()
            .map(|page| PageInfo {
                width: page.frame.width().to_pt(),
                height: page.frame.height().to_pt(),
            })
            .collect::<Vec<_>>();
        let (outline, anchors) = extract_navigation(&world, &document, &pages);
        let id = next_id();
        let response = CompileResponse {
            id: id.clone(),
            pages: pages.clone(),
            diagnostics,
            outline,
            anchors,
        };
        let dependencies = world
            .files
            .loader()
            .dependencies
            .lock()
            .map_err(|_| "Typst dependency lock poisoned")?
            .clone();
        let dates = world
            .dates
            .lock()
            .map_err(|_| "Typst date lock poisoned")?
            .clone();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Typst cache lock poisoned".to_owned())?;
        if cancellation.is_cancelled() || state.generation != generation {
            return Err(CompileError::Cancelled);
        }
        state.compiled.insert(key.clone(), id.clone());
        for (_, entry) in state.entries.iter_mut() {
            if entry.path == path && entry.theme == theme && entry.superseded_at.is_none() {
                entry.superseded_at = Some(Instant::now());
            }
        }
        state.entries.put(
            id.clone(),
            Entry {
                path,
                document: Arc::new(document),
                theme: theme.to_owned(),
                created: Instant::now(),
                last_used: Instant::now(),
                key,
                source,
                response: response.clone(),
                dependencies,
                dates,
                superseded_at: None,
            },
        );
        trim_documents(&mut state, &self.pages, &id);
        Ok(response)
    }

    pub fn page(&self, id: &str, page: usize) -> Result<RenderedPage, String> {
        self.page_cancellable(id, page, &Cancellation::default())
    }

    pub fn page_cancellable(
        &self,
        id: &str,
        page: usize,
        cancellation: &Cancellation,
    ) -> Result<RenderedPage, String> {
        let (document, page_index) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Typst cache lock poisoned".to_owned())?;
            state.last_activity = Instant::now();
            let entry = state
                .entries
                .get_mut(id)
                .ok_or_else(|| "Typst document expired".to_owned())?;
            if page == 0 || page > entry.document.pages().len() {
                return Err("Invalid Typst page".into());
            }
            let document = entry.document.clone();
            entry.last_used = Instant::now();
            if let Some(rendered) = self
                .pages
                .lock()
                .map_err(|_| "Typst page cache lock poisoned")?
                .get(&(id.to_owned(), page))
            {
                return Ok(rendered);
            }
            (document, page - 1)
        };
        let page_layout = &document.pages()[page_index];
        let options = typst_svg::SvgOptions::default();
        let svg = bytes::Bytes::from(typst_svg::svg(page_layout, &options));
        let links = extract_page_links(page_layout, page, document.introspector());
        let state = self
            .state
            .lock()
            .map_err(|_| "Typst cache lock poisoned".to_owned())?;
        let rendered = RenderedPage { svg, links };
        if !cancellation.is_cancelled() && state.entries.contains(id) {
            let bytes = rendered.svg.len()
                + rendered
                    .links
                    .iter()
                    .map(|link| {
                        std::mem::size_of::<PageLink>() + link.href.as_ref().map_or(0, String::len)
                    })
                    .sum::<usize>();
            self.pages
                .lock()
                .map_err(|_| "Typst page cache lock poisoned")?
                .insert((id.to_owned(), page), rendered.clone(), bytes);
        }
        Ok(rendered)
    }

    #[allow(dead_code)] // Also used by the standalone backend benchmark harness.
    pub fn page_svg(&self, id: &str, page: usize) -> Result<bytes::Bytes, String> {
        self.page(id, page).map(|rendered| rendered.svg)
    }
}

fn extract_page_links(
    page: &typst_layout::Page,
    page_number: usize,
    introspector: &typst_layout::PagedIntrospector,
) -> Vec<PageLink> {
    use typst::{
        layout::{Frame, FrameItem, Transform},
        model::Destination,
    };

    fn collect(
        frame: &Frame,
        transform: Transform,
        current_page: usize,
        page_width: f64,
        page_height: f64,
        introspector: &typst_layout::PagedIntrospector,
        output: &mut Vec<PageLink>,
    ) {
        for (position, item) in frame.items() {
            let transform = transform.pre_concat(Transform::translate(position.x, position.y));
            match item {
                FrameItem::Group(group) => collect(
                    &group.frame,
                    transform.pre_concat(group.transform),
                    current_page,
                    page_width,
                    page_height,
                    introspector,
                    output,
                ),
                FrameItem::Link(destination, size) => {
                    let (target_page, x, y, href) = match destination {
                        Destination::Url(url) => {
                            let href = url.as_str();
                            let scheme = href
                                .split_once(':')
                                .filter(|(prefix, _)| {
                                    !prefix.is_empty()
                                        && prefix.chars().all(|ch| {
                                            ch.is_ascii_alphanumeric()
                                                || matches!(ch, '+' | '.' | '-')
                                        })
                                })
                                .map(|(scheme, _)| scheme.to_ascii_lowercase());
                            if scheme.as_deref().is_some_and(|scheme| {
                                !matches!(scheme, "http" | "https" | "mailto" | "tel" | "ftp")
                            }) {
                                continue;
                            }
                            (None, None, None, Some(href.to_owned()))
                        }
                        Destination::Position(position) => (
                            Some(position.page.get()),
                            Some(position.point.x.to_pt()),
                            Some(position.point.y.to_pt()),
                            None,
                        ),
                        Destination::Location(location) => {
                            let Some(position) = introspector.position(*location) else {
                                continue;
                            };
                            (
                                Some(position.page.get()),
                                Some(position.point.x.to_pt()),
                                Some(position.point.y.to_pt()),
                                None,
                            )
                        }
                    };
                    let corners = [
                        typst::layout::Point::zero(),
                        typst::layout::Point::new(size.x, typst::layout::Abs::zero()),
                        typst::layout::Point::new(typst::layout::Abs::zero(), size.y),
                        typst::layout::Point::new(size.x, size.y),
                    ]
                    .map(|point| point.transform(transform));
                    let min_x = corners
                        .iter()
                        .map(|point| point.x.to_pt())
                        .fold(f64::INFINITY, f64::min);
                    let min_y = corners
                        .iter()
                        .map(|point| point.y.to_pt())
                        .fold(f64::INFINITY, f64::min);
                    let max_x = corners
                        .iter()
                        .map(|point| point.x.to_pt())
                        .fold(f64::NEG_INFINITY, f64::max);
                    let max_y = corners
                        .iter()
                        .map(|point| point.y.to_pt())
                        .fold(f64::NEG_INFINITY, f64::max);
                    let left = min_x.max(0.0).min(page_width);
                    let top = min_y.max(0.0).min(page_height);
                    let right = max_x.max(0.0).min(page_width);
                    let bottom = max_y.max(0.0).min(page_height);
                    if right <= left || bottom <= top || page_width <= 0.0 || page_height <= 0.0 {
                        continue;
                    }
                    let is_internal = target_page.is_some();
                    if is_internal && target_page == Some(current_page) && x.is_none() {
                        continue;
                    }
                    output.push(PageLink {
                        left: left / page_width * 100.0,
                        top: top / page_height * 100.0,
                        width: (right - left) / page_width * 100.0,
                        height: (bottom - top) / page_height * 100.0,
                        page: target_page,
                        x,
                        y,
                        href,
                    });
                }
                _ => {}
            }
        }
    }

    let size = page.frame.size();
    let (width, height) = (size.x.to_pt(), size.y.to_pt());
    let mut links = Vec::new();
    collect(
        &page.frame,
        typst::layout::Transform::identity(),
        page_number,
        width,
        height,
        introspector,
        &mut links,
    );
    links
}

fn next_id() -> String {
    let ticks = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{ticks:x}-{:x}", NEXT_ID.fetch_add(1, Ordering::Relaxed))
}

fn checked_typst_path(root: &Path, value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.contains('\0') {
        return Err("Invalid path".into());
    }
    let candidate = if Path::new(value).is_absolute() {
        PathBuf::from(value)
    } else {
        root.join(value)
    };
    let canonical = candidate
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !canonical.starts_with(root) {
        return Err("Typst source is outside the repository root".into());
    }
    if !canonical
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("typ"))
    {
        return Err("Not a Typst document".into());
    }
    Ok(canonical)
}

fn map_diagnostics(
    world: &TypstWorld,
    items: impl IntoIterator<Item = typst::diag::SourceDiagnostic>,
    severity: &str,
) -> Vec<Diagnostic> {
    items
        .into_iter()
        .map(|item| {
            let file = item.span.id().map_or_else(String::new, |id| {
                let path = id.vpath().get_without_slash().to_string();
                match id.root() {
                    VirtualRoot::Project => path,
                    VirtualRoot::Package(spec) => format!("{spec}/{path}"),
                }
            });
            let range = world.range(item.span).and_then(|range| {
                let id = item.span.id()?;
                let source = world.source(id).ok()?;
                let lines = source.lines();
                let (start_line, start_column) = lines.byte_to_line_column(range.start)?;
                let (end_line, end_column) = lines.byte_to_line_column(range.end)?;
                Some(DiagnosticRange {
                    start: DiagnosticPosition {
                        line: start_line + 1,
                        column: start_column + 1,
                    },
                    end: DiagnosticPosition {
                        line: end_line + 1,
                        column: end_column + 1,
                    },
                })
            });
            Diagnostic {
                file,
                severity: severity.to_owned(),
                message: item.message.to_string(),
                range,
            }
        })
        .collect()
}

fn extract_navigation(
    world: &TypstWorld,
    document: &PagedDocument,
    pages: &[PageInfo],
) -> (Vec<OutlineItem>, Vec<SourceAnchor>) {
    use typst::{
        foundations::NativeElement,
        introspection::Introspector,
        model::{HeadingElem, ParElem},
    };

    let introspector = document.introspector();
    let headings = introspector
        .query(&HeadingElem::ELEM.select())
        .into_iter()
        .filter_map(|content| {
            let heading = content.to_packed::<HeadingElem>()?;
            let span = heading.span();
            let range = world.range(span)?;
            let id = span.id()?;
            if id != world.main() {
                return None;
            }
            let source = world.source(id).ok()?;
            let (line, _) = source.lines().byte_to_line_column(range.start)?;
            let level = source
                .text()
                .lines()
                .nth(line)
                .map(|text| {
                    text.trim_start()
                        .chars()
                        .take_while(|ch| *ch == '=')
                        .count()
                })
                .filter(|level| *level > 0)
                .unwrap_or(1);
            let location = content.location()?;
            let position = introspector.position(location);
            let position = match position {
                Some(position) => {
                    let page = position.page.get();
                    let height = pages.get(page.checked_sub(1)?)?.height;
                    Some((page, position.point.y.to_pt(), height))
                }
                None => None,
            };
            let name = heading.body.plain_text().trim().to_owned();
            Some((
                OutlineItem {
                    name,
                    level,
                    line: line + 1,
                    position: position.map(|(page, y, height)| AnchorPosition {
                        page,
                        y: if height > 0.0 { y / height } else { 0.0 },
                    }),
                },
                position,
            ))
        })
        .collect::<Vec<_>>();

    let mut anchors = headings
        .iter()
        .filter_map(|(heading, position)| {
            let (page, y, _) = (*position)?;
            let absolute_y = pages
                .iter()
                .take(page.saturating_sub(1))
                .map(|page| page.height)
                .sum::<f64>()
                + y;
            Some(SourceAnchor {
                line: heading.line,
                page,
                y,
                absolute_y,
            })
        })
        .collect::<Vec<_>>();
    // Paragraphs are locatable Typst elements, so their source spans and
    // laid-out positions can be joined directly without injecting metadata
    // into the user's source.
    anchors.extend(
        introspector
            .query(&ParElem::ELEM.select())
            .into_iter()
            .filter_map(|content| {
                let paragraph = content.to_packed::<ParElem>()?;
                let span = paragraph.span();
                let range = world.range(span)?;
                let id = span.id()?;
                if id != world.main() {
                    return None;
                }
                let source = world.source(id).ok()?;
                let (line, _) = source.lines().byte_to_line_column(range.start)?;
                let location = content.location()?;
                let position = introspector.position(location)?;
                let page = position.page.get();
                let height = pages.get(page.checked_sub(1)?)?.height;
                let y = if height > 0.0 {
                    position.point.y.to_pt() / height
                } else {
                    0.0
                };
                let absolute_y = pages
                    .iter()
                    .take(page.saturating_sub(1))
                    .map(|page| page.height)
                    .sum::<f64>()
                    + position.point.y.to_pt();
                Some(SourceAnchor {
                    line: line + 1,
                    page,
                    y,
                    absolute_y,
                })
            }),
    );
    anchors.sort_by_key(|anchor| anchor.line);
    // A heading can also contribute a paragraph-like location in some
    // Typst constructs. Keep one stable anchor per source line.
    anchors.dedup_by_key(|anchor| anchor.line);
    (
        headings.into_iter().map(|(heading, _)| heading).collect(),
        anchors,
    )
}

struct ProjectFiles {
    root: FsRoot,
    packages: SystemPackages,
    main: FileId,
    main_source: Bytes,
    dependencies: Mutex<Vec<Dependency>>,
}

#[derive(Clone)]
struct Dependency {
    path: PathBuf,
    root: PathBuf,
    fingerprint: Option<u128>,
}

impl Dependency {
    fn unchanged(&self) -> bool {
        let current = self
            .path
            .canonicalize()
            .ok()
            .filter(|path| path.starts_with(&self.root))
            .and_then(|path| std::fs::read(path).ok())
            .map(|bytes| typst::utils::hash128(&bytes));
        current == self.fingerprint
    }
}

impl FileLoader for ProjectFiles {
    fn load(&self, id: FileId) -> FileResult<Bytes> {
        if id == self.main {
            return Ok(self.main_source.clone());
        }
        let (root, path) = match id.root() {
            VirtualRoot::Project => (self.root.path().to_owned(), self.root.resolve(id.vpath())?),
            VirtualRoot::Package(spec) => {
                let package = self.packages.obtain(&spec)?;
                (package.path().to_owned(), package.resolve(id.vpath())?)
            }
        };
        // `canonicalize` may add the Windows `\\?\` prefix. Canonicalize the
        // root too before comparing paths, otherwise valid files in installed
        // packages are rejected as outside their root on Windows.
        let canonical_root = root.canonicalize().unwrap_or_else(|_| root.clone());
        let result = path
            .canonicalize()
            .map_err(|error| FileError::from_io(error, &path))
            .and_then(|canonical| {
                if !canonical.starts_with(&canonical_root) {
                    return Err(FileError::AccessDenied);
                }
                std::fs::read(&canonical)
                    .map(Bytes::new)
                    .map_err(|error| FileError::from_io(error, &canonical))
            });
        self.dependencies
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(Dependency {
                path,
                root: canonical_root,
                fingerprint: result
                    .as_ref()
                    .ok()
                    .map(|bytes| typst::utils::hash128(bytes.as_slice())),
            });
        result
    }
}

struct TypstWorld {
    library: LazyHash<Library>,
    fonts: Arc<FontStore>,
    files: FileStore<ProjectFiles>,
    now: Time,
    dates: Mutex<Vec<(Option<Duration>, Option<Datetime>)>>,
}

impl TypstWorld {
    fn new(
        root: &Path,
        main_file: &Path,
        source: String,
        theme: &str,
        fonts: Arc<FontStore>,
    ) -> Result<Self, String> {
        let relative = main_file
            .strip_prefix(root)
            .map_err(|_| "Typst source is outside the repository root")?;
        let relative = relative
            .to_str()
            .ok_or("Typst path is not valid UTF-8")?
            .replace('\\', "/");
        let virtual_path = VirtualPath::new(relative).map_err(|error| error.to_string())?;
        let main = FileId::new(RootedPath::new(VirtualRoot::Project, virtual_path));
        let main_source = Bytes::from_string(source);
        let inputs = Dict::from_iter([(Str::from("theme"), theme.into_value())]);
        let library = Library::builder().with_inputs(inputs).build();
        let packages = SystemPackages::new(SystemDownloader::new("lib-ts"));
        Ok(Self {
            library: LazyHash::new(library),
            fonts,
            files: FileStore::new(ProjectFiles {
                root: FsRoot::new(root.to_path_buf()),
                packages,
                main,
                main_source,
                dependencies: Mutex::new(Vec::new()),
            }),
            now: Time::system(),
            dates: Mutex::new(Vec::new()),
        })
    }
}

impl World for TypstWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }
    fn book(&self) -> &LazyHash<FontBook> {
        self.fonts.book()
    }
    fn main(&self) -> FileId {
        self.files.loader().main
    }
    fn source(&self, id: FileId) -> FileResult<Source> {
        self.files.source(id)
    }
    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.files.file(id)
    }
    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.font(index)
    }
    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        let date = self.now.today(offset);
        self.dates
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push((offset, date));
        date
    }
}

impl Drop for NativeTypstCompiler {
    fn drop(&mut self) {
        self.clear();
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    fn request(root: &Path, name: &str, source: &str) -> CompileRequest {
        let path = root.join(name);
        std::fs::write(&path, source).unwrap();
        CompileRequest {
            path: path.to_string_lossy().into_owned(),
            source: source.into(),
            theme: None,
        }
    }

    #[test]
    fn idle_documents_expire_even_while_another_document_keeps_the_compiler_hot() {
        let root = tempfile::tempdir().unwrap();
        let compiler = NativeTypstCompiler::new(root.path().to_owned());
        let old = compiler
            .compile(request(root.path(), "old.typ", "Old"))
            .unwrap();
        let hot = compiler
            .compile(request(root.path(), "hot.typ", "Hot"))
            .unwrap();
        compiler.page(&old.id, 1).unwrap();
        compiler
            .state
            .lock()
            .unwrap()
            .entries
            .get_mut(&old.id)
            .unwrap()
            .last_used -= StdDuration::from_secs(16 * 60);
        assert!(!compiler.evict_idle(StdDuration::from_secs(15 * 60)));
        assert!(compiler.page(&old.id, 1).is_err());
        assert!(compiler.page(&hot.id, 1).is_ok());
        assert_eq!(compiler.pages.lock().unwrap().usage().0, 1);
    }

    #[test]
    fn superseded_typst_layouts_expire_after_grace_even_when_the_path_is_leased() {
        let root = tempfile::tempdir().unwrap();
        let compiler = NativeTypstCompiler::new(root.path().to_owned());
        let old = compiler
            .compile(request(root.path(), "note.typ", "Old"))
            .unwrap();
        compiler.set_active_paths([root.path().join("note.typ")]);
        let new = compiler
            .compile(request(root.path(), "note.typ", "New"))
            .unwrap();
        assert!(compiler.page(&old.id, 1).is_ok());
        compiler
            .state
            .lock()
            .unwrap()
            .entries
            .get_mut(&old.id)
            .unwrap()
            .superseded_at = Some(Instant::now() - REVISION_GRACE);
        compiler.evict_idle(StdDuration::ZERO);
        assert!(compiler.page(&old.id, 1).is_err());
        assert!(compiler.page(&new.id, 1).is_ok());
        compiler.set_active_paths([]);
        compiler.evict_idle(StdDuration::ZERO);
        assert!(compiler.fonts.lock().unwrap().is_none());
        assert_eq!(compiler.pages.lock().unwrap().usage(), (0, 0));
    }

    #[test]
    fn in_use_layout_survives_eviction_and_cannot_refill_after_clear() {
        let root = tempfile::tempdir().unwrap();
        let compiler = NativeTypstCompiler::new(root.path().to_owned());
        let compiled = compiler
            .compile(request(root.path(), "note.typ", "Snapshot"))
            .unwrap();
        let snapshot = compiler
            .state
            .lock()
            .unwrap()
            .entries
            .peek(&compiled.id)
            .unwrap()
            .document
            .clone();
        compiler.evict_idle(StdDuration::ZERO);
        assert!(compiler.page(&compiled.id, 1).is_ok());
        compiler.clear();
        assert!(!snapshot.pages().is_empty());
        assert!(compiler.page(&compiled.id, 1).is_err());
        assert_eq!(compiler.pages.lock().unwrap().usage(), (0, 0));
    }

    #[test]
    fn source_budget_returns_busy_without_discarding_a_leased_layout() {
        let root = tempfile::tempdir().unwrap();
        let compiler = NativeTypstCompiler::new(root.path().to_owned());
        let current = compiler
            .compile(request(root.path(), "note.typ", "Current"))
            .unwrap();
        compiler.set_active_paths([root.path().join("note.typ")]);
        let mut large = request(root.path(), "large.typ", "");
        large.source = "x".repeat(SOURCE_BYTES_LIMIT);
        assert!(matches!(compiler.compile(large), Err(CompileError::Busy)));
        assert!(compiler.page(&current.id, 1).is_ok());
        assert_eq!(compiler.cache_usage().0, 1);
    }
}
