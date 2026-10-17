//! Current-file definitions extracted with the language grammars' tags.scm queries.
use serde::Serialize;
use tree_sitter::{Parser, Query, QueryCursor, StreamingIterator};

const BIBTEX_TAGS_QUERY: &str = r#"
(key_brace) @name @definition.entry
(key_paren) @name @definition.entry
"#;

const JSON_TAGS_QUERY: &str = r#"
(pair
  key: (string) @name) @definition.property
"#;

const YAML_TAGS_QUERY: &str = r#"
(block_mapping_pair
  key: (flow_node
    (plain_scalar
      (string_scalar) @name))) @definition.property
(block_mapping_pair
  key: (flow_node
    (double_quote_scalar) @name)) @definition.property
(block_mapping_pair
  key: (flow_node
    (single_quote_scalar) @name)) @definition.property
(flow_pair
  key: (flow_node
    (plain_scalar
      (string_scalar) @name))) @definition.property
(flow_pair
  key: (flow_node
    (double_quote_scalar) @name)) @definition.property
(flow_pair
  key: (flow_node
    (single_quote_scalar) @name)) @definition.property
"#;

const TOML_TAGS_QUERY: &str = r#"
(table
  (bare_key) @name) @definition.module
(table
  (dotted_key) @name) @definition.module
(table_array_element
  (bare_key) @name) @definition.module
(table_array_element
  (dotted_key) @name) @definition.module
(pair
  (bare_key) @name) @definition.property
(pair
  (dotted_key) @name) @definition.property
"#;

const SQL_TAGS_QUERY: &str = r#"
(create_table
  (object_reference
    name: (identifier) @name)) @definition.class
(create_view
  (object_reference
    name: (identifier) @name)) @definition.class
(create_materialized_view
  (object_reference
    name: (identifier) @name)) @definition.class
(create_function
  (object_reference
    name: (identifier) @name)) @definition.function
(create_procedure
  (object_reference
    name: (identifier) @name)) @definition.procedure
(create_type
  (object_reference
    name: (identifier) @name)) @definition.type
"#;

#[derive(Debug, Serialize, PartialEq)]
pub struct Symbol {
    pub name: String,
    pub kind: String,
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
    kind: String,
    start: usize,
    end: usize,
    line: usize,
}

pub fn extract(extension: &str, source: &str) -> Vec<Symbol> {
    let Some(language_name) = language_name(extension) else {
        return Vec::new();
    };
    let query_source = tree_sitter_language_pack::get_tags_query(language_name)
        .filter(|query| !query.trim().is_empty())
        .or_else(|| match language_name {
            "bash" => Some(include_str!("symbols/bash.scm")),
            "bibtex" => Some(BIBTEX_TAGS_QUERY),
            "json" => Some(JSON_TAGS_QUERY),
            "yaml" => Some(YAML_TAGS_QUERY),
            "toml" => Some(TOML_TAGS_QUERY),
            "sql" => Some(SQL_TAGS_QUERY),
            _ => None,
        });
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
        let Some(kind) = query
            .capture_names()
            .get(definition.index as usize)
            .and_then(|capture| capture.strip_prefix("definition."))
        else {
            continue;
        };
        let node = name.node;
        if node.is_missing() {
            continue;
        }
        let Ok(text) = node.utf8_text(source.as_bytes()) else {
            continue;
        };
        let text = match (language_name, text) {
            ("json", text) => {
                serde_json::from_str::<String>(text).unwrap_or_else(|_| text.to_owned())
            }
            (_, text) => text.to_owned(),
        };
        if text.trim().is_empty() {
            continue;
        }
        let span = definition.node;
        definitions.push(Definition {
            name: text,
            kind: kind.to_owned(),
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
            kind: definition.kind.clone(),
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
                "bib",
                "@article{doe2024, title={A Paper}, author={Doe}}
@book(keyparen, title={A Book})",
                vec!["doe2024", "keyparen"],
            ),
            (
                "json",
                r#"{"name": "App", "nested": {"enabled": true}}"#,
                vec!["name", "nested", "enabled"],
            ),
            (
                "yaml",
                "name: App\nnested:\n  enabled: true\n",
                vec!["name", "nested", "enabled"],
            ),
            (
                "toml",
                "[server]\nname = \"App\"\n[server.tls]\nenabled = true\n",
                vec!["server", "name", "server.tls", "enabled"],
            ),
            (
                "sql",
                "CREATE TABLE users (id INT);\nCREATE VIEW active_users AS SELECT id FROM users;",
                vec!["users", "active_users"],
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
