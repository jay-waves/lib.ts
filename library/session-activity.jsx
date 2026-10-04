import React, { createContext, useEffect, useState } from 'react';
export const SessionActivity = createContext(true);

export function BrowserSession({ children }) {
  const [active, setActive] = useState(() => !document.hidden);
  useEffect(() => {
    const update = () => setActive(!document.hidden);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('pageshow', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('pageshow', update);
    };
  }, []);
  return <SessionActivity.Provider value={active}>{children}</SessionActivity.Provider>;
}
