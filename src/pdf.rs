//! Native PDF metadata and per-page SVG rendering through Hayro.

use bytes::Bytes;
use hayro_svg::{
    RenderCache, SvgRenderSettings, convert,
    hayro_interpret::InterpreterSettings,
    hayro_syntax::{
        Pdf,
        object::{Array, Dict, ObjectIdentifier, String as PdfString},
    },
};
use lru::LruCache;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    num::NonZeroUsize,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const DOCUMENT_LIMIT: usize = 3;
const FILE_LIMIT: u64 = 64 * 1024 * 1024;
const DOCUMENT_BYTES_LIMIT: usize = 128 * 1024 * 1024;
const SVG_CACHE_LIMIT: usize = 8 * 1024 * 1024;
const SVG_CACHE_ENTRIES: usize = 256;

#[derive(Debug, Clone, Serialize)]
pub struct PageInfo {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutlineItem {
    pub name: String,
    pub level: usize,
    pub page: usize,
}

#[derive(Clone)]
pub struct DocumentInfo {
    pub pages: Vec<PageInfo>,
    pub outline: Vec<OutlineItem>,
}

struct PdfEntry {
    revision: String,
    pdf: Arc<Pdf>,
    info: DocumentInfo,
    last_used: Instant,
    input_bytes: usize,
}

struct CachedSvg {
    body: Bytes,
}

struct PdfState {
    documents: LruCache<PathBuf, PdfEntry>,
    svgs: LruCache<String, CachedSvg>,
    svg_bytes: usize,
}

impl PdfState {
    fn new() -> Self {
        Self {
            documents: LruCache::new(NonZeroUsize::new(DOCUMENT_LIMIT).unwrap()),
            svgs: LruCache::new(NonZeroUsize::new(SVG_CACHE_ENTRIES).unwrap()),
            svg_bytes: 0,
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
}

fn remove_svg_for_document(state: &mut PdfState, path: &Path) {
    let prefix = format!("{}:", path.to_string_lossy());
    let keys = state
        .svgs
        .iter()
        .filter_map(|(key, _)| key.starts_with(&prefix).then(|| key.clone()))
        .collect::<Vec<_>>();
    for key in keys {
        if let Some(svg) = state.svgs.pop(&key) {
            state.svg_bytes = state.svg_bytes.saturating_sub(svg.body.len());
        }
    }
}

fn decode_outline_title(value: &[u8]) -> String {
    if let Some(bytes) = value.strip_prefix(&[0xFE, 0xFF]) {
        let words = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&words)
    } else if let Some(bytes) = value.strip_prefix(&[0xFF, 0xFE]) {
        let words = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&words)
    } else {
        String::from_utf8_lossy(value).into_owned()
    }
}

fn outline(pdf: &Pdf) -> Vec<OutlineItem> {
    let xref = pdf.xref();
    let Some(catalog) = xref.get::<Dict<'_>>(xref.root_id()) else {
        return Vec::new();
    };
    let Some(outline_root) = catalog.get::<Dict<'_>>(b"Outlines") else {
        return Vec::new();
    };
    let Some(first) = outline_root.get::<Dict<'_>>(b"First") else {
        return Vec::new();
    };
    let page_numbers = pdf
        .pages()
        .iter()
        .enumerate()
        .filter_map(|(index, page)| page.raw().obj_id().map(|id| (id, index + 1)))
        .collect::<HashMap<_, _>>();
    let mut result = Vec::new();
    let mut visited = HashSet::new();
    collect_outline_items(first, 1, &page_numbers, &mut visited, &mut result, 0);
    result
}

fn collect_outline_items(
    first: Dict<'_>,
    level: usize,
    page_numbers: &HashMap<ObjectIdentifier, usize>,
    visited: &mut HashSet<ObjectIdentifier>,
    output: &mut Vec<OutlineItem>,
    depth: usize,
) {
    if depth >= 64 || output.len() >= 10_000 {
        return;
    }
    let mut current = Some(first);
    while let Some(item) = current {
        if output.len() >= 10_000 {
            return;
        }
        if item.obj_id().is_some_and(|id| !visited.insert(id)) {
            return;
        }

        let title: Option<PdfString<'_>> = item.get(b"Title");
        let destination: Option<Array<'_>> = item.get(b"Dest");
        let action: Option<Dict<'_>> = item.get(b"A");
        let destination = destination.or_else(|| action.and_then(|action| action.get(b"D")));
        let page = destination
            .and_then(|array| array.raw_iter().next())
            .and_then(|reference| reference.as_obj_ref().map(ObjectIdentifier::from))
            .and_then(|reference| page_numbers.get(&reference).copied());

        if let (Some(title), Some(page)) = (title, page) {
            output.push(OutlineItem {
                name: decode_outline_title(title.as_bytes()),
                level,
                page,
            });
        }

        if let Some(child) = item.get::<Dict<'_>>(b"First") {
            collect_outline_items(child, level + 1, page_numbers, visited, output, depth + 1);
        }
        current = item.get::<Dict<'_>>(b"Next");
    }
}

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
    pub fn evict_idle(&self, idle_for: Duration) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let expired = state
            .documents
            .iter()
            .filter(|(_, entry)| entry.last_used.elapsed() >= idle_for)
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();
        for path in expired {
            state.documents.pop(&path);
            remove_svg_for_document(&mut state, &path);
        }
    }

    pub fn document(&self, path: &Path, revision: &str) -> Result<DocumentInfo, PdfError> {
        self.snapshot(path, revision).map(|(_, info)| info)
    }

    fn snapshot(&self, path: &Path, revision: &str) -> Result<(Arc<Pdf>, DocumentInfo), PdfError> {
        {
            let mut state = self.state.lock().map_err(|_| PdfError::CachePoisoned)?;
            if let Some(entry) = state.documents.get_mut(path)
                && entry.revision == revision
            {
                entry.last_used = Instant::now();
                return Ok((entry.pdf.clone(), entry.info.clone()));
            }
        }

        // Recheck after taking the load gate so duplicate requests share a parse.
        let _load = self.load_gate.lock().map_err(|_| PdfError::CachePoisoned)?;
        {
            let mut state = self.state.lock().map_err(|_| PdfError::CachePoisoned)?;
            if let Some(entry) = state.documents.get_mut(path)
                && entry.revision == revision
            {
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
        let info = DocumentInfo { pages, outline };

        let mut state = self.state.lock().map_err(|_| PdfError::CachePoisoned)?;
        if state.documents.pop(path).is_some() {
            remove_svg_for_document(&mut state, path);
        }
        while state.documents.len() >= DOCUMENT_LIMIT
            || state
                .documents
                .iter()
                .map(|(_, entry)| entry.input_bytes)
                .sum::<usize>()
                + input_bytes
                > DOCUMENT_BYTES_LIMIT
        {
            let Some((expired, _)) = state.documents.pop_lru() else {
                break;
            };
            remove_svg_for_document(&mut state, &expired);
        }
        let evicted = state.documents.push(
            path.to_owned(),
            PdfEntry {
                revision: revision.to_owned(),
                pdf: pdf.clone(),
                info: info.clone(),
                last_used: Instant::now(),
                input_bytes,
            },
        );
        if let Some((evicted_path, _)) = evicted {
            remove_svg_for_document(&mut state, &evicted_path);
        }
        Ok((pdf, info))
    }

    pub fn page_svg(
        &self,
        path: &Path,
        revision: &str,
        page_number: usize,
    ) -> Result<Bytes, PdfError> {
        if page_number == 0 {
            return Err(PdfError::InvalidPage);
        }
        let (pdf, info) = self.snapshot(path, revision)?;
        let page_index = page_number - 1;
        if page_index >= info.pages.len() {
            return Err(PdfError::PageNotFound);
        }
        let key = format!("{}:{revision}:{page_number}", path.to_string_lossy());
        {
            let mut state = self.state.lock().map_err(|_| PdfError::CachePoisoned)?;
            if let Some(svg) = state.svgs.get(&key) {
                return Ok(svg.body.clone());
            }
        }

        let page = &pdf.pages()[page_index];
        let cache = RenderCache::new();
        let render_settings = SvgRenderSettings {
            // A PDF page is paper, so keep its canvas white in both UI themes.
            // The PDF's own drawing colors remain unchanged.
            bg_color: [255, 255, 255, 255],
        };
        let svg = Bytes::from(convert(
            page,
            &cache,
            &InterpreterSettings::default(),
            &render_settings,
        ));
        if svg.len() <= SVG_CACHE_LIMIT {
            let mut state = self.state.lock().map_err(|_| PdfError::CachePoisoned)?;
            // An in-flight render can finish after eviction or replacement.
            if !state
                .documents
                .peek(path)
                .is_some_and(|entry| entry.revision == revision)
            {
                return Ok(svg);
            }
            if let Some(previous) = state.svgs.pop(&key) {
                state.svg_bytes = state.svg_bytes.saturating_sub(previous.body.len());
            }
            while state.svgs.len() >= SVG_CACHE_ENTRIES
                || state.svg_bytes.saturating_add(svg.len()) > SVG_CACHE_LIMIT
            {
                let Some((_, expired)) = state.svgs.pop_lru() else {
                    break;
                };
                state.svg_bytes = state.svg_bytes.saturating_sub(expired.body.len());
            }
            state.svg_bytes += svg.len();
            state.svgs.put(key, CachedSvg { body: svg.clone() });
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
        let state = renderer.state.lock().unwrap();
        assert!(state.documents.is_empty());
        assert!(state.svgs.is_empty());
        assert_eq!(state.svg_bytes, 0);
        assert_eq!(snapshot.pages().len(), 1);
    }

    #[test]
    fn reads_nested_outline_titles_levels_and_destinations() {
        let pdf = Pdf::new(pdf_with_nested_outline()).expect("test PDF should parse");
        assert_eq!(
            outline(&pdf)
                .into_iter()
                .map(|item| (item.name, item.level, item.page))
                .collect::<Vec<_>>(),
            vec![("Chapter".into(), 1, 1), ("Section".into(), 2, 1)]
        );
    }
}
