//! Current-file definitions only; no project index or reference resolution.
use serde::Serialize;
use tree_sitter::{Language, Node, Parser};

#[derive(Debug, Serialize, PartialEq)]
pub struct Symbol {
    pub name: String,
    pub level: usize,
    pub line: usize,
}

fn language(extension: &str) -> Option<Language> {
    Some(match extension {
        "lua" => tree_sitter_lua::LANGUAGE.into(),
        "sh" | "bash" | "zsh" => tree_sitter_bash::LANGUAGE.into(),
        "rs" => tree_sitter_rust::LANGUAGE.into(),
        "js" | "jsx" | "mjs" | "cjs" => tree_sitter_javascript::LANGUAGE.into(),
        "ts" | "mts" | "cts" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "py" | "pyi" => tree_sitter_python::LANGUAGE.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        "java" => tree_sitter_java::LANGUAGE.into(),
        "c" | "h" => tree_sitter_c::LANGUAGE.into(),
        "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => tree_sitter_cpp::LANGUAGE.into(),
        _ => return None,
    })
}

fn definition_name(node: Node<'_>) -> Option<Node<'_>> {
    match node.kind() {
        "function_item"
        | "function_signature_item"
        | "struct_item"
        | "enum_item"
        | "trait_item"
        | "type_item"
        | "mod_item"
        | "class_declaration"
        | "abstract_class_declaration"
        | "interface_declaration"
        | "enum_declaration"
        | "type_alias_declaration"
        | "function_declaration"
        | "generator_function_declaration"
        | "method_definition"
        | "method_declaration"
        | "constructor_declaration"
        | "class_definition"
        | "function_definition"
        | "struct_specifier"
        | "class_specifier"
        | "enum_specifier"
        | "union_specifier"
        | "record_declaration"
        | "annotation_type_declaration"
        | "type_spec"
        | "namespace_definition" => node.child_by_field_name("name").or_else(|| {
            // C/C++ function names live inside nested declarators (pointers,
            // qualified names and templates), rather than a name field.
            let mut declarator = node.child_by_field_name("declarator")?;
            while let Some(inner) = declarator.child_by_field_name("declarator") {
                declarator = inner;
            }
            Some(declarator)
        }),
        "impl_item" => node.child_by_field_name("type"),
        "variable_declarator" => {
            let value = node.child_by_field_name("value")?;
            matches!(
                value.kind(),
                "arrow_function" | "function_expression" | "generator_function" | "class"
            )
            .then(|| node.child_by_field_name("name"))
            .flatten()
        }
        _ => None,
    }
}

pub fn extract(extension: &str, source: &str) -> Vec<Symbol> {
    let Some(language) = language(extension) else {
        return Vec::new();
    };
    let mut parser = Parser::new();
    if parser.set_language(&language).is_err() {
        return Vec::new();
    }
    let Some(tree) = parser.parse(source, None) else {
        return Vec::new();
    };
    let mut symbols = Vec::new();
    // Iterative traversal avoids overflowing the stack on deeply nested input.
    let mut pending = vec![(tree.root_node(), 1)];
    while let Some((node, level)) = pending.pop() {
        let name = definition_name(node)
            .filter(|name| !name.is_missing())
            .and_then(|name| name.utf8_text(source.as_bytes()).ok())
            .filter(|name| !name.trim().is_empty());
        if let Some(name) = name {
            symbols.push(Symbol {
                name: name.to_owned(),
                level,
                line: node.start_position().row + 1,
            });
        }
        let child_level = level + usize::from(name.is_some());
        let mut cursor = node.walk();
        let children: Vec<_> = node.named_children(&mut cursor).collect();
        pending.extend(children.into_iter().rev().map(|child| (child, child_level)));
    }
    symbols
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_languages_and_lines() {
        for (extension, source, names) in [
            (
                "lua",
                "function App.run() end\nlocal function start() end",
                vec!["App.run", "start"],
            ),
            (
                "sh",
                "run() { echo ok; }\nfunction start { :; }",
                vec!["run", "start"],
            ),
            (
                "rs",
                "// fn fake() {}\nstruct App {}\nimpl App { fn run(&self) {} }",
                vec!["App", "App", "run"],
            ),
            (
                "js",
                "// function fake() {}\nclass App { run() {} }\nconst start = () => {};",
                vec!["App", "run", "start"],
            ),
            (
                "ts",
                "interface App {}\nfunction start(): void {}",
                vec!["App", "start"],
            ),
            ("tsx", "const App = () => <div />;", vec!["App"]),
            (
                "py",
                "class App:\n    def run(self):\n        pass",
                vec!["App", "run"],
            ),
            (
                "go",
                "package main\ntype App struct {}\nfunc (a App) Run() {}",
                vec!["App", "Run"],
            ),
            (
                "java",
                "class App { App() {} void run() {} }",
                vec!["App", "App", "run"],
            ),
            (
                "c",
                "struct App { int x; };\nint run(void) { return 0; }",
                vec!["App", "run"],
            ),
            ("cpp", "class App { void run() {} };", vec!["App", "run"]),
        ] {
            let symbols = extract(extension, source);
            assert_eq!(
                symbols.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
                names,
                "{extension}"
            );
            assert!(symbols.iter().all(|s| s.line >= 1));
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
