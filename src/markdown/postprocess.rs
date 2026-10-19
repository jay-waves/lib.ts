use regex::Regex;
use std::sync::LazyLock;

static SOURCEPOS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<(p|li|table|blockquote|pre)\b([^>]*?)\sdata-sourcepos="(\d+):[^"]*"([^>]*)>"#)
        .expect("valid source position regex")
});
static CODE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?s)<pre([^>]*)><code([^>]*)>(.*?)</code></pre>"#)
        .expect("valid code block regex")
});
static SOURCE_LINE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r##"data-source-line="(\d+)""##).expect("valid source line regex"));
static LANGUAGE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r##"class="language-([^"]*)""##).expect("valid language regex"));

pub(super) fn postprocess_html(html: String) -> String {
    let html = SOURCEPOS_RE
        .replace_all(&html, |captures: &regex::Captures<'_>| {
            let line = captures[3].parse::<usize>().unwrap_or(1).saturating_sub(1);
            format!(
                "<{}{} data-source-line=\"{}\"{}>",
                &captures[1], &captures[2], line, &captures[4]
            )
        })
        .into_owned();
    CODE_RE.replace_all(&html, |captures: &regex::Captures<'_>| {
        let attributes = &captures[1];
        let code_attributes = &captures[2];
        if attributes.contains("data-math-style=\"display\"") || code_attributes.contains("data-math-style=\"display\"") {
            return format!("<pre{attributes}><code{code_attributes}>{}</code></pre>", &captures[3]);
        }
        let source_line = SOURCE_LINE_RE.captures(attributes)
            .and_then(|found| found[1].parse::<usize>().ok())
            .map(|line| format!(" data-source-line=\"{line}\"")).unwrap_or_default();
        let lang = LANGUAGE_RE.captures(code_attributes).map(|found| found[1].to_owned()).unwrap_or_default();
        let label = if lang.is_empty() { String::new() } else { format!("<span class=\"code-lang\">{lang}</span>") };
        format!("<div class=\"code-wrap\"><pre{source_line}><code{code_attributes}>{}</code></pre>{label}</div>", &captures[3])
    }).into_owned()
}
