# PDF Worker comparison

File: UnderstandingDeepLearning -- 20260902.pdf (64.42 MiB), 541 pages.
Node v24.21.0; win32/x64; width 1800; WebP quality 92; 3 isolated process trials; 2 warm rounds per selected page.
Selected pages: 1, 109, 217, 325, 433, 541. Outline entries: EmbedPDF 181, MuPDF 181.

| Engine | Cold open ms | First page ms | Warm page median ms | Sampled RSS increase MiB | CPU ms | Close ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| embedpdf | 795.2 | 175.0 | 206.4 | 316.8 | 4891.0 | 17.0 |
| mupdf | 394.0 | 188.3 | 167.7 | 303.2 | 3905.0 | 16.9 |

Checks: {"pageCountEqual":true,"geometryEqual":true,"outlineEqual":true,"outputDimensionsEqual":true}.

Cold open includes worker startup, module/WASM initialization, file reading, page geometry, and outlines. It does not flush the OS file cache.
The current EmbedPDF adapter opens a temporary second PDF to read outlines; MuPDF has a built-in outline API. This contributes to the open-time difference.
Render timings include revision stat, rasterization, Sharp WebP encoding, and worker transfer. The service image cache is bypassed.
RSS is sampled every 5ms in an isolated child process. Reported increase includes worker, WASM, native allocations, and output buffers; it is not exact peak memory or WASM heap size.
Warm values are medians across pages and rounds within a trial, then medians across trials. CPU includes open and all render rounds; close and image inspection are excluded.
Images are from the last trial. Equal dimensions/metadata do not establish equal visual quality. Inspect comparison.html. One book is not a general performance corpus.
