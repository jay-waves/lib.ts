import React, { useContext, useEffect, useLayoutEffect, useRef } from 'react';
import morphdom from 'morphdom';
import { SessionActivity } from '../session-activity.jsx';
import { pageBase, treeBase } from '../urls.mjs';
import { readingKey, readPosition, savePosition } from '../reading-state.mjs';
import { observeMarkdownPosition } from './markdown-position.mjs';
import { updateAssetVersions } from './markdown.mjs';
import { navigateMarkdownFragment } from './fragment-navigation.mjs';
import { toggleFootnote } from './footnotes.mjs';
import './preview.css';
import { useReader } from '../reader-context.jsx';

export function updateHeadingAvailability(root) {
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

export function MarkdownPreview() {
  const { prepared, navigate, assetVersions, document: { path } } = useReader();
  const active = useContext(SessionActivity);
  const contentRef = useRef(null);
  useLayoutEffect(() => {
    const root = contentRef.current;
    const collapsed = new Set(readPosition(readingKey(pageBase, path)).collapsed || []);
    const next = root.cloneNode(false);
    next.append(...Array.from(prepared.body.childNodes, node => node.cloneNode(true)));
    next.querySelectorAll('.heading-section[data-heading-key]').forEach(section => {
      section.classList.toggle('is-collapsed', collapsed.has(section.dataset.headingKey));
    });
    morphdom(root, next, { childrenOnly: true,
      onBeforeElUpdated(from, to) {
        if (from.matches('.inline-footnote') && !from.hidden) to.hidden = false;
        if (from.getAttribute('data-footnote-ref') === to.getAttribute('data-footnote-ref')
          && from.hasAttribute('data-footnote-ref')) to.setAttribute('aria-expanded', from.getAttribute('aria-expanded'));
        if (from.matches('.footnote-label')) to.setAttribute('href', from.getAttribute('href'));
        if (from.tagName === 'DETAILS' && from.hasAttribute('open')) to.setAttribute('open', '');
        return true;
      } });
    updateHeadingAvailability(root);
  }, [prepared.body, path]);
  useLayoutEffect(() => {
    const root = contentRef.current;
    if (active) return observeMarkdownPosition(root.closest('.main-panel'), root);
  }, [active]);
  useEffect(() => updateAssetVersions(contentRef.current, assetVersions), [prepared.body, assetVersions]);

  function toggleSummary(summary) {
    const section = summary.closest('.heading-section');
    section?.classList.toggle('is-collapsed');
    if (contentRef.current) {
      updateHeadingAvailability(contentRef.current);
      savePosition(readingKey(pageBase, path), { collapsed: [...contentRef.current.querySelectorAll('.heading-section.is-collapsed')]
        .map(item => item.dataset.headingKey) });
    }
  }
  function click(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href]');
    if (link && toggleFootnote(contentRef.current, link)) { event.preventDefault(); return; }
    const heading = event.target.closest('.heading-summary > :is(h1,h2,h3,h4,h5,h6)');
    const summary = heading?.parentElement;
    if (summary && summary.getAttribute('aria-disabled') !== 'true') { toggleSummary(summary); return; }
    if (link && navigateMarkdownFragment(contentRef.current, link, location, updateHeadingAvailability)) {
      event.preventDefault();
      return;
    }
    if (link && link.origin === location.origin && link.pathname.startsWith(treeBase)) {
      event.preventDefault();
      navigate(decodeURIComponent(link.pathname.slice(treeBase.length)));
    }
  }
  function keyDown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.closest('a, button')) return;
    const summary = event.target.closest('.heading-summary');
    if (!summary || summary.getAttribute('aria-disabled') === 'true') return;
    event.preventDefault();
    toggleSummary(summary);
  }
  return <div id="content" ref={contentRef} className="rendered-markdown" onClick={click} onKeyDown={keyDown} />;
}
