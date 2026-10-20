import type { ReactNode } from 'react';

// Five shared silhouettes; keep the exact symbol kind in the tooltip.
const icons = {
  function: <path d="M9 2.5H7.5C6 2.5 6 4 6 5L5 11c-.2 1.5-.5 2.5-2 2.5H2M3 6.5h6m1 2 4 5m0-5-4 5" />,
  variable: <path d="M5.5 2.5H4v4L2.5 8 4 9.5v4h1.5m5-11H12v4L13.5 8 12 9.5v4h-1.5" />,
  class: <path d="m8 1.5 6 3.25v6.5L8 14.5l-6-3.25v-6.5L8 1.5Zm-6 3.25L8 8l6-3.25M8 8v6.5" />,
  type: <path d="M2.5 5V2.5h11V5M8 2.5v11m-2.5 0h5" />,
  module: <><rect x="2" y="2" width="4.5" height="4.5" rx=".5" /><rect x="9.5" y="2" width="4.5" height="4.5" rx=".5" /><rect x="2" y="9.5" width="4.5" height="4.5" rx=".5" /><rect x="9.5" y="9.5" width="4.5" height="4.5" rx=".5" /></>,
} satisfies Record<string, ReactNode>;

const groups: Record<string, keyof typeof icons> = {
  function: 'function', method: 'function', procedure: 'function', constructor: 'function' as const,
  variable: 'variable', parameter: 'variable', constant: 'variable', property: 'variable',
  field: 'variable', entry: 'variable', enum_member: 'variable',
  class: 'class', struct: 'class',
  type: 'type', typedef: 'type', interface: 'type', trait: 'type', enum: 'type',
  module: 'module', namespace: 'module',
};

export function CodeSymbolIcon({ kind }: { kind: string }) {
  const group = Object.hasOwn(groups, kind) ? groups[kind] : undefined;
  const label = kind.replaceAll('_', ' ');
  return <span className="inline-flex size-4 shrink-0 items-center justify-center" title={label.charAt(0).toUpperCase() + label.slice(1)}>
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {group ? icons[group] : <path d="m5.5 4-4 4 4 4m5-8 4 4-4 4" />}
    </svg>
  </span>;
}
