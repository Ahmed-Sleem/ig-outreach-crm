# Architecture

This describes how the extension is put together. The README's status table says
which parts are in the tree today.

## Runtime topology

Two foreground contexts, one database, no background service worker, strictly
one active task at a time while the dashboard is open.

```text
DASHBOARD TAB  (chrome-extension://<id>/app/index.html)
├── Tab 1  Collect: 2 sub-tabs (From an account, From a post) + Preview & Save
├── Tab 2  Your people: bucket tabs (All people, ready Default, user buckets + New bucket), virtual table, dossier drawer
├── Tab 3  Outreach: 3 separated sub-tabs (Follow, Messages + Message studio, Unfollow), quota meters, live run log
├── src/core/*      pure engines: scoring, lifecycle, random, governor, templates, linter
└── src/storage/*   IndexedDB workspace, clamped settings
                    │
                    │ chrome.tabs.sendMessage (one task at a time; auto-returns focus to dashboard when done)
                    ▼
INSTAGRAM TAB  (https://www.instagram.com/*)
└── active foreground tab   DOM-first session probe, 2026 browser-DOM collector, human pointer/scroll/click engine, real-UI follow/DM/unfollow
```

## Why there is no background service worker

Chrome can refuse to register an MV3 service worker (`Service worker registration
failed. Status code: 2`) for reasons the user cannot see or fix, and because the
worker is a single shared dependency, that one failure takes down every feature at
once.

Nothing here runs in the background. The extension strictly runs one task at a
time while the dashboard is open: it focuses the single Instagram tab to carry
out the active scan or outreach step visibly, and automatically switches Chrome
focus back to the dashboard tab as soon as the task finishes.

Every queue item, cooldown timestamp, quota counter and in-flight action is
persisted to IndexedDB before it is acted on, so closing the browser mid-campaign
resumes from stored state instead of repeating an action.

## Module map

```text
src/
├── manifest.json                # MV3, no service_worker, strict CSP, minimal permissions
├── content/
│   ├── content.js               # classic dynamic-import bootstrapper + Symbol duplicate guard
│   ├── main.js                  # message router: browser-DOM collect, follow, message, unfollow (zero IG API calls)
│   ├── probe.js                 # DOM-first signed-in viewer detection (zero IG API calls)
│   ├── human.js                 # cubic Bezier pointer path, human wheel scrolling & scroll-up/down nudge
│   ├── browser-collector.js     # 100% browser-driven 2026 DOM collection (followers, following, likers, commenters, dialogs)
│   ├── adapters.js              # pure row/pagination helpers (not invoked in live browser runs)
│   ├── actions.js               # real-UI follow, unfollow and Lexical DM composer + verification
│   ├── selectors.js             # single source of exact English and Arabic 2026 Instagram DOM selectors
│   ├── pacing.js                # read pacer and response/block classification
│   └── launcher.js              # closed Shadow-DOM quick launcher on instagram.com
├── core/                        # pure JS: no chrome.*, no DOM, unit and mutation tested
│   ├── scoring.js               # provenance aggregation and the tunable priority score
│   ├── lifecycle.js             # the authoritative (relState, dmState) state machine
│   ├── random.js                # EntropyPoolRNG: CSPRNG seed, cursor ring, clock, draw counter
│   ├── governor.js              # hourly, daily, shared-mutation and cold-invite caps; sleep window
│   ├── templates.js             # spintax plus {{variable|fallback}} personalisation
│   ├── linter.js                # pre-flight message checks: size, links, hidden words, similarity
│   ├── comments.js              # Arabic and English buyer-intent comment classifier
│   └── text.js                  # digit and Unicode normalisation, salutation-name extraction
├── storage/
│   ├── db.js                    # promise-wrapped IndexedDB (ig-outreach-crm v1) + WAL recovery
│   ├── settings.js              # clamped settings in chrome.storage.local + secret redaction
│   └── sync.js                  # BroadcastChannel('ig-crm-sync') pub/sub
└── app/
    ├── index.html               # dashboard shell
    ├── main.js                  # auto-connect session pill, three-tab router, foreground timer, run banner
    ├── design/{tokens,app}.css  # single source of colour, space, type, theme
    ├── lib/
    │   ├── ui.js                # el(), scannedText(), virtualTable(), modal(), drawer(), toast()
    │   ├── api.js               # timeout-guarded tab messaging, auto Default bucket, focusDashboard auto-return
    │   ├── virtual-list.js      # windowed rows for tables of tens of thousands of leads
    │   └── export-utils.js      # BOM CSV with formula guard, .igcrm.json backup, printable HTML
    └── views/
        ├── tab1-collector.js    # 2 source sub-tabs (From an account, From a post), single-task collector, preview & bucket save
        ├── tab-people.js        # bucket sub-tabs (All people, Default, custom), virtual table, dossier drawer
        ├── tab2-outreach.js     # 3 separated sub-tabs (Follow, Messages + studio, Unfollow), quota meters
        ├── backup-export.js     # restore points, exports, importers
        └── settings-view.js     # trust presets, limits, ranking weights, baseline snapshot
```

Two rules keep this from drifting:

1. **`src/core/` and `src/storage/` are pure.** No `chrome.*`, no `document`, no
   `window`. Clocks, random sources and storage handles are injected, which is why
   the whole safety model is testable in plain Node with no browser and no network.
2. **One implementation of each rule.** Colour and spacing live only in
   `tokens.css`; components live only in `ui.js`; limits live only in `governor.js`;
   state transitions live only in `lifecycle.js`. A second copy of any of them is a
   defect from the day it is written.

## Data model

IndexedDB database `ig-outreach-crm`, schema version 1. Every record carries a
`workspaceId` equal to the signed-in account's numeric user id, so two Instagram
accounts in one browser profile never share leads, quotas or campaign state. All
Instagram user ids are stored as strings: they exceed `Number.MAX_SAFE_INTEGER`.

| Store | Key | Purpose |
|---|---|---|
| `workspaces` | `workspaceId` | Signed-in account, baseline snapshot marker, governor state, in-flight action |
| `leads` | `${workspaceId}:${canonicalId}` | Identity, cached score, lifecycle state, group membership |
| `lead_edges` | `${leadKey}\|${edgeType}\|${sourceAccount}\|${refId}` | One row per provenance fact: liked post, commented post, follows source, story view, CSV import |
| `groups` | `groupId` | Campaign grouping, message pool, public-account DM policy, cleanup grace |
| `templates` | `templateId` | Message pool entries with weights, lint warnings and send/reply counters |
| `scrape_runs` | `runId` | What was collected, from where, and what the platform truncated |
| `action_log` | `logId` | Immutable audit trail of every follow, message, skip and circuit breaker |
| `snapshots` | `snapshotId` | Named local restore points |

Provenance lives in `lead_edges`, not in counters on the lead row. Re-scanning the
same post updates `lastSeenAt` without double-counting engagement, and never resets
a lifecycle state. That separation is what makes a second scan safe.

Settings live in `chrome.storage.local` under one key, never in `chrome.storage.sync`,
and are passed through the same clamping function on every read and every write.
Session and CSRF values are never persisted and are stripped from exports.

## Cross-tab sync

Any writer — Tab 1, Tab 2, a second dashboard window, or the content script —
publishes a typed event on `BroadcastChannel('ig-crm-sync')`:
`LEADS_UPSERTED`, `LEAD_STATE_CHANGED`, `GOVERNOR_TICK`, `CIRCUIT_BREAKER_TRIPPED`.
A follow executed in the managed Instagram tab shows up as a badge change in Tab 1
without a page refresh.

## Reading and writing on Instagram

Both collection and outreach run 100% through Instagram's rendered UI in a visible
browser tab — never through forged `/api/v1/` or `/graphql` collection endpoints.

- **Session detection (`probe.js`)** reads the logged-in session strictly from the
  open Instagram tab's own cookies (`ds_user_id`), navigation profile link, and
  embedded hydration scripts — zero network probes.
- **Human collection (`human.js` + `browser-collector.js`)** focuses the Instagram
  tab visibly, navigates to the profile or post, moves a subtle Shadow-DOM
  cursor along cubic Bezier curves with smoothstep acceleration, clicks the real
  Followers / Following / Likes / Next controls, scrolls dialogs in variable
  micro-steps with reading pauses, stops before `"Suggested for you"` boundaries,
  and halts immediately if Instagram displays an action-block dialog.
- **Real-UI writes (`actions.js`)** click and type in Instagram's real UI so the
  site's own frontend signs and sends every follow, unfollow, and DM with normal
  telemetry. Every write is followed by a verification window: the button label is
  re-read after 3.5 s, a rolled-back follow is recorded as not-done, and a message
  is only marked sent when the composer reports it.

## Verification

`npm test` runs the unit suites in Node. `npm run verify` adds the checks that only
make sense across the whole tree: every manifest reference resolves, no `innerHTML`
assignment exists, no host outside Instagram is contacted, the design tokens are the
only place colours are defined, no secret or internal working file is tracked, and a
set of negative controls confirms the safety tests genuinely fail when the rule they
guard is broken.
