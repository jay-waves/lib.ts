//! Markdown parsing and HTML output. Formula spans remain source text in marked
//! elements so the browser can add KaTeX rendering independently.

#[path = "markdown/ast.rs"]
mod ast;

use comrak::{
    Arena, Options,
    adapters::{HeadingAdapter, HeadingMeta},
    format_html_with_plugins,
    nodes::Sourcepos,
    options::Plugins,
    parse_document,
};
use regex::Regex;
use std::{
    borrow::Cow,
    collections::HashMap,
    fmt,
    sync::{LazyLock, Mutex},
};

static SOURCEPOS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<(p|li|table|blockquote|pre)\b([^>]*?)\sdata-sourcepos="(\d+):[^"]*"([^>]*)>"#)
        .expect("valid source position regex")
});
static ANCHOR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r##"<a href="#[^"]*" aria-label="Link to heading [^"]*" data-heading-content="[^"]*" class="anchor"></a>"##)
        .expect("valid heading anchor regex")
});
static CODE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?s)<pre([^>]*)><code([^>]*)>(.*?)</code></pre>"#)
        .expect("valid code block regex")
});
static SOURCE_LINE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r##"data-source-line="(\d+)""##).expect("valid source line regex"));
static LANGUAGE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r##"class="language-([^"]*)""##).expect("valid language regex"));

#[derive(Default)]
struct HeadingIds(Mutex<HashMap<String, usize>>);

impl HeadingAdapter for HeadingIds {
    fn enter(
        &self,
        output: &mut dyn fmt::Write,
        heading: &HeadingMeta,
        sourcepos: Option<Sourcepos>,
    ) -> fmt::Result {
        let base = slugify(&heading.content);
        let mut ids = self.0.lock().map_err(|_| fmt::Error)?;
        let occurrence = ids.entry(base.clone()).or_default();
        let id = if *occurrence == 0 {
            base
        } else {
            format!("{base}-{}", *occurrence)
        };
        *occurrence += 1;
        let line = sourcepos.map(|position| position.start.line.saturating_sub(1));
        write!(output, "<h{} id=\"{}\"", heading.level, id)?;
        if let Some(line) = line {
            write!(output, " data-source-line=\"{line}\"")?;
        }
        output.write_str(">")
    }

    fn exit(&self, output: &mut dyn fmt::Write, heading: &HeadingMeta) -> fmt::Result {
        write!(output, "</h{}>", heading.level)
    }
}

fn slugify(text: &str) -> String {
    let mut slug = String::new();
    let mut pending_dash = false;
    for ch in text.trim().to_lowercase().chars() {
        if ch.is_whitespace() {
            pending_dash = !slug.is_empty();
        } else if ch.is_alphanumeric() || ch == '_' || ch == '-' {
            if pending_dash && !slug.ends_with('-') {
                slug.push('-');
            }
            pending_dash = false;
            slug.push(ch);
        }
    }
    if slug.is_empty() {
        "heading".into()
    } else {
        slug
    }
}

fn front_matter_as_yaml(source: &str) -> Cow<'_, str> {
    let mut lines = source.split_inclusive('\n');
    if lines
        .next()
        .is_none_or(|line| line.trim_end_matches(['\r', '\n']) != "---")
    {
        return Cow::Borrowed(source);
    }
    let Some(end) = lines
        .position(|line| line.trim_end_matches(['\r', '\n']) == "---")
        .map(|index| index + 1)
    else {
        return Cow::Borrowed(source);
    };
    let mut output = String::with_capacity(source.len() + 6);
    let mut lines = source.split_inclusive('\n');
    for index in 0..=end {
        let line = lines.next().unwrap_or_default();
        if index == 0 {
            output.push_str("```yaml");
        } else if index == end {
            output.push_str("```");
        } else {
            output.push_str(line);
            continue;
        }
        if line.ends_with('\n') {
            output.push('\n');
        }
    }
    output.extend(lines);
    Cow::Owned(output)
}

fn postprocess_html(html: String) -> String {
    let html = SOURCEPOS_RE
        .replace_all(&html, |captures: &regex::Captures<'_>| {
            let line = captures[3].parse::<usize>().unwrap_or(1).saturating_sub(1);
            format!(
                "<{}{} data-source-line=\"{}\"{}>",
                &captures[1], &captures[2], line, &captures[4]
            )
        })
        .into_owned();
    let html = ANCHOR_RE.replace_all(&html, "").into_owned();
    CODE_RE
        .replace_all(&html, |captures: &regex::Captures<'_>| {
            let attributes = &captures[1];
            let code_attributes = &captures[2];
            if attributes.contains("data-math-style=\"display\"")
                || code_attributes.contains("data-math-style=\"display\"")
            {
                return format!("<pre{attributes}><code{code_attributes}>{}</code></pre>", &captures[3]);
            }
            let source_line = SOURCE_LINE_RE
                .captures(attributes)
                .and_then(|found| found[1].parse::<usize>().ok())
                .map(|line| format!(" data-source-line=\"{line}\""))
                .unwrap_or_default();
            let lang = LANGUAGE_RE
                .captures(code_attributes)
                .map(|found| found[1].to_owned())
                .unwrap_or_default();
            let label = if lang.is_empty() {
                String::new()
            } else {
                format!("<span class=\"code-lang\">{lang}</span>")
            };
            format!(
                "<div class=\"code-wrap\"><pre{source_line}><code{code_attributes}>{}</code></pre>{label}</div>",
                &captures[3]
            )
        })
        .into_owned()
}

pub fn render_markdown(source: &str, allow_raw_html: bool) -> Result<String, String> {
    let source = front_matter_as_yaml(source);
    let arena = Arena::new();
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options.extension.footnotes = true;
    options.extension.math_dollars = true;
    options.extension.math_latex = true;
    options.render.r#unsafe = allow_raw_html;
    options.render.sourcepos = true;
    let root = parse_document(&arena, &source, &options);
    ast::transform(&arena, root, &options)?;
    let heading = HeadingIds::default();
    let mut plugins = Plugins::default();
    plugins.render.heading_adapter = Some(&heading);
    let mut html = String::new();
    format_html_with_plugins(root, &options, &mut html, &plugins)
        .map_err(|error| error.to_string())?;
    Ok(postprocess_html(html))
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
