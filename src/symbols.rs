//! Current-file definitions extracted with the language grammars' tags.scm queries.
use serde::Serialize;
use tree_sitter::{Parser, Query, QueryCursor, StreamingIterator};

#[derive(Debug, Serialize, PartialEq)]
pub struct Symbol {
    pub name: String,
    pub level: usize,
    pub line: usize,
}

fn language_name(extension: &str) -> Option<&'static str> {
    match extension {
        "sh" | "bash" | "zsh" => Some("bash"),
        _ => tree_sitter_language_pack::detect_language_from_extension(extension),
    }
}

#[derive(Clone)]
struct Definition {
    name: String,
    start: usize,
    end: usize,
    line: usize,
}

pub fn extract(extension: &str, source: &str) -> Vec<Symbol> {
    let Some(language_name) = language_name(extension) else {
        return Vec::new();
    };
    let query_source = tree_sitter_language_pack::get_tags_query(language_name)
        .or_else(|| (language_name == "bash").then_some(include_str!("symbols/bash.scm")));
    let Some(query_source) = query_source else {
        return Vec::new();
    };
    let Ok(language) = tree_sitter_language_pack::get_language(language_name) else {
        return Vec::new();
    };
    let Ok(query) = Query::new(&language, query_source) else {
        return Vec::new();
    };
    let Some(name_capture) = query
        .capture_names()
        .iter()
        .position(|name| *name == "name")
    else {
        return Vec::new();
    };
    let definition_captures: Vec<_> = query
        .capture_names()
        .iter()
        .enumerate()
        .filter_map(|(index, name)| name.starts_with("definition.").then_some(index as u32))
        .collect();
    let mut parser = Parser::new();
    if parser.set_language(&language).is_err() {
        return Vec::new();
    }
    let Some(tree) = parser.parse(source, None) else {
        return Vec::new();
    };
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query, tree.root_node(), source.as_bytes());
    let mut definitions = Vec::new();
    while let Some(found) = matches.next() {
        let name = found
            .captures()
            .iter()
            .find(|capture| capture.index == name_capture as u32);
        let definition = found
            .captures()
            .iter()
            .find(|capture| definition_captures.contains(&capture.index));
        let (Some(name), Some(definition)) = (name, definition) else {
            continue;
        };
        let node = name.node;
        if node.is_missing() {
            continue;
        }
        let Ok(text) = node.utf8_text(source.as_bytes()) else {
            continue;
        };
        if text.trim().is_empty() {
            continue;
        }
        let span = definition.node;
        definitions.push(Definition {
            name: text.to_owned(),
            start: span.start_byte(),
            end: span.end_byte(),
            line: span.start_position().row + 1,
        });
    }
    definitions.sort_by_key(|definition| (definition.start, definition.end));
    definitions.dedup_by(|a, b| a.start == b.start && a.end == b.end && a.name == b.name);
    definitions
        .iter()
        .map(|definition| Symbol {
            name: definition.name.clone(),
            level: definitions
                .iter()
                .filter(|parent| parent.start < definition.start && parent.end >= definition.end)
                .count()
                + 1,
            line: definition.line,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_tags_queries_cover_supported_languages() {
        let cache = tempfile::tempdir().unwrap();
        tree_sitter_language_pack::configure(&tree_sitter_language_pack::PackConfig {
            cache_dir: Some(cache.path().to_path_buf()),
            ..Default::default()
        })
        .unwrap();
        for (extension, source, expected) in [
            (
                "lua",
                "function App.run() end\nlocal function start() end",
                vec!["run", "start"],
            ),
            (
                "sh",
                "run() { echo ok; }\nfunction start { :; }",
                vec!["run", "start"],
            ),
            (
                "rs",
                "struct App {}\nimpl App { fn run(&self) {} }",
                vec!["App", "run"],
            ),
            (
                "js",
                "class App { run() {} }\nconst start = () => {};",
                vec!["App", "run", "start"],
            ),
            (
                "ts",
                "interface App {}\nfunction start(): void {}",
                vec!["App"],
            ),
            ("tsx", "const App = () => <div />;", vec![]),
            (
                "py",
                "class App:\n    def run(self):\n        pass",
                vec!["App", "run"],
            ),
            (
                "go",
                "type App struct {}\nfunc (a App) Run() {}",
                vec!["App", "Run"],
            ),
            ("java", "class App { void run() {} }", vec!["App", "run"]),
            (
                "c",
                "struct App { int x; };\nint run(void) { return 0; }",
                vec!["App", "run"],
            ),
            ("cpp", "class App { void run() {} };", vec!["App", "run"]),
        ] {
            let symbols = extract(extension, source);
            assert_eq!(
                symbols
                    .iter()
                    .map(|symbol| symbol.name.as_str())
                    .collect::<Vec<_>>(),
                expected,
                "{extension}"
            );
            assert!(symbols.iter().all(|symbol| symbol.line >= 1));
        }
        let symbols = extract(
            "py",
            "# def fake():\nclass App:\n    def run(self):\n        pass",
        );
        assert_eq!((symbols[0].line, symbols[0].level), (2, 1));
        assert_eq!((symbols[1].line, symbols[1].level), (3, 2));
        assert!(extract("txt", "fn fake() {}").is_empty());
    }
}
