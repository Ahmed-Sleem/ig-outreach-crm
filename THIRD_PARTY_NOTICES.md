# Third-party notices

This project is licensed under the MIT License (see [LICENSE](LICENSE)). It
adapts code from the permissively licensed projects listed below. Their
copyright notices are reproduced here, and the MIT permission notice they all
share is reproduced once at the end of this file.

An attribution is added here in the same commit as the code it covers.

## By the same author

- **IG Competitor Intel** — `Ahmed-Sleem/ig-analysis`, commit `f38d1ded`, MIT.
  Source of the text normalisation and script detection in `src/core/text.js`,
  the comment intent classifier and clustering in `src/core/comments.js`
  (similarity primitives moved to `text.js` so both modules share one
  definition), the IndexedDB wrapper pattern in `src/storage/db.js`, the
  in-memory IndexedDB test double in `tests/helpers/fake-indexeddb.mjs`, and
  the shape of the verification gate in `scripts/verify.sh`.

## Adapted third-party code

| Project | Pinned commit | Licence | Adapted into |
|---|---|---|---|
| `betsol/node-spintax` | `d668d65a` | MIT | `src/core/templates.js` — nested spintax parser and variation counter, with lodash removed and the branch draw routed through the injected random engine |
| `bryc/code` | `88c1317e` | Public domain, MIT fallback | `src/core/random.js` — the `sfc32` stream cipher PRNG and the MurmurHash3 `fmix32` finaliser |
| `Trebuuu/fluidextension` | `59f36529` | MIT | `src/core/governor.js` — the strict week parser, calendar-field window maths and per-workspace opening jitter of the circadian schedule engine |
| `davidarroyo1234/InstagramUnfollowers` | `86346ae7` | MIT | `src/core/scoring.js` — the default-avatar CDN markers used for the blank-picture penalty |

## Clean-room algorithmic references

The zero-dependency human interaction and 2026 Instagram DOM collection patterns
in `src/content/human.js`, `src/content/selectors.js`, and
`src/content/browser-collector.js` are original implementations informed by
public MIT-licensed work on human cursor kinematics (Fitts's Law + cubic Bezier
trajectories, e.g. `Xetera/ghost-cursor`) and modern Instagram DOM traversal
(`IanLeung12/instagram-follower-extension`, `dartganan/instagram-comment-scraper`,
`shuangying0001-beep/human-like-automation`). No third-party source code or
runtime packages were vendored.

## Copyright notices

- node-spintax — Copyright (c) Slava Fomin II, BETTER SOLUTIONS.
- bryc/code — released to the public domain by bryc; usable under MIT where
  public domain is not recognised.
- fluidextension — Copyright (c) 2026 Fluid.
- InstagramUnfollowers — Copyright (c) 2022 David Arroyo.
- IG Competitor Intel — Copyright (c) 2026 IG Competitor Intel contributors.

## The shared permission notice (MIT)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
