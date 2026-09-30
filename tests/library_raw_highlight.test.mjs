import test from 'node:test';
import assert from 'node:assert/strict';
import { highlightRaw, rawLanguage } from '../library/raw-highlight.mjs';

test('library Raw selects a grammar for source file extensions', () => {
  const names = {
    'references.bib': 'bibtex', 'script.py': 'py', 'main.go': 'go', 'main.c': 'c',
    'main.cpp': 'cpp', 'run.sh': 'sh', 'profile.pwsh': 'powershell', 'init.lua': 'lua',
  };
  for (const [name, language] of Object.entries(names)) assert.equal(rawLanguage(name), language);
});

test('BibTeX and PowerShell Raw output contains highlighted tokens', () => {
  const bib = highlightRaw('@article{key, title = {A Book}, year = 2024}', 'references.bib');
  assert.match(bib, /hljs-keyword[^>]*>@article/);
  assert.match(bib, /hljs-attr[^>]*>title/);
  assert.match(bib, /hljs-string[^>]*>\{A Book\}/);
  assert.match(highlightRaw('Get-ChildItem', 'profile.pwsh'), /hljs-built_in/);
});
