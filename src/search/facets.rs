use super::SearchFacet;
use std::collections::HashMap;

pub(super) fn sort_facets(facets: &mut [SearchFacet]) {
    facets.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.value.cmp(&right.value))
    });
}

pub(super) fn facets<'a>(values: impl Iterator<Item = &'a str>) -> Vec<SearchFacet> {
    let mut counts = HashMap::<&str, usize>::new();
    for value in values {
        *counts.entry(value).or_default() += 1;
    }
    let mut items = counts
        .into_iter()
        .map(|(value, count)| SearchFacet {
            value: value.to_owned(),
            count,
        })
        .collect::<Vec<_>>();
    sort_facets(&mut items);
    items
}

pub(super) fn facet_paths<'a>(values: impl Iterator<Item = &'a str>) -> Vec<SearchFacet> {
    let mut counts = HashMap::<String, usize>::new();
    for path in values {
        let facet = path
            .split_once('/')
            .map(|(directory, _)| format!("{directory}/"))
            .unwrap_or_else(|| path.to_owned());
        *counts.entry(facet).or_default() += 1;
    }
    let mut items = counts
        .into_iter()
        .map(|(value, count)| SearchFacet { value, count })
        .collect::<Vec<_>>();
    sort_facets(&mut items);
    items
}
