# Unified library service

This directory contains the library browser, compact document viewer, and
their HTTP route module. The unified Node.js and Hono service entry point is
`../server-node.mjs`; it also hosts the interactive Markdown and Typst preview
pages used by Neovim.

From the repository root:

```sh
npm ci
npm run build
npm run serve -- E:/notes
```

The service prints a JSON `ready` event containing its loopback URL and listens
on `127.0.0.1:49191` by default. The library opens at `/`. A compact document
view uses `/?path=relative/path.md`; the file browser uses
`/notes/relative/path.md`.

Start the service yourself with the Neovim working directory as the root.
Neovim connects to this existing service and sends file identity and editor
metadata over its HTTP control endpoint; it does not start or stop Node.js.
Node.js reads the saved file and watches the active buffer's file for changes.
Saving refreshes Markdown and recompiles Typst. Switching Neovim's working
directory while the service runs returns HTTP 409.

The API retains `GET /api/tree`, `GET /api/document?path=...`, and
`GET /api/asset?path=...`; library Typst pages use
`GET /api/typst/page?id=...&page=...`. PDF pages use
`GET /api/pdf/page?path=...&page=...`, which renders WebP on Node.js with
EmbedPDF PDFium WASM. PDF bookmarks appear in the Symbols sidebar. The server listens on `127.0.0.1`, so
opening the page requires no login or token.

The library watches the file currently open in each browser view, independently
of Neovim. File changes are debounced before the document is fetched again;
the file tree is fetched again when navigation changes the current location.
Markdown HTML contains links to assets rather than embedded asset data. Changes
to referenced local images and media refresh those asset URLs without
rerendering the Markdown text.

Typst and PDFium WASM engines prewarm after the service starts. Typst fonts and
documents are loaded on demand. Set `WASM_PREWARM=0` to skip both engine prewarms
(`TYPST_WASM_PREWARM=0` also works), or `TYPST_WASM_PROFILE=1` to report startup,
compile, and per-page SVG times. `TYPST_WASM_FONTS` overrides the default font
file list with semicolon-separated paths. The native Typst command has its own
embedded fonts, which are not automatically available to the WASM compiler.
