import { Breadcrumbs } from '@primer/react';
import type { ReactNode } from 'react';

export interface PathBarItem {
  label: ReactNode;
  path?: string;
  href?: string;
}

export function PathBar({ items, onNavigate, disabled = false }: {
  items: readonly PathBarItem[];
  onNavigate(path: string): void;
  disabled?: boolean;
}) {
  return <div className="min-w-0 flex-1 text-ui [&_a]:text-ui! [&_button]:text-ui! [&_[aria-current=page]]:font-semibold [&_[aria-current=page]]:text-fg"
    inert={disabled}>
    <Breadcrumbs overflow="menu-with-root">
      {items.map((item, index) => {
        const selected = index === items.length - 1;
        const key = item.path ?? `${index}:${item.label}`;
        if (item.path === undefined) return <Breadcrumbs.Item key={key} as="span" selected={selected}>{item.label}</Breadcrumbs.Item>;
        const navigate = () => { if (!disabled) onNavigate(item.path!); };
        return item.href
          ? <Breadcrumbs.Item key={key} href={item.href} aria-label={item.path || undefined} selected={selected} onClick={event => {
            if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault(); navigate();
          }}>{item.label}</Breadcrumbs.Item>
          : <Breadcrumbs.Item key={key} as="button" type="button" aria-label={item.path} disabled={disabled} selected={selected}
            className="ui-focus cursor-pointer border-0 bg-transparent p-0 font-ui" onClick={navigate}>{item.label}</Breadcrumbs.Item>;
      })}
    </Breadcrumbs>
  </div>;
}
