import type { ReactNode, Ref } from 'react';

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
