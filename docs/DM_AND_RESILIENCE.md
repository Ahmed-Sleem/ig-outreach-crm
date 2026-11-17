# Direct Messaging & Per-Account Resilience Specification

This document enumerates every known 2026 desktop Instagram Direct Messaging path, UI exception, and per-account skip/stop rule enforced by the extension across **Follow**, **Messages**, and **Unfollow**.

---

## 1. Human DM Entry Paths (Profile to Open Composer)

When messaging `@target`, the extension navigates to `https://www.instagram.com/<target>/` (unless the active tab is already inside a verified Direct thread or open floating dock belonging to `@target`) and behaves exactly like a normal desktop user:

| # | Profile / Page State | What Instagram Renders | How the Extension Handles It |
|---|---|---|---|
| **1** | **Header "Message" button -> Floating chat dock** | `<header>` (or responsive `<main>` action bar outside `<article>` / `[role="dialog"]`) renders a visible `Message` button (`div[role="button"]` or `button`, English `Message` / Arabic `مراسلة`, matched via `nonSvgButtonText` stripping `<svg>` subtrees). Clicking it keeps the URL on `/<target>/` and opens the floating bottom-right Direct chat dock (NOT a `[role="dialog"]`; root contains `[Go back]`, target profile `<a>`, `[Expand]`, `[Close]` SVG-title buttons and a `div[contenteditable="true"][role="textbox"][data-lexical-editor="true"][aria-placeholder="Message..."]`). | Clicks the visible `Message` button, detects the floating dock surface (`kind: 'dock'`), waits for initial thread hydration (`[role="progressbar"]` + 250 ms settle), verifies the dock belongs to `@target`, scopes restriction check (chrome outside message bubbles), existing-thread check, typing, Send, and delivery verification strictly inside the dock container. |
| **2** | **Header "Message" button -> Full `/direct/t/<threadId>/` page (SPA)** | Clicking `Message` pushes `/direct/t/<threadId>/` via Instagram's SPA router and mounts the full Direct inbox thread inside `<main>`. | Detects `kind: 'direct_page'`, waits for hydration, verifies the open thread matches `@target`, checks restrictions/existing messages, composes, sends, and verifies delivery inside the thread panel. |
| **3** | **Header "Message" button -> Full `/direct/t/<threadId>/` page (hard reload)** | Clicking `Message` causes a full browser navigation to `/direct/t/<threadId>/`, tearing down the content script mid-command. | `sendWithNavigation` detects that the tab URL transitioned to `/direct/t/...`, waits for load, re-prepares the content script, and resumes `EXECUTE_DM` directly on the open thread once. |
| **4** | **No header "Message" button -> Hidden inside `•••` Options menu** | `<header>` (or responsive `<main>` bar) renders `Follow`/`Following` and a visible icon-only `Options` button (`div[role="button"]` containing `<svg><title>Options</title></svg>`), with no `Message` button. Clicking `Options` opens `[role="dialog"]` containing `Block`, `Restrict`, `Report`, `Share to...`, `About this account`, and **`Send message`** (`إرسال رسالة`). | Detects no profile `Message` button after hydration, clicks the visible `Options` button, waits for `[role="dialog"]`, clicks `Send message`, then handles whichever surface opens (floating dock, `/direct/t/`, dialog, or restriction notice). |
| **5** | **No header "Message" button AND no "Send message" in `•••` Options menu** | Clicking `Options` opens `[role="dialog"]` (`Block`, `Restrict`, `Report`, `About this account`, etc.) with **no** `Send message` option at all (e.g., private account or messaging disabled). | Closes the `Options` dialog cleanly (`Cancel`/`Close` or `Escape`), returns `outcome: 'skipped'` with `dmUnavailable: true`, marks the lead `DM_UNAVAILABLE`, and immediately moves to the next lead. |
| **6** | **Stale floating dock from a previous user still open on screen** | After messaging `@userA` in the floating dock, navigating to `@userB` leaves `@userA`'s dock open in the bottom-right corner. | `dmContainerMatchesUser(dock, target)` detects the mismatch, clicks the dock's `Close` button (`svg title="Close"` / `aria-label="Close"`), waits for it to close, and only then clicks `Message` on `@userB`'s profile. Never sends `@userB`'s message into `@userA`'s chat. |
| **7** | **Composer opens for `@target`, but thread already has messages** | Floating dock renders `[role="article"]` bubbles (scoped strictly inside the dock — ignoring profile `<article>` elements behind it), or `/direct/t/` renders non-system `[role="row"]` messages inside the messages `[role="grid"]` (ignoring `"View profile"` cards, encryption banners, and timestamps). | Unless `allowExisting` is enabled, returns `outcome: 'skipped'` with `existingThread: true`, records `DM_EXISTING_THREAD_SKIPPED`, and moves straight to the next lead. |
| **8** | **Restriction notice inside opened dock or `/direct/t/`** | Thread opens with no composer (or with a restriction notice): `"You can't message this account unless they follow you"`, `"Not everyone can message this account"`, `"This account can't receive your message"`, `"doesn't allow new message requests"`, or Arabic equivalents. | Detected strictly from DM chrome outside message bubbles (`dmChromeText`, so an incoming chat bubble mentioning those words never triggers a false positive); returns `outcome: 'skipped'` with `dmUnavailable: true`, records `DM_UNAVAILABLE`, and moves to the next lead. |
| **9** | **One-message invite limit already used** | Thread shows `"Invite sent"` / `"You can send more messages after your invite is accepted"` (or Arabic equivalent). | Detected immediately; returns `outcome: 'skipped'` with `inviteAlreadySent: true`, records `DM_SENT_REQUEST` (one-message lock), and moves to the next lead. |
| **10** | **Profile unavailable / deleted / 404** | Profile page renders `"Sorry, this page isn't available"` / `"The link you followed may be broken"` (or Arabic equivalent). | Returns `outcome: 'skipped'` with `profileUnavailable: true`, records `DM_UNAVAILABLE` (for DM) or unavailable observation (for Follow/Unfollow), and moves straight to the next lead. |

---

## 2. Lexical Composer Typing, Sending & Verification

2026 desktop Instagram uses Meta's **Lexical** editor (`div[contenteditable="true"][role="textbox"][data-lexical-editor="true"]`):

1. **Focus & selection activation**: Perform a human pointer click on the Lexical textbox before placing the caret at the end (`caretToEnd`). Without a pointer click, Lexical can keep its internal selection `null` and silently ignore text commands.
2. **Existing draft clearing**: Only invoke `selectAll` + `delete` (with a `beforeinput` `deleteContentBackward` fallback when Lexical ignores `execCommand('delete')`) when the composer is non-empty, then wait ~60ms before inserting text so Lexical's post-selection-command suppression flag clears.
3. **Line-by-line text insertion with safe fallbacks**:
   - Normalize `\r\n` / `\r` newlines to `\n` before splitting and before verifying expected text.
   - Primary: `document.execCommand('insertText', false, line)` (and `insertLineBreak` with a `beforeinput` `insertLineBreak` fallback between lines) with natural inter-line cadence.
   - Fallback A (if composer stayed empty): synthetic `ClipboardEvent('paste')` with `DataTransfer` (`text/plain`), handled natively by Lexical's `PASTE_COMMAND`.
   - Fallback B (if still empty): `InputEvent('beforeinput', { inputType: 'insertText', data })` + `InputEvent('input')`.
4. **Strict pre-send verification**: Read back `readComposerText(editor)` (normalizing zero-width characters, non-breaking spaces, and CRLF). Refuse and clear if doubled; refuse without sending if partial/mismatched.
5. **Waiting for the Send control**: When empty, the dock renders `[Emoji, Voice Clip, Add Photo or Video, GIF]` with **no Send button**. After typing, wait up to `1500ms` for React/Lexical to swap in a visible, interactive (not `disabled` / `aria-disabled="true"`) `Send` button (`text`, `aria-label`, `svg[aria-label]`, OR `<svg><title>Send</title></svg>`, scoped strictly to the active DM container).
6. **Enter-to-send fallback**: Only when a live, connected Lexical (`data-lexical-editor="true"`) composer (re-queried from the active DM container in case React remounted it) has valid verified text and no interactive `Send` button appears after waiting, submit via a real `Enter` (`keydown` -> `keypress` -> `keyup`, `shiftKey: false`). Never press `Enter` after clicking a `Send` button (prevents accidental double-sends).
7. **Post-send delivery verification**: Wait for the composer to clear (or unmount on invite transition) AND verify either (a) the sent text appears in the active DM container (`[role="article"]`, `[role="row"]`, or an optimistic message bubble strictly outside the composer) or (b) Instagram transitions the new one-message request into the `"Invite sent"` / `"You can send more messages after your invite is accepted"` state (`deliveryKind: 'invite_sent'`), while continuously watching for action blocks or `"Failed to send"` notices.

---

## 3. Universal Default Per-Account Skip vs. Run-Stopping Errors

Automatic per-account skip-and-continue is built in by default across **Follow**, **Messages**, and **Unfollow** (no toggle or extra button required):

### Always Skip This Account & Continue to Next Lead
- Account already followed / follow request pending / not currently following (for unfollow)
- Existing DM conversation (`existingThread`)
- Messaging unavailable: no `Message` button and no `Send message` in `•••` menu, or restriction notice (`dmUnavailable`)
- Invite already sent (`inviteAlreadySent`)
- Profile 404 / deleted / broken (`profileUnavailable`)
- Single-account UI failure or timeout (e.g., button missing, state did not settle, composer failed to open on one specific account) — recorded on that lead (`attempts += 1`, `lastError`) while the run continues to the next lead
- Transient per-account exception inside the loop (caught per lead so one broken account never crashes the queue)

Expected skips (`outcome: 'skipped'`) **never** increment the consecutive-failure counter — a run can skip dozens of restricted or already-handled accounts in a row and still process every eligible lead cleanly.

### Always Stop the Entire Run Immediately
- **Owner Stop**: Dashboard Stop button or in-page HUD Stop button (`RunPhase.STOPPED`, never trips the circuit breaker)
- **Platform Action Block / Rate Limit / Challenge**: `"Try Again Later"`, `"Action Blocked"`, checkpoint (`RunPhase.BLOCKED`, persists circuit breaker)
- **Session Lost / Logged Out**: Instagram tab is no longer logged in (`RunPhase.FAILED` / `severity: 'session'`)
- **Tab Permanently Closed**: The controlled Instagram tab was closed (`RunPhase.FAILED` / `severity: 'tab'`)
- **Safety Governor Cap / Outside Active Hours**: Hourly/daily ceiling reached or active window closed (`RunPhase.CAPPED`)
- **Systemic Repeated Hard Failures**: `MAX_CONSECUTIVE_FAILURES` consecutive unexpected hard failures (`not_done` / thrown errors, excluding all expected skips) with zero successes in between (`RunPhase.FAILED`, `severity: 'page'`)
