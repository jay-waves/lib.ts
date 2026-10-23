//! Bounded full-text search built on ripgrep's matcher and searcher crates.
//! Pagination retains a stable result snapshot; expired snapshots require a new search.
//! Never combine pages from different snapshots after eviction or query changes.

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

mod facets;
mod query;
mod scanner;
use facets::{facet_paths, facets};
use query::{SearchSpec, params_path_filter, parse_query};
#[cfg(test)]
use scanner::find_matches;
use scanner::scan;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SCAN_BYTES: u64 = 64 * 1024 * 1024;
const MAX_FILES: usize = 1000;
const MAX_PATH_FILES: usize = 20_000;
const MAX_RESULT_BYTES: usize = 2 * 1024 * 1024;
const PAGE_SIZE: usize = 20;
const MAX_SNIPPET_LINES: usize = 10;
const MAX_LINE_RANGES: usize = 24;
pub const SEARCH_EXPIRED: &str = "Search expired. Run the search again.";

const SNAPSHOT_TTL: Duration = Duration::from_secs(300);
const IGNORED_DIRS: &[&str] = &["node_modules", ".work", ".archive", ".git"];

static NEXT_SEARCH_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct SearchService {
    snapshots: Mutex<HashMap<String, Arc<Snapshot>>>,
}

struct Snapshot {
    identity: String,
    created: Instant,
    result: SearchResult,
    text_query: String,
    facets: SearchFacets,
    match_count: usize,
}

pub(super) struct SearchResult {
    pub(super) files: Vec<FileResult>,
    pub(super) engine: &'static str,
    pub(super) truncated: bool,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum SearchScope {
    Files,
    Paths,
    CurrentFile,
    Bookmarks,
}

impl SearchScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Files => "files",
            Self::Paths => "paths",
            Self::CurrentFile => "current-file",
            Self::Bookmarks => "bookmarks",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileResult {
    pub(super) path: String,
    pub(super) language: String,
    pub(super) match_count: usize,
    pub(super) snippets: Vec<Snippet>,
    pub(super) snippets_truncated: bool,
}

#[derive(Clone, Serialize)]
pub(super) struct Snippet {
    pub(super) lines: Vec<SnippetLine>,
}

#[derive(Clone, Serialize)]
pub(super) struct SnippetLine {
    pub(super) number: usize,
    pub(super) text: String,
    pub(super) clipped: bool,
    pub(super) ranges: Vec<(usize, usize)>,
}

#[derive(Clone, Serialize)]
pub(super) struct SearchFacet {
    pub(super) value: String,
    pub(super) count: usize,
}

#[derive(Clone, Serialize)]
pub(super) struct SearchFacets {
    pub(super) languages: Vec<SearchFacet>,
    pub(super) paths: Vec<SearchFacet>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SearchResponse {
    pub(super) query: String,
    pub(super) text_query: String,
    pub(super) scope: String,
    pub(super) search_id: String,
    pub(super) engine: &'static str,
    pub(super) truncated: bool,
    pub(super) total: usize,
    pub(super) match_count: usize,
    pub(super) files: Vec<FileResult>,
    pub(super) next_offset: Option<usize>,
    pub(super) facets: SearchFacets,
}

#[derive(Default, Deserialize)]
pub struct SearchParams {
    #[serde(default)]
    pub q: String,
    pub scope: Option<SearchScope>,
    #[serde(rename = "currentFile")]
    pub current_file: Option<String>,
    #[serde(rename = "searchId")]
    pub search_id: Option<String>,
    pub offset: Option<usize>,
    pub lang: Option<String>,
    pub language: Option<String>,
    pub path: Option<String>,
}

impl SearchService {
    pub fn search_with_private(
        &self,
        root: &Path,
        params: SearchParams,
        bookmarks: Option<&[String]>,
        private: Option<&Path>,
    ) -> Result<SearchResponse, String> {
        let scope = params.scope.unwrap_or(SearchScope::Files);
        let input = params.q.trim();
        if (input.is_empty() && scope != SearchScope::Paths)
            || input.len() > 256
            || input.contains(['\r', '\n', '\0'])
        {
            return Err("Enter a single-line search query of 1–256 characters.".into());
        }
        let current_file = params.current_file.as_deref().unwrap_or_default();
        let bookmark_paths = if scope == SearchScope::Bookmarks {
            Some(bookmarks.ok_or("Bookmark search is unavailable.")?)
        } else {
            None
        };
        let mut bookmark_identity = bookmark_paths.unwrap_or_default().to_vec();
        bookmark_identity.sort();
        let identity = serde_json::to_string(&(
            root,
            input,
            scope,
            current_file,
            &params.lang,
            &params.language,
            &params.path,
            bookmark_identity,
            private,
        ))
        .map_err(|error| error.to_string())?;
        self.expire_snapshots();

        let (search_id, snapshot) = if let Some(id) = params.search_id.as_ref() {
            let snapshots = self
                .snapshots
                .lock()
                .map_err(|_| "Search cache lock poisoned")?;
            let snapshot = snapshots.get(id).ok_or(SEARCH_EXPIRED)?;
            if snapshot.identity != identity {
                return Err(SEARCH_EXPIRED.into());
            }
            (id.clone(), Arc::clone(snapshot))
        } else {
            let mut spec = parse_query(input)?;
            if scope == SearchScope::CurrentFile
                && (current_file.is_empty()
                    || current_file.contains(['\\', '\0', ':'])
                    || current_file
                        .split('/')
                        .any(|part| part.is_empty() || part == "." || part == ".."))
            {
                return Err("Choose a repository-relative current file.".into());
            }
            if let Some(language) = params
                .lang
                .as_deref()
                .filter(|value| !value.is_empty())
                .or_else(|| params.language.as_deref().filter(|value| !value.is_empty()))
            {
                spec.languages.push(language.to_owned());
            }
            if let Some(filter) = params.path.as_deref().and_then(params_path_filter) {
                spec.paths.push(filter);
            }
            if spec.text.is_empty() && scope != SearchScope::Paths {
                return Err("Enter a non-empty search query.".into());
            }
            let mut result = scan(
                root,
                &spec,
                (scope == SearchScope::CurrentFile).then_some(current_file),
                private,
                scope == SearchScope::Paths,
                bookmark_paths,
            )?;
            result.files.sort_by(|a, b| {
                (b.path == current_file)
                    .cmp(&(a.path == current_file))
                    .then_with(|| a.path.cmp(&b.path))
            });
            // Facets describe this filtered snapshot, including any scan limits.
            let snapshot = Arc::new(Snapshot {
                identity,
                created: Instant::now(),
                text_query: spec.text,
                facets: SearchFacets {
                    languages: facets(result.files.iter().map(|file| file.language.as_str())),
                    paths: facet_paths(result.files.iter().map(|file| file.path.as_str())),
                },
                match_count: result.files.iter().map(|file| file.match_count).sum(),
                result,
            });
            let id = format!(
                "{}-{}",
                std::process::id(),
                NEXT_SEARCH_ID.fetch_add(1, Ordering::Relaxed)
            );
            let mut snapshots = self
                .snapshots
                .lock()
                .map_err(|_| "Search cache lock poisoned")?;
            if snapshots.len() >= 4
                && let Some(oldest) = snapshots
                    .iter()
                    .min_by_key(|(_, item)| item.created)
                    .map(|(key, _)| key.clone())
            {
                snapshots.remove(&oldest);
            }
            snapshots.insert(id.clone(), Arc::clone(&snapshot));
            (id, snapshot)
        };

        // The cache lock is released before cloning the page or serializing it.
        let result = &snapshot.result;
        let total = result.files.len();
        let offset = params.offset.unwrap_or(0).min(total);
        let page = result
            .files
            .iter()
            .skip(offset)
            .take(PAGE_SIZE)
            .cloned()
            .collect::<Vec<_>>();
        let next_offset = (offset + page.len() < total).then_some(offset + page.len());
        Ok(SearchResponse {
            query: input.to_owned(),
            text_query: snapshot.text_query.clone(),
            scope: scope.as_str().to_owned(),
            search_id,
            engine: result.engine,
            truncated: result.truncated,
            total,
            match_count: snapshot.match_count,
            files: page,
            next_offset,
            facets: snapshot.facets.clone(),
        })
    }

    fn expire_snapshots(&self) {
        if let Ok(mut snapshots) = self.snapshots.lock() {
            snapshots.retain(|_, snapshot| snapshot.created.elapsed() < SNAPSHOT_TTL);
        }
    }
}

#[cfg(test)]
mod tests;
