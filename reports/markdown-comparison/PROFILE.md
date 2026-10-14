# Comrak pipeline profile

Three fresh workers, five warmups, 21 measurements per mode, median of per-worker medians. Same synthetic corpora as worker comparison. Stage AST transform includes KaTeX; render/import includes highlighting, so substage times must not be summed twice. Direct Rust path has no custom sections, highlighting or KaTeX. Environment normalization excluded from microbench modes, included in production. Placeholder experiment compares equivalent HTML with precomputed KaTeX, no custom render hooks; outputs asserted identical. JSON byte counts are size proxies, not a claim that the binding uses JSON. Microbench stage medians need not add up to totals; GC and JIT affect runs. MathML-only timings do not measure browser layout or visual compatibility.

| Corpus | Environment prep | Parse/export | AST changes (KaTeX) | Import/render (hljs) | HTML postprocess | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| prose | 0.01 | 12.67 | 1.09 (0.00) | 16.36 (0.00) | 0.81 | 31.75 |
| mixed | 0.01 | 16.29 | 4.99 (3.74) | 22.19 (3.38) | 2.39 | 47.31 |
| math | 0.01 | 1.66 | 13.41 (13.15) | 14.95 (0.00) | 4.63 | 35.76 |
| environments | 3.20 | 1.37 | 9.19 (9.05) | 23.07 (0.00) | 0.70 | 37.91 |

| Corpus | Direct HTML | Parse/export | Import/render unchanged | Parse + import/render | Import expanded math | Import placeholder + insert |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| prose | 6.16 | 12.86 | 15.10 | 35.62 | 23.45 | 23.12 |
| mixed | 5.13 | 10.48 | 19.79 | 34.23 | 24.27 | 21.29 |
| math | 0.46 | 1.38 | 2.13 | 3.56 | 14.57 | 2.28 |
| environments | 0.41 | 0.82 | 1.82 | 3.30 | 9.42 | 1.19 |

| Corpus | Formulas | KaTeX default | KaTeX MathML only | Expanded AST KiB | Placeholder AST KiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| prose | 0 | 0.00 | 0.00 | 1465.83 | 1465.83 |
| mixed | 80 | 2.60 | 0.49 | 1281.78 | 1159.03 |
| math | 200 | 11.69 | 2.22 | 717.14 | 206.95 |
| environments | 100 | 7.61 | 2.22 | 423.77 | 106.18 |

All times in ms. Reproduce: `node scripts/profile-markdown.mjs`.
