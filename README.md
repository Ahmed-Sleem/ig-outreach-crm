# IG Outreach CRM

**A local Chrome extension that collects warm Instagram leads from profiles you already have open, and runs a human-paced follow, accept-detect and message funnel from your own logged-in session.**

![License](https://img.shields.io/badge/license-MIT-blue) ![Manifest](https://img.shields.io/badge/Chrome-MV3-lightgrey) ![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-green)

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

## Status

| Area | State |
|---|---|
| Repository, licence, docs, verification gate | Done |
| Icon and asset generation | Done |
| Core engines and local storage | Not started |
| Instagram read layer | Not started |
| Follow, accept-detect and DM execution | Not started |
| Dashboard UI | Not started |
| Loadable `EXTENSION/` build | Not started |
| Run against a live Instagram account | Not performed |

The build is not loadable yet. What is in the tree today is the source scaffold, the documentation and the checks that the rest of the code has to pass.

## Repository layout

```text
src/
├── manifest.json      # MV3, no service worker (lands with the first runnable build)
├── core/              # pure functions — no browser APIs, unit-tested in plain Node
├── storage/           # IndexedDB workspace, clamped settings, cross-tab sync
├── content/           # runs on instagram.com: reading, pacing, real-UI actions
└── app/               # the dashboard: two tabs, one design system
scripts/               # icon generation, build, verification gate
tests/                 # node:test suites, including negative controls
docs/                  # architecture and safety
```

## Further docs

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Runtime topology, module map, data model, and why there is no background service worker. |
| [docs/SAFETY.md](docs/SAFETY.md) | The account-risk model, the limits the code enforces, and what the tool refuses to do. |
| [SECURITY.md](SECURITY.md) | How to report a problem privately, and the three properties the code defends. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | The rules this codebase follows, and what has to pass before a PR. |

## License

MIT. See [LICENSE](LICENSE).
