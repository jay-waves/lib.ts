import DOMPurify from 'dompurify';
import Panzoom from '@panzoom/panzoom';
import morphdom from 'morphdom';
import './style.css';
import './heading-sections.css';
import './heading-section-controls.js';
import { observeSidenotes } from './sidenote-layout.js';
import 'katex/dist/katex.min.css';
import 'markdown-it-texmath/css/texmath.css';
import './nvim-preview.js';
        // ── DOM refs ──────────────────────────────────────────────────
        const $ = (id) => document.getElementById(id);
        const contentEl = $('content');
        observeSidenotes(contentEl);
        const loadingSkeleton = $('loadingSkeleton');

        // Overlay refs
        const overlay = $('overlay');
        const overlayPanzoom = $('overlay-panzoom');
        const overlayPanzoomInner = $('overlay-panzoom-inner');
        const ovExport = $('ovExport');
        const ovClose = $('ovClose');

        // ── State ─────────────────────────────────────────────────────
        const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
        let currentTheme = document.documentElement.dataset.theme || 'dark';
        let overlaySource = null;
        let overlayFilename = 'image';
        let overlayPanzoomInstance = null;

        // Images and rendered diagrams open here the same way: the clicked
        // element is cloned into the viewer, so it shows exactly what the page
        // shows and exporting never has to guess between a URL and SVG source.
        function openOverlay({ node, filename }) {
            const target = node.cloneNode(true);
            target.removeAttribute('id');
            overlayPanzoomInner.replaceChildren(target);
            overlayFilename = filename || target.getAttribute('alt') || 'image';
            overlaySource = target instanceof SVGElement
                ? { type: 'svg', value: new XMLSerializer().serializeToString(target) }
                : { type: 'image', value: target.currentSrc || target.src || '' };
            if (!overlay.open) overlay.showModal();
            overlayPanzoomInstance = Panzoom(target, {
                canvas: true, pinchAndPan: true, minScale: 0.1, maxScale: 8,
            });
        }

        overlay.addEventListener('close', () => {
            if (overlayPanzoomInstance) overlayPanzoomInstance.destroy();
            overlayPanzoomInstance = null;
            overlayPanzoomInner.replaceChildren();
            overlaySource = null;
        });
        overlayPanzoom.addEventListener('wheel', event => {
            if (!overlayPanzoomInstance) return;
            event.preventDefault();
            if (event.ctrlKey) return overlayPanzoomInstance.zoomWithWheel(event);
            const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? overlayPanzoom.clientHeight : 1;
            const scale = overlayPanzoomInstance.getScale();
            const pan = overlayPanzoomInstance.getPan();
            overlayPanzoomInstance.pan(pan.x - event.deltaX * unit / scale, pan.y - event.deltaY * unit / scale);
        }, { passive: false });
        ovClose.addEventListener('click', () => overlay.close());
        ovExport.addEventListener('click', () => {
            if (!overlaySource) return;
            const anchor = document.createElement('a');
            if (overlaySource.type === 'svg') {
                anchor.href = URL.createObjectURL(new Blob([overlaySource.value], { type: 'image/svg+xml' }));
                setTimeout(() => URL.revokeObjectURL(anchor.href), 2000);
            } else {
                anchor.href = overlaySource.value;
            }
            anchor.download = overlayFilename;
            anchor.click();
        });
        // Clicking an image opens it in the viewer. Links and controls keep
        // their own behavior, and a drag-selected image is not treated as a click.
        contentEl.addEventListener('click', event => {
            if (event.target.closest('a, button, input, select, textarea, summary, .heading-summary')) return;
            if (window.getSelection()?.toString()) return;
            const image = event.target.closest('img');
            if (image?.src) {
                openOverlay({ node: image, filename: image.alt || image.src.split('/').pop() || 'image' });
            }
        });

        function showContent() {
            if (loadingSkeleton) loadingSkeleton.style.display = 'none';
            contentEl.style.display = '';
        }

        // ── Theme ─────────────────────────────────────────────────────
        function applyTheme(theme) {
            currentTheme = theme;
            document.documentElement.setAttribute('data-theme', theme);
        }

        systemThemeQuery.addEventListener('change', (event) => {
            applyTheme(event.matches ? 'dark' : 'light');
        });

        function sanitizeRenderedHtml(html) {
            return DOMPurify.sanitize(html, {
                // Preserve common layout HTML and images, KaTeX MathML, and
                // raw SVG used in Markdown, including SVG filter effects.
                USE_PROFILES: {
                    html: true,
                    svg: true,
                    svgFilters: true,
                    mathMl: true,
                },
                ALLOW_DATA_ATTR: true,
            });
        }

        // Restore section state before morphdom replaces the rendered content.
        function captureHeadingStates(root) {
            const states = new Map();
            root.querySelectorAll('section.heading-section[data-heading-key]').forEach(section => {
                states.set(section.dataset.headingKey, section.classList.contains('is-collapsed'));
            });
            return states;
        }

        function buildContent(html, transform) {
            const next = document.createElement('main');
            next.id = 'content';
            next.innerHTML = sanitizeRenderedHtml(html);
            if (transform) transform(next);
            const states = captureHeadingStates(contentEl);
            next.querySelectorAll('section.heading-section[data-heading-key]').forEach(section => {
                const collapsed = states.get(section.dataset.headingKey) === true;
                section.classList.toggle('is-collapsed', collapsed);
                section.querySelector(':scope > .heading-summary')
                    ?.setAttribute('aria-expanded', String(!collapsed));
            });
            return next;
        }

        function updateContent(html, transform) {
            const next = buildContent(html, transform);
            showContent();
            morphdom(contentEl, next, {
                    childrenOnly: false,
                    getNodeKey(node) {
                        if (node.nodeType !== 1) return null;
                        if (node.matches?.('section.heading-section')) {
                            return `heading:${node.dataset.headingKey}`;
                        }
                        return node.id || null;
                    },
                    onBeforeElUpdated(fromEl, toEl) {
                        if (fromEl.tagName === 'DETAILS' && fromEl.hasAttribute('open')) {
                            toEl.setAttribute('open', '');
                        }
                        return true;
                    },
            });
            window.dispatchEvent(new CustomEvent('markdown-preview-content-updated', {
                detail: { contentElement: contentEl },
            }));
            return contentEl;
        }

        // ── Public renderer API ───────────────────────────────────────
        const core = {
            contentElement: contentEl,
            updateContent,
            async render(html) {
                return updateContent(html);
            },
            setTheme: applyTheme,
            showContent,
        };

        // Initialize renderer-only features. Host integrations, including the
        // Neovim live-preview protocol, attach through the ready event below.
        applyTheme(currentTheme);
        window.markdownPreviewCore = core;
        window.dispatchEvent(new CustomEvent('markdown-preview-ready', { detail: core }));
