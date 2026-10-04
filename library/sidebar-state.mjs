const views = new Set(['files', 'bookmarks', 'search', 'symbols', 'git', 'repos']);
const storageKey = repository => `library-sidebar:${repository}`;

export function normalizeSidebarState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const state = {};
  if (views.has(value.sidebarTab)) state.sidebarTab = value.sidebarTab;
  for (const key of ['filesVisible', 'bookmarksOnly', 'recentOnly', 'fileSearchCollapsed']) {
    if (typeof value[key] === 'boolean') state[key] = value[key];
  }
  if (Number.isFinite(value.sidebarWidth) && value.sidebarWidth >= 180 && value.sidebarWidth <= 480)
    state.sidebarWidth = value.sidebarWidth;
  if (['name', 'modified'].includes(value.sortMode)) state.sortMode = value.sortMode;
  if (state.bookmarksOnly) state.sidebarTab = 'bookmarks';
  delete state.bookmarksOnly;
  return state;
}

export function readSidebarState(repository, storage = globalThis.localStorage) {
  try { return normalizeSidebarState(JSON.parse(storage.getItem(storageKey(repository)))); }
  catch { return {}; }
}

export function saveSidebarState(repository, value, storage = globalThis.localStorage) {
  try { storage.setItem(storageKey(repository), JSON.stringify(normalizeSidebarState(value))); }
  catch { /* Storage restrictions must not prevent using the sidebar. */ }
}
