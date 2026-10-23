//! Shared repository snapshots refreshed by native filesystem events.
//! Repositories share a serialized snapshot and non-recursive visible-directory watches.
//! Only requested directories are scanned; filesystem events invalidate their listings.
//! Idle subscriptions release watches. Ignore rules and private paths are applied when walking.
//! Responses contain one directory level; clients merge by path and retain
//! unchanged branches. Foreground requests precede bounded direct-child prefetch,
//! which scans one directory per turn. No recursive or persisted tree snapshot
//! is maintained; content/path search walks its own scope independently.
use ignore::WalkBuilder;
use notify::{EventKind, RecursiveMode, Watcher, event::ModifyKind};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use tokio::sync::{broadcast, watch};

const IDLE_TIME: Duration = Duration::from_secs(60);
const DEBOUNCE: Duration = Duration::from_millis(250);
const PREFETCH_LIMIT: usize = 32;
static NEXT_REVISION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
struct Node {
    name: String,
    path: String,
    #[serde(rename = "absolutePath", skip_serializing_if = "Option::is_none")]
    absolute_path: Option<String>,
    #[serde(rename = "type")]
    kind: &'static str,
    modified: String,
    #[serde(rename = "transportStream", skip_serializing_if = "std::ops::Not::not")]
    transport_stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<Node>>,
}

#[cfg(test)]
#[derive(Serialize)]
struct Root {
    name: String,
    #[serde(rename = "absolutePath")]
    absolute_path: String,
    children: Vec<Node>,
}

#[derive(Serialize)]
struct DirectoryListing {
    path: String,
    name: String,
    #[serde(rename = "absolutePath")]
    absolute_path: String,
    children: Vec<Node>,
}

#[derive(Clone)]
pub struct Snapshot {
    #[cfg(test)]
    pub body: bytes::Bytes,
    pub revision: u64,
    requested: Arc<HashSet<PathBuf>>,
}

#[derive(Clone, Copy)]
pub enum Event {
    Changed(u64),
    Removed,
}

pub struct Entry {
    snapshot: watch::Sender<Option<Result<Snapshot, String>>>,
    events: broadcast::Sender<Event>,
    last_used: Mutex<Instant>,
    requested: Mutex<HashSet<PathBuf>>,
    listings: RwLock<HashMap<PathBuf, bytes::Bytes>>,
    prefetch: Mutex<VecDeque<PathBuf>>,
    focus: Mutex<Option<PathBuf>>,
    wake: mpsc::SyncSender<()>,
    #[cfg(test)]
    scans: AtomicU64,
    #[cfg(test)]
    listing_scans: AtomicU64,
}

impl Entry {
    pub async fn directory(&self, root: &Path, path: &Path) -> Result<Snapshot, String> {
        *self.focus.lock().unwrap_or_else(|e| e.into_inner()) = Some(path.to_path_buf());
        {
            let mut requested = self.requested.lock().unwrap_or_else(|e| e.into_inner());
            let mut changed = false;
            for ancestor in path
                .ancestors()
                .take_while(|parent| parent.starts_with(root))
            {
                changed |= requested.insert(ancestor.to_path_buf());
            }
            if changed {
                let _ = self.wake.try_send(());
            }
            self.prefetch
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .retain(|queued| queued != path);
        }
        // A foreground request can arrive while a background scan is running.
        // Wake the worker so it is selected before the next prefetch task.
        let _ = self.wake.try_send(());
        *self.last_used.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
        let mut receiver = self.snapshot.subscribe();
        loop {
            if let Some(value) = receiver.borrow_and_update().clone() {
                match value {
                    Ok(snapshot)
                        if snapshot.requested.contains(path) && self.listing(path).is_some() =>
                    {
                        return Ok(snapshot);
                    }
                    Err(error) => return Err(error),
                    _ => {}
                }
            }
            receiver.changed().await.map_err(|_| "File tree stopped")?;
        }
    }
    pub async fn snapshot(&self) -> Result<Snapshot, String> {
        *self.last_used.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
        let mut receiver = self.snapshot.subscribe();
        loop {
            if let Some(snapshot) = receiver.borrow_and_update().clone() {
                return snapshot;
            }
            receiver.changed().await.map_err(|_| "File tree stopped")?;
        }
    }

    pub fn listing(&self, path: &Path) -> Option<bytes::Bytes> {
        self.listings
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(path)
            .cloned()
    }

    pub fn prefetch_children(&self, root: &Path, path: &Path) {
        let Some(body) = self.listing(path) else {
            return;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body) else {
            return;
        };
        let children = value.get("children").and_then(serde_json::Value::as_array);
        let Some(children) = children else { return };
        let requested = self.requested.lock().unwrap_or_else(|e| e.into_inner());
        let candidates = children
            .iter()
            .filter(|child| {
                child.get("type").and_then(serde_json::Value::as_str) == Some("directory")
            })
            .filter_map(|child| child.get("path").and_then(serde_json::Value::as_str))
            .map(|child| root.join(child))
            .filter(|child| !requested.contains(child))
            .collect::<Vec<_>>();
        drop(requested);
        let mut queue = self.prefetch.lock().unwrap_or_else(|e| e.into_inner());
        let before = queue.len();
        for child in candidates {
            if queue.len() >= PREFETCH_LIMIT {
                break;
            }
            if !queue.contains(&child) {
                queue.push_back(child);
            }
        }
        let changed = queue.len() != before;
        drop(queue);
        if changed {
            let _ = self.wake.try_send(());
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }
}

type Entries = HashMap<(PathBuf, bool), Arc<Entry>>;

#[derive(Clone, Default)]
pub struct Service {
    entries: Arc<Mutex<Entries>>,
}

impl Service {
    pub fn entry(
        &self,
        root: PathBuf,
        private: PathBuf,
        show_hidden: bool,
    ) -> Result<Arc<Entry>, String> {
        let key = (root.clone(), show_hidden);
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = entries.get(&key) {
            *entry.last_used.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
            return Ok(entry.clone());
        }
        let (snapshot, _) = watch::channel(None);
        let (events, _) = broadcast::channel(16);
        let (wake, signals) = mpsc::sync_channel(1);
        let entry = Arc::new(Entry {
            snapshot,
            events,
            last_used: Mutex::new(Instant::now()),
            requested: Mutex::new(HashSet::from([root.clone()])),
            listings: RwLock::new(HashMap::new()),
            prefetch: Mutex::new(VecDeque::new()),
            focus: Mutex::new(Some(root.clone())),
            wake,
            #[cfg(test)]
            scans: AtomicU64::new(0),
            #[cfg(test)]
            listing_scans: AtomicU64::new(0),
        });
        entries.insert(key.clone(), entry.clone());
        let map = Arc::downgrade(&self.entries);
        let worker_entry = entry.clone();
        let worker_root = root.clone();
        let worker_key = key.clone();
        if let Err(error) = std::thread::Builder::new().name("tree-watch".into()).spawn(move || {
            let outcome = run(&worker_root, &private, show_hidden, &worker_entry, signals, || {
                let Some(map) = map.upgrade() else { return false; };
                let mut map = map.lock().unwrap_or_else(|e| e.into_inner());
                let active = worker_entry.events.receiver_count() > 0
                    || worker_entry.last_used.lock().unwrap_or_else(|e| e.into_inner()).elapsed() < IDLE_TIME;
                if !active && map.get(&worker_key).is_some_and(|entry| Arc::ptr_eq(entry, &worker_entry)) {
                    map.remove(&worker_key);
                }
                active
            });
            if let Err(error) = outcome {
                tracing::warn!(root = %worker_root.display(), %error, "File tree watcher stopped");
                worker_entry.snapshot.send_replace(Some(Err(error)));
            }
            let _ = worker_entry.events.send(Event::Removed);
            if let Some(map) = map.upgrade() {
                let mut map = map.lock().unwrap_or_else(|e| e.into_inner());
                if map.get(&worker_key).is_some_and(|entry| Arc::ptr_eq(entry, &worker_entry)) {
                    map.remove(&worker_key);
                }
            }
        }) {
            entries.remove(&key);
            return Err(error.to_string());
        }
        Ok(entry)
    }

    #[cfg(test)]
    pub fn cached_roots(&self) -> usize {
        self.entries.lock().unwrap().len()
    }
}

fn excluded(path: &Path, root: &Path, private: &Path, show_hidden: bool) -> bool {
    path.starts_with(private)
        || path.strip_prefix(root).is_ok_and(|relative| {
            relative.components().any(|part| {
                let name = part.as_os_str().to_string_lossy();
                (!show_hidden && name.starts_with('.')) || name == ".git" || name == "node_modules"
            })
        })
}

fn control_files(root: &Path) -> HashSet<PathBuf> {
    let mut paths = HashSet::new();
    for parent in root.ancestors() {
        paths.insert(parent.join(".gitignore"));
        paths.insert(parent.join(".ignore"));
        paths.insert(parent.join(".git/info/exclude"));
    }
    paths.insert(root.join(".git"));
    if let Ok(repo) = git2::Repository::discover(root) {
        paths.insert(repo.path().join("info/exclude"));
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        paths.insert(home.join(".gitconfig"));
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        paths.insert(config.join("git/config"));
        paths.insert(config.join("git/ignore"));
    }
    if let Ok(config) = git2::Config::open_default()
        && let Ok(path) = config.get_path("core.excludesfile")
    {
        paths.insert(path);
    }
    paths
}

fn add_watch(
    watcher: &mut notify::RecommendedWatcher,
    watched: &mut HashSet<PathBuf>,
    path: &Path,
) -> Result<(), String> {
    if !watched.contains(path) {
        watcher
            .watch(path, RecursiveMode::NonRecursive)
            .map_err(|error| error.to_string())?;
        watched.insert(path.to_path_buf());
    }
    Ok(())
}

struct Scan<'a> {
    root: &'a Path,
    private: &'a Path,
    watcher: &'a mut notify::RecommendedWatcher,
    watched: &'a mut HashSet<PathBuf>,
    desired: HashSet<PathBuf>,
    known: &'a RwLock<HashSet<PathBuf>>,
    paths: HashSet<PathBuf>,
    show_hidden: bool,
    requested: &'a HashSet<PathBuf>,
    focus: &'a Option<PathBuf>,
    cache: &'a mut HashMap<PathBuf, Vec<Node>>,
    directory_listings: &'a RwLock<HashMap<PathBuf, bytes::Bytes>>,
    listing_changed: &'a mut bool,
    #[cfg(test)]
    listing_count: &'a AtomicU64,
}

fn directory_entries(directory: &Path, private: &Path, show_hidden: bool) -> ignore::Walk {
    let private = private.to_path_buf();
    let mut builder = WalkBuilder::new(directory);
    builder
        .max_depth(Some(1))
        .hidden(!show_hidden)
        .follow_links(false)
        .require_git(false)
        .filter_entry(move |entry| {
            !entry.path().starts_with(&private)
                && entry.file_name() != "node_modules"
                && entry.file_name() != ".git"
        });
    builder.build()
}

impl Scan<'_> {
    fn directory(&mut self, directory: &Path) -> Result<Vec<Node>, String> {
        if !directory.is_dir() {
            return Ok(Vec::new());
        }
        // Register before enumerating, so edits during traversal queue a refresh.
        add_watch(self.watcher, self.watched, directory)?;
        self.desired.insert(directory.to_path_buf());
        self.paths.insert(directory.to_path_buf());
        self.known
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(directory.to_path_buf());
        let nodes = if let Some(nodes) = self.cache.get(directory) {
            nodes.clone()
        } else {
            #[cfg(test)]
            self.listing_count.fetch_add(1, Ordering::Relaxed);
            let mut nodes = Vec::new();
            for item in directory_entries(directory, self.private, self.show_hidden) {
                let item = match item {
                    Ok(item) if item.depth() > 0 => item,
                    Ok(_) => continue,
                    Err(error) => {
                        tracing::debug!(%error, "Skipping unavailable tree entry");
                        continue;
                    }
                };
                let Some(ty) = item.file_type() else { continue };
                if ty.is_symlink() || (!ty.is_dir() && !ty.is_file()) {
                    continue;
                }
                let file = item.path();
                let metadata = match item.metadata() {
                    Ok(metadata) => metadata,
                    Err(_) => continue,
                };
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .and_then(|duration| {
                        time::OffsetDateTime::from_unix_timestamp_nanos(duration.as_nanos() as i128)
                            .ok()
                    })
                    .and_then(|date| {
                        date.format(&time::format_description::well_known::Rfc3339)
                            .ok()
                    })
                    .unwrap_or_else(|| "1970-01-01T00:00:00Z".into());
                nodes.push(Node {
                    name: item.file_name().to_string_lossy().into_owned(),
                    path: file
                        .strip_prefix(self.root)
                        .unwrap_or(file)
                        .to_string_lossy()
                        .replace('\\', "/"),
                    absolute_path: ty.is_dir().then(|| crate::client_path(file)),
                    kind: if ty.is_dir() { "directory" } else { "file" },
                    transport_stream: ty.is_file()
                        && file
                            .extension()
                            .is_some_and(|ext| ext.eq_ignore_ascii_case("ts"))
                        && crate::media::is_video(file),
                    modified,
                    children: None,
                });
            }
            nodes.sort_by(|a, b| {
                (a.kind != "directory")
                    .cmp(&(b.kind != "directory"))
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });
            self.cache.insert(directory.to_path_buf(), nodes.clone());
            nodes
        };
        #[cfg(test)]
        let mut nodes = nodes;
        let listing = DirectoryListing {
            path: directory
                .strip_prefix(self.root)
                .unwrap_or(directory)
                .to_string_lossy()
                .replace('\\', "/"),
            name: directory
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            absolute_path: crate::client_path(directory),
            children: nodes.clone(),
        };
        let body =
            bytes::Bytes::from(serde_json::to_vec(&listing).map_err(|error| error.to_string())?);
        let mut listings = self
            .directory_listings
            .write()
            .unwrap_or_else(|e| e.into_inner());
        if listings
            .get(directory)
            .is_some_and(|previous| previous != &body)
        {
            *self.listing_changed = true;
        }
        listings.insert(directory.to_path_buf(), body);
        drop(listings);
        for node in &nodes {
            let path = self.root.join(&node.path);
            self.paths.insert(path.clone());
            self.known
                .write()
                .unwrap_or_else(|e| e.into_inner())
                .insert(path);
        }
        let mut directories = nodes
            .iter()
            .filter(|node| {
                node.kind == "directory" && self.requested.contains(&self.root.join(&node.path))
            })
            .map(|node| node.path.clone())
            .collect::<Vec<_>>();
        directories.sort_by_key(|relative| {
            let path = self.root.join(relative);
            usize::from(
                !self
                    .focus
                    .as_ref()
                    .is_some_and(|focus| focus.starts_with(&path)),
            )
        });
        for relative in directories {
            let path = self.root.join(&relative);
            self.paths.insert(path.clone());
            self.known
                .write()
                .unwrap_or_else(|e| e.into_inner())
                .insert(path.clone());
            if nodes.iter().any(|node| node.path == relative) {
                let children = self.directory(&path)?;
                #[cfg(test)]
                if let Some(node) = nodes.iter_mut().find(|node| node.path == relative) {
                    node.children = Some(children);
                }
                #[cfg(not(test))]
                {
                    let _ = children;
                }
            }
        }
        Ok(nodes)
    }
}

fn run(
    root: &Path,
    private: &Path,
    show_hidden: bool,
    entry: &Entry,
    signals: mpsc::Receiver<()>,
    alive: impl Fn() -> bool,
) -> Result<(), String> {
    let dirty = entry.wake.clone();
    let known = Arc::new(RwLock::new(HashSet::from([root.to_path_buf()])));
    let controls = Arc::new(RwLock::new(control_files(root)));
    let event_known = known.clone();
    let event_controls = controls.clone();
    let invalidated = Arc::new(Mutex::new(HashSet::<PathBuf>::new()));
    let event_invalidated = invalidated.clone();
    let event_root = root.to_path_buf();
    let event_private = private.to_path_buf();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let event = match result {
            Ok(event) => event,
            Err(error) => {
                tracing::warn!(%error, "File tree events need resynchronization");
                event_invalidated
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(event_root.clone());
                let _ = dirty.try_send(());
                return;
            }
        };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        let structural = matches!(
            event.kind,
            EventKind::Create(_)
                | EventKind::Remove(_)
                | EventKind::Modify(ModifyKind::Name(_))
                | EventKind::Any
                | EventKind::Other
        );
        let relevant = event.need_rescan()
            || event.paths.iter().any(|path| {
                if path.starts_with(&event_private) {
                    return false;
                }
                if event_controls
                    .read()
                    .unwrap_or_else(|e| e.into_inner())
                    .iter()
                    .any(|control| control == path || control.starts_with(path))
                {
                    return true;
                }
                if matches!(
                    path.file_name().and_then(|name| name.to_str()),
                    Some(".gitignore" | ".ignore")
                ) && path.parent().is_some_and(|parent| {
                    event_known
                        .read()
                        .unwrap_or_else(|e| e.into_inner())
                        .contains(parent)
                }) {
                    return true;
                }
                if !path.starts_with(&event_root)
                    || excluded(path, &event_root, &event_private, show_hidden)
                {
                    return false;
                }
                structural
                    || event_known
                        .read()
                        .unwrap_or_else(|e| e.into_inner())
                        .contains(path)
            });
        if relevant {
            {
                let mut invalid = event_invalidated.lock().unwrap_or_else(|e| e.into_inner());
                if event.need_rescan() || invalid.len() > 4096 {
                    invalid.clear();
                    invalid.insert(event_root.clone());
                } else {
                    invalid.extend(event.paths);
                }
            }
            let _ = dirty.try_send(());
        }
    })
    .map_err(|error| error.to_string())?;
    let mut watched = HashSet::<PathBuf>::new();
    let mut cache = HashMap::new();
    loop {
        if !root.is_dir() {
            return Err("Repository directory was removed".into());
        }
        #[cfg(test)]
        entry.scans.fetch_add(1, Ordering::Relaxed);
        // A removed/recreated directory can retain its pathname while losing
        // the OS watch. Reinstall affected watches before traversing it.
        let invalid = std::mem::take(&mut *invalidated.lock().unwrap_or_else(|e| e.into_inner()));
        let control_paths = control_files(root);
        // Ignore/config changes may affect every loaded directory. Ordinary
        // changes invalidate only the containing listing and removed subtrees.
        cache.retain(|directory: &PathBuf, _: &mut Vec<Node>| {
            !invalid.iter().any(|path| {
                path == root
                    || !path.starts_with(root)
                    || control_paths
                        .iter()
                        .any(|control| control == path || control.starts_with(path))
                    || matches!(
                        path.file_name().and_then(|name| name.to_str()),
                        Some(".gitignore" | ".ignore")
                    )
                    || directory.starts_with(path)
                    || path.parent() == Some(directory.as_path())
            })
        });
        entry
            .listings
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|directory, _| {
                !invalid.iter().any(|path| {
                    path == root
                        || !path.starts_with(root)
                        || control_paths
                            .iter()
                            .any(|control| control == path || control.starts_with(path))
                        || matches!(
                            path.file_name().and_then(|name| name.to_str()),
                            Some(".gitignore" | ".ignore")
                        )
                        || directory.starts_with(path)
                        || path.parent() == Some(directory.as_path())
                })
            });
        let focus = entry
            .focus
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if focus.is_none() {
            loop {
                let path = entry
                    .prefetch
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .pop_front();
                let Some(path) = path else { break };
                if entry
                    .requested
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(path)
                {
                    break;
                }
            }
        }
        let requested = entry
            .requested
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        for stale in watched
            .iter()
            .filter(|path| invalid.iter().any(|prefix| path.starts_with(prefix)))
            .cloned()
            .collect::<Vec<_>>()
        {
            let _ = watcher.unwatch(&stale);
            watched.remove(&stale);
        }
        *controls.write().unwrap_or_else(|e| e.into_inner()) = control_paths.clone();
        let mut listing_changed = false;
        let mut scan = Scan {
            root,
            private,
            watcher: &mut watcher,
            watched: &mut watched,
            desired: HashSet::new(),
            known: &known,
            paths: HashSet::new(),
            show_hidden,
            requested: &requested,
            focus: &focus,
            cache: &mut cache,
            directory_listings: &entry.listings,
            listing_changed: &mut listing_changed,
            #[cfg(test)]
            listing_count: &entry.listing_scans,
        };
        // Watch ignore/config parents too, including creation of missing files.
        for path in control_paths {
            if let Some(parent) = path.ancestors().skip(1).find(|parent| parent.is_dir()) {
                add_watch(scan.watcher, scan.watched, parent)?;
                scan.desired.insert(parent.to_path_buf());
            }
        }
        let children = scan.directory(root)?;
        for stale in scan
            .watched
            .difference(&scan.desired)
            .cloned()
            .collect::<Vec<_>>()
        {
            let _ = scan.watcher.unwatch(&stale);
            scan.watched.remove(&stale);
        }
        *known.write().unwrap_or_else(|e| e.into_inner()) = scan.paths;
        #[cfg(test)]
        let body = bytes::Bytes::from(
            serde_json::to_vec(&Root {
                name: root
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                absolute_path: crate::client_path(root),
                children,
            })
            .map_err(|error| error.to_string())?,
        );
        #[cfg(not(test))]
        let _ = children;
        let changed = entry
            .snapshot
            .borrow()
            .as_ref()
            .is_none_or(|previous| match previous {
                Ok(previous) => {
                    let changed =
                        *previous.requested != requested || !invalid.is_empty() || listing_changed;
                    #[cfg(test)]
                    let changed = changed || previous.body != body;
                    changed
                }
                Err(_) => true,
            });
        if changed {
            // Expanding/prefetching directories changes snapshot coverage, not
            // filesystem freshness. Reconnecting clients retain those listings.
            let revision = if invalid.is_empty() {
                entry
                    .snapshot
                    .borrow()
                    .as_ref()
                    .and_then(|previous| previous.as_ref().ok())
                    .map(|previous| previous.revision)
                    .unwrap_or_else(|| NEXT_REVISION.fetch_add(1, Ordering::Relaxed))
            } else {
                NEXT_REVISION.fetch_add(1, Ordering::Relaxed)
            };
            entry.snapshot.send_replace(Some(Ok(Snapshot {
                #[cfg(test)]
                body,
                revision,
                requested: Arc::new(requested),
            })));
            // Loading a requested or prefetched directory changes the snapshot
            // shape, but it is not a filesystem change for SSE subscribers.
            if !invalid.is_empty() {
                let _ = entry.events.send(Event::Changed(revision));
            }
        }
        if focus.is_some() {
            let mut current_focus = entry.focus.lock().unwrap_or_else(|e| e.into_inner());
            if *current_focus == focus {
                *current_focus = None;
            }
        }
        if !entry
            .prefetch
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
        {
            let _ = entry.wake.try_send(());
        }
        loop {
            if !alive() {
                return Ok(());
            }
            match signals.recv_timeout(Duration::from_secs(1)) {
                Ok(()) => {
                    std::thread::sleep(DEBOUNCE);
                    while signals.try_recv().is_ok() {}
                    break;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_entries_are_optional_while_ignores_and_private_paths_remain_excluded() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        for name in [".config", ".empty", ".git", "node_modules", "private"] {
            std::fs::create_dir(root.join(name)).unwrap();
        }
        std::fs::write(root.join(".gitignore"), ".ignored\n").unwrap();
        std::fs::write(root.join(".ignored"), "ignored").unwrap();
        std::fs::write(root.join(".env"), "hidden").unwrap();
        std::fs::write(root.join("note.md"), "note").unwrap();
        let names = |show_hidden| {
            directory_entries(root, &root.join("private"), show_hidden)
                .filter_map(Result::ok)
                .filter(|entry| entry.depth() > 0)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect::<HashSet<_>>()
        };
        assert_eq!(names(false), HashSet::from(["note.md".to_owned()]));
        assert_eq!(
            names(true),
            HashSet::from([
                ".config".to_owned(),
                ".empty".to_owned(),
                ".env".to_owned(),
                ".gitignore".to_owned(),
                "note.md".to_owned(),
            ])
        );
    }

    #[test]
    fn hidden_event_filter_matches_visibility_without_exposing_fixed_exclusions() {
        let root = Path::new("repo");
        let private = root.join("private");
        assert!(excluded(
            &root.join(".config/settings"),
            root,
            &private,
            false
        ));
        assert!(!excluded(
            &root.join(".config/settings"),
            root,
            &private,
            true
        ));
        for path in [
            ".git/config",
            "nested/.git/config",
            "node_modules/pkg",
            "private/data",
        ] {
            assert!(excluded(&root.join(path), root, &private, true));
        }
    }

    fn paths(snapshot: &Snapshot) -> Vec<String> {
        fn collect(nodes: &[serde_json::Value], paths: &mut Vec<String>) {
            for node in nodes {
                paths.push(node["path"].as_str().unwrap().to_owned());
                if let Some(children) = node["children"].as_array() {
                    collect(children, paths);
                }
            }
        }
        let value: serde_json::Value = serde_json::from_slice(&snapshot.body).unwrap();
        let mut paths = Vec::new();
        collect(value["children"].as_array().unwrap(), &mut paths);
        paths
    }

    async fn wait_for(
        entry: &Entry,
        events: &mut broadcast::Receiver<Event>,
        predicate: impl Fn(&[String]) -> bool,
    ) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if predicate(&paths(&entry.snapshot().await.unwrap())) {
                    return;
                }
                events.recv().await.unwrap();
            }
        })
        .await
        .expect("native watcher did not update the tree");
    }

    #[tokio::test]
    async fn shared_cache_does_not_scan_while_idle_or_for_ignored_build_outputs() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().to_path_buf();
        std::fs::create_dir(root.join("target")).unwrap();
        std::fs::write(root.join(".gitignore"), "target/\nignored.txt\n").unwrap();
        std::fs::write(root.join("note.md"), "note").unwrap();
        std::fs::write(root.join("ignored.txt"), "ignored").unwrap();
        let service = Service::default();
        let entry = service
            .entry(root.clone(), root.join("private"), false)
            .unwrap();
        let other = service
            .entry(root.clone(), root.join("private"), false)
            .unwrap();
        assert!(Arc::ptr_eq(&entry, &other));
        let (first, second) = tokio::join!(entry.snapshot(), other.snapshot());
        let first = first.unwrap();
        let second = second.unwrap();
        assert_eq!(paths(&first), ["note.md"]);
        assert_eq!(first.revision, second.revision);
        assert_eq!(first.body.as_ptr(), second.body.as_ptr());
        std::fs::write(root.join("target/generated.txt"), "build output").unwrap();
        std::fs::write(root.join("ignored.txt"), "changed").unwrap();
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert_eq!(entry.scans.load(Ordering::Relaxed), 1);
        assert_eq!(entry.snapshot().await.unwrap().revision, first.revision);
        *entry.last_used.lock().unwrap() = Instant::now() - IDLE_TIME;
        tokio::time::timeout(Duration::from_secs(3), async {
            while service.cached_roots() != 0 {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn shallow_start_and_expansion_reuse_loaded_directory_listings() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().to_path_buf();
        std::fs::create_dir_all(root.join("docs/deep")).unwrap();
        std::fs::create_dir(root.join("unopened")).unwrap();
        std::fs::write(root.join("docs/deep/note.md"), "note").unwrap();
        std::fs::write(root.join("unopened/hidden.md"), "not browsed").unwrap();
        let service = Service::default();
        let entry = service
            .entry(root.clone(), root.join("private"), false)
            .unwrap();
        let initial = entry.snapshot().await.unwrap();
        assert_eq!(paths(&initial), ["docs", "unopened"]);
        assert_eq!(entry.listing_scans.load(Ordering::Relaxed), 1);
        let loaded = entry
            .directory(&root, &root.join("docs/deep"))
            .await
            .unwrap();
        assert_eq!(loaded.revision, initial.revision);
        assert_eq!(
            paths(&loaded),
            ["docs", "docs/deep", "docs/deep/note.md", "unopened"]
        );
        assert_eq!(entry.listing_scans.load(Ordering::Relaxed), 3);
        let again = entry.directory(&root, &root.join("docs")).await.unwrap();
        assert_eq!(again.body.as_ptr(), loaded.body.as_ptr());
        assert_eq!(entry.listing_scans.load(Ordering::Relaxed), 3);
    }

    #[tokio::test]
    async fn native_events_track_new_directories_nested_ignores_and_git_excludes() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().to_path_buf();
        git2::Repository::init(&root).unwrap();
        std::fs::create_dir(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/.gitignore"), "hidden.md\n").unwrap();
        std::fs::write(root.join("docs/hidden.md"), "hidden").unwrap();
        std::fs::write(root.join("excluded.md"), "excluded").unwrap();
        std::fs::write(root.join(".git/info/exclude"), "excluded.md\n").unwrap();
        let service = Service::default();
        let entry = service
            .entry(root.clone(), root.join("private"), false)
            .unwrap();
        let mut events = entry.subscribe();
        assert_eq!(paths(&entry.snapshot().await.unwrap()), ["docs"]);
        std::fs::create_dir_all(root.join("docs/new/sub")).unwrap();
        std::fs::write(root.join("docs/new/sub/note.md"), "new").unwrap();
        // Unopened directories are intentionally absent until requested.
        entry
            .directory(&root, &root.join("docs/new/sub"))
            .await
            .unwrap();
        wait_for(&entry, &mut events, |paths| {
            paths.iter().any(|path| path == "docs/new/sub/note.md")
        })
        .await;
        std::fs::write(root.join("docs/.gitignore"), "").unwrap();
        wait_for(&entry, &mut events, |paths| {
            paths.iter().any(|path| path == "docs/hidden.md")
        })
        .await;
        std::fs::write(root.join(".git/info/exclude"), "").unwrap();
        wait_for(&entry, &mut events, |paths| {
            paths.iter().any(|path| path == "excluded.md")
        })
        .await;
        std::fs::remove_file(root.join("docs/new/sub/note.md")).unwrap();
        wait_for(&entry, &mut events, |paths| {
            !paths.iter().any(|path| path == "docs/new/sub/note.md")
        })
        .await;
        // Editors commonly publish a hidden temporary file by renaming it.
        std::fs::write(root.join(".temporary-note"), "atomic save").unwrap();
        std::fs::rename(
            root.join(".temporary-note"),
            root.join("docs/new/atomic.md"),
        )
        .unwrap();
        wait_for(&entry, &mut events, |paths| {
            paths.iter().any(|path| path == "docs/new/atomic.md")
        })
        .await;
        // Reusing a pathname must install a watch on the replacement directory.
        std::fs::remove_dir_all(root.join("docs/new")).unwrap();
        std::fs::create_dir(root.join("docs/new")).unwrap();
        std::fs::write(root.join("docs/new/replaced.md"), "replacement").unwrap();
        wait_for(&entry, &mut events, |paths| {
            paths.iter().any(|path| path == "docs/new/replaced.md")
        })
        .await;
        std::fs::write(root.join("docs/new/later.md"), "subsequent event").unwrap();
        wait_for(&entry, &mut events, |paths| {
            paths.iter().any(|path| path == "docs/new/later.md")
        })
        .await;
    }
}
