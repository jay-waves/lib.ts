import React, { createContext, useSyncExternalStore } from 'react';
export const SessionActivity = createContext(true);
// Active means visible, including visible windows without keyboard focus.

const isVisible = () => !document.hidden;
const subscribe = notify => {
  const controller = new AbortController();
  document.addEventListener('visibilitychange', notify, { signal: controller.signal });
  window.addEventListener('pageshow', notify, { signal: controller.signal });
  return () => controller.abort();
};

export function BrowserSession({ children }) {
  const active = useSyncExternalStore(subscribe, isVisible);
  return <SessionActivity value={active}>{children}</SessionActivity>;
}
