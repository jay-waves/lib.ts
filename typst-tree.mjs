import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Language, Parser } from 'web-tree-sitter';

let parserPromise;

async function typstParser() {
  if (!parserPromise) parserPromise = (async () => {
    await Parser.init();
    const grammar = readFileSync(fileURLToPath(import.meta.resolve('@lumis-sh/wasm-typst/tree-sitter-typst.wasm')));
    const parser = new Parser();
    parser.setLanguage(await Language.load(grammar));
    return parser;
  })();
  return parserPromise;
}

function blockKind(node) {
  if (node.type === 'section' || node.type === 'heading') return 'heading';
  if (node.type === 'math') return 'equation';
  if (node.type === 'code') {
    const call = node.namedChildren.find(child => child.type === 'call');
    if (call?.namedChildren[0]?.text === 'table') return 'table';
    return node.startPosition.row < node.endPosition.row ? 'code' : 'paragraph';
  }
  return 'paragraph';
}

export async function analyzeTypst(source) {
  const parser = await typstParser();
  const tree = parser.parse(source);
  const lines = source.split('\n');
  const headings = [];
  const blocks = [];
  const seen = new Set();

  function visit(container) {
    const children = container.namedChildren;
    for (let index = 0; index < children.length; index++) {
      const node = children[index];
      if (node.type === 'heading') {
        const marks = node.text.match(/^=+/)?.[0] || '';
        if (marks) headings.push({ level: marks.length,
          name: node.text.slice(marks.length).replace(/\s*<[\w-]+>\s*$/, '').trim(),
          line: node.startPosition.row + 1 });
      }
      if (node.type === 'parbreak' && children[index + 1]) {
        const next = children[index + 1];
        const line = next.startPosition.row + 1;
        const slot = node.endPosition.row;
        if (!seen.has(slot) && slot > 0 && slot < line && !lines[slot - 1]?.trim()) {
          blocks.push({ kind: blockKind(next), line, slot });
          seen.add(slot);
        }
      }
      if (node.type === 'section' || node.type === 'content') visit(node);
    }
  }
  visit(tree.rootNode);
  tree.delete();
  return { headings, blocks };
}

export function anchorBlocks(source, blocks, { headings = [], minLineGap = 0 } = {}) {
  const lines = source.split('\n');
  const positions = new Map();
  const headingLines = new Set(headings.map(heading => heading.line));
  const candidates = blocks.filter(block => !headingLines.has(block.line));
  let previousLine = 0;
  for (const { line, slot } of candidates) {
    if (slot < 1 || slot >= line || lines[slot - 1]?.trim()) continue;
    if (minLineGap && previousLine && line - previousLine < minLineGap
      && line !== candidates.at(-1)?.line) continue;
    const id = `preview-anchor-${line}`;
    positions.set(id, line);
    lines[slot - 1] = `#context metadata((id: "${id}", pos: here().position()))`;
    previousLine = line;
  }
  // Metadata inside the heading receives its laid-out position, including when
  // a heading starts a new page. Keep trailing labels attached to the heading.
  for (const { line } of headings) {
    const id = `preview-heading-${line}`;
    const text = lines[line - 1];
    if (!text?.match(/^\s*=+\s/)) continue;
    const label = text.match(/\s*<[\w-]+>\s*$/)?.[0] || '';
    lines[line - 1] = `${label ? text.slice(0, -label.length) : text} #context metadata((id: "${id}", pos: here().position()))${label}`;
    positions.set(id, line);
  }
  return { text: lines.join('\n'), positions };
}
