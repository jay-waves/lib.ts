//! Native PDF metadata and per-page SVG rendering through Hayro.

use crate::resources::{ByteCache, Cancellation};
use bytes::Bytes;
use hayro_svg::{
    RenderCache, SvgRenderSettings, convert, hayro_interpret::InterpreterSettings,
    hayro_syntax::Pdf,
};
use lru::LruCache;
use serde::Serialize;
use std::{
    collections::HashSet,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const DOCUMENT_LIMIT: usize = 3;
const FILE_LIMIT: u64 = 64 * 1024 * 1024;
const DOCUMENT_BYTES_LIMIT: usize = 128 * 1024 * 1024;
const SVG_CACHE_LIMIT: usize = 8 * 1024 * 1024;
const DOCUMENT_HARD_LIMIT: usize = 32;
const REVISION_GRACE: Duration = Duration::from_secs(60);
type DocumentKey = (PathBuf, String);
type PageKey = (PathBuf, String, usize);

#[derive(Debug, Clone, Serialize)]
pub struct PageInfo {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutlineItem {
    pub name: String,
    pub level: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
}

#[derive(Clone)]
pub struct DocumentInfo {
    pub pages: Vec<PageInfo>,
    pub outline: Vec<OutlineItem>,
}

struct PdfEntry {
    pdf: Arc<Pdf>,
    info: Arc<DocumentInfo>,
    last_used: Instant,
    input_bytes: usize,
    superseded_at: Option<Instant>,
}

struct PdfState {
    documents: LruCache<DocumentKey, PdfEntry>,
    svgs: ByteCache<PageKey, Bytes>,
    active_paths: HashSet<PathBuf>,
    generation: u64,
}

impl PdfState {
    fn new() -> Self {
        Self {
            documents: LruCache::unbounded(),
            svgs: ByteCache::new(64, SVG_CACHE_LIMIT, Duration::from_secs(60)),
            active_paths: HashSet::new(),
            generation: 0,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PdfError {
    #[error("PDF I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("Invalid PDF: {0}")]
    Invalid(String),
    #[error("PDF cache lock poisoned")]
    CachePoisoned,
    #[error("PDF changed; reload its metadata")]
    Changed,
    #[error("PDF source exceeds 64 MiB")]
    TooLarge,
    #[error("Page number must be positive")]
    InvalidPage,
    #[error("Page not found")]
    PageNotFound,
    #[error("PDF resources are busy; close an unused reader and retry")]
    Busy,
    #[error("PDF request cancelled")]
    Cancelled,
}

fn remove_document(state: &mut PdfState, key: &DocumentKey) {
    state.documents.pop(key);
    state
        .svgs
        .retain(|(path, revision, _)| path != &key.0 || revision != &key.1);
}

fn protected(state: &PdfState, key: &DocumentKey, entry: &PdfEntry) -> bool {
    Arc::strong_count(&entry.pdf) > 1
        || (entry.superseded_at.is_none() && state.active_paths.contains(&key.0))
        || entry
            .superseded_at
            .is_some_and(|at| at.elapsed() < REVISION_GRACE)
}

fn trim_documents(
    state: &mut PdfState,
    incoming_bytes: usize,
    keep: Option<&DocumentKey>,
) -> Result<(), PdfError> {
    loop {
        let bytes = state
            .documents
            .iter()
            .map(|(_, entry)| entry.input_bytes)
            .sum::<usize>();
        let hard_pressure = bytes.saturating_add(incoming_bytes) > DOCUMENT_BYTES_LIMIT
            || state.documents.len() + usize::from(incoming_bytes > 0) > DOCUMENT_HARD_LIMIT;
        if !hard_pressure
            && state.documents.len() < DOCUMENT_LIMIT + usize::from(incoming_bytes == 0)
        {
            break;
        }
        let victim = state
            .documents
            .iter()
            .rev()
            .find(|(key, entry)| Some(*key) != keep && !protected(state, key, entry))
            .map(|(key, _)| key.clone());
        if let Some(key) = victim {
            remove_document(state, &key);
        } else if hard_pressure {
            return Err(PdfError::Busy);
        } else {
            break;
        }
    }
    Ok(())
}

#[path = "pdf_outline.rs"]
mod pdf_outline;
use pdf_outline::outline;

pub struct NativePdfRenderer {
    state: Mutex<PdfState>,
    load_gate: Mutex<()>,
}

impl Default for NativePdfRenderer {
    fn default() -> Self {
        Self {
            state: Mutex::new(PdfState::new()),
            load_gate: Mutex::new(()),
        }
    }
}

impl NativePdfRenderer {
    #[cfg(test)]
    #[allow(dead_code)] // Standalone lifecycle benchmark diagnostics.
    pub fn cache_usage(&self) -> (usize, usize, usize, usize) {
        let state = self.state.lock().unwrap();
        let (pages, bytes) = state.svgs.usage();
        (
            state.documents.len(),
            state
                .documents
                .iter()
                .map(|(_, entry)| entry.input_bytes)
                .sum(),
            pages,
            bytes,
        )
    }
    pub fn set_active_paths(&self, paths: impl IntoIterator<Item = PathBuf>) {
        if let Ok(mut state) = self.state.lock() {
            state.active_paths = paths.into_iter().collect();
        }
    }

    pub fn clear(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.generation = state.generation.wrapping_add(1);
            state.documents.clear();
            state.svgs.clear();
            state.active_paths.clear();
        }
    }

    pub fn evict_idle(&self, idle_for: Duration) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let expired = state
            .documents
            .iter()
            .filter(|(key, entry)| {
                !protected(&state, key, entry)
                    && (entry.last_used.elapsed() >= idle_for
                        || entry
                            .superseded_at
                            .is_some_and(|at| at.elapsed() >= REVISION_GRACE))
            })
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();
        for path in expired {
            remove_document(&mut state, &path);
        }
        state.svgs.prune();
        let _ = trim_documents(&mut state, 0, None);
    }

    #[cfg(test)]
    pub fn document(&self, path: &Path, revision: &str) -> Result<DocumentInfo, PdfError> {
        self.snapshot(path, revision)
            .map(|(_, info)| (*info).clone())
    }

    pub fn document_cancellable(
        &self,
        path: &Path,
        revision: &str,
        cancellation: &Cancellation,
    ) -> Result<DocumentInfo, PdfError> {
        self.snapshot_cancellable(path, revision, cancellation)
            .map(|(_, info)| (*info).clone())
    }

    #[cfg(test)]
    fn snapshot(
        &self,
        path: &Path,
        revision: &str,
    ) -> Result<(Arc<Pdf>, Arc<DocumentInfo>), PdfError> {
        self.snapshot_cancellable(path, revision, &Cancellation::default())
    }

    fn snapshot_cancellable(
        &self,
        path: &Path,
        revision: &str,
        cancellation: &Cancellation,
    ) -> Result<(Arc<Pdf>, Arc<DocumentInfo>), PdfError> {
        let key = (path.to_owned(), revision.to_owned());
        if cancellation.is_cancelled() {
            return Err(PdfError::Cancelled);
        }
        let generation;
        {
            let mut state = self.state.lock().map_err(|_| PdfError::CachePoisoned)?;
            generation = state.generation;
            if state.documents.peek(&key).is_some_and(|entry| {
                entry
                    .superseded_at
                    .is_some_and(|at| at.elapsed() >= REVISION_GRACE)
                    && Arc::strong_count(&entry.pdf) == 1
            }) {
                remove_document(&mut state, &key);
            }
            if let Some(entry) = state.documents.get_mut(&key) {
                entry.last_used = Instant::now();
                return Ok((entry.pdf.clone(), entry.info.clone()));
            }
        }

        // Recheck after taking the load gate so duplicate requests share a parse.
        let _load = self.load_gate.lock().map_err(|_| PdfError::CachePoisoned)?;
        {
            let mut state = self.state.lock().map_err(|_| PdfError::CachePoisoned)?;
            if let Some(entry) = state.documents.get_mut(&key) {
                entry.last_used = Instant::now();
                return Ok((entry.pdf.clone(), entry.info.clone()));
            }
        }
        if self::revision(path)? != revision {
            return Err(PdfError::Changed);
        }
        let file = std::fs::File::open(path)?;
        if file.metadata()?.len() > FILE_LIMIT {
            return Err(PdfError::TooLarge);
        }
        {
            let mut state = self.state.lock().map_err(|_| PdfError::CachePoisoned)?;
            let obsolete = state
                .documents
                .iter()
                .filter(|((other_path, _), entry)| {
                    other_path == path
                        && entry.superseded_at.is_some()
                        && Arc::strong_count(&entry.pdf) == 1
                })
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            for key in obsolete {
                remove_document(&mut state, &key);
            }
            let previous = state
                .documents
                .iter()
                .find(|((other_path, _), entry)| {
                    other_path == path && entry.superseded_at.is_none()
                })
                .map(|(key, _)| key.clone());
            trim_documents(
                &mut state,
                file.metadata()?.len() as usize,
                previous.as_ref(),
            )?;
        }
        let mut data = Vec::new();
        file.take(FILE_LIMIT + 1).read_to_end(&mut data)?;
        if data.len() as u64 > FILE_LIMIT {
            return Err(PdfError::TooLarge);
        }
        if self::revision(path)? != revision {
            return Err(PdfError::Changed);
        }
        let input_bytes = data.len();

        let pdf =
            Arc::new(Pdf::new(data).map_err(|error| PdfError::Invalid(format!("{error:?}")))?);
        let pages = pdf
            .pages()
            .iter()
            .map(|page| {
                let (width, height) = page.render_dimensions();
                PageInfo {
                    width: f64::from(width),
                    height: f64::from(height),
                }
            })
            .collect();
        let outline = outline(&pdf);
        let info = Arc::new(DocumentInfo { pages, outline });

        if cancellation.is_cancelled() {
            return Err(PdfError::Cancelled);
        }
        let mut state = self.state.lock().map_err(|_| PdfError::CachePoisoned)?;
        if cancellation.is_cancelled() || state.generation != generation {
            return Err(PdfError::Cancelled);
        }
        for ((other_path, _), entry) in state.documents.iter_mut() {
            if other_path == path && entry.superseded_at.is_none() {
                entry.superseded_at = Some(Instant::now());
            }
        }
        // Retain at most one superseded revision per file, unless a renderer
        // still owns it. Arc keeps native data alive until that render returns.
        let old = state
            .documents
            .iter()
            .filter(|((other_path, _), _)| other_path == path)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in old.iter().skip(1) {
            if state
                .documents
                .peek(key)
                .is_some_and(|entry| Arc::strong_count(&entry.pdf) == 1)
            {
                remove_document(&mut state, key);
            }
        }
        state.documents.put(
            key,
            PdfEntry {
                pdf: pdf.clone(),
                info: info.clone(),
                last_used: Instant::now(),
                input_bytes,
                superseded_at: None,
            },
        );
        Ok((pdf, info))
    }

    #[cfg(test)]
    pub fn page_svg(
        &self,
        path: &Path,
        revision: &str,
        page_number: usize,
    ) -> Result<Bytes, PdfError> {
        self.page_svg_cancellable(path, revision, page_number, &Cancellation::default())
    }

    pub fn page_svg_cancellable(
        &self,
        path: &Path,
        revision: &str,
        page_number: usize,
        cancellation: &Cancellation,
    ) -> Result<Bytes, PdfError> {
        if page_number == 0 {
            return Err(PdfError::InvalidPage);
        }
        let (pdf, info) = self.snapshot_cancellable(path, revision, cancellation)?;
        let page_index = page_number - 1;
        if page_index >= info.pages.len() {
            return Err(PdfError::PageNotFound);
        }
        let key = (path.to_owned(), revision.to_owned(), page_number);
        {
            let mut state = self.state.lock().map_err(|_| PdfError::CachePoisoned)?;
            if let Some(svg) = state.svgs.get(&key) {
                return Ok(svg);
            }
        }

        let page = &pdf.pages()[page_index];
        let cache = RenderCache::new();
        let render_settings = SvgRenderSettings {
            // A PDF page is paper, so keep its canvas white in both UI themes.
            // The PDF's own drawing colors remain unchanged.
            bg_color: [255, 255, 255, 255],
        };
        let interpreter_settings = InterpreterSettings {
            render_annotations: false,
            ..InterpreterSettings::default()
        };
        let svg = Bytes::from(convert(
            page,
            &cache,
            &interpreter_settings,
            &render_settings,
        ));
        if !cancellation.is_cancelled() && svg.len() <= SVG_CACHE_LIMIT {
            let mut state = self.state.lock().map_err(|_| PdfError::CachePoisoned)?;
            // An in-flight render can finish after eviction or replacement.
            if cancellation.is_cancelled()
                || !state
                    .documents
                    .peek(&(path.to_owned(), revision.to_owned()))
                    .is_some_and(|entry| Arc::ptr_eq(&entry.pdf, &pdf))
            {
                return Ok(svg);
            }
            state.svgs.insert(key, svg.clone(), svg.len());
        }
        Ok(svg)
    }
}

pub fn revision(path: &Path) -> Result<String, PdfError> {
    let metadata = path.metadata()?;
    let modified = metadata
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(format!("{modified}-{}", metadata.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leases_keep_all_active_pdfs_resident_until_release() {
        let root = tempfile::tempdir().unwrap();
        let renderer = NativePdfRenderer::default();
        let paths = (0..5)
            .map(|index| root.path().join(format!("{index}.pdf")))
            .collect::<Vec<_>>();
        renderer.set_active_paths(paths.clone());
        let snapshots = paths
            .iter()
            .map(|path| {
                std::fs::write(path, pdf_with_nested_outline()).unwrap();
                let (snapshot, _) = renderer.snapshot(path, &revision(path).unwrap()).unwrap();
                Arc::downgrade(&snapshot)
            })
            .collect::<Vec<_>>();
        renderer.evict_idle(Duration::ZERO);
        assert!(
            snapshots
                .iter()
                .all(|snapshot| snapshot.upgrade().is_some())
        );
        renderer.set_active_paths([]);
        renderer.evict_idle(Duration::ZERO);
        assert!(
            snapshots
                .iter()
                .all(|snapshot| snapshot.upgrade().is_none())
        );
        assert_eq!(renderer.state.lock().unwrap().svgs.usage(), (0, 0));
    }

    #[test]
    fn superseded_pdf_is_available_during_grace_then_expires_despite_lease() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("revision.pdf");
        let renderer = NativePdfRenderer::default();
        let mut bytes = pdf_with_nested_outline();
        std::fs::write(&path, &bytes).unwrap();
        let old = revision(&path).unwrap();
        renderer.document(&path, &old).unwrap();
        renderer.set_active_paths([path.clone()]);
        bytes.push(b'\n');
        std::fs::write(&path, &bytes).unwrap();
        let new = revision(&path).unwrap();
        renderer.document(&path, &new).unwrap();
        assert!(renderer.page_svg(&path, &old, 1).is_ok());
        renderer
            .state
            .lock()
            .unwrap()
            .documents
            .get_mut(&(path.clone(), old.clone()))
            .unwrap()
            .superseded_at = Some(Instant::now() - REVISION_GRACE);
        assert!(matches!(
            renderer.page_svg(&path, &old, 1),
            Err(PdfError::Changed)
        ));
        renderer.evict_idle(Duration::ZERO);
        assert!(renderer.page_svg(&path, &new, 1).is_ok());
        assert_eq!(renderer.state.lock().unwrap().documents.len(), 1);
    }

    #[test]
    fn pdf_byte_pressure_rejects_new_load_without_evicting_leased_documents() {
        let root = tempfile::tempdir().unwrap();
        let renderer = NativePdfRenderer::default();
        let paths = (0..3)
            .map(|index| root.path().join(format!("{index}.pdf")))
            .collect::<Vec<_>>();
        renderer.set_active_paths(paths.clone());
        for path in &paths {
            std::fs::write(path, pdf_with_nested_outline()).unwrap();
        }
        for path in &paths[..2] {
            renderer.document(path, &revision(path).unwrap()).unwrap();
        }
        for (_, entry) in renderer.state.lock().unwrap().documents.iter_mut() {
            entry.input_bytes = FILE_LIMIT as usize;
        }
        assert!(matches!(
            renderer.document(&paths[2], &revision(&paths[2]).unwrap()),
            Err(PdfError::Busy)
        ));
        assert_eq!(renderer.state.lock().unwrap().documents.len(), 2);
    }

    #[test]
    fn cancelled_pdf_load_does_not_publish_native_or_svg_cache_entries() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("cancelled.pdf");
        std::fs::write(&path, pdf_with_nested_outline()).unwrap();
        let renderer = NativePdfRenderer::default();
        let cancellation = Cancellation::default();
        cancellation.cancel();
        assert!(matches!(
            renderer.document_cancellable(&path, &revision(&path).unwrap(), &cancellation),
            Err(PdfError::Cancelled)
        ));
        assert!(renderer.state.lock().unwrap().documents.is_empty());
        let revision = revision(&path).unwrap();
        renderer.document(&path, &revision).unwrap();
        renderer.clear();
        assert_eq!(renderer.state.lock().unwrap().svgs.usage(), (0, 0));
        assert!(renderer.page_svg(&path, &revision, 1).is_ok());
    }

    fn pdf_with_nested_outline() -> Vec<u8> {
        let objects = [
            b"<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>".as_slice(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".as_slice(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>".as_slice(),
            b"<< /Type /Outlines /First 5 0 R /Last 5 0 R /Count 2 >>".as_slice(),
            b"<< /Title (Chapter) /Parent 4 0 R /Dest [3 0 R /Fit] /First 6 0 R /Last 6 0 R /Count 1 >>".as_slice(),
            b"<< /Title (Section) /Parent 5 0 R /Dest [3 0 R /Fit] >>".as_slice(),
        ];
        let mut bytes = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(bytes.len());
            bytes.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
            bytes.extend_from_slice(object);
            bytes.extend_from_slice(b"\nendobj\n");
        }
        let xref_offset = bytes.len();
        bytes.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
        bytes.extend_from_slice(b"0000000000 65535 f \n");
        for offset in offsets {
            bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        bytes.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        bytes
    }

    #[test]
    fn idle_eviction_releases_pdf_and_svg_caches_but_keeps_inflight_snapshot_valid() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("outline.pdf");
        std::fs::write(&path, pdf_with_nested_outline()).unwrap();
        let renderer = NativePdfRenderer::default();
        let revision = revision(&path).unwrap();
        let (snapshot, info) = renderer.snapshot(&path, &revision).unwrap();
        let svg = renderer.page_svg(&path, &revision, 1).unwrap();
        assert!(
            String::from_utf8_lossy(&svg).contains("background-color: rgba(255, 255, 255, 255);")
        );
        assert_eq!(info.pages.len(), 1);
        renderer.evict_idle(Duration::ZERO);
        assert_eq!(renderer.state.lock().unwrap().documents.len(), 1);
        assert_eq!(snapshot.pages().len(), 1);
        drop(snapshot);
        renderer.evict_idle(Duration::ZERO);
        let state = renderer.state.lock().unwrap();
        assert!(state.documents.is_empty());
        assert_eq!(state.svgs.usage(), (0, 0));
    }

    #[test]
    fn reads_nested_outline_titles_levels_and_destinations() {
        let pdf = Pdf::new(pdf_with_nested_outline()).expect("test PDF should parse");
        assert_eq!(
            outline(&pdf)
                .into_iter()
                .map(|item| (item.name, item.level, item.page))
                .collect::<Vec<_>>(),
            vec![
                ("Chapter".into(), 1, Some(1)),
                ("Section".into(), 2, Some(1))
            ]
        );
    }
}
