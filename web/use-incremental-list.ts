import { useCallback, useEffect, useRef, useState } from 'react';

// Bound the first render without adding a virtual-list dependency. A visible
// sentinel fills the viewport and loads another batch as the user scrolls.
export function useIncrementalList(length: number, minimum = 0) {
  const [count, setCount] = useState(256);
  const shown = Math.max(count, minimum);
  const marker = useRef<HTMLSpanElement>(null);
  const more = useCallback(() => setCount(value => Math.max(value, minimum) + 256), [minimum]);
  const hasMore = shown < length;
  useEffect(() => {
    const target = marker.current;
    if (!target || !hasMore) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) more();
    }, { root: target.closest('.sidebar-scroll, .main-panel'), rootMargin: '600px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, shown, more]);
  return { shown, marker, hasMore, more };
}
