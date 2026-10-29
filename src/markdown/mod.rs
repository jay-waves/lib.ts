//! Markdown parsing and HTML output, with shared QuickJS renderers for formulas,
//! highlighted code, and diagrams.

mod ast;

mod headings;
mod postprocess;
use headings::{HeadingIds, slugify};

use comrak::{Arena, Options, format_html_with_plugins, options::Plugins, parse_document};
use std::path::Path;

#[cfg(test)]
pub fn render_markdown(source: &str, allow_raw_html: bool) -> Result<String, String> {
    render_inner(source, allow_raw_html, None).map(|(html, _)| html)
}

pub fn render_document(
    source: &str,
    input: &Path,
    root: &Path,
    private: &Path,
) -> Result<(String, Vec<(String, String)>), String> {
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .name("markdown-graphs".into())
            .stack_size(16 * 1024 * 1024)
            .spawn_scoped(scope, || {
                let root = dunce::canonicalize(root).map_err(|e| e.to_string())?;
                let attachments = lib_comrak::document::Attachments::new(
                    input,
                    input,
                    root,
                    lib_comrak::cli::Images::Reference,
                    false,
                )?
                .exclude_private(private.to_owned());
                let engine = lib_comrak::engine::Engine::default();
                render_inner(source, true, Some((&engine, &attachments)))
            })
            .map_err(|e| e.to_string())?
            .join()
            .map_err(|_| "graph compiler thread failed".to_string())?
    })
}

pub fn render_diagram(source: &str) -> Result<String, String> {
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .name("diagram-compiler".into())
            .stack_size(16 * 1024 * 1024)
            .spawn_scoped(scope, || {
                lib_comrak::engine::Engine::default()
                    .render("diagram", source, "", 0)
                    .and_then(|svg| svg.ok_or_else(|| "cannot render diagram".into()))
            })
            .map_err(|e| e.to_string())?
            .join()
            .map_err(|_| "diagram compiler thread failed".to_string())?
    })
}

fn render_inner(
    source: &str,
    allow_raw_html: bool,
    graphs: Option<(
        &lib_comrak::engine::Engine,
        &lib_comrak::document::Attachments,
    )>,
) -> Result<(String, Vec<(String, String)>), String> {
    let arena = Arena::new();
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options.extension.footnotes = true;
    options.extension.front_matter_delimiter = Some("---".into());
    options.extension.math_dollars = true;
    options.extension.math_latex = true;
    options.render.r#unsafe = allow_raw_html;
    options.render.sourcepos = true;
    let root = parse_document(&arena, source, &options);
    let mut modules = Vec::new();
    if let Some((engine, attachments)) = graphs {
        match lib_comrak::document::compile_fragments(root, engine, attachments) {
            Ok((warnings, graph_modules)) => {
                modules = graph_modules;
                for warning in warnings {
                    tracing::warn!(
                        line = warning.line,
                        column = warning.column,
                        "{}",
                        warning.message
                    );
                }
            }
            Err(errors) => {
                return Err(errors
                    .into_iter()
                    .map(|e| format!("{}:{}: {}", e.line, e.column, e.message))
                    .collect::<Vec<_>>()
                    .join("\n"));
            }
        }
    }
    ast::transform(&arena, root, &options)?;
    let heading = HeadingIds::default();
    let mut plugins = Plugins::default();
    plugins.render.heading_adapter = Some(&heading);
    let mut html = String::new();
    format_html_with_plugins(root, &options, &mut html, &plugins)
        .map_err(|error| error.to_string())?;
    Ok((postprocess::postprocess_html(html), modules))
}

#[cfg(test)]
mod tests {
    use super::render_markdown;

    #[test]
    fn section_ids_follow_heading_ids_without_duplicate_keys() {
        let html = render_markdown("# Foo\n\n# Foo\n\n# Foo-1\n\n# Section-foo\n", true).unwrap();
        let ids = regex::Regex::new(r#"\bid="([^"]+)""#).unwrap();
        let values: Vec<_> = ids.captures_iter(&html).map(|c| c[1].to_owned()).collect();
        assert_eq!(
            values
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            values.len()
        );
        let headings = regex::Regex::new(r#"<h1 id="([^"]+)""#).unwrap();
        for heading in headings.captures_iter(&html) {
            assert!(values.contains(&format!("section-{}", &heading[1])));
        }
        assert!(!html.contains("data-heading-key"));
        assert!(!html.contains("data-node-id"));
    }

    #[test]
    fn graph_tags_remain_available_to_the_preview() {
        let source = "<viz src=\"charts/a.js\" width=\"75%\" caption=\"Chart\"></viz>\n\n<mermaid caption=\"Flow\">\nflowchart LR\n A --> B\n</mermaid>\n";
        let html = render_markdown(source, true).unwrap();
        assert!(html.contains("<viz src=\"charts/a.js\" width=\"75%\" caption=\"Chart\"></viz>"));
        assert!(html.contains("<mermaid caption=\"Flow\">"));
        assert!(html.contains("A --> B"));
    }

    #[test]
    fn document_compiles_graphs_before_returning_html() {
        let temp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(temp.path()).unwrap();
        let input = root.join("note.md");
        std::fs::write(root.join("chart.js"), "import * as d3 from 'd3'; export default c => {d3.select(c).append('svg').append('circle').attr('r', 7)}; export function hydrate(c) {}").unwrap();
        let (html, modules) = super::render_document(
            "<viz src=\"chart.js\" caption=\"Sample\"></viz>\n\n<mermaid>\nflowchart LR\n A --> B\n</mermaid>\n",
            &input, &root, &root.join("private"),
        ).unwrap();
        assert_eq!(html.matches("<svg").count(), 2);
        assert_eq!(modules.len(), 1);
        assert!(modules[0].1.starts_with("data:text/javascript;base64,"));
        assert!(!html.contains("data-viz-module="));
        assert!(html.contains("data-graph-source=\"chart.js\""));
        assert!(html.contains("<figcaption>Sample</figcaption>"));
        assert!(!html.contains("<script"));
        std::fs::create_dir(root.join("private")).unwrap();
        std::fs::write(root.join("private/chart.js"), "export default () => {};").unwrap();
        assert!(
            super::render_document(
                "<viz src=\"private/chart.js\"></viz>",
                &input,
                &root,
                &root.join("private")
            )
            .unwrap_err()
            .contains("private")
        );
    }

    #[test]
    fn document_prerenders_math_and_highlight_including_footnotes() {
        let temp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(temp.path()).unwrap();
        let source = "Formula $x^2$ and note[^a].\n\n```js\nconst x = 1;\n```\n\n```math\nz^2\n```\n\n[^a]: Formula $y^2$.\n";
        let (html, _) =
            super::render_document(source, &root.join("note.md"), &root, &root.join("private"))
                .unwrap();
        assert!(html.matches("class=\"katex\"").count() >= 3);
        assert!(html.contains("hljs-keyword"));
        assert!(html.contains("class=\"math-block\""));
        assert!(html.contains("data-line=\"3\""));
        assert!(html.contains("inline-footnote"));
    }

    #[test]
    fn graph_ids_survive_prose_edits_and_chart_file_updates() {
        let temp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(temp.path()).unwrap();
        let input = root.join("note.md");
        let chart = root.join("chart.js");
        let script = "export default c => { c.innerHTML = '<svg><text>first</text></svg>'; }; export function hydrate(c) {}";
        std::fs::write(&chart, script).unwrap();
        let graph = "<viz src=\"chart.js\"></viz>\n\n<viz src=\"chart.js\"></viz>\n\n<mermaid>\nflowchart LR\nA --> B\n</mermaid>\n";
        let render = |source: &str| {
            super::render_document(source, &input, &root, &root.join("private")).unwrap()
        };
        let (before_html, before) = render(graph);
        let (after_html, after) = render(&format!("# New section\n\nNew paragraph.\n\n{graph}"));
        assert_eq!(before, after);
        assert_ne!(before[0].0, before[1].0);
        let diagrams = |html: &str| {
            html.split("id=\"graph-")
                .skip(1)
                .map(|s| s.split('"').next().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(diagrams(&before_html), diagrams(&after_html));
        std::fs::write(&chart, script.replace("first", "second")).unwrap();
        let (updated_html, updated) = render(graph);
        assert_eq!(
            before.iter().map(|v| &v.0).collect::<Vec<_>>(),
            updated.iter().map(|v| &v.0).collect::<Vec<_>>()
        );
        assert_ne!(before[0].1, updated[0].1);
        assert!(updated_html.contains("second"));
    }

    fn panels(html: &str) -> Vec<&str> {
        html.split("<aside ")
            .skip(1)
            .map(|panel| panel.split("</aside>").next().unwrap())
            .collect()
    }

    #[test]
    fn footnotes_follow_reference_order_and_share_only_within_a_paragraph() {
        let html = render_markdown("First[^b], second[^a], repeated[^b].\n\nAgain[^b].\n\n[^a]: Alpha **bold**\n[^b]: Beta", true).unwrap();
        let notes = panels(&html);
        assert_eq!(notes.len(), 3, "{html}");
        assert!(notes[0].starts_with("id=\"F1\""));
        assert!(notes[0].contains("[1]</a> Beta"));
        assert!(notes[1].starts_with("id=\"F2\""));
        assert!(notes[1].contains("[2]</a> Alpha <strong>bold</strong>"));
        assert!(notes[2].starts_with("id=\"F1-2\""));
        assert!(notes[2].contains("href=\"#fnref1-2\""));
        assert_eq!(html.matches("data-footnote-ref=\"F1\"").count(), 2);
        assert_eq!(html.matches("aria-expanded=\"false\"").count(), 4);
        assert!(html.contains("id=\"fnref1-1\""));
        assert!(html.contains("aria-controls=\"F1-2\""));
        assert!(!html.contains("footnote-backref"));
        assert!(!html.contains("class=\"footnotes\""));
        for note in notes {
            assert!(note.contains("role=\"doc-footnote\" hidden>"));
            assert_eq!(note.matches("class=\"footnote-label\"").count(), 1);
            assert!(!note.contains("data-source"));
        }
    }

    #[test]
    fn footnote_panels_stay_in_lists_and_quotes_but_outside_tables() {
        let html = render_markdown("- Item[^n]\n- Next\n\n> Quote[^n]\n\n| Column | Other |\n|---|---|\n| Cell[^n] | Again[^n] |\n\n[^n]: Note", true).unwrap();
        assert_eq!(panels(&html).len(), 3, "{html}");
        assert!(html.find("<aside id=\"F1\"").unwrap() < html.find("</li>").unwrap());
        let quote = html
            .split("<blockquote")
            .nth(1)
            .unwrap()
            .split("</blockquote>")
            .next()
            .unwrap();
        assert!(quote.contains("<aside id=\"F1-1\""));
        assert!(html.contains("</table>\n<aside id=\"F1-2\""));
        assert_eq!(html.matches("data-footnote-ref=\"F1-2\"").count(), 2);
        assert!(
            !html
                .split("<table")
                .nth(1)
                .unwrap()
                .split("</table>")
                .next()
                .unwrap()
                .contains("<aside")
        );
    }

    #[test]
    fn footnote_bodies_preserve_rich_content_without_scroll_anchors() {
        let html = render_markdown("Reference[^n]\n\n[^n]: **Rich** note $x^2$.\n\n    Final [link](https://example.com).\n\n    ```js\n    const x = 1;\n    ```", true).unwrap();
        let notes = panels(&html);
        assert_eq!(notes.len(), 1);
        let note = notes[0];
        assert!(note.contains("<strong>Rich</strong>"));
        assert!(note.contains("data-math-style=\"inline\""));
        assert!(note.contains("<p>Final <a href=\"https://example.com\">link</a>.</p>"));
        assert!(note.contains("<div class=\"code-wrap\"><pre><code class=\"language-js\">"));
        assert!(!note.contains("data-source"));
        assert!(html.contains("<p data-line=\"1\">"));
    }

    #[test]
    fn code_only_footnotes_have_a_return_label_and_respect_raw_html_policy() {
        let source = "Reference[^code] and[^html]\n\n[^code]:\n    ```js\n    const x = 1;\n    ```\n\n[^html]: <em>Raw</em>";
        for allow_raw_html in [true, false] {
            let html = render_markdown(source, allow_raw_html).unwrap();
            let notes = panels(&html);
            assert_eq!(notes.len(), 2);
            assert!(notes[0].contains("[1]</a></p>\n<div class=\"code-wrap\">"));
            assert!(notes[0].contains("href=\"#fnref1\""));
            assert_eq!(notes[1].contains("<em>Raw</em>"), allow_raw_html);
            assert!(html.contains("data-footnote-ref=\"F2\""));
        }
    }

    #[test]
    fn heading_sections_keep_footnotes_inside_their_content() {
        let html = render_markdown(
            "# Parent[^n]\n\nText\n\n## Child\n\nMore[^n]\n\n# Next\n\n[^n]: Note",
            true,
        )
        .unwrap();
        assert_eq!(html.matches("<section class=\"heading-section").count(), 3);
        assert_eq!(html.matches("</section>").count(), 3);
        assert!(
            html.contains("<div class=\"heading-content\">\n<aside id=\"F1\""),
            "{html}"
        );
        let next = html.find("id=\"section-next\"").unwrap();
        assert!(html.find("<aside id=\"F1-1\"").unwrap() < next);
    }

    #[test]
    fn undefined_and_unused_footnotes_do_not_create_panels() {
        let html = render_markdown("Undefined[^missing].\n\n[^unused]: Unused body", true).unwrap();
        assert!(html.contains("[^missing]"));
        assert!(panels(&html).is_empty());
        assert!(!html.contains("Unused body"));
    }

    #[test]
    fn nested_and_cyclic_footnotes_finish_with_unique_targets() {
        let html =
            render_markdown("Reference[^a]\n\n[^a]: Alpha[^b]\n[^b]: Beta[^a]", true).unwrap();
        assert!(html.contains("Alpha"));
        assert!(html.contains("Beta"));
        assert!(html.contains("data-footnote-ref=\"F1-F2\""), "{html}");
        let ids = regex::Regex::new(r#"\bid="([^"]+)""#)
            .unwrap()
            .captures_iter(&html)
            .map(|capture| capture[1].to_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            ids.len(),
            ids.iter().collect::<std::collections::HashSet<_>>().len()
        );
        assert!(html.len() < 4000);
    }

    #[test]
    fn html_matches_frontend_math_and_highlight_contract() {
        let html = render_markdown(
            "Inline $x^2$ and display:\n\n$$\ny^2\n$$\n\n```js\nconst answer = 42;\n```\n",
            true,
        )
        .unwrap();

        assert!(html.contains("<span data-math-style=\"inline\""));
        assert!(html.contains(">x^2</span>"));
        assert!(html.contains("data-math-style=\"display\""));
        assert!(html.contains("<div class=\"code-wrap\"><pre"));
        assert!(html.contains("<code class=\"language-js\">const answer = 42;"));
        assert!(!html.contains("hljs-keyword"));
    }
}
