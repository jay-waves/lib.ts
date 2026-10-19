use super::query::{CompiledPathFilter, normalize_language, search_language};
use super::*;
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{Searcher, sinks::UTF8};
use ignore::WalkBuilder;
use std::{fs, io, path::Path};

#[derive(Default)]
pub(super) struct MatchDetails {
    pub(super) match_count: usize,
    pub(super) snippets: Vec<SnippetLine>,
    pub(super) snippets_truncated: bool,
}

pub(super) fn scan(
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

pub(super) fn find_matches(
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

fn valid_text(bytes: &[u8]) -> bool {
    crate::file_kind::is_text(bytes)
}

fn ignored_relative_path(path: &str) -> bool {
    path.split('/')
        .any(|name| name.starts_with('.') || IGNORED_DIRS.contains(&name))
}

pub(super) fn group_snippets(lines: Vec<SnippetLine>) -> Vec<Snippet> {
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

pub(super) fn estimate_file_bytes(file: &FileResult) -> usize {
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

pub(super) fn byte_to_utf16(text: &str, byte: usize) -> usize {
    text[..byte].encode_utf16().count()
}
