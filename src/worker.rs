//! Bounded CPU workers, independent of Tokio's filesystem/blocking pool.
use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
};
use tokio::sync::oneshot;

type Job = Box<dyn FnOnce() + Send + 'static>;

#[derive(Clone)]
pub struct WorkerPool {
    sender: mpsc::SyncSender<Job>,
    bytes: Arc<AtomicUsize>,
}

#[derive(Debug, thiserror::Error)]
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
        let (sender, receiver) = mpsc::sync_channel::<Job>(pending);
        let receiver = Arc::new(Mutex::new(receiver));
        for index in 0..threads {
            let receiver = receiver.clone();
            std::thread::Builder::new()
                .name(format!("{name}-{index}"))
                .spawn(move || {
                    loop {
                        // Release the receiver lock before executing the job.
                        let job = receiver.lock().unwrap_or_else(|e| e.into_inner()).recv();
                        match job {
                            Ok(job) => job(),
                            Err(_) => break,
                        }
                    }
                })
                .expect("start render worker");
        }
        Self {
            sender,
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
        self.sender
            .try_send(Box::new(move || {
                let _reservation = reservation;
                // Disconnected HTTP requests do not consume CPU while queued.
                if reply.is_closed() {
                    return;
                }
                let value = catch_unwind(AssertUnwindSafe(task)).map_err(|_| WorkerError::Panicked);
                drop(_reservation);
                let _ = reply.send(value);
            }))
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => WorkerError::Busy,
                mpsc::TrySendError::Disconnected(_) => WorkerError::Stopped,
            })?;
        result.await.map_err(|_| WorkerError::Stopped)?
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
        release.send(()).unwrap();
        first.await.unwrap().unwrap();
        // The worker drains the cancelled task before this barrier job.
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
