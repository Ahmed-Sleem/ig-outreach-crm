# IG Outreach CRM

**A local Chrome extension that collects warm Instagram leads from profiles you already have open, and runs a human-paced follow, accept-detect and message funnel from your own logged-in session.**

![License](https://img.shields.io/badge/license-MIT-blue) ![Manifest](https://img.shields.io/badge/Chrome-MV3-lightgrey) ![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-green) ![Tests](https://img.shields.io/badge/tests-128%20passing-brightgreen)

## Why

Messaging strangers cold is how Instagram accounts get restricted. The people worth talking to are already visible: they comment on your competitors' posts, they like the same three accounts in your niche, they follow the shop two streets over. Finding them by hand means scrolling for hours and keeping a spreadsheet that is stale by the time you finish it.

This extension does the collecting and the pacing. One tab gathers people from the profiles, posts, comment threads, liker lists, follower lists and story viewers you open yourself, deduplicates them by immutable Instagram user id, records exactly where each one came from, and ranks them by how warm they actually are. The second tab runs the funnel — follow, wait for the follow to be accepted or returned, then send one message at a human interval inside your waking hours.

There is no server, no API key and no account. Everything is stored in IndexedDB on your machine and can be exported in full at any time.

## What it is / what it is not

- **It acts on Instagram.** Unlike a read-only analyser, this tool follows, messages and unfollows. It does that through Instagram's own rendered UI in a single visible tab, never through forged write requests, and never in parallel tabs.
- **It is not a bulk tool.** Every ceiling in `src/core/governor.js` is clamped in code below the levels that get accounts blocked, and the UI cannot raise a value past its floor. Defaults assume an account you care about keeping.
- **It is not undetectable.** Nothing that runs inside a real session at machine rhythm is. The pacing exists to stay inside the envelope a person produces, not to be invisible.
- **It does not scrape what Instagram withholds.** Liker lists stop at roughly 100 per post, third-party follower lists are server-capped, and hidden counts stay hidden. The app reports the truncation instead of guessing around it.
- **Your account, your responsibility.** Automated following and messaging conflicts with Instagram's Terms of Use. Use it on an account you can afford to lose, at the lowest settings that still work, and stop immediately if Instagram shows you a checkpoint or an action block.

## What the code in this tree does

The extension is being built engine-first: every rule is written as a pure, unit-tested module before the UI that exposes it exists.

| Module | Behaviour |
|---|---|
| `core/random.js` | `EntropyPoolRNG`: a CSPRNG seed mixed with cursor movement, two clocks and a draw counter, so a hands-free run still produces unmodellable intervals. Lemire-rejected integers, log-normal delays. |
| `core/templates.js` | Nested `{a|{b|c}}` spintax plus `{{first_name|fallback}}` variables, resolved in the order that keeps the two syntaxes from colliding. |
| `core/linter.js` | Pre-flight message checks: the 1000-byte limit, link shorteners, hidden-word phrasing, pool size and pairwise trigram similarity. |
| `core/lifecycle.js` | The `(relState, dmState)` state machine, the one-message lock on unaccepted requests, and unfollow eligibility with its protections. |
| `core/governor.js` | Hourly, daily, shared-mutation and cold-invite caps, the circadian window with a 14-hour active cap, the warm-up ramp and the 48-hour circuit breaker. |
| `core/scoring.js` | Priority ranking from provenance edges, per-post deduplicated, with a breakdown behind every rank. |
| `core/text.js`, `core/comments.js` | Language-agnostic normalisation, similarity, and the Arabic/English buyer-intent comment classifier. |
| `storage/db.js` | The IndexedDB workspace: eight stores, idempotent provenance writes, and startup reconciliation of interrupted actions. |
| `storage/settings.js` | One settings key in `chrome.storage.local`, clamped against the hard ceilings on every read and write, with credential redaction on export. |
| `storage/sync.js` | `BroadcastChannel` bus so two open tabs never disagree about a lead. |

## Requirements

- Node.js 20 or newer, for the tests, the verification gate, and the one-command build. The extension itself has zero runtime dependencies.
- Chrome 116 or newer.

## What can I paste?

The Collect screen asks one plain question first — *what do you want to collect
from?* — then shows a single field that adapts to the answer:

| Collect from | Paste | Example |
|---|---|---|
| An account | Their username | `linen.studio` |
| A post | Its link or shortcode | `https://www.instagram.com/p/C1a2b3c4/` or `C1a2b3c4` |
| A hashtag | The tag, with or without `#` | `#homedecor` or `homedecor` |
| What I have open | Nothing — it reads the page you have open | — |

The field checks what you type as you type it and confirms it (for example
`Account: @linen.studio`); **Collect** stays disabled until the input is valid, and
pressing Enter collects. If something goes wrong you get one plain sentence — and
the raw technical detail is tucked into a collapsed **Details** line, not thrown at
you.

## The everyday flow

1. Open any Instagram profile, post or hashtag page. A small pill sits at the
   bottom-right corner.
2. Click the pill and choose **Collect followers** (or likers, commenters, and so
   on). A new tab opens the dashboard already set to that source and starts
   collecting.
3. Review the people it found — username, name and warmth.
4. Pick a bucket under **Save into** and click **Save**; they join your library.

You can also do it from the dashboard itself: choose **An account**, paste a
username, and click **Collect**.

## Screenshots

Dashboard captures are **pending**. This environment cannot drive Chrome with the
extension loaded (and the in-page pill shot needs a logged-in Instagram session),
so no images were fabricated. The exact list of the eight shots to produce — and
how to produce them — is in [`docs/screenshots/TODO.md`](docs/screenshots/TODO.md);
the fictional demo-data seed for them is in [`tools/seed-demo.md`](tools/seed-demo.md).

## Quick start

```bash
git clone https://github.com/Ahmed-Sleem/ig-outreach-crm.git
cd ig-outreach-crm
npm test                       # 760 tests, no dependencies
npm run verify                 # 24 checks: shape, hygiene, code invariants, links, tests
node scripts/build.mjs         # writes the loadable folder to build/extension/
node scripts/check-package.mjs build/extension   # verifies it the way Chrome would load it
```

Then load `build/extension/` unpacked in `chrome://extensions`. Full steps, the
first-run walkthrough, the safety model and an honest "what is not proven" list are
in [INSTALL.md](INSTALL.md).

## Status

| Area | State |
|---|---|
| Repository, licence, docs, verification gate | Done |
| Icon and asset generation | Done |
| Core engines and local storage | Done, unit-tested |
| Instagram read layer | Done — session-cookie + DOM-dialog paths, unit-tested; **not run live** |
| Follow, accept-detect and DM execution | Done — governor-capped, duplicate-suppressed, unit-tested; **not run live** |
| Dashboard UI | Done — Collect and Outreach screens, light theme, virtual tables, drawers; unit-tested |
| Loadable `build/extension/` build | Done — `node scripts/build.mjs`, passes the package check |
| README screenshots | Pending — cannot drive Chrome with the extension here; see `docs/screenshots/TODO.md` |
| Run against a live Instagram account | Not performed |

## Repository layout

```text
src/
├── core/              # pure functions — no browser APIs, unit-tested in Node
├── storage/           # IndexedDB workspace, clamped settings, cross-tab sync
├── assets/            # icons and logo, regenerated by scripts/gen-icons.mjs
├── content/           # runs on instagram.com — probes, adapters, actions, launcher
└── app/               # the dashboard: two tabs, one design system, popup
scripts/               # build, package check, icon generation, verification gate
tests/                 # node:test suites, including mutation negative controls
docs/                  # architecture and safety
```

## Further docs

| Document | Contents |
|---|---|
| [INSTALL.md](INSTALL.md) | Build, load, first-run walkthrough, the safety model, and what is not proven. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Runtime topology, module map, data model, and why there is no background service worker. |
| [docs/SAFETY.md](docs/SAFETY.md) | The account-risk model, the limits the code enforces, and what the tool refuses to do. |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Upstream projects this code adapts, pinned by commit, with their licences. |
| [SECURITY.md](SECURITY.md) | How to report a problem privately, and the three properties the code defends. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | The rules this codebase follows, and what has to pass before a PR. |

## License

MIT. See [LICENSE](LICENSE).
