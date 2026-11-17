# README screenshots — status & capture guide

Shots `01`–`07` have been captured in real Chromium with the unpacked
`build/extension/` loaded and purely fictional demo data (zero console/page errors,
compressed to 12–133 KB each). Shot `08-in-page-pill.png` requires a logged-in
Instagram session and must be captured by the repository owner.

## Files

| # | File | Content | Status |
|---|---|---|---|
| 1 | `01-collect.png` | Collect screen: the two focused sub-tabs (**From an account**, **From a post**) and adaptive input field in the warm cream/vermilion editorial theme | **Done** (`1280×860`) |
| 2 | `02-collect-preview.png` | After a collection: preview table with warmth badges plus "Save into bucket" (`Default (ready)`) | **Done** (`1280×1271`) |
| 3 | `03-library.png` | "Your people" table with bucket tabs (**All people**, **Default**, custom buckets), search, and warmth filters | **Done** (`1280×860`) |
| 4 | `04-lead-drawer.png` | A lead drawer open showing bucket memberships, metrics, and score breakdown | **Done** (`1280×860`) |
| 5 | `05-outreach.png` | Outreach **Messages** sub-tab with dry-run queue preview, spintax Message studio, linter status, and pool health | **Done** (`1280×2220`) |
| 6 | `06-settings.png` | Safety & ranking settings drawer with trust presets and governor-capped limit sliders | **Done** (`1280×860`) |
| 7 | `07-popup.png` | Toolbar popup (`280×268`) | **Done** (`280×268`) |
| 8 | `08-in-page-pill.png` | The pill on a real Instagram profile — **owner must capture** (needs a logged-in session; blur or crop any real account names, then add it to the `## Screenshots` section of `README.md`) | **Missing — owner only** |

## How to re-capture (1–7)

- Viewport 1440×900, device scale factor 2, then downscale to at most 1600px wide.
- Compress each PNG (`oxipng` or `pngquant`); target ≤ 300 KB each.
- Use only the fictional demo data from [`../../tools/seed-demo.md`](../../tools/seed-demo.md).
  Never real usernames, real names, real bios, or the owner's account name.
- Build first: `node scripts/build.mjs build/extension`, then load
  `build/extension/` unpacked.

Drive Chromium with Playwright or Puppeteer:

```
--disable-extensions-except=<abs path to build/extension>
--load-extension=<abs path to build/extension>
```

Use a persistent context. Open `chrome-extension://<id>/app/index.html`. This
extension has no service worker, so the id cannot be read from a background page.
For an unpacked extension the id derives from the absolute path: take the first 32
hex characters of the SHA-256 of that path and map each hex digit `0–f` to the
letters `a–p`. Compute it, then confirm by loading the URL; if that fails, open
`chrome://extensions` and read the id off the page. Wait for the table to render
before each shot; take viewport (not full-page) shots; for shot 4, open the drawer
first.

## Seeding the demo data

Seed from the dashboard's DevTools console using the snippet in
[`../../tools/seed-demo.md`](../../tools/seed-demo.md). Do **not** commit any seed
script into the extension folder.
