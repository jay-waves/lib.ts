//! Bounded full-text search built on ripgrep's matcher and searcher crates.

use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{Searcher, sinks::UTF8};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs, io,
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SCAN_BYTES: u64 = 64 * 1024 * 1024;
const MAX_FILES: usize = 1000;
const MAX_RESULT_BYTES: usize = 2 * 1024 * 1024;
const PAGE_SIZE: usize = 20;
const MAX_SNIPPET_LINES: usize = 10;
const MAX_LINE_RANGES: usize = 24;
const SNAPSHOT_TTL: Duration = Duration::from_secs(300);
const IGNORED_DIRS: &[&str] = &["node_modules", ".work", ".archive", ".git"];

static NEXT_SEARCH_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct SearchService {
    snapshots: Mutex<HashMap<String, Snapshot>>,
}

struct Snapshot {
    identity: String,
    created: Instant,
    result: SearchResult,
}

#[derive(Clone)]
struct SearchResult {
    files: Vec<FileResult>,
    engine: &'static str,
    truncated: bool,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum SearchScope {
    Files,
    CurrentFile,
    Bookmarks,
}

impl SearchScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Files => "files",
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

#[derive(Serialize)]
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
        let input = params.q.trim();
        if input.is_empty() || input.len() > 256 || input.contains(['\r', '\n', '\0']) {
            return Err("Enter a single-line search query of 1–256 characters.".into());
        }
        let scope = params.scope.unwrap_or(SearchScope::Files);
        let mut spec = parse_query(input)?;
        let current_file = params.current_file.as_deref().unwrap_or_default();
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
        if spec.text.is_empty() {
            return Err("Enter a non-empty search query.".into());
        }
        let bookmark_identity = bookmarks
            .map(|paths| {
                let mut paths = paths.to_vec();
                paths.sort();
                paths.join("\0")
            })
            .unwrap_or_default();
        let identity = format!(
            "{}\0{input}\0{}\0{current_file}\0{bookmark_identity}",
            root.display(),
            scope.as_str()
        );
        self.expire_snapshots();

        let search_id = if let Some(id) = params.search_id.as_ref() {
            let snapshots = self
                .snapshots
                .lock()
                .map_err(|_| "Search cache lock poisoned")?;
            let snapshot = snapshots
                .get(id)
                .ok_or("Search expired. Run the search again.")?;
            if snapshot.identity != identity {
                return Err("Search expired. Run the search again.".into());
            }
            id.clone()
        } else {
            let root = root.to_path_buf();
            let mut result = scan(
                &root,
                &spec,
                (scope == SearchScope::CurrentFile).then_some(current_file),
                private,
            )?;
            if scope == SearchScope::Bookmarks {
                let bookmarks =
                    bookmarks.ok_or("Bookmark search is unavailable in the Rust backend.")?;
                result
                    .files
                    .retain(|file| bookmarks.iter().any(|path| path == &file.path));
            }
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
            snapshots.insert(
                id.clone(),
                Snapshot {
                    identity,
                    created: Instant::now(),
                    result,
                },
            );
            id
        };

        let snapshots = self
            .snapshots
            .lock()
            .map_err(|_| "Search cache lock poisoned")?;
        let result = &snapshots
            .get(&search_id)
            .ok_or("Search expired. Run the search again.")?
            .result;
        let language_filters = spec
            .languages
            .iter()
            .map(|value| normalize_language(value))
            .collect::<Vec<_>>();
        let extra_path = params.path.as_deref().and_then(params_path_filter);
        let matches = result
            .files
            .iter()
            .filter(|file| {
                language_filters
                    .iter()
                    .all(|language| normalize_language(&file.language) == *language)
                    && spec
                        .paths
                        .iter()
                        .all(|filter| path_matches(&file.path, filter))
                    && extra_path
                        .as_ref()
                        .is_none_or(|filter| path_matches(&file.path, filter))
            })
            .collect::<Vec<_>>();
        let preferred = params.current_file.as_deref().unwrap_or("");
        let mut matches = matches;
        matches.sort_by(|a, b| {
            (b.path == preferred)
                .cmp(&(a.path == preferred))
                .then_with(|| a.path.cmp(&b.path))
        });
        let offset = params.offset.unwrap_or(0).min(MAX_FILES);
        let page = matches
            .iter()
            .skip(offset)
            .take(PAGE_SIZE)
            .map(|file| (*file).clone())
            .collect::<Vec<_>>();
        let languages = facets(
            result
                .files
                .iter()
                .filter(|file| {
                    spec.paths
                        .iter()
                        .all(|filter| path_matches(&file.path, filter))
                })
                .map(|file| file.language.as_str()),
        );
        let paths = facet_paths(
            result
                .files
                .iter()
                .filter(|file| {
                    language_filters
                        .iter()
                        .all(|language| normalize_language(&file.language) == *language)
                })
                .map(|file| file.path.as_str()),
        );
        let total = matches.len();
        let match_count = matches.iter().map(|file| file.match_count).sum::<usize>();
        let next_offset = (offset + page.len() < total).then_some(offset + page.len());
        Ok(SearchResponse {
            query: input.to_owned(),
            text_query: spec.text,
            scope: scope.as_str().to_owned(),
            search_id,
            engine: result.engine,
            truncated: result.truncated,
            total,
            match_count,
            files: page,
            next_offset,
            facets: SearchFacets { languages, paths },
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
) -> Result<SearchResult, String> {
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!spec.case_sensitive)
        .fixed_strings(!spec.regex)
        .build(&spec.text)
        .map_err(|error| format!("Invalid regular expression: {error}"))?;
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
        .parents(true);
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
    walker.filter_entry(move |entry| {
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
            || ignored_relative_path(&relative)
            || crate::file_kind::has_binary_extension(path)
        {
            continue;
        }
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
        let details =
            find_matches(&mut searcher, &matcher, text).map_err(|error| error.to_string())?;
        if details.match_count == 0 {
            continue;
        }
        let language = search_language(path);
        let file = FileResult {
            path: relative,
            language,
            match_count: details.match_count,
            snippets: group_snippets(details.snippets),
            snippets_truncated: details.snippets_truncated,
        };
        result_bytes = result_bytes.saturating_add(estimate_file_bytes(&file));
        if result_bytes > MAX_RESULT_BYTES {
            truncated = true;
            break;
        }
        files.push(file);
        if files.len() >= MAX_FILES {
            truncated = true;
            break;
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(SearchResult {
        files,
        engine: "ripgrep",
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
            let mut ranges: Vec<(usize, usize)> = Vec::new();
            let mut first_match = None;
            matcher
                .find_iter(line.as_bytes(), |matched| {
                    let start = byte_to_utf16(line, matched.start());
                    let end = byte_to_utf16(line, matched.end());
                    first_match.get_or_insert(start);
                    details.match_count += 1;
                    if details.snippets.len() < MAX_SNIPPET_LINES && start < 1400 {
                        let mut merged = false;
                        if let Some(last) = ranges.last_mut() {
                            if last.1 == start && last.0 != last.1 && end > start {
                                last.1 = end;
                                merged = true;
                            }
                        }
                        if !merged && ranges.len() < MAX_LINE_RANGES {
                            ranges.push((start, end));
                        } else if !merged {
                            details.snippets_truncated = true;
                        }
                    } else {
                        details.snippets_truncated = true;
                    }
                    true
                })
                .map_err(|error| io::Error::other(error.to_string()))?;
            if let Some(first_match) = first_match {
                if details.snippets.len() < MAX_SNIPPET_LINES {
                    let from = first_match.saturating_sub(200);
                    let to = from + 1200;
                    let (snippet, actual_from, actual_to) = utf16_slice(line, from, to);
                    let ranges = ranges
                        .into_iter()
                        .filter(|(start, end)| {
                            if start == end {
                                *start >= actual_from && *start <= actual_to
                            } else {
                                *start < actual_to && *end > actual_from
                            }
                        })
                        .map(|(start, end)| {
                            (
                                start.saturating_sub(actual_from),
                                end.min(actual_to).saturating_sub(actual_from),
                            )
                        })
                        .collect();
                    details.snippets.push(SnippetLine {
                        number: line_num as usize,
                        text: snippet,
                        clipped: actual_from > 0 || actual_to < line.encode_utf16().count(),
                        ranges,
                    });
                } else {
                    details.snippets_truncated = true;
                }
            }
            Ok(true)
        }),
    )?;
    Ok(details)
}

fn parse_query(input: &str) -> Result<SearchSpec, String> {
    let mut tokens = Vec::<(String, bool)>::new();
    let mut index = 0;
    let chars = input.char_indices().collect::<Vec<_>>();
    while index < chars.len() {
        while index < chars.len() && chars[index].1.is_whitespace() {
            index += 1;
        }
        if index == chars.len() {
            break;
        }
        let start = chars[index].0;
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
            RegexMatcherBuilder::new()
                .case_insensitive(flags == "i")
                .build(&pattern)
                .map_err(|error| format!("Invalid regular expression: {error}"))?;
            tokens.push((format!("\0REGEX:{}:{}", flags, pattern), false));
            index = after;
            continue;
        }
        let quoted = chars[index].1 == '"';
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
            tokens.push((value, true));
        } else {
            let mut end = index;
            while end < chars.len() && !chars[end].1.is_whitespace() {
                end += 1;
            }
            let byte_end = chars.get(end).map(|item| item.0).unwrap_or(input.len());
            tokens.push((input[start..byte_end].to_owned(), false));
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
    for (token, quoted) in tokens {
        if let Some(value) = token.strip_prefix("\0REGEX:") {
            let (flags, pattern) = value.split_once(':').unwrap_or(("", value));
            text_terms.push(pattern.to_owned());
            regex = true;
            regex_case_sensitive = Some(flags != "i");
        } else if !quoted {
            let lower = token.to_ascii_lowercase();
            if let Some(value) = lower
                .strip_prefix("lang:")
                .or_else(|| lower.strip_prefix("language:"))
            {
                languages.push(value.to_owned());
            } else if let Some(value) = lower.strip_prefix("path:") {
                paths.push(PathFilter {
                    value: value.to_owned(),
                    quoted: false,
                });
            } else if lower == "--no-gitignore" {
                respect_gitignore = false;
            } else if let Some(value) = lower.strip_prefix("gitignore:") {
                match value {
                    "yes" => respect_gitignore = true,
                    "no" => respect_gitignore = false,
                    _ => return Err("Use gitignore:yes or gitignore:no.".into()),
                }
            } else if let Some(value) = lower.strip_prefix("case:") {
                match value {
                    "yes" => case_sensitive = true,
                    "no" => case_sensitive = false,
                    _ => return Err("Use case:yes or case:no.".into()),
                }
            } else {
                text_terms.push(token);
            }
        } else {
            text_terms.push(token);
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

fn path_matches(path: &str, filter: &PathFilter) -> bool {
    if filter.quoted || !filter.value.contains(['*', '?']) {
        return path.to_lowercase().contains(&filter.value.to_lowercase());
    }
    let anchored = filter.value.starts_with('/');
    let pattern = filter.value.trim_start_matches('/');
    let mut regex = String::new();
    let chars = pattern.chars().collect::<Vec<_>>();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' if chars.get(i + 1) == Some(&'*') => {
                i += 1;
                if chars.get(i + 1) == Some(&'/') {
                    regex.push_str("(?:.*/)?");
                    i += 1;
                } else {
                    regex.push_str(".*");
                }
            }
            '*' => regex.push_str("[^/]*"),
            '?' => regex.push_str("[^/]"),
            ch => regex.push_str(&regex::escape(&ch.to_string())),
        }
        i += 1;
    }
    let prefix = if anchored { "^" } else { "(?:^|/)" };
    RegexMatcherBuilder::new()
        .case_insensitive(true)
        .build(&format!("{prefix}{regex}$"))
        .ok()
        .and_then(|matcher| matcher.is_match(path.as_bytes()).ok())
        .unwrap_or(false)
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

fn utf16_slice(text: &str, start: usize, end: usize) -> (String, usize, usize) {
    let mut utf16 = 0;
    let mut byte_start = text.len();
    let mut byte_end = text.len();
    for (byte, ch) in text.char_indices() {
        if utf16 >= start && byte_start == text.len() {
            byte_start = byte;
        }
        if utf16 >= end {
            byte_end = byte;
            break;
        }
        utf16 += ch.len_utf16();
    }
    if byte_start == text.len() && start >= utf16 {
        byte_start = text.len();
    }
    if byte_end == text.len() && end >= utf16 {
        byte_end = text.len();
    }
    let actual_start = text[..byte_start].encode_utf16().count();
    let actual_end = text[..byte_end].encode_utf16().count();
    (
        text[byte_start..byte_end].to_owned(),
        actual_start,
        actual_end,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
