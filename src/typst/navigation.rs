use super::*;

pub(super) fn extract_page_links(
    page: &typst_layout::Page,
    page_number: usize,
    introspector: &typst_layout::PagedIntrospector,
) -> Vec<PageLink> {
    use typst::{
        layout::{Frame, FrameItem, Transform},
        model::Destination,
    };

    fn collect(
        frame: &Frame,
        transform: Transform,
        current_page: usize,
        page_width: f64,
        page_height: f64,
        introspector: &typst_layout::PagedIntrospector,
        output: &mut Vec<PageLink>,
    ) {
        for (position, item) in frame.items() {
            let transform = transform.pre_concat(Transform::translate(position.x, position.y));
            match item {
                FrameItem::Group(group) => collect(
                    &group.frame,
                    transform.pre_concat(group.transform),
                    current_page,
                    page_width,
                    page_height,
                    introspector,
                    output,
                ),
                FrameItem::Link(destination, size) => {
                    let (target_page, x, y, href) = match destination {
                        Destination::Url(url) => {
                            let href = url.as_str();
                            let scheme = href
                                .split_once(':')
                                .filter(|(prefix, _)| {
                                    !prefix.is_empty()
                                        && prefix.chars().all(|ch| {
                                            ch.is_ascii_alphanumeric()
                                                || matches!(ch, '+' | '.' | '-')
                                        })
                                })
                                .map(|(scheme, _)| scheme.to_ascii_lowercase());
                            if scheme.as_deref().is_some_and(|scheme| {
                                !matches!(scheme, "http" | "https" | "mailto" | "tel" | "ftp")
                            }) {
                                continue;
                            }
                            (None, None, None, Some(href.to_owned()))
                        }
                        Destination::Position(position) => (
                            Some(position.page.get()),
                            Some(position.point.x.to_pt()),
                            Some(position.point.y.to_pt()),
                            None,
                        ),
                        Destination::Location(location) => {
                            let Some(position) = introspector.position(*location) else {
                                continue;
                            };
                            (
                                Some(position.page.get()),
                                Some(position.point.x.to_pt()),
                                Some(position.point.y.to_pt()),
                                None,
                            )
                        }
                    };
                    let corners = [
                        typst::layout::Point::zero(),
                        typst::layout::Point::new(size.x, typst::layout::Abs::zero()),
                        typst::layout::Point::new(typst::layout::Abs::zero(), size.y),
                        typst::layout::Point::new(size.x, size.y),
                    ]
                    .map(|point| point.transform(transform));
                    let min_x = corners
                        .iter()
                        .map(|point| point.x.to_pt())
                        .fold(f64::INFINITY, f64::min);
                    let min_y = corners
                        .iter()
                        .map(|point| point.y.to_pt())
                        .fold(f64::INFINITY, f64::min);
                    let max_x = corners
                        .iter()
                        .map(|point| point.x.to_pt())
                        .fold(f64::NEG_INFINITY, f64::max);
                    let max_y = corners
                        .iter()
                        .map(|point| point.y.to_pt())
                        .fold(f64::NEG_INFINITY, f64::max);
                    let left = min_x.max(0.0).min(page_width);
                    let top = min_y.max(0.0).min(page_height);
                    let right = max_x.max(0.0).min(page_width);
                    let bottom = max_y.max(0.0).min(page_height);
                    if right <= left || bottom <= top || page_width <= 0.0 || page_height <= 0.0 {
                        continue;
                    }
                    let is_internal = target_page.is_some();
                    if is_internal && target_page == Some(current_page) && x.is_none() {
                        continue;
                    }
                    output.push(PageLink {
                        left: left / page_width * 100.0,
                        top: top / page_height * 100.0,
                        width: (right - left) / page_width * 100.0,
                        height: (bottom - top) / page_height * 100.0,
                        page: target_page,
                        x,
                        y,
                        href,
                    });
                }
                _ => {}
            }
        }
    }

    let size = page.frame.size();
    let (width, height) = (size.x.to_pt(), size.y.to_pt());
    let mut links = Vec::new();
    collect(
        &page.frame,
        typst::layout::Transform::identity(),
        page_number,
        width,
        height,
        introspector,
        &mut links,
    );
    links
}

pub(super) fn next_id() -> String {
    let ticks = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{ticks:x}-{:x}", NEXT_ID.fetch_add(1, Ordering::Relaxed))
}

pub(super) fn checked_typst_path(root: &Path, value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.contains('\0') {
        return Err("Invalid path".into());
    }
    let candidate = if Path::new(value).is_absolute() {
        PathBuf::from(value)
    } else {
        root.join(value)
    };
    let canonical = candidate
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !canonical.starts_with(root) {
        return Err("Typst source is outside the repository root".into());
    }
    if !canonical
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("typ"))
    {
        return Err("Not a Typst document".into());
    }
    Ok(canonical)
}

pub(super) fn map_diagnostics(
    world: &TypstWorld,
    items: impl IntoIterator<Item = typst::diag::SourceDiagnostic>,
    severity: &str,
) -> Vec<Diagnostic> {
    items
        .into_iter()
        .map(|item| {
            let file = item.span.id().map_or_else(String::new, |id| {
                let path = id.vpath().get_without_slash().to_string();
                match id.root() {
                    VirtualRoot::Project => path,
                    VirtualRoot::Package(spec) => format!("{spec}/{path}"),
                }
            });
            let range = world.range(item.span).and_then(|range| {
                let id = item.span.id()?;
                let source = world.source(id).ok()?;
                let lines = source.lines();
                let (start_line, start_column) = lines.byte_to_line_column(range.start)?;
                let (end_line, end_column) = lines.byte_to_line_column(range.end)?;
                Some(DiagnosticRange {
                    start: DiagnosticPosition {
                        line: start_line + 1,
                        column: start_column + 1,
                    },
                    end: DiagnosticPosition {
                        line: end_line + 1,
                        column: end_column + 1,
                    },
                })
            });
            Diagnostic {
                file,
                severity: severity.to_owned(),
                message: item.message.to_string(),
                range,
            }
        })
        .collect()
}

pub(super) fn extract_navigation(
    world: &TypstWorld,
    document: &PagedDocument,
    pages: &[PageInfo],
) -> (Vec<OutlineItem>, Vec<SourceAnchor>) {
    use typst::{
        foundations::NativeElement,
        introspection::Introspector,
        model::{HeadingElem, ParElem},
    };

    let introspector = document.introspector();
    let headings = introspector
        .query(&HeadingElem::ELEM.select())
        .into_iter()
        .filter_map(|content| {
            let heading = content.to_packed::<HeadingElem>()?;
            let span = heading.span();
            let range = world.range(span)?;
            let id = span.id()?;
            if id != world.main() {
                return None;
            }
            let source = world.source(id).ok()?;
            let (line, _) = source.lines().byte_to_line_column(range.start)?;
            let level = source
                .text()
                .lines()
                .nth(line)
                .map(|text| {
                    text.trim_start()
                        .chars()
                        .take_while(|ch| *ch == '=')
                        .count()
                })
                .filter(|level| *level > 0)
                .unwrap_or(1);
            let location = content.location()?;
            let position = introspector.position(location);
            let position = match position {
                Some(position) => {
                    let page = position.page.get();
                    let height = pages.get(page.checked_sub(1)?)?.height;
                    Some((page, position.point.y.to_pt(), height))
                }
                None => None,
            };
            let name = heading.body.plain_text().trim().to_owned();
            Some((
                OutlineItem {
                    name,
                    level,
                    line: line + 1,
                    position: position.map(|(page, y, height)| AnchorPosition {
                        page,
                        y: if height > 0.0 { y / height } else { 0.0 },
                    }),
                },
                position,
            ))
        })
        .collect::<Vec<_>>();

    let mut anchors = headings
        .iter()
        .filter_map(|(heading, position)| {
            let (page, y, _) = (*position)?;
            let absolute_y = pages
                .iter()
                .take(page.saturating_sub(1))
                .map(|page| page.height)
                .sum::<f64>()
                + y;
            Some(SourceAnchor {
                line: heading.line,
                page,
                y,
                absolute_y,
            })
        })
        .collect::<Vec<_>>();
    // Paragraphs are locatable Typst elements, so their source spans and
    // laid-out positions can be joined directly without injecting metadata
    // into the user's source.
    anchors.extend(
        introspector
            .query(&ParElem::ELEM.select())
            .into_iter()
            .filter_map(|content| {
                let paragraph = content.to_packed::<ParElem>()?;
                let span = paragraph.span();
                let range = world.range(span)?;
                let id = span.id()?;
                if id != world.main() {
                    return None;
                }
                let source = world.source(id).ok()?;
                let (line, _) = source.lines().byte_to_line_column(range.start)?;
                let location = content.location()?;
                let position = introspector.position(location)?;
                let page = position.page.get();
                let height = pages.get(page.checked_sub(1)?)?.height;
                let y = if height > 0.0 {
                    position.point.y.to_pt() / height
                } else {
                    0.0
                };
                let absolute_y = pages
                    .iter()
                    .take(page.saturating_sub(1))
                    .map(|page| page.height)
                    .sum::<f64>()
                    + position.point.y.to_pt();
                Some(SourceAnchor {
                    line: line + 1,
                    page,
                    y,
                    absolute_y,
                })
            }),
    );
    anchors.sort_by_key(|anchor| anchor.line);
    // A heading can also contribute a paragraph-like location in some
    // Typst constructs. Keep one stable anchor per source line.
    anchors.dedup_by_key(|anchor| anchor.line);
    (
        headings.into_iter().map(|(heading, _)| heading).collect(),
        anchors,
    )
}
