import type { DocumentSymbol } from './symbols-panel';

export interface SymbolTreeNode {
  symbol: DocumentSymbol;
  children: SymbolTreeNode[];
}

export function buildSymbolTree(symbols: readonly DocumentSymbol[]): SymbolTreeNode[] {
  const roots: SymbolTreeNode[] = [];
  const parents: { level: number; node: SymbolTreeNode }[] = [];
  for (const symbol of symbols) {
    const level = Math.max(1, Number(symbol.level) || 1);
    while (parents.length && parents.at(-1)!.level >= level) parents.pop();
    const node: SymbolTreeNode = { symbol, children: [] };
    (parents.at(-1)?.node.children ?? roots).push(node);
    parents.push({ level, node });
  }
  return roots;
}

function symbolSubtree(node: SymbolTreeNode): string[] {
  return [node.symbol.id, ...node.children.flatMap(symbolSubtree)];
}

/** Return the path to a symbol plus every symbol nested beneath it. */
export function symbolBranch(nodes: readonly SymbolTreeNode[], id: string): string[] {
  for (const node of nodes) {
    if (node.symbol.id === id) return symbolSubtree(node);
    const nested = symbolBranch(node.children, id);
    if (nested.length) return [node.symbol.id, ...nested];
  }
  return [];
}
