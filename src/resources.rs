//! Small ownership primitives shared by the native document services.

use futures_util::{
    FutureExt,
    future::{BoxFuture, WeakShared},
};
use lru::LruCache;
use std::{
    collections::HashMap,
    future::Future,
    hash::Hash,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

/// HTTP cancellation is cooperative: native work can finish, but must not
/// publish a new cache entry after its last subscriber has gone away.
#[derive(Clone, Default)]
pub struct Cancellation(Arc<AtomicBool>);

impl Cancellation {
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
}

/// Dropping the last shared future cancels queued work. Weak entries retain
/// neither inputs nor results; they are removed on the next admission.
pub struct RequestFlights<K, V: Clone> {
    pending: Mutex<HashMap<K, WeakShared<BoxFuture<'static, V>>>>,
}

impl<K, V: Clone> Default for RequestFlights<K, V> {
    fn default() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }
}

impl<K: Eq + Hash, V: Clone + Send + Sync + 'static> RequestFlights<K, V> {
    pub async fn run(&self, key: K, work: impl Future<Output = V> + Send + 'static) -> V {
        let flight = {
            let mut pending = self
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            pending.retain(|_, flight| flight.upgrade().is_some());
            if let Some(flight) = pending.get(&key).and_then(WeakShared::upgrade) {
                flight
            } else {
                let flight = work.boxed().shared();
                pending.insert(key, flight.downgrade().expect("new flight"));
                flight
            }
        };
        flight.await
    }
}

struct Cached<V> {
    value: V,
    bytes: usize,
    last_used: Instant,
}

/// Encoded output only; the budget intentionally excludes native layouts,
/// decoder allocations and temporary rendering buffers.
pub struct ByteCache<K, V> {
    entries: LruCache<K, Cached<V>>,
    bytes: usize,
    max_entries: usize,
    max_bytes: usize,
    idle_for: Duration,
}

impl<K: Eq + Hash, V: Clone> ByteCache<K, V> {
    pub fn new(max_entries: usize, max_bytes: usize, idle_for: Duration) -> Self {
        Self {
            entries: LruCache::unbounded(),
            bytes: 0,
            max_entries,
            max_bytes,
            idle_for,
        }
    }

    pub fn get(&mut self, key: &K) -> Option<V> {
        if self
            .entries
            .peek(key)
            .is_some_and(|entry| entry.last_used.elapsed() >= self.idle_for)
        {
            self.remove(key);
        }
        let entry = self.entries.get_mut(key)?;
        entry.last_used = Instant::now();
        Some(entry.value.clone())
    }

    pub fn insert(&mut self, key: K, value: V, bytes: usize) {
        self.remove(&key);
        self.prune();
        if bytes > self.max_bytes || self.max_entries == 0 {
            return;
        }
        while self.entries.len() >= self.max_entries
            || self.bytes.saturating_add(bytes) > self.max_bytes
        {
            let Some((_, entry)) = self.entries.pop_lru() else {
                break;
            };
            self.bytes -= entry.bytes;
        }
        self.entries.put(
            key,
            Cached {
                value,
                bytes,
                last_used: Instant::now(),
            },
        );
        self.bytes += bytes;
    }

    fn remove(&mut self, key: &K) {
        if let Some(entry) = self.entries.pop(key) {
            self.bytes -= entry.bytes;
        }
    }

    pub fn retain(&mut self, mut keep: impl FnMut(&K) -> bool)
    where
        K: Clone,
    {
        let removed = self
            .entries
            .iter()
            .filter_map(|(key, _)| (!keep(key)).then(|| key.clone()))
            .collect::<Vec<_>>();
        for key in removed {
            self.remove(&key);
        }
    }

    pub fn prune(&mut self) {
        // LRU order and idle deadlines share the same last-use order.
        while self
            .entries
            .peek_lru()
            .is_some_and(|(_, entry)| entry.last_used.elapsed() >= self.idle_for)
        {
            if let Some((_, entry)) = self.entries.pop_lru() {
                self.bytes -= entry.bytes;
            }
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }

    #[cfg(test)]
    pub fn usage(&self) -> (usize, usize) {
        (self.entries.len(), self.bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_cache_enforces_weight_lru_and_idle_expiry() {
        let mut cache = ByteCache::new(2, 5, Duration::from_secs(60));
        cache.insert(1, "one", 2);
        cache.insert(2, "two", 3);
        assert_eq!(cache.get(&1), Some("one"));
        cache.insert(3, "three", 3);
        assert_eq!(cache.get(&2), None);
        assert_eq!(cache.usage(), (2, 5));
        cache.insert(4, "oversized", 6);
        assert_eq!(cache.get(&4), None);
        cache.entries.get_mut(&1).unwrap().last_used -= Duration::from_secs(61);
        assert_eq!(cache.get(&1), None);
        cache.retain(|key| *key != 3);
        assert_eq!(cache.usage(), (0, 0));
        cache.clear();
        let cancellation = Cancellation::default();
        cancellation.cancel();
        assert!(cancellation.is_cancelled());
    }

    #[tokio::test]
    async fn flights_share_work_and_only_last_cancellation_drops_it() {
        let flights = RequestFlights::default();
        let (release, ready) = tokio::sync::oneshot::channel();
        let mut first = Box::pin(flights.run("page", async {
            ready.await.unwrap();
            42
        }));
        assert!(futures_util::poll!(&mut first).is_pending());
        let mut second = Box::pin(flights.run("page", async { panic!("duplicate work") }));
        assert!(futures_util::poll!(&mut second).is_pending());
        drop(first);
        release.send(()).unwrap();
        assert_eq!(second.await, 42);
        // Completed results are not a second, unbounded result cache.
        assert_eq!(flights.run("page", async { 43 }).await, 43);
        let (release, ready) = tokio::sync::oneshot::channel::<()>();
        let mut cancelled = Box::pin(flights.run("cancelled", async {
            ready.await.unwrap();
            1
        }));
        assert!(futures_util::poll!(&mut cancelled).is_pending());
        drop(cancelled);
        assert!(release.is_closed());
    }
}
