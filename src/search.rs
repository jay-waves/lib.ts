//! Bounded full-text search built on ripgrep's matcher and searcher crates.
//! Pagination retains a stable result snapshot; expired snapshots require a new search.
//! Never combine pages from different snapshots after eviction or query changes.

use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{Searcher, sinks::UTF8};
use ignore::{
    WalkBuilder,
    overrides::{Override, OverrideBuilder},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs, io,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

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

struct SearchResult {
    files: Vec<FileResult>,
    engine: &'static str,
    truncated: bool,
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

#[derive(Default)]
struct MatchDetails {
    match_count: usize,
    snippets: Vec<SnippetLine>,
    snippets_truncated: bool,
}

struct SearchSpec {
    text: String,
    regex: bool,
    case_sensitive: bool,
    respect_gitignore: bool,
    languages: Vec<String>,
    paths: Vec<PathFilter>,
}

struct PathFilter {
    value: String,
    quoted: bool,
}

#[derive(Deserialize)]
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
            if snapshots.len() >= 4 {
                if let Some(oldest) = snapshots
                    .iter()
                    .min_by_key(|(_, item)| item.created)
                    .map(|(key, _)| key.clone())
                {
                    snapshots.remove(&oldest);
                }
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

fn scan(
    root: &Path,
    spec: &SearchSpec,
    only_path: Option<&str>,
    private: Option<&Path>,
    paths_only: bool,
    bookmarks: Option<&[String]>,
) -> Result<SearchResult, String> {
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!spec.case_sensitive)
        .fixed_strings(!spec.regex)
        .build(&spec.text)
        .map_err(|error| format!("Invalid regular expression: {error}"))?;
    let path_filters = spec
        .paths
        .iter()
        .map(CompiledPathFilter::new)
        .collect::<Result<Vec<_>, _>>()?;
    let languages = spec
        .languages
        .iter()
        .map(|value| normalize_language(value))
        .collect::<Vec<_>>();
    let bookmarks = bookmarks.map(|paths| {
        paths
            .iter()
            .map(String::as_str)
            .collect::<std::collections::HashSet<_>>()
    });
    let mut searcher = Searcher::new();
    let mut files = Vec::new();
    let mut scanned_bytes = 0_u64;
    let mut result_bytes = 0_usize;
    let mut truncated = false;
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let mut walker = WalkBuilder::new(&root);
    walker
        .hidden(true)
        .follow_links(false)
        .git_ignore(spec.respect_gitignore)
        .git_global(spec.respect_gitignore)
        .git_exclude(spec.respect_gitignore)
        .require_git(false)
        .parents(true)
        .max_filesize((!paths_only).then_some(MAX_FILE_BYTES))
        .add_custom_ignore_filename(".rgignore");
    if let Some(relative) = only_path {
        let candidate = root.join(relative);
        let canonical = candidate
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !canonical.starts_with(&root) || !canonical.is_file() {
            return Err("Current file is outside the repository or is not a file.".into());
        }
    }
    let only_path = only_path.map(|relative| root.join(relative));
    let private = private.map(Path::to_path_buf);
    let walk_root = root.clone();
    walker.filter_entry(move |entry| {
        if entry.depth() > 0
            && entry.path().strip_prefix(&walk_root).is_ok_and(|relative| {
                ignored_relative_path(&relative.to_string_lossy().replace('\\', "/"))
            })
        {
            return false;
        }
        !private
            .as_ref()
            .is_some_and(|private| entry.path().starts_with(private))
            && only_path.as_ref().is_none_or(|candidate| {
                entry.path() == candidate || candidate.starts_with(entry.path())
            })
    });
    for result in walker.build() {
        let entry = match result {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let path = entry.path();
        let relative = path
            .strip_prefix(&root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        if relative.starts_with("../")
            || relative == ".."
            || (!paths_only && crate::file_kind::has_binary_extension(path))
        {
            continue;
        }
        let language = search_language(path);
        let normalized_language = normalize_language(&language);
        if !languages.iter().all(|value| *value == normalized_language)
            || !path_filters.iter().all(|filter| filter.matches(&relative))
            || bookmarks
                .as_ref()
                .is_some_and(|paths| !paths.contains(relative.as_str()))
        {
            continue;
        }
        let details = if paths_only {
            if !spec.text.is_empty()
                && !matcher
                    .is_match(relative.as_bytes())
                    .map_err(|error| error.to_string())?
            {
                continue;
            }
            MatchDetails {
                match_count: 1,
                ..MatchDetails::default()
            }
        } else {
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.len() > MAX_FILE_BYTES {
                continue;
            }
            if scanned_bytes.saturating_add(metadata.len()) > MAX_SCAN_BYTES {
                truncated = true;
                break;
            }
            scanned_bytes += metadata.len();
            let bytes = match fs::read(path) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            if bytes.len() as u64 > MAX_FILE_BYTES || !valid_text(&bytes) {
                continue;
            }
            let text = match std::str::from_utf8(&bytes) {
                Ok(text) => text,
                Err(_) => continue,
            };
            find_matches(&mut searcher, &matcher, text).map_err(|error| error.to_string())?
        };
        if details.match_count == 0 {
            continue;
        }
        let file = FileResult {
            path: relative,
            language,
            match_count: details.match_count,
            snippets: group_snippets(details.snippets),
            snippets_truncated: details.snippets_truncated,
        };
        result_bytes = result_bytes.saturating_add(estimate_file_bytes(&file));
        let max_files = if paths_only {
            MAX_PATH_FILES
        } else {
            MAX_FILES
        };
        if result_bytes > MAX_RESULT_BYTES || files.len() >= max_files {
            truncated = true;
            break;
        }
        files.push(file);
    }
    Ok(SearchResult {
        files,
        engine: if paths_only { "paths" } else { "ripgrep" },
        truncated,
    })
}

fn find_matches(
    searcher: &mut Searcher,
    matcher: &impl Matcher,
    text: &str,
) -> io::Result<MatchDetails> {
    let mut details = MatchDetails::default();
    searcher.search_slice(
        matcher,
        text.as_bytes(),
        UTF8(|line_num, line: &str| {
            let line = line.trim_end_matches(['\r', '\n']);
            let mut snippet: Option<SnippetLine> = None;
            let mut window = 0..0;
            matcher
                .find_iter(line.as_bytes(), |matched| {
                    details.match_count += 1;
                    if details.snippets.len() >= MAX_SNIPPET_LINES {
                        details.snippets_truncated = true;
                        return true;
                    }
                    let snippet = snippet.get_or_insert_with(|| {
                        // Work in byte offsets until rendering the bounded snippet. This
                        // avoids rescanning a long line's prefix for every match.
                        let start = line[..matched.start()]
                            .char_indices()
                            .rev()
                            .nth(199)
                            .map_or(0, |(offset, _)| offset);
                        let end = line[start..]
                            .char_indices()
                            .nth(1200)
                            .map_or(line.len(), |(offset, _)| start + offset);
                        window = start..end;
                        SnippetLine {
                            number: line_num as usize,
                            text: line[window.clone()].to_owned(),
                            clipped: start > 0 || end < line.len(),
                            ranges: Vec::new(),
                        }
                    });
                    if matched.start() > window.end
                        || (matched.start() == window.end && !matched.is_empty())
                        || snippet.ranges.len() >= MAX_LINE_RANGES
                    {
                        details.snippets_truncated = true;
                        return true;
                    }
                    if matched.end() > window.end {
                        details.snippets_truncated = true;
                    }
                    let start = byte_to_utf16(&snippet.text, matched.start() - window.start);
                    let end =
                        byte_to_utf16(&snippet.text, matched.end().min(window.end) - window.start);
                    if let Some(last) = snippet.ranges.last_mut() {
                        if last.1 == start && last.0 != last.1 && end > start {
                            last.1 = end;
                            return true;
                        }
                    }
                    snippet.ranges.push((start, end));
                    true
                })
                .map_err(|error| io::Error::other(error.to_string()))?;
            if let Some(snippet) = snippet {
                details.snippets.push(snippet);
            }
            Ok(true)
        }),
    )?;
    Ok(details)
}

fn parse_query(input: &str) -> Result<SearchSpec, String> {
    let mut tokens = Vec::<(String, String, bool)>::new();
    let mut index = 0;
    let chars = input.char_indices().collect::<Vec<_>>();
    while index < chars.len() {
        while index < chars.len() && chars[index].1.is_whitespace() {
            index += 1;
        }
        if index == chars.len() {
            break;
        }
        let mut start = chars[index].0;
        if chars[index].1 == '/' {
            let mut end = None;
            let mut in_class = false;
            let mut escaped = false;
            for (char_index, (_, ch)) in chars.iter().enumerate().skip(index + 1) {
                if escaped {
                    escaped = false;
                    continue;
                }
                if *ch == '\\' {
                    escaped = true;
                    continue;
                }
                if *ch == '[' {
                    in_class = true;
                }
                if *ch == ']' {
                    in_class = false;
                }
                if *ch == '/' && !in_class {
                    end = Some(char_index);
                    break;
                }
            }
            let end = end.ok_or("Close the regular expression with /.")?;
            let pattern_start = chars[index].0 + 1;
            let pattern_end = chars[end].0;
            let pattern = input[pattern_start..pattern_end].replace("\\/", "/");
            let mut after = end + 1;
            let flags_start = chars.get(after).map(|item| item.0).unwrap_or(input.len());
            while after < chars.len() && !chars[after].1.is_whitespace() {
                after += 1;
            }
            let flags_end = chars.get(after).map(|item| item.0).unwrap_or(input.len());
            let flags = &input[flags_start..flags_end];
            if flags != "" && flags != "i" {
                return Err("Only the i flag is supported: /pattern/ or /pattern/i.".into());
            }
            if pattern.is_empty() {
                return Err("Enter a non-empty regular expression between the slashes.".into());
            }
            tokens.push(("regex".into(), format!("{flags}:{pattern}"), false));
            index = after;
            continue;
        }
        let qualifier = ["lang:", "language:", "path:", "case:", "gitignore:"]
            .into_iter()
            .find(|prefix| {
                input[start..]
                    .get(..prefix.len())
                    .is_some_and(|value| value.eq_ignore_ascii_case(prefix))
            });
        let kind = qualifier.map_or("text", |prefix| prefix.trim_end_matches(':'));
        if let Some(prefix) = qualifier {
            index += prefix.len();
            start += prefix.len();
        }
        let quoted = chars.get(index).is_some_and(|(_, ch)| *ch == '"');
        if quoted {
            index += 1;
            let mut value = String::new();
            let mut closed = false;
            while index < chars.len() {
                let ch = chars[index].1;
                if ch == '"' {
                    index += 1;
                    closed = true;
                    break;
                }
                if ch == '\\' && index + 1 < chars.len() && matches!(chars[index + 1].1, '"' | '\\')
                {
                    index += 1;
                }
                value.push(chars[index].1);
                index += 1;
            }
            if !closed {
                return Err("Close the quotation mark in your search query.".into());
            }
            if chars.get(index).is_some_and(|(_, ch)| !ch.is_whitespace()) {
                return Err("Separate search terms and filters with a space.".into());
            }
            tokens.push((kind.into(), value, true));
        } else {
            let mut end = index;
            while end < chars.len() && !chars[end].1.is_whitespace() {
                end += 1;
            }
            let byte_end = chars.get(end).map(|item| item.0).unwrap_or(input.len());
            tokens.push((kind.into(), input[start..byte_end].to_owned(), false));
            index = end;
        }
    }
    let mut text_terms = Vec::new();
    let mut languages = Vec::new();
    let mut paths = Vec::new();
    let mut regex = false;
    let mut case_sensitive = false;
    let mut regex_case_sensitive = None;
    let mut respect_gitignore = true;
    for (kind, value, quoted) in tokens {
        if kind != "text" && value.is_empty() {
            return Err(format!("Enter a value after {kind}:"));
        }
        match kind.as_str() {
            "regex" => {
                let (flags, pattern) = value.split_once(':').unwrap();
                text_terms.push(pattern.to_owned());
                regex = true;
                regex_case_sensitive = Some(flags != "i");
            }
            "lang" | "language" => languages.push(value),
            "path" => paths.push(PathFilter { value, quoted }),
            "case" => {
                case_sensitive = match value.as_str() {
                    "yes" => true,
                    "no" => false,
                    _ => return Err("Use case:yes or case:no.".into()),
                }
            }
            "gitignore" => {
                respect_gitignore = match value.as_str() {
                    "yes" => true,
                    "no" => false,
                    _ => return Err("Use gitignore:yes or gitignore:no.".into()),
                }
            }
            _ if !quoted && value == "--no-gitignore" => respect_gitignore = false,
            _ => text_terms.push(value),
        }
    }
    if regex && text_terms.len() != 1 {
        return Err("Use one regular expression with optional lang/path filters; quote text for a literal search.".into());
    }
    if let Some(regex_case_sensitive) = regex_case_sensitive {
        case_sensitive = regex_case_sensitive;
    }
    Ok(SearchSpec {
        text: text_terms.join(" "),
        regex,
        case_sensitive,
        respect_gitignore,
        languages,
        paths,
    })
}

enum CompiledPathFilter {
    Literal(String),
    Glob(Override),
}

impl CompiledPathFilter {
    fn new(filter: &PathFilter) -> Result<Self, String> {
        if filter.quoted || !filter.value.contains(['*', '?']) {
            return Ok(Self::Literal(filter.value.to_lowercase()));
        }
        // Preserve substring filters and AND between qualifiers. Only glob
        // matching is delegated to ripgrep's matcher; it must not override gitignore.
        let mut builder = OverrideBuilder::new("");
        builder
            .case_insensitive(true)
            .map_err(|error| error.to_string())?;
        // The query language exposes *, ** and ?. Other glob metacharacters
        // remain literal, matching the browser's bookmark filters.
        let escaped = filter.value.chars().fold(String::new(), |mut pattern, ch| {
            if matches!(ch, '[' | ']' | '{' | '}' | '\\') {
                pattern.push('\\');
            }
            pattern.push(ch);
            pattern
        });
        let pattern = if escaped.starts_with('/') {
            escaped
        } else {
            format!("**/{escaped}")
        };
        builder
            .add(&pattern)
            .map_err(|error| format!("Invalid path glob: {error}"))?;
        Ok(Self::Glob(
            builder.build().map_err(|error| error.to_string())?,
        ))
    }

    fn matches(&self, path: &str) -> bool {
        match self {
            Self::Literal(needle) => path.to_lowercase().contains(needle),
            Self::Glob(glob) => glob.matched(path, false).is_whitelist(),
        }
    }
}

fn params_path_filter(value: &str) -> Option<PathFilter> {
    (!value.is_empty()).then(|| PathFilter {
        value: value.to_owned(),
        quoted: true,
    })
}

fn valid_text(bytes: &[u8]) -> bool {
    crate::file_kind::is_text(bytes)
}

fn ignored_relative_path(path: &str) -> bool {
    path.split('/')
        .any(|name| name.starts_with('.') || IGNORED_DIRS.contains(&name))
}

fn search_language(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let name = match ext.as_str() {
        "js" | "mjs" | "cjs" | "jsx" => "JavaScript",
        "ts" | "tsx" => "TypeScript",
        "py" => "Python",
        "rs" => "Rust",
        "go" => "Go",
        "c" | "h" => "C",
        "cpp" | "hpp" => "C++",
        "java" => "Java",
        "lua" => "Lua",
        "sh" | "bash" => "Shell",
        "ps1" | "pwsh" => "PowerShell",
        "md" | "markdown" => "Markdown",
        "typ" => "Typst",
        "json" => "JSON",
        "css" => "CSS",
        "html" | "htm" => "HTML",
        "yaml" | "yml" => "YAML",
        "toml" => "TOML",
        "xml" => "XML",
        "svg" => "SVG",
        "rb" => "Ruby",
        "php" => "PHP",
        "sql" => "SQL",
        _ => "Text",
    };
    name.into()
}

fn normalize_language(language: &str) -> String {
    let lower = language.to_lowercase().replace([' ', '-'], "");
    match lower.as_str() {
        "js" | "jsx" | "mjs" | "cjs" => "javascript".into(),
        "ts" | "tsx" => "typescript".into(),
        "py" => "python".into(),
        "rs" => "rust".into(),
        "cpp" | "cplusplus" => "c++".into(),
        "sh" | "bash" => "shell".into(),
        "md" => "markdown".into(),
        "yml" => "yaml".into(),
        "plain" | "plaintext" => "text".into(),
        _ => lower,
    }
}

pub(super) fn sort_facets(facets: &mut [SearchFacet]) {
    facets.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.value.cmp(&right.value))
    });
}

fn facets<'a>(values: impl Iterator<Item = &'a str>) -> Vec<SearchFacet> {
    let mut counts = HashMap::<&str, usize>::new();
    for value in values {
        *counts.entry(value).or_default() += 1;
    }
    let mut items = counts
        .into_iter()
        .map(|(value, count)| SearchFacet {
            value: value.to_owned(),
            count,
        })
        .collect::<Vec<_>>();
    sort_facets(&mut items);
    items
}

fn facet_paths<'a>(values: impl Iterator<Item = &'a str>) -> Vec<SearchFacet> {
    let mut counts = HashMap::<String, usize>::new();
    for path in values {
        let facet = path
            .split_once('/')
            .map(|(directory, _)| format!("{directory}/"))
            .unwrap_or_else(|| path.to_owned());
        *counts.entry(facet).or_default() += 1;
    }
    let mut items = counts
        .into_iter()
        .map(|(value, count)| SearchFacet { value, count })
        .collect::<Vec<_>>();
    sort_facets(&mut items);
    items
}

fn group_snippets(lines: Vec<SnippetLine>) -> Vec<Snippet> {
    let mut snippets = Vec::<Snippet>::new();
    for line in lines {
        if let Some(last) = snippets.last_mut() {
            if line
                .number
                .saturating_sub(last.lines.last().map(|item| item.number).unwrap_or(0))
                <= 5
            {
                last.lines.push(line);
                continue;
            }
        }
        snippets.push(Snippet { lines: vec![line] });
    }
    snippets
}

fn estimate_file_bytes(file: &FileResult) -> usize {
    512 + file.path.len() * 2
        + file
            .snippets
            .iter()
            .map(|snippet| {
                128 + snippet
                    .lines
                    .iter()
                    .map(|line| 512 + line.text.len() * 2 + line.ranges.len() * 80)
                    .sum::<usize>()
            })
            .sum::<usize>()
}

fn byte_to_utf16(text: &str, byte: usize) -> usize {
    text[..byte].encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(query: &str) -> SearchParams {
        SearchParams {
            q: query.into(),
            scope: None,
            current_file: None,
            search_id: None,
            offset: None,
            lang: None,
            language: None,
            path: None,
        }
    }

    #[test]
    fn filters_before_spending_the_result_budget() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir(root.join("target")).unwrap();
        fs::write(root.join("target/keep.rs"), "needle").unwrap();
        for index in 0..=MAX_FILES {
            fs::write(root.join(format!("other-{index}.txt")), "needle").unwrap();
        }
        let service = SearchService::default();
        for query in [
            "needle lang:rs",
            "needle path:target/",
            "needle path:**/*.rs",
        ] {
            let result = service
                .search_with_private(root, params(query), None, None)
                .unwrap();
            assert_eq!(result.total, 1, "{query}");
            assert_eq!(result.files[0].path, "target/keep.rs");
            assert!(
                !result.truncated,
                "unrelated matches must not consume the budget"
            );
            assert_eq!(result.facets.languages.len(), 1);
            assert_eq!(result.facets.languages[0].count, 1);
        }
        let mut request = params("needle");
        request.scope = Some(SearchScope::Bookmarks);
        let result = service
            .search_with_private(root, request, Some(&["target/keep.rs".into()]), None)
            .unwrap();
        assert_eq!(result.total, 1);
        assert!(!result.truncated);
    }

    #[test]
    fn text_pages_keep_order_counts_and_contents_from_the_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        for index in 0..25 {
            fs::write(
                directory.path().join(format!("file{index:02}.rs")),
                "needle needle",
            )
            .unwrap();
        }
        let service = SearchService::default();
        let mut request = params("needle");
        request.current_file = Some("file24.rs".into());
        let first = service
            .search_with_private(directory.path(), request, None, None)
            .unwrap();
        assert_eq!(first.files[0].path, "file24.rs");
        assert_eq!(first.match_count, 50);
        fs::write(directory.path().join("file23.rs"), "changed").unwrap();
        let mut request = params("needle");
        request.current_file = Some("file24.rs".into());
        request.search_id = Some(first.search_id);
        request.offset = first.next_offset;
        let second = service
            .search_with_private(directory.path(), request, None, None)
            .unwrap();
        assert_eq!(second.files.len(), 5);
        assert_eq!(second.total, 25);
        assert_eq!(second.match_count, 50);
        assert_eq!(second.facets.languages[0].count, 25);
        assert!(second.next_offset.is_none());
        assert!(
            second
                .files
                .iter()
                .all(|file| file.snippets[0].lines[0].text == "needle needle")
        );
        let paths = first
            .files
            .iter()
            .chain(&second.files)
            .map(|file| &file.path)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(paths.len(), 25);
    }

    #[test]
    fn snapshot_identity_includes_filters_but_not_unrelated_bookmarks() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("keep.rs"), "needle").unwrap();
        let service = SearchService::default();
        let first = service
            .search_with_private(directory.path(), params("needle"), None, None)
            .unwrap();
        let mut page = params("needle");
        page.search_id = Some(first.search_id.clone());
        let result = service
            .search_with_private(directory.path(), page, Some(&["changed.md".into()]), None)
            .unwrap();
        assert_eq!(result.total, 1);
        for (language, path) in [(Some("js"), None), (None, Some("other/"))] {
            let mut page = params("needle");
            page.search_id = Some(first.search_id.clone());
            page.lang = language.map(str::to_owned);
            page.path = path.map(str::to_owned);
            assert!(
                matches!(service.search_with_private(directory.path(), page, None, None), Err(error) if error == SEARCH_EXPIRED)
            );
        }
        service.snapshots.lock().unwrap().clear();
        let mut page = params("needle");
        page.search_id = Some(first.search_id);
        assert!(
            matches!(service.search_with_private(directory.path(), page, None, None), Err(error) if error == SEARCH_EXPIRED)
        );
    }

    #[test]
    fn parses_quoted_qualifiers_and_rejects_missing_values() {
        let query = parse_query(r#"needle PATH:"My Docs/" lang:"Rust" path:"literal*""#).unwrap();
        assert_eq!(query.text, "needle");
        assert_eq!(query.paths[0].value, "My Docs/");
        assert!(query.paths[0].quoted);
        assert!(
            CompiledPathFilter::new(&query.paths[1])
                .unwrap()
                .matches("literal*/a.rs")
        );
        assert!(
            !CompiledPathFilter::new(&query.paths[1])
                .unwrap()
                .matches("literal-other/a.rs")
        );
        for query in [
            "needle lang:",
            "needle path:",
            "needle case:maybe",
            r#"needle path:"unterminated"#,
            r#""word"suffix"#,
        ] {
            assert!(parse_query(query).is_err(), "{query}");
        }
    }

    #[test]
    fn native_path_globs_preserve_root_and_recursive_matching() {
        for (pattern, path, expected) in [
            ("src/**/*.rs", "src/main.rs", true),
            ("src/**/*.rs", "nested/src/deep/main.rs", true),
            ("/src/*.rs", "nested/src/main.rs", false),
            ("/src/*.rs", "src/deep/main.rs", false),
            ("/src/*.rs", "src/MAIN.RS", true),
            ("*.rs", "nested/main.rs", true),
            ("file?.rs", "file12.rs", false),
            ("src/[id]/*.rs", "src/[id]/main.rs", true),
            ("src/{a,b}/*.rs", "src/a/main.rs", false),
        ] {
            let filter = CompiledPathFilter::new(&PathFilter {
                value: pattern.into(),
                quoted: false,
            })
            .unwrap();
            assert_eq!(filter.matches(path), expected, "{pattern}: {path}");
        }
    }

    #[test]
    fn long_line_snippets_keep_distant_unicode_matches_and_bound_ranges() {
        let matcher = RegexMatcherBuilder::new()
            .fixed_strings(true)
            .build("hit")
            .unwrap();
        let line = format!("{}hit", "😀".repeat(2000));
        let result = find_matches(&mut Searcher::new(), &matcher, &line).unwrap();
        assert_eq!(result.match_count, 1);
        assert_eq!(result.snippets[0].ranges, [(400, 403)]);
        assert!(result.snippets[0].clipped);
        assert!(result.snippets[0].text.ends_with("hit"));
        let dense = "hit ".repeat(20_000);
        let result = find_matches(&mut Searcher::new(), &matcher, &dense).unwrap();
        assert_eq!(result.match_count, 20_000);
        assert_eq!(result.snippets[0].ranges.len(), MAX_LINE_RANGES);
        assert!(result.snippets_truncated);
    }

    #[test]
    fn gitignore_and_fixed_exclusions_apply_to_both_search_modes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::write(root.join(".gitignore"), "ignored.rs\n").unwrap();
        fs::write(root.join(".rgignore"), "rgignored.rs\n").unwrap();
        for name in ["keep.rs", "ignored.rs", "rgignored.rs"] {
            fs::write(root.join(name), "needle").unwrap();
        }
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/dependency.rs"), "needle").unwrap();
        let service = SearchService::default();
        for scope in [SearchScope::Files, SearchScope::Paths] {
            for (query, total) in [("", 1), (" gitignore:no", 2)] {
                let mut request = params(&format!(
                    "{}{}",
                    if scope == SearchScope::Paths {
                        ".rs"
                    } else {
                        "needle"
                    },
                    query
                ));
                request.scope = Some(scope);
                let result = service
                    .search_with_private(root, request, None, None)
                    .unwrap();
                assert_eq!(result.total, total);
                assert!(
                    !result
                        .files
                        .iter()
                        .any(|file| file.path.starts_with("node_modules/"))
                );
            }
        }
    }

    #[test]
    fn parses_ripgrep_query_forms() {
        let query = parse_query("/TODO|FIXME/i lang:rs path:src/**").unwrap();
        assert_eq!(query.text, "TODO|FIXME");
        assert!(query.regex);
        assert!(!query.case_sensitive);
        assert_eq!(query.languages, ["rs"]);
        assert_eq!(query.paths[0].value, "src/**");
    }

    #[test]
    fn path_search_pages_names_without_reading_contents_and_keeps_a_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir(root.join("src")).unwrap();
        fs::create_dir(root.join("private")).unwrap();
        fs::write(root.join("private/secret.rs"), "").unwrap();
        fs::write(root.join(".hidden.rs"), "").unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/dependency.rs"), "").unwrap();
        for index in 0..25 {
            fs::write(root.join(format!("src/file{index:02}.rs")), [0, 255]).unwrap();
        }
        fs::write(root.join("src/document.pdf"), [0, 255]).unwrap();
        let service = SearchService::default();
        let params = |q: &str, search_id, offset| SearchParams {
            q: q.into(),
            scope: Some(SearchScope::Paths),
            current_file: None,
            search_id,
            offset,
            lang: None,
            language: None,
            path: None,
        };
        let first = service
            .search_with_private(
                root,
                params("", None, None),
                None,
                Some(&root.join("private")),
            )
            .unwrap();
        assert_eq!(first.total, 26);
        assert_eq!(first.files.len(), PAGE_SIZE);
        assert_eq!(first.next_offset, Some(PAGE_SIZE));
        assert!(first.files.iter().all(|file| file.snippets.is_empty()));
        fs::write(root.join("src/new.rs"), "").unwrap();
        let second = service
            .search_with_private(
                root,
                params("", Some(first.search_id), first.next_offset),
                None,
                Some(&root.join("private")),
            )
            .unwrap();
        assert_eq!(second.total, 26);
        assert_eq!(second.files.len(), 6);
        assert_eq!(second.next_offset, None);
        let filtered = service
            .search_with_private(
                root,
                params("/FILE0/i lang:rs path:src/**", None, None),
                None,
                None,
            )
            .unwrap();
        assert_eq!(filtered.total, 10);
        assert!(
            filtered
                .files
                .iter()
                .all(|file| file.path.starts_with("src/file0"))
        );
        assert!(
            service
                .search_with_private(
                    root,
                    params("different", Some(filtered.search_id), Some(20)),
                    None,
                    None
                )
                .is_err()
        );
    }

    #[test]
    fn snippets_use_utf16_offsets_for_browser_highlighting() {
        let matcher = RegexMatcherBuilder::new()
            .fixed_strings(true)
            .build("hit")
            .unwrap();
        let text = "😀 hit";
        let details = find_matches(&mut Searcher::new(), &matcher, text).unwrap();
        assert_eq!(details.snippets[0].ranges, [(3, 6)]);
    }
}
