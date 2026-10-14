# PDF Worker comparison

File: High-Dimensional Probability -- Roman Vershynin.pdf (4.05 MiB), 299 pages.
Node v24.21.0; win32/x64; width 1800; WebP quality 92; 3 isolated process trials; 2 warm rounds per selected page.
Selected pages: 1, 61, 120, 180, 239, 299. Outline entries: EmbedPDF 107, MuPDF 107.

| Engine | Cold open ms | First page ms | Warm page median ms | Sampled RSS increase MiB | CPU ms | Close ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| embedpdf | 174.2 | 276.4 | 230.2 | 202.5 | 4594.0 | 4.9 |
| mupdf | 114.0 | 220.7 | 196.2 | 118.6 | 3952.0 | 4.5 |

Checks: {"pageCountEqual":true,"geometryEqual":true,"outlineEqual":true,"outputDimensionsEqual":true}.

Cold open includes worker startup, module/WASM initialization, file reading, page geometry, and outlines. It does not flush the OS file cache.
This compares the current complete adapters: EmbedPDF reads outlines using an additional temporary PDF in the same runtime; MuPDF has a built-in outline API. This contributes to the open-time difference.
Render timings include revision stat, rasterization, Sharp WebP encoding, and worker transfer. The service image cache is bypassed.
RSS is sampled every 5ms in an isolated child process. Reported increase includes worker, WASM, native allocations, and output buffers; it is not exact peak memory or WASM heap size.
Warm values are medians across pages and rounds within a trial, then medians across trials. CPU includes open and all render rounds; close and image inspection are excluded.
Images are from the last trial. Equal dimensions/metadata do not establish equal visual quality. Inspect comparison.html. One book is not a general performance corpus.
