# README screenshots — to capture

These eight PNGs are referenced by `README.md` but **none exist yet**. This
environment cannot drive Chrome with an unpacked extension loaded, and shot 8
needs a logged-in Instagram session, so nothing was fabricated. Capture them on a
machine with Chrome and the built extension, then drop the files in this folder
and the README's Screenshots section will light up.

## Files to produce

| # | File | Content | Status |
|---|---|---|---|
| 1 | `01-collect.png` | Collect screen, empty state: the four source groups and the adaptive field | **Missing** |
| 2 | `02-collect-preview.png` | After a collection: preview table plus "Save into a bucket" | **Missing** |
| 3 | `03-library.png` | "Your people" table with the search and warmth filters | **Missing** |
| 4 | `04-lead-drawer.png` | A lead drawer open | **Missing** |
| 5 | `05-outreach.png` | Outreach screen with the queue and message studio | **Missing** |
| 6 | `06-settings.png` | Settings drawer | **Missing** |
| 7 | `07-popup.png` | Toolbar popup, cropped to about 280px wide | **Missing** |
| 8 | `08-in-page-pill.png` | The pill on a real Instagram profile — **owner must capture** (needs a logged-in session; blur or crop any real account names) | **Missing — owner only** |

## How to capture (1–7)

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
