import { createClient } from "../shared/preview-client.js";

(() => {
  const client = createClient();
  const endpoint = client.url;
  const pages = document.getElementById("pages");
  const colorScheme = matchMedia("(prefers-color-scheme: dark)");
  const views = new Map();
  const visible = new Set();
  const loaded = new Set();
  const svgCache = new Map();
  const pendingSvg = new Map();
  const svgCacheLimit = 16;
  let state = { document: "", version: -1 };
  const baseWidth = Math.max(16, Math.min(900, innerWidth - 40));
  let zoom = 100;
  let pendingCursor;
  let refreshing = false;
  let dirty = false;
  let retryTimer;
  let ended = false;
  let themeKey = "";

  function send(event, payload) {
    return client.send(event, { document: state.document, version: state.version, ...payload });
  }

  async function reportTheme() {
    if (!state.document) return;
    const theme = colorScheme.matches ? "dark" : "light";
    const key = `${state.document}:${theme}`;
    if (key === themeKey) return;
    const response = await send("theme-change", { theme });
    if (response.ok) themeKey = key;
  }
  colorScheme.addEventListener("change", () => reportTheme().catch(console.error));

  function setZoom(value) {
    zoom = Math.max(10, Math.min(500, Math.round(value)));
    pages.style.setProperty("--page-width", `${baseWidth * zoom / 100}px`);
  }
  setZoom(zoom);

  function pageNear(y) {
    let nearest;
    let distance = Infinity;
    for (const el of pages.children) {
      const rect = el.getBoundingClientRect();
      const next = Math.max(rect.top - y, y - rect.bottom, 0);
      if (next < distance) { nearest = el; distance = next; }
    }
    return nearest;
  }

  function position(x = innerWidth / 2, y = innerHeight / 2) {
    const el = pageNear(y);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    return { page: Number(el.dataset.page), x: (x - rect.left) / rect.width,
      y: (y - rect.top) / rect.height, zoom };
  }

  function restore(saved, x = innerWidth / 2, y = innerHeight / 2) {
    if (!saved || !pages.children.length) return;
    const el = pages.children[Math.min(saved.page, pages.children.length) - 1];
    const rect = el.getBoundingClientRect();
    scrollBy({ left: rect.left + saved.x * rect.width - x,
      top: rect.top + saved.y * rect.height - y, behavior: "instant" });
  }

  // Capture pinch over the whole viewport, including the background below
  // short/shrunken documents, so it cannot fall back to browser viewport zoom.
  document.addEventListener("wheel", event => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const saved = position(event.clientX, event.clientY);
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
    setZoom(zoom * Math.exp(-event.deltaY * unit * 0.01));
    restore(saved, event.clientX, event.clientY);
  }, { passive: false, capture: true });

  // Keep browser page zoom shortcuts inside the SVG preview as well.
  document.addEventListener("keydown", event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key;
    const direction = key === "+" || key === "=" || key === "Add" ? 1
      : key === "-" || key === "_" || key === "Subtract" ? -1 : 0;
    const reset = key === "0" || key === "Numpad0";
    if (!direction && !reset) return;
    event.preventDefault();
    event.stopPropagation();
    const saved = position();
    setZoom(reset ? 100 : zoom * (direction > 0 ? 1.1 : 1 / 1.1));
    restore(saved);
  }, { capture: true });

  async function pageSvg(src) {
    if (svgCache.has(src)) {
      const svg = svgCache.get(src);
      svgCache.delete(src);
      svgCache.set(src, svg);
      return svg;
    }
    if (pendingSvg.has(src)) return pendingSvg.get(src);
    const request = (async () => {
      const response = await client.fetch(src, { cache: "no-store" });
      if (!response.ok) throw Object.assign(new Error(`Preview: HTTP ${response.status}`), { status: response.status });
      const svg = await response.text();
      if (pendingSvg.get(src) === request) {
        svgCache.set(src, svg);
        if (svgCache.size > svgCacheLimit) svgCache.delete(svgCache.keys().next().value);
      }
      return svg;
    })();
    pendingSvg.set(src, request);
    try { return await request; }
    finally { if (pendingSvg.get(src) === request) pendingSvg.delete(src); }
  }

  async function loadPage(el) {
    const src = el.dataset.src;
    const content = el.firstElementChild;
    if (content.dataset.src === src || content.dataset.loadingSrc === src) return;
    content.dataset.loadingSrc = src;
    try {
      const svg = await pageSvg(src);
      if (!el.isConnected || el.dataset.src !== src || !loaded.has(el)) return;
      content.innerHTML = svg;
      content.dataset.src = src;
    } catch (error) {
      console.error(error);
      if (el.isConnected && el.dataset.src === src) refresh();
    } finally {
      if (content.dataset.loadingSrc === src) delete content.dataset.loadingSrc;
    }
  }

  function updateWindow() {
    if (!visible.size) return;
    const numbers = [...visible].map(el => Number(el.dataset.page));
    const first = Math.max(1, Math.min(...numbers) - 3);
    const last = Math.min(pages.children.length, Math.max(...numbers) + 3);
    for (const el of loaded) {
      if (Number(el.dataset.page) >= first && Number(el.dataset.page) <= last) continue;
      el.firstElementChild.replaceChildren();
      delete el.firstElementChild.dataset.src;
      delete el.firstElementChild.dataset.loadingSrc;
      loaded.delete(el);
    }
    for (let page = first; page <= last; page++) {
      const el = pages.children[page - 1];
      loaded.add(el);
      loadPage(el);
    }
  }

  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.target.isConnected) continue;
      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    }
    updateWindow();
  });

  function render(next) {
    const switched = next.document !== state.document;
    const changed = switched || next.version !== state.version;
    const saved = position();
    if (saved) views.set(state.document, saved);
    state = next;
    document.title = next.title;
    if (!changed) return;
    const view = switched ? views.get(next.document) : saved || views.get(next.document);
    if (switched) {
      zoom = view?.zoom ?? 100;
    }
    observer.takeRecords();
    observer.disconnect();
    visible.clear();
    loaded.clear();
    svgCache.clear();
    pendingSvg.clear();
    const old = switched ? [] : [...pages.children];
    const elements = [];
    for (let index = 0; index < next.count; index++) {
      const el = old[index] || document.createElement("div");
      el.className = "page";
      el.dataset.page = String(index + 1);
      const size = next.sizes[index];
      el.style.aspectRatio = `${size.width} / ${size.height}`;
      let content = el.firstElementChild;
      if (!content) {
        content = document.createElement("div");
        content.className = "page-content";
        el.append(content);
      }
      const src = endpoint(`/__live/asset?p=${encodeURIComponent(next.files[index])}`);
      if (content.dataset.src && content.dataset.src !== src) {
        content.replaceChildren();
        delete content.dataset.src;
      }
      if (content.dataset.loadingSrc && content.dataset.loadingSrc !== src) delete content.dataset.loadingSrc;
      el.dataset.src = src;
      elements.push(el);
    }
    pages.replaceChildren(...elements);
    if (!next.count) {
      const problem = next.diagnostics?.find(item => item.severity === "error") || next.diagnostics?.[0];
      pages.textContent = problem?.message
        ? `Typst preview failed: ${problem.message}`
        : next.document ? "Waiting for Typst SVG…" : "No active Typst document";
    }
    setZoom(zoom);
    if (view) restore(view);
    else if (switched) scrollTo({ top: 0, left: 0, behavior: "instant" });
    elements.forEach(el => observer.observe(el));
    if (!view && next.cursor?.page) applyCursor({ ...next.cursor,
      document: next.document, version: next.version,
      line: next.cursor_line });
  }

  function applyCursor(value) {
    if (value.document !== state.document || value.version !== state.version) return;
    if (!value.page) return;
    const el = pages.children[value.page - 1];
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const top = rect.top + scrollY + value.y * rect.height;
    const margin = Math.min(120, innerHeight * 0.18);
    if (top < scrollY + margin) scrollTo({ top: Math.max(0, top - margin), behavior: "smooth" });
    else if (top > scrollY + innerHeight - margin) scrollTo({ top: top - innerHeight + margin, behavior: "smooth" });
  }

  async function refresh() {
    if (ended) return;
    dirty = true;
    if (refreshing) return;
    refreshing = true;
    clearTimeout(retryTimer);
    try {
      while (dirty && !ended) {
        dirty = false;
        const next = await client.get("/state");
        if (dirty || ended) continue;
        render(next);
        if (pendingCursor) { applyCursor(pendingCursor); pendingCursor = undefined; }
        reportTheme().catch(console.error);
      }
    } catch (error) {
      console.error(error);
      if (error.status === 403) {
        ended = true;
        pages.textContent = "Preview session expired. Run TypstPreview again.";
        return;
      }
      if (!ended) retryTimer = setTimeout(refresh, 1000);
    } finally {
      refreshing = false;
    }
  }

  pages.addEventListener("click", event => {
    const page = event.target.closest(".page");
    if (!page) return;
    const selection = globalThis.getSelection?.();
    if (selection && !selection.isCollapsed) return;
    const link = event.target.closest("a[data-typst-page]");
    if (link) {
      event.preventDefault();
      event.stopPropagation();
      const targetPage = Number(link.dataset.typstPage);
      const size = state.sizes[targetPage - 1];
      if (size) restore({ page: targetPage, x: Number(link.dataset.typstX) / size.width,
        y: Number(link.dataset.typstY) / size.height });
      return;
    }
    if (event.target.closest("a[href], a[xlink\\:href]")) return;
    const rect = page.getBoundingClientRect();
    const ripple = document.createElement("span");
    ripple.className = "page-ripple";
    ripple.style.left = `${event.clientX - rect.left}px`;
    ripple.style.top = `${event.clientY - rect.top}px`;
    page.append(ripple);
    setTimeout(() => ripple.remove(), 240);
    send("source-jump", { page: Number(page.dataset.page),
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }).catch(console.error);
  });

  client.connect({
    events: {
      refresh,
      cursor(value) {
        if (refreshing) pendingCursor = value;
        else applyCursor(value);
      },
    },
    closeEvent: "typst-watch-close",
    onClose() {
      ended = true;
      clearTimeout(retryTimer);
      observer.disconnect();
      window.close();
      const status = document.createElement("div");
      status.className = "preview-ended";
      status.setAttribute("role", "status");
      status.textContent = "Preview ended. You can close this tab.";
      document.body.append(status);
    },
    onOpen: refresh,
    onError() {
      if (!ended && !pages.children.length) pages.textContent = "Neovim disconnected. Reconnecting…";
    },
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
})();
