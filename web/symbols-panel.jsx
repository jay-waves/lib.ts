import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActionList } from '@primer/react';
import { SearchInput } from './search-input.jsx';
import { activeSymbolId, revealSymbolVertically } from './active-symbol.mjs';
import styles from './symbols-panel.module.css';

export function documentSymbols(document) {
  if (document.type === 'pdf') return (document.outline || []).map((item, index) => ({
    id: `pdf-symbol-${index}`, name: item.name, level: item.level, page: item.page, y: item.y,
    group: !Number.isInteger(item.page),
  }));
  if (document.type === 'typst') return (document.outline || []).map((heading, index) => ({
    id: `typst-symbol-${index}`, name: heading.name, level: heading.level, line: heading.line, position: heading.position,
  }));
  if (document.type !== 'markdown') return [];
  const dom = new DOMParser().parseFromString(document.html, 'text/html');
  return [...dom.querySelectorAll(':is(h1,h2,h3,h4,h5,h6)[data-source-line]')]
    .filter(heading => heading.id).map(heading => ({
      id: heading.id, name: heading.textContent.trim(), level: Number(heading.tagName.slice(1)),
      line: Number(heading.dataset.sourceLine) + 1,
    }));
}


export function SymbolsPanel({ symbols, status, onSelect, hidden, visible }) {
  const [symbolSearch, setSymbolSearch] = useState('');
  const scrollRef = useRef(null);
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

  return <div className={styles.panel} hidden={hidden}>
    <div className={styles.filter}>
      <SearchInput size="small" block onClear={() => setSymbolSearch('')} aria-label="Search symbols" placeholder="Search symbols…"
        value={symbolSearch} onChange={event => setSymbolSearch(event.target.value)} />
    </div>
    <nav ref={scrollRef} className={styles.list} aria-label="Document symbols">
      {filteredSymbols.length ? <ActionList variant="full">
        {filteredSymbols.map(symbol => <ActionList.Item className={styles.item} key={symbol.id} disabled={symbol.group}
          active={symbol.id === currentSymbol} aria-current={symbol.id === currentSymbol ? 'location' : undefined}
          style={{ marginInlineStart: `${Math.max(0, (symbol.level || 1) - 1) * 20}px` }}
          onSelect={() => onSelect(symbol)}><span className={styles.name}>{symbol.name}</span></ActionList.Item>)}
      </ActionList> : <div className="tree-empty">{symbols.length ? 'No matching symbols' : 'No symbols found'}</div>}
    </nav>
  </div>;
}
