# Nota

A Chrome extension (Manifest V3) for Mitch's own use. It marks up any page with edits, notes, and removals, then copies them as one prompt for a coding agent. Read `README.md` for behavior and the file map.

## Rules

- Vanilla JS, no TypeScript, and no build step. Chrome loads the files in `manifest.json` as-is.
- Content scripts share the `globalThis.Nota` namespace. Each file is an IIFE that adds to it. Never declare top-level `const` or `let`: a second injection from `background.js` would throw.
- `src/nota.js` owns all state. `src/ui.js` only renders. Keep that split.
- Every frame runs the content scripts. The top frame owns the panel, view, and mode. An iframe picks and applies changes in its own document and reaches other frames only through `background.js` relays, never `postMessage`.
- The UI lives in a closed shadow root on `<html>`, not `<body>`, so Turbo body swaps keep it. Build UI nodes with the `h()` helper. Never pass page text to `innerHTML`.
- Treat every page as hostile. Page event handlers skip events whose `isTrusted` is false. Text entry lives in `pages/note.html`, an extension iframe, never in the page's document. Clipboard writes go through `background.js`. Tests reach the panel with the `nota()` helper, since Playwright locators cannot pierce a closed shadow root.
- The UI uses Knox's Ubud theme. Colors come from the `--sage-*`, `--accent`, and status tokens in `src/ui-css.js`. Never hardcode a color there.
- Page text comes from `readText`, not `innerText`. `innerText` applies CSS `text-transform`, and the agent greps source text.
- Prettier: `{"semi": false, "useTabs": true, "singleQuote": true}`. Run `npm run format`.
- Run `npm test` after every change. It loads the unpacked extension into Playwright's Chromium, which is pinned at 1.62.1.
