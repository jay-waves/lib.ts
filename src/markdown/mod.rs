//! Markdown parsing and HTML output. Formula spans remain source text in marked
//! elements so the browser can add KaTeX rendering independently.

mod ast;

mod headings;
mod postprocess;
use headings::{HeadingIds, slugify};

use comrak::{Arena, Options, format_html_with_plugins, options::Plugins, parse_document};
pub fn render_markdown(source: &str, allow_raw_html: bool) -> Result<String, String> {
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
    ast::transform(&arena, root, &options)?;
    let heading = HeadingIds::default();
    let mut plugins = Plugins::default();
    plugins.render.heading_adapter = Some(&heading);
    let mut html = String::new();
    format_html_with_plugins(root, &options, &mut html, &plugins)
        .map_err(|error| error.to_string())?;
    Ok(postprocess::postprocess_html(html))
}

#[cfg(test)]
mod tests {
    use super::render_markdown;

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
        assert!(notes[0].starts_with("id=\"fn1\""));
        assert!(notes[0].contains("[1]</a> Beta"));
        assert!(notes[1].starts_with("id=\"fn2\""));
        assert!(notes[1].contains("[2]</a> Alpha <strong>bold</strong>"));
        assert!(notes[2].starts_with("id=\"fn1-2\""));
        assert!(notes[2].contains("href=\"#fnref1-2\""));
        assert_eq!(html.matches("data-footnote-ref=\"fn1\"").count(), 2);
        assert_eq!(html.matches("aria-expanded=\"false\"").count(), 4);
        assert!(html.contains("id=\"fnref1-1\""));
        assert!(html.contains("aria-controls=\"fn1-2\""));
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
        assert!(html.find("<aside id=\"fn1\"").unwrap() < html.find("</li>").unwrap());
        let quote = html
            .split("<blockquote")
            .nth(1)
            .unwrap()
            .split("</blockquote>")
            .next()
            .unwrap();
        assert!(quote.contains("<aside id=\"fn1-1\""));
        assert!(html.contains("</table>\n<aside id=\"fn1-2\""));
        assert_eq!(html.matches("data-footnote-ref=\"fn1-2\"").count(), 2);
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
        assert!(html.contains("<p data-source-line=\"0\">"));
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
            assert!(html.contains("data-footnote-ref=\"fn2\""));
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
            html.contains("<div class=\"heading-content\">\n<aside id=\"fn1\""),
            "{html}"
        );
        let next = html.find("data-heading-key=\"H1:next:0\"").unwrap();
        assert!(html.find("<aside id=\"fn1-1\"").unwrap() < next);
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
        assert!(html.contains("data-footnote-ref=\"fn1-fn2\""), "{html}");
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
