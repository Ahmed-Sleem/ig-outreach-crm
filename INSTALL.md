# Instagram Outreach CRM — install and first run

A local-first relationship CRM and careful outreach autopilot for **your own**
Instagram business account. It collects the people who engage a niche, ranks them,
and follows or messages them at a human pace inside strict daily limits. Everything
is stored in IndexedDB in your browser profile. Nothing is uploaded anywhere.

Please read **Account safety** and **What is not proven** before the first run.

---

## Build the loadable folder

Chrome's "Load unpacked" needs a folder with `manifest.json` at its **root**. The
repository keeps sources under `src/`, so build the flat distributable first:

```
node scripts/build.mjs
```

This writes **`build/extension/`** and fails loudly if any file the manifest
references is missing. To verify the folder the way Chrome would load it:

```
node scripts/check-package.mjs build/extension
```

You need Node 18+ to run the build. The extension itself has **zero runtime
dependencies** — the build is a copy plus a manifest check, not a bundler.

## Install (2 minutes)

1. Open Chrome and go to **`chrome://extensions`**.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the **`build/extension`** folder itself — not its parent, not a subfolder.

Chrome 116 or newer is required.

The toolbar icon opens a small popup with **Open the dashboard**. Click it and the
dashboard opens in its own tab.

> **There is no background service worker, on purpose.** The dashboard page does
> all the work itself, so there is no worker that can fail to register and take the
> whole extension down with it. If a previous build of *another* extension left you
> staring at `Service worker registration failed. Status code: 2`, that failure mode
> does not exist here. The one piece that runs off-page is a tiny Web Worker
> metronome that keeps the autopilot countdown ticking when the dashboard tab is
> backgrounded; if it cannot start, the page falls back to its own timer.

> **Upgrading? Remove the old copy first.** In `chrome://extensions`, click
> **Remove** on the old install, then **Load unpacked** the freshly built folder.
> Your saved leads, buckets, templates and history are unaffected — they live in the
> browser profile, not in the extension folder.

## First run

1. Log in to Instagram in a normal tab, as usual. The extension only ever acts on
   pages inside your own browser session.
2. Click the toolbar icon → **Open dashboard**. The top-right connection pill automatically detects your logged-in Instagram tab (if you have not opened Instagram yet, click the pill to open it).
3. In **Collect**, choose a sub-tab (**From an account** or **From a post**), enter a target handle or link, and press **Collect**. Your Instagram tab comes forward and runs visibly with human cursor movement and scrolling (zero Instagram API calls). Nothing is written to your library yet — you get a **Preview** first.
4. Review the preview, pick a bucket (the ready **Default** bucket is pre-selected, or choose **+ Create new bucket…** inline), and press **Save**.
5. Open **Your people** to browse **All people**, **Default**, and every custom bucket as its own tab. Click **+ New bucket** at any time to create another bucket tab, or click any row to inspect details and toggle bucket memberships.
6. Open **Outreach** and select the dedicated **Follow**, **Messages**, or **Unfollow** sub-tab, pick a bucket, and press **Plan (dry run)**. This costs nothing and touches no tab: it shows how many people are ready, the governor's remaining budget, and whether the active window is open.
7. Only when the plan looks right, press **Start Follow run** / **Start Messages run** / **Start Unfollow run**. **Stop** lands after the current action.

**Start with the Conservative trust preset and a tiny daily cap.**

## Recommended settings before you run

Open **Settings** (top-right `⋯` menu) and:

- Pick a **trust preset**. *Conservative* (20 follows/day, 3 cold invites/day) is the
  right place to start a new or warmed-up account. The sliders are capped at the
  governor's hard ceiling, so you cannot dial in a number the safety layer would
  refuse anyway.
- Set the **active window** to the hours you are normally awake and browsing. The
  autopilot only acts inside it, and never more than 14 hours a day.
- Leave the **warm-up ramp** on: a new account starts at 40% of its caps and climbs
  to 100% over seven days.
- In **Outreach → Messages → Message studio**, write at least **5 structurally different
  templates** before any DM run. The pool health panel tells you when you have
  enough variety; a single repeated opening line is exactly what a spam classifier
  looks for.

## What each surface gives you

| Surface | What it does |
|---|---|
| **Tab 1 · Collect** | Two focused sub-tabs (**From an account** and **From a post**) driving visible human browser automation into a preview, ready to save into **Default** or a new bucket. |
| **Tab 2 · Your people** | Ranked, virtualised CRM organised into bucket tabs (**All people**, ready **Default** bucket, and every custom bucket you create as its own tab) with search, warmth filters, and a lead drawer with one-click bucket toggles. |
| **Tab 3 · Outreach** | Three cleanly separated sub-tabs — **Follow**, **Messages** (including Message studio & pool health), and **Unfollow** — with bucket filtering, dry-run planning, governor quota meters, and live run logs. |
| **Top bar** | Brand, three-tab switcher (**Collect**, **Your people**, **Outreach**), interactive connection status pill, and overflow menu (**Settings**, **Backup & export**). |
| **Settings** (drawer) | Trust presets, limit sliders, the active window, and ranking weights. |
| **Backup** (drawer) | Export CSV / a printable report / a `.igcrm.json` save file, create local save points, and import or restore (merging, never replacing). |
| **Toolbar popup** | Jump straight to the dashboard, **Your people**, or **Outreach**. |

## Account safety — read this once

The asset at risk is **your own Instagram account**, because the extension acts
inside your logged-in session. Unlike a read-only analytics tool, this one can
follow and message, so the stakes are higher and the limits are not decorative.

What the build does about it:

- **Hard governor caps.** Hourly and daily ceilings on follows, unfollows, warm DMs
  and cold invites, plus a shared daily mutation budget. The governor refuses to
  exceed them no matter what a campaign asks for, and the UI will not let you set a
  cap above the ceiling.
- **A circadian active window and a 7-day warm-up ramp.** It only acts during your
  waking hours, and a fresh account ramps up slowly.
- **Randomised human pacing with breaks.** Delays between actions are drawn from a
  log-normal spread and periodically include a longer break, so the timing is not
  mechanical.
- **It stops rather than pushes through.** An action block, a `challenge_required`
  or `feedback_required` response trips a **circuit breaker** that locks everything
  for 24–72 hours. The lock is persisted: reloading the dashboard or restarting the
  browser does not clear it, and retrying during a lock only extends the platform's
  patience. If you see the account-flag warning, **stay off Instagram entirely** for
  the lock duration.
- **Duplicate suppression from your own records.** Before every action the runner
  re-reads the lead from IndexedDB and re-asks the governor, so a resumed run never
  messages or follows the same person twice. It never asks Instagram "have I already
  done this?" — that would be one more request per action.
- **The cleaner protects people.** The unfollow cleaner only touches accounts the
  extension itself followed, honours a grace period, and never unfollows a replier, a
  whitelisted contact, or a baseline friend.

**Nothing is undetectable, and no automation is "safe".** Any tool claiming otherwise
is lying. Realistic, sustainable ceilings are tens of actions a day, not hundreds.
Automated DMs are the fastest route to a permanent ban — use the warm, mutual-only
policy and keep volumes low.

You are responsible for using this in line with **Instagram's Terms of Use** and
applicable law. Automated engagement may violate those terms regardless of the
precautions here.

## What is not proven

Being straight with you, because it affects how you should treat the first run:

- **No live Instagram run has happened.** Every selector, endpoint and field name was
  written from research, not confirmed against the live site. If Instagram's DOM or
  API shape differs, a collect or an action will fail or return partial data. The run
  log and the lead dossier show what was actually seen — check them after the first run.
- **The public GraphQL `query_hash` list endpoints are dead.** As of late 2026 the
  public followers/following `query_hash` queries return a correct count but empty
  `edges`. The read layer therefore uses the session-cookie `i.instagram.com`
  friendship endpoints, which require you to be logged in, and falls back to reading
  an open follower/following dialog in the DOM. If a list comes back empty but the
  count is non-zero, that is this boundary — not a bug in your data.
- **Liker lists are capped by Instagram** at roughly 100–120 per post, with no
  pagination. Liker-derived numbers are a floor, not a true ranking.
- **The layout has not been visually checked in a real browser** at every screen size.
  It is statically clean (fluid grids, tables own their scrolling, no fixed widths),
  but if something looks off at an unusual window size, that is why.

## If something goes wrong

- **Nothing happens on the Instagram page** → reload the Instagram tab. Content
  scripts do not attach to tabs that were already open when the extension was installed.
- **"No Instagram tab is open"** → open the profile or post you want to collect from,
  then try again.
- **A run stops immediately as *Blocked*** → you are outside the active window, a daily
  cap is reached, or the circuit breaker is locked. The reason is printed next to the
  Start button and in the top telemetry strip.
- **A run ends as *Failed (page)*** → three actions in a row did not land, which usually
  means Instagram changed the page shape. Stop, check the run log, and re-test on one
  account you do not care about.
- **The dashboard is blank** → open it from the toolbar popup rather than a bookmark;
  the page needs the extension context. If it still fails, the page prints the reason.
- **The toolbar icon seems inert** → it opens a popup, not a direct action; click
  **Open the dashboard**. There is no service worker to inspect.

Your leads, buckets, templates, history and save points live in IndexedDB inside
Chrome, on your machine. Nothing is uploaded anywhere.
