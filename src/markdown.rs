//! Markdown parsing and HTML output. Formula spans remain source text in marked
//! elements so the browser can add KaTeX rendering independently.

use comrak::{
    Arena, Options,
    adapters::{HeadingAdapter, HeadingMeta},
    format_html_with_plugins,
    nodes::{Ast, AstNode, NodeValue, Sourcepos},
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

fn encode_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn raw<'a>(arena: &'a Arena<'a>, html: String) -> &'a AstNode<'a> {
    arena.alloc(Ast::new(NodeValue::Raw(html), Default::default()).into())
}

fn add_heading_sections<'a>(arena: &'a Arena<'a>, root: &'a AstNode<'a>) {
    let mut top = Vec::new();
    let mut node = root.first_child();
    while let Some(current) = node {
        top.push(current);
        node = current.next_sibling();
    }
    let mut stack: Vec<(&'a AstNode<'a>, u8, &'a AstNode<'a>, bool)> = Vec::new();
    let mut occurrences = HashMap::<String, usize>::new();

    for current in top {
        let heading_level = match current.data().value {
            NodeValue::Heading(heading) => Some(heading.level),
            _ => None,
        };
        if let Some(level) = heading_level {
            if let Some((_, _, _, has_content)) = stack.last_mut() {
                *has_content = true;
            }
            if stack.last().is_some() {
                current.insert_before(raw(arena, "</div>\n".into()));
            }
            while stack
                .last()
                .is_some_and(|(_, parent_level, _, _)| *parent_level >= level)
            {
                let (_, _, open, has_content) = stack.pop().unwrap();
                if let NodeValue::Raw(html) = &mut open.data.borrow_mut().value {
                    if has_content && !html.contains("has-heading-content") {
                        *html = html.replacen(
                            "class=\"heading-section\"",
                            "class=\"heading-section has-heading-content\"",
                            1,
                        );
                    }
                }
                current.insert_before(raw(arena, "</section>\n".into()));
            }
            let heading_id = slugify(&current.collect_text());
            let occurrence = occurrences
                .entry(format!("H{level}:{heading_id}"))
                .or_default();
            let key = format!("H{level}:{heading_id}:{}", *occurrence);
            *occurrence += 1;
            let section_id = encode_component(&key);
            let open = raw(
                arena,
                format!(
                    "<section class=\"heading-section\" data-heading-level=\"{level}\" data-heading-key=\"{key}\" id=\"heading-section-{section_id}\">\n"
                ),
            );
            current.insert_before(open);
            current.insert_before(raw(arena, "<div class=\"heading-summary\" role=\"button\" tabindex=\"0\" aria-expanded=\"true\">\n".into()));
            current.insert_after(raw(arena, "<span class=\"heading-collapsed-indicator\" aria-hidden=\"true\">…</span></div>\n<div class=\"heading-content\">\n".into()));
            stack.push((current, level, open, false));
        } else if let Some((_, _, _, has_content)) = stack.last_mut() {
            *has_content = true;
        }
    }

    while let Some((_, _, open, has_content)) = stack.pop() {
        if let NodeValue::Raw(html) = &mut open.data.borrow_mut().value {
            if has_content && !html.contains("has-heading-content") {
                *html = html.replacen(
                    "class=\"heading-section\"",
                    "class=\"heading-section has-heading-content\"",
                    1,
                );
            }
        }
        root.append(raw(arena, "</div>\n</section>\n".into()));
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
    add_heading_sections(&arena, root);
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
