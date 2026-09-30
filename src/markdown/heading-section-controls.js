function updateHeadingAvailability(root) {
  if (!root) return;
  root.querySelectorAll('section.heading-section').forEach(section => {
    const summary = section.querySelector(':scope > .heading-summary');
    if (!summary) return;
    const disabled = Boolean(section.parentElement?.closest('section.heading-section.is-collapsed'));
    summary.tabIndex = disabled ? -1 : 0;
    summary.setAttribute('aria-expanded', String(!section.classList.contains('is-collapsed')));
    if (disabled) summary.setAttribute('aria-disabled', 'true');
    else summary.removeAttribute('aria-disabled');
  });
}

function toggleHeadingSection(section) {
  section.classList.toggle('is-collapsed');
  updateHeadingAvailability(section.closest('#content'));
}

function toggleFromEvent(event) {
  const summary = event.target.closest?.('.heading-summary');
  if (!summary || !summary.closest('#content') || summary.getAttribute('aria-disabled') === 'true') return;
  const section = summary.closest('section.heading-section');
  if (section) toggleHeadingSection(section);
}

document.addEventListener('click', toggleFromEvent);
document.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const summary = event.target.closest?.('.heading-summary');
  if (!summary || !summary.closest('#content') || summary.getAttribute('aria-disabled') === 'true') return;
  event.preventDefault();
  toggleFromEvent(event);
});
document.addEventListener('markdown-preview-content-updated', event => {
  updateHeadingAvailability(event.detail?.contentElement || document.getElementById('content'));
});
