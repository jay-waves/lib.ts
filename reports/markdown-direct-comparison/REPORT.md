# Markdown Worker comparison

Fresh isolated child per engine/run, actual production worker entry. No service cache. Cold includes worker startup/import/WASM and first small KaTeX render. Render time uses worker profile; round trip includes string transfer. RSS is whole child process, sampled every 5ms. Worker heap/external are unforced-GC snapshots; external includes WASM. Comrak uses direct HTML + parse5 + MathML; markdown-it retains folded sections, sidenotes and HTML+MathML formulas. Synthetic corpora; environment formulas now use explicit dollar delimiters. Feature/output differences mean this is an application comparison, not parser-core or isolated AST-speedup measurement. Browser layout not measured.

Node v24.21.0; win32/x64; Intel(R) Core(TM) Ultra 7 258V. Three fresh runs per engine; five warmups and fifteen measured renders per corpus.

| Engine | Cold ms | Peak RSS increase MiB | Final worker heap MiB | Final external MiB |
| --- | ---: | ---: | ---: | ---: |
| markdown-it | 90.31 | 187.33 | 51.52 | 3.34 |
| comrak | 100.11 | 121.29 | 41.77 | 11.28 |

| Corpus | Input KiB | markdown-it render / round trip ms | Comrak render / round trip ms |
| --- | ---: | ---: | ---: |
| prose | 32.4 | 4.27 / 5.09 | 10.50 / 11.66 |
| mixed | 27.2 | 7.29 / 8.44 | 12.76 / 14.11 |
| math | 8.3 | 8.72 / 10.42 | 5.75 / 6.26 |
| environments | 7.7 | 5.51 / 6.31 | 5.09 / 5.47 |

Reproduce: `node scripts/benchmark-markdown.mjs`
