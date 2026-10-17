import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TreeView } from '@primer/react';
import { buildSymbolTree, symbolBranch, type SymbolTreeNode } from './symbol-tree';
import { isPlainTreeActivation } from './file-tree.mjs';
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

export function SymbolLevelIcon({ level }: { level?: number }) {
  return <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-[11px] leading-none font-semibold tracking-[-.04em] text-muted" aria-hidden="true">H{Math.max(1, Number(level) || 1)}</span>;
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
  if (document.type === 'text') return (document.outline || []).map((item, index) => ({
    ...item, id: `code-symbol-${index}`,
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
  const scrollRef = useRef<HTMLElement>(null);
  const currentSymbol = activeSymbolId(symbols, status);
  const nodes = useMemo(() => buildSymbolTree(symbols), [symbols]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => setExpanded({}), [symbols]);
  useEffect(() => {
    if (!currentSymbol) return;
    const branch = symbolBranch(nodes, currentSymbol);
    if (branch.length) setExpanded(previous => ({ ...previous, ...Object.fromEntries(branch.map(id => [id, true])) }));
  }, [nodes, currentSymbol]);
  useLayoutEffect(() => {
    if (hidden || !visible || !currentSymbol) return;
    const panel = scrollRef.current;
    revealSymbolVertically(panel, panel?.querySelector('[aria-current="true"]'));
  }, [currentSymbol, hidden, visible, expanded]);

  function renderNode({ symbol, children }: SymbolTreeNode) {
    const isExpanded = expanded[symbol.id] ?? false;
    return <TreeView.Item key={symbol.id} id={`outline-tree-${symbol.id}`} className="file-tree-item"
      current={symbol.id === currentSymbol} expanded={children.length ? isExpanded : undefined}
      onExpandedChange={value => setExpanded(previous => ({ ...previous, [symbol.id]: value }))}
      onSelect={event => {
        if (!isPlainTreeActivation(event)) return;
        event.preventDefault();
        if (children.length && !isExpanded) {
          setExpanded(previous => ({ ...previous, [symbol.id]: true }));
          return;
        }
        if (!symbol.group) onSelect(symbol);
      }}>
      <TreeView.LeadingVisual><SymbolLevelIcon level={symbol.level} /></TreeView.LeadingVisual>
      <span className="file-tree-link symbol-tree-label">{symbol.name}</span>
      {children.length > 0 && <TreeView.SubTree>{children.map(renderNode)}</TreeView.SubTree>}
    </TreeView.Item>;
  }

  return <div className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden" hidden={hidden}>
    <nav ref={scrollRef} className="sidebar-scroll pt-sidebar-top" aria-label="Document symbols">
      {symbols.length ? <div className="file-tree-view symbol-tree"><TreeView aria-label="Symbol hierarchy">
        {nodes.map(renderNode)}
      </TreeView></div> : <div className="sidebar-empty">No symbols found</div>}
    </nav>
  </div>;
}
