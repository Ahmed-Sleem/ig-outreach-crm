# Contributing

Small, focused pull requests are easier to review than large ones.

## Before you open a PR

```bash
npm test        # unit tests, no dependencies
npm run verify  # structure, safety and honesty gates
```

Both must pass. `npm run verify` also fails on things a reviewer would otherwise
have to catch by hand: an `.innerHTML` assignment, a hardcoded colour outside the
design tokens, a network host other than `instagram.com`, or a secret in the tree.

## Rules this codebase follows

- **One implementation of each rule.** Colours, spacing and type live in
  `src/app/design/tokens.css`. UI components live in `src/app/lib/ui.js`. Safety
  limits live in `src/core/governor.js`. State transitions live in
  `src/core/lifecycle.js`. If you need a variant, extend the shared thing rather
  than copying it next to the call site.
- **`src/core/` and `src/storage/` stay pure.** No `chrome.*`, no `document`, no
  `window`. They are unit-tested in plain Node, and that is only possible because
  they do not touch the browser. Clocks, random sources and storage handles are
  passed in.
- **No runtime dependencies.** The extension ships zero packages. Node is a
  development tool only.
- **Never render scraped text with `innerHTML`.** Usernames, display names, bios
  and comments are third-party input. Build nodes with `document.createTextNode`
  or the `el()` helper.

## Instagram behaviour

Anything that changes how fast or how often the extension acts on Instagram needs
a matching change in `docs/SAFETY.md` and a test that proves the new floor holds.
A limit that can be raised from the UI above the documented ceiling is a bug.
