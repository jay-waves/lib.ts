# Worker infrastructure

The main thread owns HTTP responses, revision checks and bounded result caches.
Workers own CPU-heavy engines and their private mutable state.

- `worker-client.mjs`: lazy worker creation, request/reply IDs, structured errors,
  profiling events, termination and reference management. A transport factory
  permits Typst to use child-process IPC while Markdown/PDF use worker_threads.
- `worker-runtime.mjs`: bounded admission, serialization by default, idle shutdown,
  active-document retention, close state and optional crash replay.
- `worker-host.mjs`: serialized method dispatch, method allowlist, error metadata,
  optional profiling and transferable result buffers.
- `singleFlight(map, key, work)`: coalesces in-flight requests and removes both
  successes and failures. Result caching remains a separate service policy.

To add a format, implement a worker method table and pass it to `serveWorker`.
Create a client and runtime in its service, then wrap engine work in `runtime.run`.
Use `singleFlight` outside `run` so duplicates do not consume queue slots.
Call `runtime.assertOpen()` before serving cached results and `runtime.close()`
before clearing service caches.

`run(work, { touchIdle: false })` admits maintenance without resetting the idle deadline.
`isActive` keeps a resident engine while its documents are viewed; services call
`scheduleIdle()` after their own sweeps. Worker exit retries replay the entire
callback once by default, allowing Typst to restore residency before rendering.
Callbacks must be replayable; set `retries: 0` for operations with side effects.
RPC calls themselves do not retry. Timeouts and worker pools are not implemented.

`run(work, { key, bytes, priority, signal })` supports latest-version admission:
new work with the same key replaces waiting work and marks running work obsolete.
Callbacks call `assertCurrent()` before publishing results and release engine
artifacts they have already allocated if that check fails. Native/WASM execution
is not interrupted. Admission bounds waiting inputs to 32 MiB as well as 32 tasks;
larger individual inputs can run when a slot is immediately available. Higher
priority runs first, FIFO within a priority. Priorities are fixed at admission;
shared prefetch is reused when its page becomes visible. Closing rejects all
waiting work immediately.

`shared/request-flight.mjs` coalesces cancellable requests with independent
subscribers. Only the last subscriber's cancellation aborts shared work. Markdown
and Typst document keys include render options so independent themes/safe modes
do not supersede one another. Typst visible pages take precedence over prefetch;
navigation and page-window changes abort unused requests.

Typst uses a native NodeCompiler plus the WASM renderer in a child process.
The native addon crashes during repeated worker_threads teardown on Windows;
fork/IPC isolates its native caches and threads and permits complete reclamation.
Calls remain serialized through the same runtime and host. Each complete
compile/query/export calls evictCache(30) in finally, aging the global comemo
cache and VFS cache; main-file shadow overlays are removed as well. After 256 compilations the process
is recycled before its next compile, providing a backstop for residual native/renderer
retention while active documents continue to use cached pages and artifact restoration. Renderer
artifacts remain byte-bounded independently. Fonts use native file-backed loading;
SC aliases are cached font-name adaptations, replacing the WASM metadata builder.

Typst has three independent owners:

- `typst/artifacts.mjs` owns worker-local artifact LRU, bounded to 64 MiB of
  backing buffers and three entries. Serialized calls need no artifact pins or
  mirrored resident set. One lone oversized artifact is allowed. This budget
  excludes compiler caches, fonts, WASM heap and compilation working memory.
- `typst/service.mjs` owns stable document IDs, source snapshots and coalesced
  requests. Metadata is bounded separately to 64 entries and 16 MiB of source
  strings, with at most two revisions per file/theme and a 15-second transition
  grace measured from supersession. Page requests/compile responses are pinned;
  one oversized source is allowed. Active latest revisions survive idle expiry.
- The service owns encoded page caching independently of artifact residency.
  Evicting an artifact preserves metadata and cached pages. An uncached page
  receives `ARTIFACT_MISSING` from the worker, causing the service to validate
  the main-file revision and restore the artifact under the same ID. Restoration
  also checks page dimensions and a canonical native SVG SHA-256 fingerprint;
  native vector bytes themselves contain process-specific serialization data. Expired
  document IDs or changed compiled content produce HTTP 410 at the route boundary.

Typst service methods return domain data (`compile` metadata or `page` image),
and throw errors with status/code. Routes own HTTP/JSON/SVG responses. Expired
metadata triggers coalesced worker `retain` maintenance with a dirty loop, so
changes during an in-flight flush are not lost. Artifact budget enforcement is
synchronous inside the worker and does not depend on maintenance completing.

Transport errors from `postMessage` are removed from the pending request map.
Worker methods may return transferable buffers through the host's `transfer`
option; PDF uses this to avoid copying rendered image bodies.

PDF uses MuPDF only. `pdf/store.mjs` owns document residency, revision keys and
idle eviction; `pdf/mupdf.mjs` opens documents, reads outlines and renders WebP;
`pdf/worker.mjs` checks revisions and exposes the RPC contract. The worker host
serializes every open, render and sweep, so the store needs no duplicate-flight,
in-use or closing state. Request coalescing and encoded-image caching stay in
the main-thread service. MuPDF pages, devices and pixmaps remain alive through
asynchronous Sharp encoding and are released in `finally`.
