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

mod compiler;
mod fonts;
mod navigation;
mod world;
use fonts::typst_font_store;
use navigation::{
    checked_typst_path, extract_navigation, extract_page_links, map_diagnostics, next_id,
};
use world::{Dependency, TypstWorld};

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
