import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActionList } from '@primer/react';
import { SearchInput } from './search-input.tsx';
import { activeSymbolId, revealSymbolVertically } from './active-symbol.mjs';

interface OutlineItem {
  name: string;
  level?: number;
  line?: number;
  page?: number;
  y?: number;
  position?: { page: number; x: number; y: number } | null;
}

export interface DocumentSymbol extends OutlineItem {
  id: string;
  group?: boolean;
}

interface SymbolsPanelProps {
  symbols: DocumentSymbol[];
  status: { symbolId?: string | null; line?: number | null; page?: number | null };
  onSelect(symbol: DocumentSymbol): void;
  hidden: boolean;
  visible: boolean;
}

export function documentSymbols(document: { type: string; html?: string; outline?: OutlineItem[] }): DocumentSymbol[] {
  if (document.type === 'pdf') return (document.outline || []).map((item, index) => ({
    id: `pdf-symbol-${index}`, name: item.name, level: item.level, page: item.page, y: item.y,
    group: !Number.isInteger(item.page),
  }));
  if (document.type === 'typst') return (document.outline || []).map((heading, index) => ({
    id: `typst-symbol-${index}`, name: heading.name, level: heading.level, line: heading.line, position: heading.position,
  }));
  if (document.type !== 'markdown') return [];
  const dom = new DOMParser().parseFromString(document.html ?? '', 'text/html');
  return [...dom.querySelectorAll<HTMLElement>(':is(h1,h2,h3,h4,h5,h6)[data-source-line]')]
    .filter(heading => heading.id).map(heading => ({
      id: heading.id, name: heading.textContent.trim(), level: Number(heading.tagName.slice(1)),
      line: Number(heading.dataset.sourceLine) + 1,
    }));
}
export function SymbolsPanel({ symbols, status, onSelect, hidden, visible }: SymbolsPanelProps) {
  const [symbolSearch, setSymbolSearch] = useState('');
  const scrollRef = useRef<HTMLElement>(null);
  const filteredSymbols = useMemo(() => {
    const term = symbolSearch.trim().toLocaleLowerCase();
    return term ? symbols.filter(symbol => symbol.name.toLocaleLowerCase().includes(term)) : symbols;
  }, [symbols, symbolSearch]);
  const currentSymbol = activeSymbolId(symbols, status);
  useLayoutEffect(() => {
    if (hidden || !visible || !currentSymbol) return;
    const panel = scrollRef.current;
    revealSymbolVertically(panel, panel?.querySelector('[aria-current="location"]'));
  }, [currentSymbol, hidden, visible, symbolSearch]);

  return <div className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden" hidden={hidden}>
    <div className="sidebar-search">
      <SearchInput size="small" block onClear={() => setSymbolSearch('')} aria-label="Search symbols" placeholder="Search symbols…"
        value={symbolSearch} onChange={event => setSymbolSearch(event.target.value)} />
    </div>
    <nav ref={scrollRef} className="sidebar-scroll" aria-label="Document symbols">
      {filteredSymbols.length ? <ActionList variant="full">
        {filteredSymbols.map(symbol => <ActionList.Item className="sidebar-list-item group" key={symbol.id} disabled={symbol.group}
          active={symbol.id === currentSymbol} aria-current={symbol.id === currentSymbol ? 'location' : undefined}
          onSelect={() => onSelect(symbol)}><span className="block min-w-0 box-border truncate text-ui font-normal text-fg group-aria-[current=page]:font-semibold group-aria-[current=location]:font-semibold" style={{ paddingInlineStart: `${Math.max(0, (symbol.level || 1) - 1) * 20}px` }}>{symbol.name}</span></ActionList.Item>)}
      </ActionList> : <div className="sidebar-empty">{symbols.length ? 'No matching symbols' : 'No symbols found'}</div>}
    </nav>
  </div>;
}
