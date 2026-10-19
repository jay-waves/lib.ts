//! Bookmark semantics on top of Hayro's existing parsed objects.
use super::OutlineItem;
use hayro_svg::hayro_syntax::{
    Pdf,
    object::{Array, Dict, Name, Object, ObjectIdentifier, String as PdfString},
};
use std::collections::{HashMap, HashSet};

const LIMIT: usize = 10_000;

fn title(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xfe, 0xff]) || bytes.starts_with(&[0xff, 0xfe]) {
        let little = bytes[0] == 0xff;
        let words = bytes[2..]
            .chunks_exact(2)
            .map(|pair| {
                if little {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            })
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&words);
    }
    if let Some(bytes) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    // Unmarked PDF text strings use PDFDocEncoding, not UTF-8.
    const SPECIAL: [char; 32] = [
        '•', '†', '‡', '…', '—', '–', 'ƒ', '⁄', '‹', '›', '−', '‰', '„', '“', '”', '‘', '’', '‚',
        '™', 'ﬁ', 'ﬂ', 'Ł', 'Œ', 'Š', 'Ÿ', 'Ž', 'ı', 'ł', 'œ', 'š', 'ž', '�',
    ];
    const ACCENTS: [char; 8] = ['˘', 'ˇ', 'ˆ', '˙', '˝', '˛', '˚', '˜'];
    bytes
        .iter()
        .map(|byte| match *byte {
            0x18..=0x1f => ACCENTS[(*byte - 0x18) as usize],
            0x80..=0x9f => SPECIAL[(*byte - 0x80) as usize],
            0xa0 => '€',
            0x7f | 0xad => '�',
            byte => char::from(byte),
        })
        .collect()
}

fn names<'a>(
    node: Dict<'a>,
    output: &mut HashMap<Vec<u8>, Object<'a>>,
    seen: &mut HashSet<ObjectIdentifier>,
    depth: usize,
) {
    if depth >= 32 || output.len() >= LIMIT || node.obj_id().is_some_and(|id| !seen.insert(id)) {
        return;
    }
    if let Some(entries) = node.get::<Array<'_>>(b"Names") {
        let mut entries = entries.iter::<Object<'_>>();
        while output.len() < LIMIT {
            let (Some(Object::String(key)), Some(value)) = (entries.next(), entries.next()) else {
                break;
            };
            output.insert(key.as_bytes().to_vec(), value);
        }
    }
    if let Some(kids) = node.get::<Array<'_>>(b"Kids") {
        for child in kids.iter::<Dict<'_>>().take(LIMIT) {
            names(child, output, seen, depth + 1);
        }
    }
}

struct Resolver<'a> {
    pdf: &'a Pdf,
    pages: HashMap<ObjectIdentifier, usize>,
    names: HashMap<Vec<u8>, Object<'a>>,
}

impl<'a> Resolver<'a> {
    fn destination(&self, mut value: Object<'a>) -> Option<(usize, Option<f64>)> {
        // Resolve ordinary named destinations and /D wrappers; cap aliases.
        for _ in 0..8 {
            value = match value {
                Object::Name(key) => self.names.get(key.as_ref())?.clone(),
                Object::String(key) => self.names.get(key.as_bytes())?.clone(),
                Object::Dict(dict) => dict.get::<Object<'_>>(b"D")?,
                Object::Array(array) => return self.explicit(array),
                _ => return None,
            };
        }
        None
    }

    fn explicit(&self, array: Array<'a>) -> Option<(usize, Option<f64>)> {
        let reference = array.raw_iter().next()?.as_obj_ref()?;
        let number = *self.pages.get(&reference.into())?;
        let page = &self.pdf.pages()[number - 1];
        let mut values = array.iter::<Object<'_>>().skip(1);
        let mode = values.next()?.into_name()?;
        let (left, top) = match mode.as_ref() {
            b"XYZ" => (
                values.next()?.into_f32().unwrap_or(0.0),
                values.next()?.into_f32(),
            ),
            b"FitH" | b"FitBH" => (0.0, values.next()?.into_f32()),
            b"FitR" => {
                let left = values.next()?.into_f32().unwrap_or(0.0);
                values.next();
                values.next();
                (left, values.next()?.into_f32())
            }
            _ => (0.0, None),
        };
        let y = top.and_then(|top| {
            let [_, b, _, d, _, f] = page.initial_transform(true).as_coeffs();
            let y = (b * f64::from(left) + d * f64::from(top) + f)
                / f64::from(page.render_dimensions().1);
            y.is_finite().then(|| y.clamp(0.0, 1.0))
        });
        Some((number, y))
    }

    fn collect(
        &self,
        first: Dict<'a>,
        level: usize,
        seen: &mut HashSet<ObjectIdentifier>,
        budget: &mut usize,
        output: &mut Vec<OutlineItem>,
    ) {
        if level > 64 {
            return;
        }
        let mut current = Some(first);
        while let Some(item) = current {
            if *budget == 0 || item.obj_id().is_some_and(|id| !seen.insert(id)) {
                return;
            }
            *budget -= 1;
            let destination = item
                .get::<Object<'_>>(b"Dest")
                .or_else(|| {
                    let action = item.get::<Dict<'_>>(b"A")?;
                    let kind = action.get::<Name<'_>>(b"S")?;
                    (kind.as_ref() == b"GoTo")
                        .then(|| action.get::<Object<'_>>(b"D"))
                        .flatten()
                })
                .and_then(|destination| self.destination(destination));
            if let Some(value) = item.get::<PdfString<'_>>(b"Title") {
                output.push(OutlineItem {
                    name: title(value.as_bytes()),
                    level,
                    page: destination.map(|(page, _)| page),
                    y: destination.and_then(|(_, y)| y),
                });
            }
            if let Some(child) = item.get::<Dict<'_>>(b"First") {
                self.collect(child, level + 1, seen, budget, output);
            }
            current = item.get::<Dict<'_>>(b"Next");
        }
    }
}

pub(super) fn outline(pdf: &Pdf) -> Vec<OutlineItem> {
    let Some(catalog) = pdf.xref().get::<Dict<'_>>(pdf.xref().root_id()) else {
        return Vec::new();
    };
    let Some(first) = catalog
        .get::<Dict<'_>>(b"Outlines")
        .and_then(|root| root.get::<Dict<'_>>(b"First"))
    else {
        return Vec::new();
    };
    let mut named = HashMap::new();
    if let Some(legacy) = catalog.get::<Dict<'_>>(b"Dests") {
        for key in legacy.keys().take(LIMIT) {
            if let Some(value) = legacy.get::<Object<'_>>(key.as_ref()) {
                named.insert(key.as_ref().to_vec(), value);
            }
        }
    }
    if let Some(root) = catalog
        .get::<Dict<'_>>(b"Names")
        .and_then(|names| names.get::<Dict<'_>>(b"Dests"))
    {
        names(root, &mut named, &mut HashSet::new(), 0);
    }
    let resolver = Resolver {
        pdf,
        names: named,
        pages: pdf
            .pages()
            .iter()
            .enumerate()
            .filter_map(|(index, page)| page.raw().obj_id().map(|id| (id, index + 1)))
            .collect(),
    };
    let mut output = Vec::new();
    let mut budget = LIMIT;
    resolver.collect(first, 1, &mut HashSet::new(), &mut budget, &mut output);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(objects: &[&str]) -> Pdf {
        let mut data = b"%PDF-2.0\n".to_vec();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(data.len());
            data.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", index + 1).as_bytes());
        }
        let xref = data.len();
        data.extend_from_slice(
            format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
        );
        for offset in offsets {
            data.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        data.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        Pdf::new(data).unwrap()
    }

    #[test]
    fn resolves_named_destinations_preserves_groups_and_maps_crop_coordinates() {
        let pdf = document(&[
            "<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R /Names << /Dests 8 0 R >> /Dests << /legacy [4 0 R /FitH 400] >> >>",
            "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [10 20 610 820] /Resources << >> >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << >> >>",
            "<< /Type /Outlines /First 6 0 R /Last 11 0 R >>",
            "<< /Title <FEFF7AE08282> /Parent 5 0 R /First 7 0 R /Next 9 0 R >>",
            "<< /Title <436166E9208093> /Parent 6 0 R /A << /S /GoTo /D (section) >> >>",
            "<< /Kids [10 0 R] >>",
            "<< /Title <EFBBBFE79BAEE5BD95> /Parent 5 0 R /Dest /legacy /Next 11 0 R >>",
            "<< /Names [(section) << /D [3 0 R /XYZ 10 620 null] >>] >>",
            "<< /Title (External) /Parent 5 0 R /A << /S /GoToR /D [4 0 R /Fit] /F (other.pdf) >> >>",
        ]);
        let items = outline(&pdf);
        assert_eq!(items.len(), 4);
        assert_eq!(
            (&*items[0].name, items[0].level, items[0].page),
            ("章节", 1, None)
        );
        assert_eq!(
            (&*items[1].name, items[1].level, items[1].page),
            ("Café •ﬁ", 2, Some(1))
        );
        assert!((items[1].y.unwrap() - 0.25).abs() < 1e-6);
        assert_eq!(
            (&*items[2].name, items[2].page, items[2].y),
            ("目录", Some(2), Some(0.5))
        );
        assert_eq!((&*items[3].name, items[3].page), ("External", None));
    }

    #[test]
    fn direct_page_targets_and_missing_coordinates_keep_page_navigation() {
        let pdf = document(&[
            "<< /Type /Catalog /Pages 2 0 R /Outlines << /First 4 0 R >> >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << >> >>",
            "<< /Title (Page) /Dest [3 0 R /XYZ null null null] >>",
        ]);
        let items = outline(&pdf);
        assert_eq!(items[0].page, Some(1));
        assert_eq!(items[0].y, None);
    }
}
