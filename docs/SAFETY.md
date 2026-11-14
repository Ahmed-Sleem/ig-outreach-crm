# Safety and account risk

This extension acts inside your own logged-in browser. That is what lets it work
without an API key, and it is also what puts your account — not an anonymous server —
at risk.

This document states what the risk is, what the code does about it, and what it
refuses to do. It is not reassurance. Read it before turning the autopilot on.

## The risk model

Traffic from a datacentre is blocked by IP reputation and TLS fingerprinting. A
browser extension bypasses both, because requests come from your real browser, your
real session and your real residential IP.

What remains is the behavioural layer: rate, rhythm and volume. Instagram does not
need to identify a tool. It only needs to notice that an account is doing things no
human hand does — uniform intervals, no sleep window, follow-and-unfollow churn, or
ten identical messages to ten strangers.

Meta publishes numeric limits only for the official Business Graph and Messaging API.
Web session limits are not published, because enforcement is behavioural and scored
against account trust. Every number below is an operating ceiling derived from
observed enforcement, set deliberately under the point where blocks start.

### How restriction escalates

| Stage | What you see | Typical duration | Usual trigger |
|---|---|---|---|
| Silent rollback | The follow button flips to `Following` and reverts seconds later; a request returns `200` with `spam: true`; messages land in Hidden Requests with no notification | Minutes to hours | Burst clicking, a repeated template skeleton, a link in a cold message |
| Action block | `feedback_required` in the response body, or a "Try Again Later" dialog, or HTTP `429` | 12–48 h first time, 3–7 days if repeated inside a month | Hourly velocity, dozens of one-by-one friendship lookups, many identical cold messages |
| Checkpoint | `challenge_required` / `checkpoint_required`, redirect to `/challenge/`, SMS or selfie prompt | Until verified, plus a day of observation | Device or IP mismatch, round-the-clock uptime, forged write calls with no browser telemetry |
| Trust suppression | Reach drops; messages to non-followers go to Hidden Requests; follow-back rate falls | Weeks | Near-identical messages, public link shorteners, unbalanced follow/unfollow churn |
| Suspension | Login refused with an appeal window; missing the appeal makes it permanent | Appeal review, then permanent | Recipients reporting messages as spam, acting through an active block, aggressive velocity on a young account, proxy logins |

The last row is the one that matters. Roughly ten spam reports in a short window can
suspend an account regardless of how careful the pacing was. That is why the default
funnel follows first and messages only people who followed back or accepted a request:
a message to someone who chose to connect with you is not unsolicited.

## Ceilings the code enforces

These are hard clamps in `src/core/governor.js`. The settings UI cannot raise a value
past them, and it shows the corrected number rather than silently accepting one the
engine will not honour.

| Dimension | Danger zone | Hard ceiling | Default (balanced preset) |
|---|---|---|---|
| Follows per hour | over 20–25, or more than 8 in five minutes | 18 | 10 |
| Follows per day | over 150–200 | 140 | 50 |
| Unfollows per hour | over 25–30 | 18 | 10 |
| Unfollows per day | over 150–200 | 140 | 50 |
| Follows + unfollows per day (shared budget) | over 200 combined | 160 | 75 |
| Lifetime following | 7 500 platform limit | queue pauses at 7 450 | — |
| Grace before unfollowing | same-day cycling is an immediate flag | 48 h floor | 5 days |
| Warm messages per day (recipient follows you) | over 80–120 | 75 (10/hour) | 25 |
| Cold invites per day (recipient does not follow you) | over 25–35, or 5–10 identical texts | 25 (5/hour) | 8 |
| Delay between write actions | under 20 s, or a constant interval | 35 s floor | 75–190 s, jittered |
| Read requests | over 200/hour unpaced, or 40 sequential friendship lookups | 15/min, 400/session | paced, batched |
| Active hours per day | round-the-clock operation | 14 h, so at least 10 h of sleep | 09:30–22:30 local |

New accounts (under three months) should use the conservative preset: 20 follows a
day, 30 combined mutations, 10 warm messages, 3 cold invites. A warm-up ramp starts a
new campaign at 40% of the configured daily limit and steps up over seven clean days.

## What the engine does

**Real UI only.** Follow, unfollow and message are performed by clicking and typing
in Instagram's own rendered interface, in one visible tab. The site's frontend signs
and sends the request with its normal telemetry. Forged `fetch` mutations skip that
telemetry and are a known route to a block, so they are not used for writes.

**Verification after every write.** A follow is not recorded as done when the button
changes; it is recorded when the label is still correct 3.5 s later and no
"Try Again Later" dialog appeared. A message is not recorded as sent until the
composer and thread agree it left.

**Shared mutation budget.** Follows and unfollows draw from one daily pool as well as
their own caps. "150 follows plus 150 unfollows" is a block even though each number
looks safe alone.

**Circadian sleep window.** Automation only runs inside a configured local window,
with a daily drift of up to ±20 minutes on both edges so it never starts at exactly
09:30:00. Outside the window the queue sleeps and says so.

**Non-uniform timing.** Delays are drawn from a skewed log-normal distribution over a
random engine that mixes a cryptographic seed, cursor movement, wall clock,
sub-millisecond clock and a draw counter — never `Math.random()` alone, and never a
fixed interval. Roughly one action in ten is followed by a 45–180 s distraction pause,
and every 8–12 actions by a 6–15 minute break.

**One message per unaccepted request.** Instagram allows a single text-only message
to someone who does not follow you, and hides the composer until they accept. Once a
request message is logged, the state machine refuses to queue a second one until the
recipient follows back or replies. The limit is enforced in code, not in the UI.

**Pre-send thread audit.** Before typing anything, the existing thread is read. If a
conversation already exists — including one you started from your phone — the send is
skipped and logged.

**Post-acceptance cool-off.** A private account that accepts a follow request is not
messaged two seconds later. The wait is a randomised 25–120 minutes inside waking hours.

**Pre-flight message linting.** Templates are checked before a campaign starts:
1 000-byte UTF-8 limit, no public link shorteners in cold messages, no hidden-word
triggers, a minimum number of structurally distinct templates, and pairwise trigram
similarity low enough that a spam-similarity classifier has nothing to match.

**Circuit breaker with no retry.** One `feedback_required`, `challenge_required`,
`checkpoint_required`, `spam: true` or HTTP `403` halts the campaign and locks write
actions for 48 hours. The lock is persisted, so reloading the dashboard or restarting
the browser does not clear it. Retrying during a block extends it.

**Workspace binding.** Every action checks that the account currently signed in to
Instagram is the account the workspace belongs to. Logging out and into a different
account stops everything instead of acting on the wrong profile.

## What it refuses to do

- No parallel tabs, no headless browser, no proxy, no credential storage.
- No message to a source account you scraped, and none to yourself. Both are
  excluded from every queue automatically.
- No unfollowing anyone followed less than 48 hours ago, anyone who replied, anyone
  on the whitelist, or anyone in the protected baseline snapshot of your existing
  friends. By default the cleaner only considers accounts this extension followed.
- No bulk friendship lookups one-by-one; status resolution is batched or indexed.
- No follower-list crawling beyond the pages Instagram serves, and no pretending the
  truncated list is complete.
- No background activity. Nothing runs unless the dashboard is open and the
  autopilot is started.

## Privacy

Leads, provenance, templates, quotas and the action log are stored in IndexedDB on
your machine. The extension contacts no host other than `instagram.com` and
Instagram's own CDNs. There is no telemetry, no analytics and no update server.

Session cookies and CSRF values are read from the live page when a request needs
them, kept in memory, and stripped from every backup and export. A `.igcrm.json`
workspace file contains no credential.

Everything can be exported: a full workspace backup, ranked lead CSVs with a UTF-8
BOM so Excel renders Arabic correctly, a segmented campaign CSV pack, and a printable
HTML report. Nothing is locked inside the browser profile.

## Terms of use and responsibility

Automated following, messaging and unfollowing conflicts with Instagram's Terms of
Use. This tool reduces the likelihood of enforcement; it does not make the activity
permitted, and it cannot promise your account is safe. Use it on an account you can
afford to lose, keep the defaults unless you have a reason not to, and treat any
checkpoint or action block as a stop sign rather than an obstacle.

## Practical advice

- Warm up a new campaign rather than starting at full volume, even on an old account.
- Keep cold invites near zero. Follow-backs and accepted requests convert better and
  cannot be reported as unsolicited.
- Write templates that a person would write. Five structurally different messages
  beat fifty variations of one.
- If Instagram shows a checkpoint, complete it by hand in a normal tab and leave
  automation off for a day or two afterwards.
- Snapshot your existing following list as a protected baseline before the first
  cleanup run.
