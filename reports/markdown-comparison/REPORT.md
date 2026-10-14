# Markdown Worker comparison

Fresh isolated child per engine/run, actual production worker entry. No service cache. Cold includes worker startup/import/WASM and first small KaTeX render. Render time uses worker profile; round trip includes string transfer. RSS is whole child process, sampled every 5ms. Worker heap/external are unforced-GC snapshots; external includes WASM. Synthetic corpus; markdown-it retains sidenotes, Comrak uses native endnotes. HTML sizes differ. Browser layout not measured.

Node v24.21.0; win32/x64; Intel(R) Core(TM) Ultra 7 258V. Three fresh runs per engine; five warmups and fifteen measured renders per corpus.

| Engine | Cold ms | Peak RSS increase MiB | Final worker heap MiB | Final external MiB |
| --- | ---: | ---: | ---: | ---: |
| markdown-it | 93.52 | 187.94 | 51.24 | 3.34 |
| comrak | 93.46 | 278.71 | 42.50 | 85.62 |

| Corpus | Input KiB | markdown-it render / round trip ms | Comrak render / round trip ms |
| --- | ---: | ---: | ---: |
| prose | 32.4 | 4.45 / 5.33 | 20.97 / 21.90 |
| mixed | 27.2 | 7.85 / 8.78 | 22.56 / 23.17 |
| math | 8.3 | 9.62 / 11.31 | 15.46 / 17.22 |
| environments | 7.1 | 5.25 / 6.37 | 12.90 / 15.38 |

Reproduce: `node scripts/benchmark-markdown.mjs`
