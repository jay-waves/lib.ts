// Legacy records used H<level>:<slug>:<occurrence>; new records store section IDs.
export function collapsedSectionIds(root, saved) {
  const stored = new Set(saved), result = new Set(), occurrences = new Map();
  for (const section of root.querySelectorAll('.heading-section[id]')) {
    const heading = section.querySelector(':scope > .heading-summary > :is(h1,h2,h3,h4,h5,h6)');
    let legacy;
    if (heading) {
      let slug = '', pendingDash = false;
      for (const ch of heading.textContent.trim().toLowerCase()) {
        if (/\s/u.test(ch)) pendingDash = Boolean(slug);
        else if (/[\p{L}\p{N}_-]/u.test(ch)) {
          if (pendingDash && !slug.endsWith('-')) slug += '-';
          pendingDash = false;
          slug += ch;
        }
      }
      slug ||= 'heading';
      const base = `H${section.dataset.headingLevel}:${slug}`;
      const occurrence = occurrences.get(base) || 0;
      occurrences.set(base, occurrence + 1);
      legacy = `${base}:${occurrence}`;
    }
    if (stored.has(section.id) || stored.has(legacy)) result.add(section.id);
  }
  return result;
}
