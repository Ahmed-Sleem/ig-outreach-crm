/**
 * Real-UI actions: follow, unfollow and the Lexical DM composer.
 *
 * Every mutation in this extension is performed by driving the actual
 * instagram.com interface — the same buttons a person clicks — rather than by
 * calling a mutation endpoint directly. That is slower and more fragile, and it
 * is the whole point: a follow issued without the page's own telemetry, focus
 * history and pointer trail is the single easiest thing for Instagram to
 * distinguish from a human, and the account at risk is the owner's real one.
 *
 * Three rules the code below enforces:
 *
 *  1. An action is only reported as done once the UI has SETTLED into the new
 *     state. A click that Instagram silently rolled back (spam filter, action
 *     block) must be recorded as not-done, because recording it as done makes
 *     the campaign believe it is further along than it is and keeps spending.
 *  2. A message is verified against the composer before Send is touched, and
 *     against the thread after. The doubled-readback check exists because
 *     Lexical can leave the previous draft in place, and sending the same text
 *     twice to one person is exactly the pattern that gets a DM restricted.
 *  3. An action-block dialog anywhere on the page ends the run. Not the action —
 *     the run.
 *
 * Spacing between actions is NOT decided here: `core/governor.js` owns the
 * ceilings and hands this module a wait to spend.
 */

import { interruptibleWait } from './pacing.js';
import { generateHumanPath } from './human.js';
import {
  Label,
  collapse,
  composerScope,
  findActionBlockDialog,
  findButtonByLabel,
  findConfirmDialog,
  findDialogs,
  isProfileUnavailable,
  isRtlElement,
  threadBubbles,
} from './selectors.js';

/** Verification windows. Long enough for the UI, short enough to stay honest. */
export const SETTLE_MS = Object.freeze({
  follow: 3500,
  unfollow: 3500,
  dmSend: 6500,
  dmOpen: 7000,
  dialog: 2500,
});

export const ActionOutcome = Object.freeze({
  DONE: 'done',
  NOT_DONE: 'not_done',
  REFUSED: 'refused',
  SKIPPED: 'skipped',
  STOPPED: 'stopped',
});

/** A refusal carries the reason verbatim so the UI can show it. */
export function refusal(reason, extra = {}) {
  return { ok: false, outcome: ActionOutcome.REFUSED, reason, ...extra };
}

export function success(extra = {}) {
  return { ok: true, outcome: ActionOutcome.DONE, reason: null, ...extra };
}

/** A refusal whose outcome is not REFUSED (skipped, or a run-stopping block). */
export function halted(outcome, reason, extra = {}) {
  return { ok: false, outcome, reason, ...extra };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait used between checks. Injectable so tests run in milliseconds. */
function tickOf(ctx) {
  return ctx?.wait ?? interruptibleWait;
}

/** The jitter source. Injectable so a test can make "random" deterministic. */
function randomOf(ctx) {
  return typeof ctx?.random === 'function' ? ctx.random : Math.random;
}

/**
 * Where in the element to press.
 *
 * Never the exact centre: a hundred clicks that all land on the same pixel of a
 * button is a fingerprint no human produces. The point is inside the element and
 * away from its edges, so a jittered press cannot slip onto a neighbour.
 */
export function jitterPoint(rect, random = Math.random) {
  if (!rect || !Number.isFinite(rect.width) || rect.width <= 0) return { clientX: 0, clientY: 0 };
  const padX = Math.min(6, rect.width * 0.2);
  const padY = Math.min(4, rect.height * 0.2);
  return {
    clientX: Math.round(rect.left + padX + random() * Math.max(1, rect.width - padX * 2)),
    clientY: Math.round(rect.top + padY + random() * Math.max(1, rect.height - padY * 2)),
  };
}

/**
 * The points a pointer passes on the way to a target.
 *
 * A content script cannot move the operating system's cursor — that would need
 * the `debugger` permission, which this extension deliberately does not ask for.
 * What it can do is stop teleporting: the events that precede a press start where
 * the last press ended and arrive in a few uneven steps, which is what a real
 * pointer stream looks like to a listener on the page.
 */
export function approachPath(from, to, random = Math.random) {
  const start = { clientX: Number(from?.clientX ?? 0), clientY: Number(from?.clientY ?? 0) };
  const end = { clientX: Number(to?.clientX ?? 0), clientY: Number(to?.clientY ?? 0) };
  const steps = 3 + Math.floor(random() * 2);
  const points = [];
  for (let step = 1; step <= steps; step += 1) {
    const t = step / (steps + 1);
    points.push({
      clientX: Math.round(start.clientX + (end.clientX - start.clientX) * t + (random() - 0.5) * 14),
      clientY: Math.round(start.clientY + (end.clientY - start.clientY) * t + (random() - 0.5) * 14),
    });
  }
  points.push({ clientX: end.clientX, clientY: end.clientY });
  return points;
}

/** Is an action-block dialog on screen right now? */
export function isActionBlocked(document) {
  return Boolean(findActionBlockDialog(document));
}

/**
 * Wait until `predicate` holds, polling on a human-ish interval.
 * Returns `{ found, elapsedMs, ticks }` — never throws, because "it did not
 * appear" is a normal answer that the caller has to report honestly.
 */
export async function waitFor(ctx, predicate, { timeoutMs = 2500, intervalMs = 150, signal = null, label = 'condition' } = {}) {
  const wait = tickOf(ctx);
  const now = ctx?.now ?? (() => Date.now());
  const started = now();
  let ticks = 0;
  while (now() - started < timeoutMs) {
    if (signal?.aborted) return { found: false, elapsedMs: now() - started, ticks, reason: 'aborted', label };
    ticks += 1;
    let hit = null;
    try {
      hit = predicate();
    } catch {
      hit = null;
    }
    if (hit) return { found: true, value: hit, elapsedMs: now() - started, ticks, reason: null, label };
    await wait(Math.min(intervalMs, Math.max(20, timeoutMs - (now() - started))), { signal });
  }
  let last = null;
  try {
    last = predicate();
  } catch {
    last = null;
  }
  if (last) return { found: true, value: last, elapsedMs: now() - started, ticks, reason: null, label };
  return { found: false, elapsedMs: now() - started, ticks, reason: `${label} did not appear within ${timeoutMs}ms`, label };
}

/**
 * Click the way a person does: scroll into view, pause, then the full pointer
 * sequence. `element.click()` alone produces a click with no preceding pointer
 * events and no coordinates, which is trivially distinguishable.
 */
export async function humanClick(ctx, element, options = {}) {
  if (!element) return false;
  const wait = tickOf(ctx);
  const document = ctx.document;
  const signal = options.signal ?? null;
  const settleMs = options.settleMs ?? 120;

  try {
    element.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'auto' });
  } catch {
    /* older layouts without scrollIntoView options still scroll */
  }
  await wait(settleMs, { signal });

  const random = randomOf(ctx);
  const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
  const point = jitterPoint(rect, random);

  // Arrive, then press. `ctx.pointer` remembers where the last press ended, so a
  // run that follows twenty people produces twenty short journeys rather than
  // twenty clicks that appear from nowhere.
  ctx.pointer = ctx.pointer ?? {
    clientX: rect ? Math.round(rect.left + rect.width * 3) : 0,
    clientY: rect ? Math.round(rect.top - rect.height * 2) : 0,
  };
  const dispatch = (type, at, target = element) => {
    const view = target?.ownerDocument?.defaultView ?? ctx.window ?? globalThis.window ?? undefined;
    const detail = { bubbles: true, cancelable: true, composed: true, view, ...at };
    if (type === 'focus') {
      target.focus?.();
      return;
    }
    if (type === 'click' && typeof target.click === 'function') {
      target.click();
      return;
    }
    const PointerCtor = view?.PointerEvent ?? globalThis.PointerEvent;
    const MouseCtor = view?.MouseEvent ?? globalThis.MouseEvent;
    const EventCtor = view?.Event ?? globalThis.Event;
    try {
      if (type.startsWith('pointer') && typeof PointerCtor === 'function') {
        target.dispatchEvent(new PointerCtor(type, { ...detail, pointerId: 1, isPrimary: true, pointerType: 'mouse' }));
        return;
      }
      if (typeof MouseCtor === 'function' && (type === 'mousedown' || type === 'mouseup' || type === 'click' || type === 'mousemove' || type === 'mouseover')) {
        target.dispatchEvent(new MouseCtor(type, { ...detail, button: 0 }));
        return;
      }
      if (typeof EventCtor === 'function') {
        const ev = new EventCtor(type, { bubbles: true, cancelable: true });
        try { Object.assign(ev, at); } catch { /* readonly properties */ }
        target.dispatchEvent(ev);
        return;
      }
      target.dispatchEvent({ type, ...detail });
    } catch {
      try {
        target.dispatchEvent({ type, ...detail });
      } catch { /* minimal shim or strict EventTarget */ }
    }
  };

  const steps = generateHumanPath(ctx.pointer, point, {
    random,
    minSteps: 4,
    maxSteps: 14,
    allowOvershoot: false,
  });
  ctx.virtualCursor?.show?.(options.label ?? null);
  for (const step of steps) {
    if (signal?.aborted) return false;
    dispatch('pointermove', step);
    dispatch('mousemove', step);
    ctx.virtualCursor?.move?.(step.clientX, step.clientY);
    ctx.pointer = { clientX: step.clientX, clientY: step.clientY };
    await wait(8 + Math.round(random() * 18), { signal });
  }

  ctx.virtualCursor?.highlight?.(element);
  for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click']) {
    if (type === 'pointerdown') ctx.virtualCursor?.pulseClick?.(point.clientX, point.clientY);
    dispatch(type, point);
    if (type === 'pointerdown' || type === 'mouseup') await wait(40 + Math.round(random() * 60), { signal });
  }
  ctx.virtualCursor?.clearHighlight?.();
  ctx.pointer = point;
  return true;
}

/**
 * Read the relationship state off the buttons currently rendered.
 *
 * This is the ground truth for follow verification: Instagram's own UI, not a
 * second API read. `requested` is reported separately from `following` because
 * a private account never settles into Following, and treating Requested as a
 * failed follow would queue the same person again tomorrow.
 */
export function readRelationshipState(document) {
  const kinds = [Label.FOLLOWING, Label.REQUESTED, Label.FOLLOW, Label.FOLLOW_BACK];
  let hit = null;
  if (typeof document?.querySelectorAll === 'function') {
    for (const hdr of [...document.querySelectorAll('header')]) {
      if (hdr.closest?.('[role="dialog"]')) continue;
      hit = findButtonByLabel(hdr, kinds);
      if (hit) break;
    }
  }
  if (!hit) hit = findButtonByLabel(document, kinds);
  if (!hit) return { state: 'unknown', kind: null, reason: 'no relationship button rendered on this page' };
  const state = hit.kind === Label.FOLLOWING
    ? 'following'
    : hit.kind === Label.REQUESTED
      ? 'requested'
      : hit.kind === Label.FOLLOW_BACK
        ? 'follows_me'
        : 'none';
  return { state, kind: hit.kind, button: hit.button, reason: null };
}

/**
 * Follow the account on the current page.
 *
 * Refuses when the page is not a profile, when the button is already Following
 * or Requested (nothing to do, and clicking again would unfollow), when the
 * account looks like a business or mega account that settings protect, or when
 * an action block is on screen.
 */
export async function executeFollow(ctx, options = {}) {
  const { document, signal = null, settleMs = SETTLE_MS.follow, readyTimeoutMs = 0 } = { ...options };
  if (!document) return refusal('no document to act on');
  if (isActionBlocked(document)) return halted(ActionOutcome.STOPPED, 'Instagram is showing an action-block dialog; the run must stop');
  if (isProfileUnavailable(document)) return refusal('this profile is unavailable or was deleted');

  let before = readRelationshipState(document);
  if (!before.button && readyTimeoutMs > 0) {
    ctx.virtualCursor?.label?.('Waiting for profile…');
    const hydrated = await waitFor(ctx, () => {
      if (isActionBlocked(document) || isProfileUnavailable(document)) return { earlyExit: true };
      const cur = readRelationshipState(document);
      return cur.button ? cur : null;
    }, { timeoutMs: readyTimeoutMs, intervalMs: 150, signal, label: 'profile Follow button' });
    if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
    if (isActionBlocked(document)) return halted(ActionOutcome.STOPPED, 'Instagram is showing an action-block dialog; the run must stop');
    if (isProfileUnavailable(document)) return refusal('this profile is unavailable or was deleted');
    if (hydrated.found && hydrated.value?.button) before = hydrated.value;
    else before = readRelationshipState(document);
  }
  if (before.state === 'following') return halted(ActionOutcome.SKIPPED, 'already following this account');
  if (before.state === 'requested') return halted(ActionOutcome.SKIPPED, 'a follow request is already pending');
  if (!before.button) return refusal(before.reason ?? 'no Follow button found');

  await humanClick(ctx, before.button, { signal, label: 'Clicking Follow…' });
  if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });

  ctx.virtualCursor?.label?.('Verifying Follow…');
  const settled = await waitFor(ctx, () => {
    const now = readRelationshipState(document);
    return now.state === 'following' || now.state === 'requested' ? now : null;
  }, { timeoutMs: settleMs, signal, label: 'follow state' });

  if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
  if (isActionBlocked(document)) {
    return halted(ActionOutcome.STOPPED, 'Instagram blocked the follow ("Try Again Later"); the run must stop', { state: before.state });
  }
  if (!settled.found) {
    // The click did not take. Reporting this as done would let the campaign
    // believe it is further along than it is and keep spending the budget.
    return { ok: false, outcome: ActionOutcome.NOT_DONE, reason: settled.reason, state: readRelationshipState(document).state };
  }
  return success({
    state: settled.value.state,
    requested: settled.value.state === 'requested',
    elapsedMs: settled.elapsedMs,
  });
}

/**
 * Unfollow the account on the current page, including the confirm dialog.
 *
 * The grace period, whitelist and reply protections are enforced by
 * `core/lifecycle.js` before this is ever called; this function only performs
 * the click sequence and verifies it landed.
 */
export async function executeUnfollow(ctx, options = {}) {
  const { document, signal = null, settleMs = SETTLE_MS.unfollow, readyTimeoutMs = 0, allowRequested = false } = { ...options };
  if (!document) return refusal('no document to act on');
  if (isActionBlocked(document)) return halted(ActionOutcome.STOPPED, 'Instagram is showing an action-block dialog; the run must stop');
  if (isProfileUnavailable(document)) return refusal('this profile is unavailable or was deleted');

  let before = readRelationshipState(document);
  if (!before.button && readyTimeoutMs > 0) {
    ctx.virtualCursor?.label?.('Waiting for profile…');
    const hydrated = await waitFor(ctx, () => {
      if (isActionBlocked(document) || isProfileUnavailable(document)) return { earlyExit: true };
      const cur = readRelationshipState(document);
      return cur.button ? cur : null;
    }, { timeoutMs: readyTimeoutMs, intervalMs: 150, signal, label: 'profile relationship button' });
    if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
    if (isActionBlocked(document)) return halted(ActionOutcome.STOPPED, 'Instagram is showing an action-block dialog; the run must stop');
    if (isProfileUnavailable(document)) return refusal('this profile is unavailable or was deleted');
    if (hydrated.found && hydrated.value?.button) before = hydrated.value;
    else before = readRelationshipState(document);
  }
  const canClick = before.state === 'following' || (allowRequested && before.state === 'requested');
  if (!canClick) {
    return halted(ActionOutcome.SKIPPED, `not following this account (state: ${before.state})`);
  }

  await humanClick(ctx, before.button, { signal, label: 'Opening Following menu…' });
  if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });

  const dialog = await waitFor(ctx, () => findConfirmDialog(document), { timeoutMs: SETTLE_MS.dialog, signal, label: 'unfollow confirm dialog' });
  if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
  if (!dialog.found) {
    return { ok: false, outcome: ActionOutcome.NOT_DONE, reason: dialog.reason ?? 'the confirm dialog never appeared' };
  }
  await humanClick(ctx, dialog.value.confirm, { signal, label: 'Confirming Unfollow…' });
  if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });

  ctx.virtualCursor?.label?.('Verifying Unfollow…');
  const settled = await waitFor(ctx, () => {
    const now = readRelationshipState(document);
    return now.state === 'none' || now.state === 'follows_me' ? now : null;
  }, { timeoutMs: settleMs, signal, label: 'unfollow state' });

  if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
  if (isActionBlocked(document)) {
    return halted(ActionOutcome.STOPPED, 'Instagram blocked the unfollow; the run must stop');
  }
  if (!settled.found) return { ok: false, outcome: ActionOutcome.NOT_DONE, reason: settled.reason };
  return success({ state: settled.value.state, elapsedMs: settled.elapsedMs });
}

/* ------------------------------------------------------------------ direct DM */

/** The composer of the currently open thread, or null with a reason. */
export function findComposer(ctx, options = {}) {
  const { document, pathname = '' } = options;
  const editor = composerScope(document, pathname);
  if (!editor) return { editor: null, reason: 'no DM composer is open (a contenteditable outside a direct thread is a comment box, not a DM)' };
  return { editor, reason: null };
}

/**
 * Put the caret at the end of the composer.
 *
 * Direction matters for geometry, not for the text: in an RTL thread the visual
 * end of the line is on the left, and Lexical mirrors the caret accordingly. We
 * always collapse to the END of the content and let the browser place it, which
 * is correct in both directions — the mistake to avoid is computing a pixel
 * offset and assuming left-to-right.
 */
export function caretToEnd(ctx, editor) {
  const document = ctx.document;
  const getSel = ctx.getSelection ?? (typeof getSelection === 'function' ? getSelection : null);
  const current = getSel ? getSel() : document?.selection ?? null;
  if (!current || typeof document?.createRange !== 'function') {
    editor.focus?.();
    return { ok: false, reason: 'no selection API available', rtl: isRtlElement(editor) };
  }
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  current.removeAllRanges();
  current.addRange(range);
  editor.focus?.();
  return { ok: true, reason: null, rtl: isRtlElement(editor) };
}

/**
 * Read what the composer actually holds, normalised for comparison.
 *
 * innerText, not textContent: Lexical renders a line break as <br>, which
 * textContent drops entirely, so a two-line draft would compare as one long
 * word. innerText is what the person on the other end will see.
 */
export function readComposerText(editor) {
  if (!editor) return '';
  const rendered = typeof editor.innerText === 'string' ? editor.innerText : editor.textContent;
  return collapse(String(rendered ?? '').replace(/[\u200B-\u200D\uFEFF]/g, ''));
}

/**
 * The text Lexical should end up holding for a message.
 *
 * Line breaks collapse to a single space, so the comparison asks "did every line
 * arrive" rather than "did the DOM keep my newline elements".
 */
export function expectedComposerText(message) {
  return collapse(String(message ?? '').split('\n').join(' '));
}

/** True when the rendered text is the message written twice. */
export function isDoubled(rendered, message) {
  const once = expectedComposerText(message);
  if (!once) return false;
  const text = collapse(rendered);
  return text === `${once} ${once}` || text === `${once}${once}`;
}

/**
 * Type a message into the composer and VERIFY it before anything is sent.
 *
 * The sequence is caret-to-end, select-all, delete, insert line by line, then
 * read the composer back. A doubled draft or a partial one is refused here,
 * because after Send it is too late: the person has already received it.
 */
export async function composeMessage(ctx, options = {}) {
  const { document, message, editor = null, signal = null, pathname = '' } = options;
  const text = String(message ?? '');
  if (!text.trim()) return refusal('the message is empty');
  if (text.length > 1000) return refusal(`the message is ${text.length} bytes; Instagram's composer limit is 1000`);

  const found = findComposer(ctx, { document, pathname });
  const target = editor ?? found.editor;
  if (!target) return refusal(found.reason);

  ctx.virtualCursor?.label?.('Typing message…');
  try { target.focus?.(); } catch { /* noop */ }
  caretToEnd(ctx, target);
  if (readComposerText(target)) {
    document.execCommand?.('selectAll');
    document.execCommand?.('delete');
    if (readComposerText(target)) {
      return refusal('the composer still holds text after clearing it; refusing to type on top of someone else\'s draft');
    }
  }

  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'stopped while composing', { stoppedByOwner: true });
    if (index > 0) document.execCommand?.('insertLineBreak');
    const inserted = document.execCommand?.('insertText', false, lines[index]);
    if (inserted === false && typeof globalThis.InputEvent === 'function') {
      try {
        target.dispatchEvent?.(new globalThis.InputEvent('beforeinput', {
          inputType: 'insertText',
          data: lines[index],
          bubbles: true,
          cancelable: true,
        }));
      } catch { /* shim */ }
    }
    await tickOf(ctx)(60 + Math.round(randomOf(ctx)() * 90), { signal });
  }

  const rendered = readComposerText(target);
  const expected = expectedComposerText(text);
  if (isDoubled(rendered, text)) {
    document.execCommand?.('selectAll');
    document.execCommand?.('delete');
    return refusal('the composer rendered the message twice; the draft was cleared and nothing was sent');
  }
  if (rendered !== expected) {
    return refusal(`the composer holds "${rendered}" but the message was "${expected}"; nothing was sent`, { rendered, expected });
  }
  return success({ rendered, lines: lines.length, rtl: isRtlElement(target), editor: target });
}

/** The newest bubble in the open thread, or null. */
export function newestBubble(document) {
  const bubbles = threadBubbles(document);
  return bubbles.length ? bubbles[bubbles.length - 1] : null;
}

/**
 * Is the newest message in the open thread one of ours?
 *
 * `ours` is decided by the caller: the extension marks its own bubbles, and
 * Instagram's own DOM gives no reliable "sent by me" attribute across locales.
 * Default is a text comparison, which is enough for the doubled-send check.
 */
export function newestIsOurs(document, message) {
  const bubble = newestBubble(document);
  if (!bubble) return false;
  return collapse(bubble.textContent).includes(expectedComposerText(message));
}

/** Has the thread been opened before? One existing bubble is enough to skip. */
export function hasExistingThread(document) {
  return threadBubbles(document).length > 0;
}

/** Receipt wording Instagram renders under the newest message, per locale. */
export const SEEN_RECEIPT_TEXT = Object.freeze(['Seen', 'تمت المشاهدة', 'شوهد']);

/**
 * Does the open thread show a "Seen" receipt?
 *
 * The receipt is a sibling of the last bubble, not part of it, so the search is
 * scoped to the thread container and matches the wording exactly. Substring
 * matching would report a person called "Seena" as a read receipt.
 */
export function threadShowsSeen(document) {
  const bubbles = threadBubbles(document);
  if (!bubbles.length) return false;
  const scope = bubbles[bubbles.length - 1].parentNode;
  if (!scope) return false;
  const wanted = new Set(SEEN_RECEIPT_TEXT.map((text) => collapse(text).toLowerCase()));
  for (const node of scope.querySelectorAll('span, div, time')) {
    if (node === bubbles[bubbles.length - 1]) continue;
    if (wanted.has(collapse(node.textContent).toLowerCase())) return true;
  }
  return false;
}

/**
 * Open the DM thread for the account on the current page.
 *
 * Prefers the Message button on the profile. When there is none — Instagram
 * hides it for accounts that restrict messages, and for some business profiles —
 * the caller may navigate to /direct/new/{username}/ instead, which this
 * function reports as `needsNavigation` rather than pretending the thread opened.
 */
export async function openDm(ctx, options = {}) {
  const { document, signal = null, timeoutMs = SETTLE_MS.dmOpen, readyTimeoutMs = 0 } = options;
  if (!document) return refusal('no document to act on');
  if (isProfileUnavailable(document)) return refusal('this profile is unavailable or was deleted');

  let hit = findButtonByLabel(document, [Label.MESSAGE]);
  if (!hit && readyTimeoutMs > 0) {
    ctx.virtualCursor?.label?.('Waiting for profile…');
    const hydrated = await waitFor(ctx, () => {
      if (isActionBlocked(document) || isProfileUnavailable(document)) return { earlyExit: true };
      const msg = findButtonByLabel(document, [Label.MESSAGE]);
      if (msg) return msg;
      // If the profile header already rendered Follow/Following with no Message
      // button, don't wait the full timeout — this profile hides Message.
      const rel = readRelationshipState(document);
      if (rel.button) return { noMessageButton: true };
      return null;
    }, { timeoutMs: readyTimeoutMs, intervalMs: 150, signal, label: 'profile Message button' });
    if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
    if (isProfileUnavailable(document)) return refusal('this profile is unavailable or was deleted');
    if (hydrated.found && hydrated.value?.button) hit = hydrated.value;
    else hit = findButtonByLabel(document, [Label.MESSAGE]);
  }
  if (!hit) {
    return refusal('this profile renders no Message button', { needsNavigation: true });
  }
  await humanClick(ctx, hit.button, { signal, label: 'Clicking Message…' });
  if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });

  ctx.virtualCursor?.label?.('Opening message thread…');
  const opened = await waitFor(ctx, () => composerScope(document, '/direct/'), { timeoutMs, signal, label: 'DM composer' });
  if (!opened.found) {
    return { ok: false, outcome: ActionOutcome.NOT_DONE, reason: opened.reason, needsNavigation: true };
  }
  // The editor stays here: a DOM node cannot cross the storage bridge, and the
  // caller only needs to know the composer is open.
  return success({ elapsedMs: opened.elapsedMs, existingThread: hasExistingThread(document), composerFound: true });
}

/**
 * Send one message to the open thread.
 *
 * Refuses to send into a thread that already has messages unless `allowExisting`
 * is set: the funnel's rule is one first message, and a second message to a
 * stranger who never answered is what Instagram's spam classifier looks for.
 */
export async function executeDm(ctx, options = {}) {
  const {
    document,
    message,
    signal = null,
    pathname = '',
    allowExisting = false,
    settleMs = SETTLE_MS.dmSend,
  } = options;

  if (!document) return refusal('no document to act on');
  if (isActionBlocked(document)) return halted(ActionOutcome.STOPPED, 'Instagram is showing an action-block dialog; the run must stop');
  if (hasExistingThread(document) && !allowExisting) {
    return halted(ActionOutcome.SKIPPED, 'this thread already has messages; the funnel sends one first message only', { existingThread: true });
  }

  const composed = await composeMessage(ctx, { document, message, signal, pathname });
  if (!composed.ok) return composed;
  const editor = composed.editor;

  if (isDoubled(readComposerText(editor), message)) {
    return refusal('the composer doubled the message after verification; nothing was sent');
  }

  const send = findButtonByLabel(document, [Label.SEND]);
  if (!send) {
    return { ok: false, outcome: ActionOutcome.NOT_DONE, reason: 'the composer holds the message but no Send button is rendered' };
  }
  await humanClick(ctx, send.button, { signal, label: 'Clicking Send…' });
  if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });

  ctx.virtualCursor?.label?.('Verifying delivery…');

  const cleared = await waitFor(ctx, () => (readComposerText(editor) === '' ? editor : null), { timeoutMs: settleMs, signal, label: 'composer cleared after send' });
  if (!cleared.found) {
    return { ok: false, outcome: ActionOutcome.NOT_DONE, reason: 'Send was clicked but the composer still holds the message', rendered: readComposerText(editor) };
  }
  const delivered = await waitFor(ctx, () => (newestIsOurs(document, message) ? newestBubble(document) : null), {
    timeoutMs: Math.max(1000, settleMs - cleared.elapsedMs),
    signal,
    label: 'message bubble in thread',
  });
  if (!delivered.found) {
    return { ok: false, outcome: ActionOutcome.NOT_DONE, reason: 'the composer cleared but the message never appeared in the thread' };
  }
  return success({
    clearedMs: cleared.elapsedMs,
    deliveredMs: delivered.elapsedMs,
    seen: threadShowsSeen(document),
    rtl: composed.rtl,
  });
}
