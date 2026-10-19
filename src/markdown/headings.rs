use comrak::{
    adapters::{HeadingAdapter, HeadingMeta},
    nodes::Sourcepos,
};
use std::{collections::HashMap, fmt, sync::Mutex};

#[derive(Default)]
pub(super) struct HeadingIds(Mutex<HashMap<String, usize>>);

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
            format!("{base}-{occurrence}")
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

pub(super) fn slugify(text: &str) -> String {
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
