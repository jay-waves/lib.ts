import React, { useContext, useEffect, useLayoutEffect, useRef } from 'react';
import morphdom from 'morphdom';
import { SessionActivity } from '../session-activity';
import { pageBase, treeBase } from '../urls.mjs';
import { readingKey, readPosition, savePosition } from '../reading-state.mjs';
import { observeMarkdownPosition } from './markdown-position.mjs';
import { updateAssetVersions } from './markdown.mjs';
import { hydrateGraphs } from './graphs.mjs';
import { enableDiagramZoom } from '../diagrams/zoom.mjs';
import { collapsedSectionIds } from './heading-state.mjs';
import '../../crates/lib-comrak/d3.css';
import '../../crates/lib-comrak/mermaid.css';
import { navigateMarkdownFragment } from './fragment-navigation.mjs';
import { toggleFootnote } from './footnotes.mjs';
import './preview.css';

// Remember server markup before hydration mutates SVG, so unrelated edits do
// not replace a chart whose compiled output is unchanged.
const graphMarkup = new WeakMap();
const graphModules = new WeakMap();
function graphSignature(graph) {
  const copy = graph.cloneNode(true);
  copy.removeAttribute('data-line');
  return copy.outerHTML;
}

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

export function MarkdownPreview({ prepared, navigate, assetVersions, path }) {
  const active = useContext(SessionActivity);
  const contentRef = useRef(null);
  useLayoutEffect(() => {
    const root = contentRef.current;
    const savedCollapsed = readPosition(readingKey(pageBase, path)).collapsed || [];
    const next = root.cloneNode(false);
    const nextModules = new Map(prepared.graphModules);
    next.append(...Array.from(prepared.body.childNodes, node => node.cloneNode(true)));
    const collapsed = collapsedSectionIds(next, savedCollapsed);
    next.querySelectorAll('.heading-section[id]').forEach(section => {
      section.classList.toggle('is-collapsed', collapsed.has(section.id));
    });
    if (savedCollapsed.some(key => /^H[1-6]:/.test(key))) {
      savePosition(readingKey(pageBase, path), { collapsed: [...collapsed] });
    }
    morphdom(root, next, { childrenOnly: true,
      onBeforeElUpdated(from, to) {
        if (from.matches('.viz, .diagram')) {
          const module = nextModules.get(to.id);
          if (graphMarkup.get(from) === graphSignature(to) && graphModules.get(from) === module) {
            if (to.hasAttribute('data-line')) from.setAttribute('data-line', to.getAttribute('data-line'));
            else from.removeAttribute('data-line');
            return false;
          }
          // A changed chart needs a fresh element so old event listeners cannot
          // survive when the new module attaches its own interactions.
          from.replaceWith(to.cloneNode(true));
          return false;
        }
        if (from.matches('.inline-footnote') && !from.hidden) to.hidden = false;
        if (from.getAttribute('data-footnote-ref') === to.getAttribute('data-footnote-ref')
          && from.hasAttribute('data-footnote-ref')) to.setAttribute('aria-expanded', from.getAttribute('aria-expanded'));
        if (from.matches('.footnote-label')) to.setAttribute('href', from.getAttribute('href'));
        if (from.tagName === 'DETAILS' && from.hasAttribute('open')) to.setAttribute('open', '');
        if (from.matches('.katex, .code-wrap') && from.isEqualNode(to)) return false;
        return true;
      } });
    root.querySelectorAll('.viz, .diagram').forEach(graph => {
      if (!graphMarkup.has(graph)) {
        graphMarkup.set(graph, graphSignature(graph));
        graphModules.set(graph, nextModules.get(graph.id));
      }
    });
    updateHeadingAvailability(root);
    const navigateHash = () => {
      if (!active) return;
      if (!/^#[LF][1-9]\d*$/.test(location.hash)) return;
      const link = root.ownerDocument.createElement('a');
      link.href = location.href;
      navigateMarkdownFragment(root, link, location, updateHeadingAvailability);
    };
    if (active) navigateHash();
    window.addEventListener('hashchange', navigateHash);
    const stopGraphs = hydrateGraphs(root, prepared.graphModules);
    const stopZoom = [...root.querySelectorAll('.diagram')].map(enableDiagramZoom);
    return () => { window.removeEventListener('hashchange', navigateHash); stopGraphs(); stopZoom.forEach(stop => stop()); };
  }, [prepared.body, path, active]);
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
        .map(item => item.id) });
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
  return <div id="content" ref={contentRef} className="rendered-markdown" data-dim-images onClick={click} onKeyDown={keyDown} />;
}
