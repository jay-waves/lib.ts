use super::*;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::Searcher;
use std::fs;

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
