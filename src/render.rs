//! Native render services: bounded execution, shared requests and repository owners.

use crate::{
    pdf,
    resources::RequestFlights,
    typst,
    worker::{WorkerError, WorkerPool},
};
use lru::LruCache;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

type CompileKey = (PathBuf, String, String, u128);
type CompileResult = Result<Result<typst::CompileResponse, typst::CompileError>, WorkerError>;
type TypstPageKey = (PathBuf, String, usize);
type TypstPageResult = Result<Result<typst::RenderedPage, String>, WorkerError>;
type PdfPageKey = (PathBuf, String, usize);
type PdfPageResult = Result<Result<bytes::Bytes, Arc<pdf::PdfError>>, WorkerError>;

pub struct RenderService {
    pub pdf: Arc<pdf::NativePdfRenderer>,
    compilers: Mutex<LruCache<PathBuf, Arc<typst::NativeTypstCompiler>>>,
    active_paths: Mutex<HashSet<PathBuf>>,
    pages: typst::PageCache,
    compile_workers: WorkerPool,
    page_workers: WorkerPool,
    compilations: RequestFlights<CompileKey, CompileResult>,
    typst_pages: RequestFlights<TypstPageKey, TypstPageResult>,
    pdf_pages: RequestFlights<PdfPageKey, PdfPageResult>,
    closed: AtomicBool,
}

impl Default for RenderService {
    fn default() -> Self {
        Self {
            pdf: Arc::new(pdf::NativePdfRenderer::default()),
            compilers: Mutex::new(LruCache::unbounded()),
            active_paths: Mutex::new(HashSet::new()),
            pages: typst::page_cache(),
            compile_workers: WorkerPool::new("compile", 1, 32),
            page_workers: WorkerPool::new("page", 2, 32),
            compilations: RequestFlights::default(),
            typst_pages: RequestFlights::default(),
            pdf_pages: RequestFlights::default(),
            closed: AtomicBool::new(false),
        }
    }
}

impl RenderService {
    fn compiler(&self, root: &Path) -> Result<Arc<typst::NativeTypstCompiler>, WorkerError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(WorkerError::Stopped);
        }
        let mut compilers = self
            .compilers
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(compiler) = compilers.get(root) {
            return Ok(compiler.clone());
        }
        let mut retired = Vec::new();
        while compilers.len() >= 3 {
            let victim = compilers
                .iter()
                .rev()
                .find(|(_, compiler)| {
                    Arc::strong_count(compiler) == 1 && !compiler.has_active_documents()
                })
                .map(|(root, _)| root.clone());
            let Some(root) = victim else { break };
            if let Some(compiler) = compilers.pop(&root) {
                retired.push(compiler);
            }
        }
        if compilers.len() >= 8 {
            return Err(WorkerError::Busy);
        }
        let compiler = Arc::new(typst::NativeTypstCompiler::with_page_cache(
            root.to_owned(),
            self.pages.clone(),
        ));
        compiler.set_active_paths(
            self.active_paths
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .iter()
                .cloned(),
        );
        compilers.put(root.to_owned(), compiler.clone());
        drop(compilers);
        drop(retired);
        Ok(compiler)
    }

    pub fn set_active_paths(&self, paths: HashSet<PathBuf>) {
        // Keep registry -> lease -> compiler lock order consistent with admission.
        let compilers = self
            .compilers
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut active = self
            .active_paths
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *active = paths;
        self.pdf.set_active_paths(active.iter().cloned());
        for (_, compiler) in compilers.iter() {
            compiler.set_active_paths(active.iter().cloned());
        }
    }

    pub async fn compile(
        self: &Arc<Self>,
        root: &Path,
        request: typst::CompileRequest,
    ) -> CompileResult {
        if self.closed.load(Ordering::Acquire) {
            return Err(WorkerError::Stopped);
        }
        let key = (
            root.to_owned(),
            request.path.clone(),
            request
                .theme
                .as_deref()
                .filter(|theme| *theme == "dark")
                .unwrap_or("light")
                .to_owned(),
            ::typst::utils::hash128(&request.source),
        );
        let workers = self.compile_workers.clone();
        let service = self.clone();
        let root = root.to_owned();
        let bytes = request.source.len().saturating_mul(2);
        self.compilations
            .run(key, async move {
                workers
                    .run_cancellable(bytes, move |cancellation| {
                        Ok(service
                            .compiler(&root)?
                            .compile_cancellable(request, &cancellation))
                    })
                    .await?
            })
            .await
    }

    pub async fn typst_page(
        self: &Arc<Self>,
        root: &Path,
        id: String,
        page: usize,
    ) -> TypstPageResult {
        if self.closed.load(Ordering::Acquire) {
            return Err(WorkerError::Stopped);
        }
        let key = (root.to_owned(), id.clone(), page);
        let workers = self.page_workers.clone();
        let service = self.clone();
        let root = root.to_owned();
        self.typst_pages
            .run(key, async move {
                workers
                    .run_cancellable(0, move |cancellation| {
                        Ok(service
                            .compiler(&root)?
                            .page_cancellable(&id, page, &cancellation))
                    })
                    .await?
            })
            .await
    }

    pub async fn pdf_page(&self, path: PathBuf, revision: String, page: usize) -> PdfPageResult {
        if self.closed.load(Ordering::Acquire) {
            return Err(WorkerError::Stopped);
        }
        let key = (path.clone(), revision.clone(), page);
        let workers = self.page_workers.clone();
        let renderer = self.pdf.clone();
        self.pdf_pages
            .run(key, async move {
                workers
                    .run_cancellable(0, move |cancellation| {
                        renderer
                            .page_svg_cancellable(&path, &revision, page, &cancellation)
                            .map_err(Arc::new)
                    })
                    .await
            })
            .await
    }

    pub fn sweep(&self) {
        self.pdf.evict_idle(Duration::from_secs(5 * 60));
        let compilers = self
            .compilers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|(_, compiler)| compiler.clone())
            .collect::<Vec<_>>();
        let all_idle = compilers
            .iter()
            .map(|compiler| compiler.evict_idle(Duration::from_secs(15 * 60)))
            .fold(true, |all, idle| all && idle);
        if all_idle {
            comemo::evict(0);
        }
    }

    pub async fn close(self: &Arc<Self>) {
        self.closed.store(true, Ordering::Release);
        self.compile_workers.shutdown().await;
        self.page_workers.shutdown().await;
        let service = self.clone();
        let _ = tokio::task::spawn_blocking(move || service.clear()).await;
    }

    fn clear(&self) {
        let compilers = self
            .compilers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|(_, compiler)| compiler.clone())
            .collect::<Vec<_>>();
        for compiler in compilers {
            compiler.clear();
        }
        self.compilers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        self.pdf.clear();
        self.pages
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        self.active_paths
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        comemo::evict(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn duplicate_compiles_share_queue_slot_and_survive_one_subscriber_cancelling() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("shared.typ");
        std::fs::write(&path, "Shared").unwrap();
        let service = Arc::new(RenderService {
            compile_workers: WorkerPool::new("coalesced-test", 1, 1),
            ..Default::default()
        });
        let workers = service.compile_workers.clone();
        let (release, wait) = std::sync::mpsc::channel();
        let (started, ready) = tokio::sync::oneshot::channel();
        let blocker = tokio::spawn(async move {
            workers
                .run(move || {
                    started.send(()).unwrap();
                    wait.recv().unwrap();
                })
                .await
        });
        ready.await.unwrap();
        let request = || typst::CompileRequest {
            path: path.to_string_lossy().into_owned(),
            source: "Shared".into(),
            theme: None,
        };
        let mut first = Box::pin(service.compile(root.path(), request()));
        let mut second = Box::pin(service.compile(root.path(), request()));
        assert!(futures_util::poll!(&mut first).is_pending());
        assert!(futures_util::poll!(&mut second).is_pending());
        let mut other = request();
        other.source = "Different".into();
        assert!(matches!(
            service.compile(root.path(), other).await,
            Err(WorkerError::Busy)
        ));
        drop(first);
        release.send(()).unwrap();
        blocker.await.unwrap().unwrap();
        let compiled = second.await.unwrap().unwrap();
        assert_eq!(
            compiled.id,
            service
                .compile(root.path(), request())
                .await
                .unwrap()
                .unwrap()
                .id
        );
        let page = service
            .typst_page(root.path(), compiled.id.clone(), 1)
            .await
            .unwrap()
            .unwrap();
        assert!(!page.svg.is_empty());
        assert_eq!(service.pages.lock().unwrap().usage().0, 1);
        service.close().await;
        assert_eq!(service.pages.lock().unwrap().usage(), (0, 0));
        assert!(matches!(
            service.typst_page(root.path(), compiled.id, 1).await,
            Err(WorkerError::Stopped)
        ));
    }

    #[tokio::test]
    async fn page_ids_are_repository_scoped_and_compilers_share_one_output_budget() {
        let roots = [tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap()];
        let service = Arc::new(RenderService::default());
        let mut compiled = Vec::new();
        for root in &roots {
            let path = root.path().join("note.typ");
            std::fs::write(&path, "Notes").unwrap();
            compiled.push(
                service
                    .compile(
                        root.path(),
                        typst::CompileRequest {
                            path: path.to_string_lossy().into_owned(),
                            source: "Notes".into(),
                            theme: None,
                        },
                    )
                    .await
                    .unwrap()
                    .unwrap(),
            );
        }
        assert!(
            service
                .typst_page(roots[1].path(), compiled[0].id.clone(), 1)
                .await
                .unwrap()
                .is_err()
        );
        for (root, compiled) in roots.iter().zip(compiled) {
            service
                .typst_page(root.path(), compiled.id, 1)
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(service.pages.lock().unwrap().usage().0, 2);
        service.close().await;
    }
}
