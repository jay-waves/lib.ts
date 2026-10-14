# PDF Worker comparison

File: 《Real-Time Rendering 3rd》 提炼总结.pdf (100.10 MiB), 252 pages.
Node v24.21.0; win32/x64; width 1800; WebP quality 92; 3 isolated process trials; 2 warm rounds per selected page.
Selected pages: 1, 51, 101, 152, 202, 252. Outline entries: EmbedPDF 288, MuPDF 288.

| Engine | Cold open ms | First page ms | Warm page median ms | Sampled RSS increase MiB | CPU ms | Close ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| embedpdf | 334.9 | 181.4 | 216.0 | 436.9 | 4704.0 | 8.6 |
| mupdf | 213.3 | 184.0 | 200.0 | 371.0 | 4156.0 | 4.2 |

Checks: {"pageCountEqual":true,"geometryEqual":true,"outlineEqual":true,"outputDimensionsEqual":true}.

Cold open includes worker startup, module/WASM initialization, file reading, page geometry, and outlines. It does not flush the OS file cache.
This compares the current complete adapters: EmbedPDF reads outlines using an additional temporary PDF in the same runtime; MuPDF has a built-in outline API. This contributes to the open-time difference.
Render timings include revision stat, rasterization, Sharp WebP encoding, and worker transfer. The service image cache is bypassed.
RSS is sampled every 5ms in an isolated child process. Reported increase includes worker, WASM, native allocations, and output buffers; it is not exact peak memory or WASM heap size.
Warm values are medians across pages and rounds within a trial, then medians across trials. CPU includes open and all render rounds; close and image inspection are excluded.
Images are from the last trial. Equal dimensions/metadata do not establish equal visual quality. Inspect comparison.html. One book is not a general performance corpus.
