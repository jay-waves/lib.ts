use super::*;

/// Mutable coordination state shared by concurrent HTTP requests.
/// Long-lived services and configuration stay on `AppState`.
#[derive(Default)]
pub(super) struct RuntimeState {
    pub(super) leases: Mutex<HashMap<String, DocumentLease>>,
    pub(super) library_events: Arc<LibraryEventHub>,
    pub(super) file_watchers:
        Mutex<HashMap<FileWatchKey, tokio::sync::broadcast::Sender<FileWatchEvent>>>,
}

#[derive(Clone, Hash, PartialEq, Eq)]
pub(super) struct FileWatchKey {
    document: PathBuf,
    pub(super) assets: Vec<(PathBuf, String)>,
}

#[derive(Clone)]
pub(super) struct FileWatchEvent {
    pub(super) document_changed: bool,
    pub(super) assets: Vec<String>,
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
pub(super) enum LeaseUpdateError {
    Busy,
    Poisoned,
}

#[derive(Debug)]
pub(super) enum ClientStateError {
    Poisoned,
}

/// Owns active library sessions and routes document-open notifications.
#[derive(Default)]
pub(super) struct LibraryEventHub {
    pub(super) clients: Mutex<HashMap<String, LibraryClient>>,
}

impl RuntimeState {
    pub(super) fn active_lease_paths(&self, now: Instant) -> HashSet<PathBuf> {
        let Ok(mut leases) = self.leases.lock() else {
            return HashSet::new();
        };
        leases.retain(|_, lease| lease.expires_at > now);
        leases
            .values()
            .flat_map(|lease| lease.paths.iter().cloned())
            .collect()
    }

    pub(super) fn subscribe_file_events(
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

    pub(super) fn update_lease(
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
    pub(super) fn subscribe(
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

    pub(super) fn dispatch_open(
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

    pub(super) fn unregister(&self, id: &str, sender: &mpsc::Sender<LibraryOpenEvent>) {
        if let Ok(mut clients) = self.clients.lock()
            && clients
                .get(id)
                .is_some_and(|client| client.sender.same_channel(sender))
        {
            clients.remove(id);
        }
    }

    pub(super) fn record_library_activity(&self, client_id: &str, now: Instant) -> bool {
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
