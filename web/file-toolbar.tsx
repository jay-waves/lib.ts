import { useEffect, useState, type ReactNode, type Ref } from 'react';
import { IconButton } from '@primer/react';
import { MoveToTopIcon } from '@primer/octicons-react';

export function useToolbarStuck(enabled = true) {
  const [sentinel, sentinelRef] = useState<HTMLDivElement | null>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    setStuck(false);
    const panel = sentinel?.closest('.main-panel');
    if (!enabled || !sentinel || !panel) return;
    const observer = new IntersectionObserver(([entry]) => {
      setStuck(Boolean(entry.rootBounds && entry.boundingClientRect.bottom <= entry.rootBounds.top));
    }, { root: panel, threshold: [0, 1] });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, enabled]);
  return { stuck, sentinelRef };
}

export function MoveToTopButton({ onClick }: { onClick?: () => void }) {
  return <IconButton unsafeDisableTooltip size="small" variant="invisible" className="[&_svg]:size-4"
    icon={MoveToTopIcon} aria-label="Back to top" onClick={event => {
      if (onClick) onClick();
      else event.currentTarget.closest('.main-panel')?.scrollTo({ top: 0, behavior: 'smooth' });
    }} />;
}

interface FileToolbarProps {
  children: ReactNode;
  className?: string;
  sentinelRef?: Ref<HTMLDivElement>;
}

/** Shared sticky surface for document and directory controls. */
export function FileToolbar({ children, className = '', sentinelRef }: FileToolbarProps) {
  return <>
    {sentinelRef && <div className="pointer-events-none h-px flex-none -mb-px" ref={sentinelRef} aria-hidden="true" />}
    <div className={`file-toolbar ui-toolbar flex-none ${className}`}>
      {children}
    </div>
  </>;
}
