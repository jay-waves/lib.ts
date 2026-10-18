//! Shared repository snapshots refreshed by native filesystem events.
//! Repositories share a serialized snapshot and non-recursive visible-directory watches.
//! Debounced events rebuild the full visible tree; unchanged snapshots do not emit updates.
//! Idle subscriptions release watches. Ignore rules and private paths are applied when walking.
use ignore::WalkBuilder;
use notify::{EventKind, RecursiveMode, Watcher, event::ModifyKind};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
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
static NEXT_REVISION: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize)]
struct Node {
    name: String,
    path: String,
    #[serde(rename = "absolutePath", skip_serializing_if = "Option::is_none")]
    absolute_path: Option<String>,
    #[serde(rename = "type")]
    kind: &'static str,
    modified: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    children: Vec<Node>,
}

#[derive(Serialize)]
struct Root {
    name: String,
    #[serde(rename = "absolutePath")]
    absolute_path: String,
    children: Vec<Node>,
}

#[derive(Clone)]
pub struct Snapshot {
    pub body: bytes::Bytes,
    pub revision: u64,
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
    #[cfg(test)]
    scans: AtomicU64,
}

impl Entry {
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

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }
}

#[derive(Clone, Default)]
pub struct Service {
    entries: Arc<Mutex<HashMap<(PathBuf, bool), Arc<Entry>>>>,
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
        let entry = Arc::new(Entry {
            snapshot,
            events,
            last_used: Mutex::new(Instant::now()),
            #[cfg(test)]
            scans: AtomicU64::new(0),
        });
        entries.insert(key.clone(), entry.clone());
        let map = Arc::downgrade(&self.entries);
        let worker_entry = entry.clone();
        let worker_root = root.clone();
        let worker_key = key.clone();
        if let Err(error) = std::thread::Builder::new().name("tree-watch".into()).spawn(move || {
            let outcome = run(&worker_root, &private, show_hidden, &worker_entry, || {
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
            self.paths.insert(file.to_path_buf());
            self.known
                .write()
                .unwrap_or_else(|e| e.into_inner())
                .insert(file.to_path_buf());
            let metadata = match item.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            let children = if ty.is_dir() {
                self.directory(file)?
            } else {
                Vec::new()
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
                modified,
                children,
            });
        }
        nodes.sort_by(|a, b| {
            (a.kind != "directory")
                .cmp(&(b.kind != "directory"))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(nodes)
    }
}

fn run(
    root: &Path,
    private: &Path,
    show_hidden: bool,
    entry: &Entry,
    alive: impl Fn() -> bool,
) -> Result<(), String> {
    let (dirty, signals) = mpsc::sync_channel(1);
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
            if event.need_rescan()
                || matches!(
                    event.kind,
                    EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
                )
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
    loop {
        if !root.is_dir() {
            return Err("Repository directory was removed".into());
        }
        #[cfg(test)]
        entry.scans.fetch_add(1, Ordering::Relaxed);
        // A removed/recreated directory can retain its pathname while losing
        // the OS watch. Reinstall affected watches before traversing it.
        let invalid = std::mem::take(&mut *invalidated.lock().unwrap_or_else(|e| e.into_inner()));
        for stale in watched
            .iter()
            .filter(|path| invalid.iter().any(|prefix| path.starts_with(prefix)))
            .cloned()
            .collect::<Vec<_>>()
        {
            let _ = watcher.unwatch(&stale);
            watched.remove(&stale);
        }
        let control_paths = control_files(root);
        *controls.write().unwrap_or_else(|e| e.into_inner()) = control_paths.clone();
        let mut scan = Scan {
            root,
            private,
            watcher: &mut watcher,
            watched: &mut watched,
            desired: HashSet::new(),
            known: &known,
            paths: HashSet::new(),
            show_hidden,
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
        let changed = entry
            .snapshot
            .borrow()
            .as_ref()
            .is_none_or(|previous| match previous {
                Ok(previous) => previous.body != body,
                Err(_) => true,
            });
        if changed {
            let revision = NEXT_REVISION.fetch_add(1, Ordering::Relaxed);
            entry
                .snapshot
                .send_replace(Some(Ok(Snapshot { body, revision })));
            let _ = entry.events.send(Event::Changed(revision));
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
