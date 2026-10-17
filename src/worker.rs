//! Bounded CPU workers, independent of Tokio's filesystem/blocking pool.
//! Cancellation skips queued jobs; a running native job cannot be forcibly stopped.
//! Queue/input budgets bound admitted work, not peak process memory.
use crate::resources::Cancellation;
use std::{
    collections::VecDeque,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc, Condvar, Mutex, Weak,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};
use tokio::sync::oneshot;

type Job = Box<dyn FnOnce() + Send + 'static>;

#[derive(Clone)]
pub struct WorkerPool {
    owner: Arc<PoolOwner>,
    bytes: Arc<AtomicUsize>,
}

struct PoolOwner {
    queue: Arc<Queue>,
    threads: Mutex<Vec<std::thread::JoinHandle<()>>>,
}

struct Queue {
    state: Mutex<QueueState>,
    ready: Condvar,
    limit: usize,
    next_id: AtomicU64,
}

#[derive(Default)]
struct QueueState {
    jobs: VecDeque<(u64, Job)>,
    closed: bool,
}

impl Queue {
    fn close(&self) {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .closed = true;
        self.ready.notify_all();
    }
}

impl Drop for PoolOwner {
    fn drop(&mut self) {
        self.queue.close();
    }
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum WorkerError {
    #[error("Render queue is full; retry shortly")]
    Busy,
    #[error("Render worker stopped")]
    Stopped,
    #[error("Render task panicked")]
    Panicked,
}

impl WorkerPool {
    pub fn new(name: &str, threads: usize, pending: usize) -> Self {
        assert!(threads > 0 && pending > 0);
        let queue = Arc::new(Queue {
            state: Mutex::new(QueueState::default()),
            ready: Condvar::new(),
            limit: pending,
            next_id: AtomicU64::new(1),
        });
        let mut handles = Vec::new();
        for index in 0..threads {
            let queue = queue.clone();
            let thread = std::thread::Builder::new()
                .name(format!("{name}-{index}"))
                .spawn(move || {
                    loop {
                        let job = {
                            let state = queue
                                .state
                                .lock()
                                .unwrap_or_else(|error| error.into_inner());
                            let mut state = queue
                                .ready
                                .wait_while(state, |state| state.jobs.is_empty() && !state.closed)
                                .unwrap_or_else(|error| error.into_inner());
                            state.jobs.pop_front()
                        };
                        let Some((_, job)) = job else { break };
                        job();
                    }
                })
                .expect("start render worker");
            handles.push(thread);
        }
        Self {
            owner: Arc::new(PoolOwner {
                queue,
                threads: Mutex::new(handles),
            }),
            bytes: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub async fn run<F, T>(&self, task: F) -> Result<T, WorkerError>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        self.run_sized(0, task).await
    }

    pub async fn run_sized<F, T>(&self, bytes: usize, task: F) -> Result<T, WorkerError>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        self.run_cancellable(bytes, move |_| task()).await
    }

    pub async fn run_cancellable<F, T>(&self, bytes: usize, task: F) -> Result<T, WorkerError>
    where
        F: FnOnce(Cancellation) -> T + Send + 'static,
        T: Send + 'static,
    {
        let cancellation = Cancellation::default();
        let id = self.owner.queue.next_id.fetch_add(1, Ordering::Relaxed);
        let _cancel_on_drop = CancelOnDrop {
            cancellation: cancellation.clone(),
            queue: Arc::downgrade(&self.owner.queue),
            id,
        };
        // Include running work in the budget. The guard also releases cancelled
        // and rejected tasks, without waiting for a successful reply.
        let mut used = self.bytes.load(Ordering::Acquire);
        loop {
            let total = used
                .checked_add(bytes)
                .filter(|total| *total <= 32 * 1024 * 1024)
                .ok_or(WorkerError::Busy)?;
            match self
                .bytes
                .compare_exchange_weak(used, total, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => break,
                Err(current) => used = current,
            }
        }
        let reservation = Reservation {
            counter: self.bytes.clone(),
            bytes,
        };
        let (reply, result) = oneshot::channel();
        {
            let mut state = self
                .owner
                .queue
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if state.closed {
                return Err(WorkerError::Stopped);
            }
            if state.jobs.len() >= self.owner.queue.limit {
                return Err(WorkerError::Busy);
            }
            state.jobs.push_back((
                id,
                Box::new(move || {
                    let _reservation = reservation;
                    // Disconnected HTTP requests do not consume CPU while queued.
                    if reply.is_closed() {
                        return;
                    }
                    // Recovery applies only to unwind builds (including Cargo tests).
                    // Release uses panic=abort, so a panic terminates the process.
                    let value = catch_unwind(AssertUnwindSafe(|| task(cancellation)))
                        .map_err(|_| WorkerError::Panicked);
                    drop(_reservation);
                    let _ = reply.send(value);
                }),
            ));
        }
        self.owner.queue.ready.notify_one();
        result.await.map_err(|_| WorkerError::Stopped)?
    }

    /// Stop admission, drain accepted work and join native threads off Tokio.
    pub async fn shutdown(&self) {
        self.owner.queue.close();
        let threads = std::mem::take(
            &mut *self
                .owner
                .threads
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        let _ = tokio::task::spawn_blocking(move || {
            for thread in threads {
                let _ = thread.join();
            }
        })
        .await;
    }
}

struct CancelOnDrop {
    cancellation: Cancellation,
    queue: Weak<Queue>,
    id: u64,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.cancellation.cancel();
        if let Some(queue) = self.queue.upgrade() {
            let removed = {
                let mut state = queue
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                state
                    .jobs
                    .iter()
                    .position(|(id, _)| *id == self.id)
                    .and_then(|index| state.jobs.remove(index))
            };
            // Release captured sources and their byte reservation outside the
            // queue lock; dropping a capture can release another service owner.
            drop(removed);
        }
    }
}

struct Reservation {
    counter: Arc<AtomicUsize>,
    bytes: usize,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.counter.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc;

    #[tokio::test]
    async fn running_work_observes_last_subscriber_cancellation_and_shutdown_joins_workers() {
        let pool = WorkerPool::new("cancel-running", 1, 2);
        let (release, wait) = mpsc::channel();
        let (started, ready) = oneshot::channel();
        let (observed, result) = oneshot::channel();
        let mut request = Box::pin(pool.run_cancellable(1024, move |cancellation| {
            started.send(()).unwrap();
            wait.recv().unwrap();
            observed.send(cancellation.is_cancelled()).unwrap();
        }));
        assert!(futures_util::poll!(&mut request).is_pending());
        ready.await.unwrap();
        drop(request);
        release.send(()).unwrap();
        assert!(result.await.unwrap());
        pool.shutdown().await;
        assert_eq!(pool.bytes.load(Ordering::Acquire), 0);
        assert!(matches!(pool.run(|| ()).await, Err(WorkerError::Stopped)));
        pool.shutdown().await;
    }

    #[tokio::test]
    async fn bounded_queue_skips_cancelled_jobs_and_recovers_after_panics() {
        let pool = WorkerPool::new("test", 1, 1);
        let (release, wait) = mpsc::channel();
        let (started, ready) = oneshot::channel();
        let first_pool = pool.clone();
        let first = tokio::spawn(async move {
            first_pool
                .run(move || {
                    let _ = started.send(());
                    wait.recv().unwrap();
                })
                .await
        });
        ready.await.unwrap();
        let executed = Arc::new(AtomicBool::new(false));
        let flag = executed.clone();
        let mut queued = Box::pin(pool.run_sized(1024, move || {
            flag.store(true, Ordering::Release);
        }));
        assert!(futures_util::poll!(&mut queued).is_pending());
        assert!(matches!(
            pool.run_sized(2048, || ()).await,
            Err(WorkerError::Busy)
        ));
        assert_eq!(pool.bytes.load(Ordering::Acquire), 1024);
        drop(queued);
        assert_eq!(pool.bytes.load(Ordering::Acquire), 0);
        // Cancellation frees the queue immediately, even while native work is
        // still blocked. A replacement must not wait for tombstones to drain.
        let mut replacement = Box::pin(pool.run_sized(2048, || ()));
        assert!(futures_util::poll!(&mut replacement).is_pending());
        assert_eq!(pool.bytes.load(Ordering::Acquire), 2048);
        drop(replacement);
        assert_eq!(pool.bytes.load(Ordering::Acquire), 0);
        release.send(()).unwrap();
        first.await.unwrap().unwrap();
        // A barrier confirms admission still works after cancellation.
        loop {
            match pool.run(|| ()).await {
                Ok(()) => break,
                Err(WorkerError::Busy) => tokio::task::yield_now().await,
                result => panic!("unexpected result: {result:?}"),
            }
        }
        assert!(!executed.load(Ordering::Acquire));
        assert_eq!(pool.bytes.load(Ordering::Acquire), 0);
        assert!(matches!(
            pool.run(|| panic!("test panic")).await,
            Err(WorkerError::Panicked)
        ));
        assert_eq!(pool.run(|| 42).await.unwrap(), 42);
    }

    #[tokio::test]
    async fn byte_budget_rejects_oversized_work_without_running_it() {
        let pool = WorkerPool::new("test-budget", 1, 1);
        assert!(matches!(
            pool.run_sized(32 * 1024 * 1024 + 1, || panic!("must not run"))
                .await,
            Err(WorkerError::Busy)
        ));
        assert_eq!(pool.bytes.load(Ordering::Acquire), 0);
        assert_eq!(pool.run_sized(32 * 1024 * 1024, || 7).await.unwrap(), 7);
    }
}
