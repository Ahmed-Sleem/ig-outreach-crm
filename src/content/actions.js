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
  detectDmRestriction,
  dmContainerUserMatch,
  findActionBlockDialog,
  findButtonByLabel,
  findConfirmDialog,
  findDialogs,
  findDmDockCloseButton,
  findDmSurface,
  findOpenDmDock,
  findOptionsDialogSendMessage,
  findProfileMessageButton,
  findProfileOptionsButton,
  findSendButton,
  hasMessageEditorCue,
  isProfileUnavailable,
  isRtlElement,
  threadBubbles,
} from './selectors.js';

/** Verification windows. Long enough for the UI, short enough to stay honest. */
export const SETTLE_MS = Object.freeze({
  follow: 3500,
  unfollow: 3500,
  dmSend: 7000,
  dmSendButton: 1500,
  dmOpen: 10000,
  dialog: 3000,
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
  if (isActionBlocked(document)) return halted(ActionOutcome.STOPPED, 'Instagram is showing an action-block dialog; the run must stop', { severity: 'account' });
  if (isProfileUnavailable(document)) return halted(ActionOutcome.SKIPPED, 'this profile is unavailable or was deleted', { profileUnavailable: true });

  let before = readRelationshipState(document);
  if (!before.button && readyTimeoutMs > 0) {
    ctx.virtualCursor?.label?.('Waiting for profile…');
    const hydrated = await waitFor(ctx, () => {
      if (isActionBlocked(document) || isProfileUnavailable(document)) return { earlyExit: true };
      const cur = readRelationshipState(document);
      return cur.button ? cur : null;
    }, { timeoutMs: readyTimeoutMs, intervalMs: 150, signal, label: 'profile Follow button' });
    if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
    if (isActionBlocked(document)) return halted(ActionOutcome.STOPPED, 'Instagram is showing an action-block dialog; the run must stop', { severity: 'account' });
    if (isProfileUnavailable(document)) return halted(ActionOutcome.SKIPPED, 'this profile is unavailable or was deleted', { profileUnavailable: true });
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
  if (isActionBlocked(document)) return halted(ActionOutcome.STOPPED, 'Instagram is showing an action-block dialog; the run must stop', { severity: 'account' });
  if (isProfileUnavailable(document)) return halted(ActionOutcome.SKIPPED, 'this profile is unavailable or was deleted', { profileUnavailable: true });

  let before = readRelationshipState(document);
  if (!before.button && readyTimeoutMs > 0) {
    ctx.virtualCursor?.label?.('Waiting for profile…');
    const hydrated = await waitFor(ctx, () => {
      if (isActionBlocked(document) || isProfileUnavailable(document)) return { earlyExit: true };
      const cur = readRelationshipState(document);
      return cur.button ? cur : null;
    }, { timeoutMs: readyTimeoutMs, intervalMs: 150, signal, label: 'profile relationship button' });
    if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
    if (isActionBlocked(document)) return halted(ActionOutcome.STOPPED, 'Instagram is showing an action-block dialog; the run must stop', { severity: 'account' });
    if (isProfileUnavailable(document)) return halted(ActionOutcome.SKIPPED, 'this profile is unavailable or was deleted', { profileUnavailable: true });
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
  const surface = findDmSurface(document, pathname);
  if (!surface?.editor) {
    return { editor: null, surface: null, reason: 'no DM composer is open (a contenteditable outside a direct thread is a comment box, not a DM)' };
  }
  return { editor: surface.editor, surface, reason: null };
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
/** Notify Lexical and similar editors that DOM selection changed. */
function fireSelectionChange(ctx, editor) {
  const doc = editor?.ownerDocument ?? ctx?.document ?? null;
  const view = doc?.defaultView ?? ctx?.window ?? globalThis.window ?? null;
  const EventCtor = view?.Event ?? globalThis.Event;
  if (typeof EventCtor !== 'function') return;
  for (const target of [doc, editor, view]) {
    if (!target || typeof target.dispatchEvent !== 'function') continue;
    try { target.dispatchEvent(new EventCtor('selectionchange', { bubbles: false })); } catch { /* shim */ }
  }
}

/**
 * Give Lexical/React two animation frames (in a real browser) or a short tick
 * (in tests) to observe `selectionchange` and reconcile DOM changes.
 */
async function waitForEditorFrame(ctx, signal = null) {
  if (signal?.aborted) return;
  if (!ctx?.wait && typeof globalThis.requestAnimationFrame === 'function') {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const timer = setTimeout(finish, 80);
      if (typeof timer?.unref === 'function') timer.unref();
      globalThis.requestAnimationFrame(() => {
        globalThis.requestAnimationFrame(() => {
          clearTimeout(timer);
          finish();
        });
      });
    });
    return;
  }
  await Promise.resolve();
}

/**
 * Put focus and caret INSIDE the composer's innermost Lexical `<p>` (or editor
 * root when no `<p>` exists), fire `selectionchange` so Lexical syncs
 * `$getSelection()`, and collapse to the END (safe for both LTR and RTL).
 */
export function caretToEnd(ctx, editor, { selectAll = false } = {}) {
  const document = ctx.document ?? editor?.ownerDocument;
  // Focus FIRST so the browser accepts DOM selection ranges inside the editor.
  try { editor.focus?.(); } catch { /* noop */ }
  const getSel = ctx.getSelection ?? (typeof getSelection === 'function' ? getSelection : null);
  const current = getSel ? getSel() : document?.getSelection?.() ?? document?.selection ?? null;
  if (!current || typeof document?.createRange !== 'function') {
    return { ok: false, reason: 'no selection API available', rtl: isRtlElement(editor) };
  }
  const range = document.createRange();
  if (selectAll) {
    range.selectNodeContents(editor);
  } else {
    // Placing the collapsed caret inside the last `<p>` (instead of after `<p>`
    // on the outer contenteditable `<div>`) matches what Lexical expects for
    // `$getSelection()` and `KEY_ENTER_COMMAND`.
    let anchor = editor;
    if (typeof editor.querySelectorAll === 'function') {
      const paragraphs = [...editor.querySelectorAll('p')];
      if (paragraphs.length > 0) anchor = paragraphs[paragraphs.length - 1];
    }
    range.selectNodeContents(anchor);
    range.collapse(false);
  }
  current.removeAllRanges();
  current.addRange(range);
  fireSelectionChange(ctx, editor);
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
  if (String(editor.tagName ?? '').toUpperCase() === 'TEXTAREA') {
    return collapse(String(editor.value ?? '').replace(/[\u200B-\u200F\uFEFF]/g, ''));
  }
  const rendered = typeof editor.innerText === 'string' ? editor.innerText : editor.textContent;
  return collapse(String(rendered ?? '').replace(/[\u200B-\u200F\uFEFF]/g, ''));
}

/**
 * The text Lexical should end up holding for a message.
 *
 * Line breaks collapse to a single space, so the comparison asks "did every line
 * arrive" rather than "did the DOM keep my newline elements".
 */
export function expectedComposerText(message) {
  return collapse(String(message ?? '').replace(/\r\n?/g, '\n').split('\n').join(' '));
}

/** True when the rendered text is the message written twice. */
export function isDoubled(rendered, message) {
  const once = expectedComposerText(message);
  if (!once) return false;
  const text = collapse(rendered);
  return text === `${once} ${once}` || text === `${once}${once}`;
}

/** Build a Chromium-honored `StaticRange[]` from the live DOM selection (or inner `<p>`). */
function currentStaticRanges(ctx, target) {
  try {
    const view = target?.ownerDocument?.defaultView ?? ctx?.window ?? globalThis.window ?? globalThis;
    const StaticRangeCtor = view?.StaticRange ?? globalThis.StaticRange;
    if (typeof StaticRangeCtor !== 'function') return [];
    const getSel = ctx?.getSelection ?? (typeof getSelection === 'function' ? getSelection : null);
    const sel = getSel ? getSel() : target?.ownerDocument?.getSelection?.() ?? null;
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      if (r) {
        return [new StaticRangeCtor({
          startContainer: r.startContainer,
          startOffset: r.startOffset,
          endContainer: r.endContainer,
          endOffset: r.endOffset,
          collapsed: r.collapsed,
        })];
      }
    }
    const anchor = (typeof target.querySelector === 'function' && target.querySelector('p')) || target;
    return [new StaticRangeCtor({
      startContainer: anchor,
      startOffset: 0,
      endContainer: anchor,
      endOffset: 0,
      collapsed: true,
    })];
  } catch {
    return [];
  }
}

/** Dispatch a real plain-text paste event (Lexical handles PASTE_COMMAND natively). */
function dispatchPlainTextPaste(target, text) {
  try {
    const view = target?.ownerDocument?.defaultView ?? globalThis.window ?? globalThis;
    const ClipboardCtor = view?.ClipboardEvent ?? globalThis.ClipboardEvent;
    const DataTransferCtor = view?.DataTransfer ?? globalThis.DataTransfer;
    if (typeof ClipboardCtor !== 'function' || typeof DataTransferCtor !== 'function') return false;
    const dt = new DataTransferCtor();
    dt.setData('text/plain', text);
    const ev = new ClipboardCtor('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    if (!ev.clipboardData || !ev.clipboardData.getData?.('text/plain')) {
      try { Object.defineProperty(ev, 'clipboardData', { value: dt, configurable: true }); } catch { /* noop */ }
    }
    target.dispatchEvent?.(ev);
    return true;
  } catch {
    return false;
  }
}

/**
 * Dispatch a spec-compliant `beforeinput` carrying `targetRanges` in the init
 * dict (honored across Chrome's ISOLATED-world boundary by Lexical 0.52+).
 */
function dispatchLexicalBeforeInput(ctx, target, text, inputType = 'insertText') {
  try {
    const view = target?.ownerDocument?.defaultView ?? ctx?.window ?? globalThis.window ?? globalThis;
    const InputCtor = view?.InputEvent ?? globalThis.InputEvent;
    if (typeof InputCtor !== 'function') return false;
    const targetRanges = currentStaticRanges(ctx, target);
    const init = {
      inputType,
      bubbles: true,
      cancelable: true,
      composed: true,
      ...(targetRanges.length ? { targetRanges } : {}),
    };
    if (inputType === 'insertFromPaste') {
      const DataTransferCtor = view?.DataTransfer ?? globalThis.DataTransfer;
      if (typeof DataTransferCtor === 'function') {
        const dt = new DataTransferCtor();
        dt.setData('text/plain', text);
        init.dataTransfer = dt;
      } else {
        init.data = text;
      }
    } else if (text !== null && text !== undefined) {
      init.data = text;
    }
    target.dispatchEvent?.(new InputCtor('beforeinput', init));
    return true;
  } catch {
    return false;
  }
}

/** Dispatch a real Enter key sequence on a Lexical composer. */
function dispatchEnterKey(ctx, target) {
  const view = target?.ownerDocument?.defaultView ?? ctx.window ?? globalThis.window ?? undefined;
  const KeyCtor = view?.KeyboardEvent ?? globalThis.KeyboardEvent;
  const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, shiftKey: false, bubbles: true, cancelable: true, composed: true, view };
  for (const type of ['keydown', 'keypress', 'keyup']) {
    try {
      if (typeof KeyCtor === 'function') {
        target.dispatchEvent?.(new KeyCtor(type, init));
      } else {
        target.dispatchEvent?.({ type, ...init });
      }
    } catch {
      try { target.dispatchEvent?.({ type, ...init }); } catch { /* shim */ }
    }
  }
}

/** Dispatch Escape to dismiss a modal dialog (such as an Options menu without Send message). */
function dispatchEscapeKey(ctx, document) {
  const target = document?.activeElement ?? document?.body ?? document;
  if (!target?.dispatchEvent) return;
  const view = target?.ownerDocument?.defaultView ?? ctx.window ?? globalThis.window ?? undefined;
  const KeyCtor = view?.KeyboardEvent ?? globalThis.KeyboardEvent;
  const init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true, view };
  for (const type of ['keydown', 'keyup']) {
    try {
      if (typeof KeyCtor === 'function') target.dispatchEvent(new KeyCtor(type, init));
      else target.dispatchEvent({ type, ...init });
    } catch { /* shim */ }
  }
}

/**
 * Type a message into the composer and VERIFY it before anything is sent.
 *
 * The sequence is click/focus (activates Lexical's internal selection),
 * caret inside `<p>` + `selectionchange` + frame settle, clear any pre-existing
 * draft with a post-clear beat so Lexical never swallows the next insertText,
 * insert line by line (with Chromium ISOLATED-world Lexical fallbacks:
 * plain-text `paste`, `beforeinput(insertFromPaste + targetRanges)`, and
 * `beforeinput(insertText + targetRanges)` if `execCommand` did not stick),
 * then read the composer back. A doubled or partial draft is refused before Send.
 */
export async function composeMessage(ctx, options = {}) {
  const { document, message, editor = null, signal = null, pathname = '' } = options;
  const text = String(message ?? '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return refusal('the message is empty');
  if (text.length > 1000) return refusal(`the message is ${text.length} bytes; Instagram's composer limit is 1000`);

  const found = findComposer(ctx, { document, pathname });
  const target = editor ?? found.editor;
  if (!target) return refusal(found.reason);

  ctx.virtualCursor?.label?.('Typing message…');
  const rect = typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null;
  if (rect && rect.width > 0 && rect.height > 0) {
    await humanClick(ctx, target, { signal, settleMs: 60, label: 'Focusing message box…' });
    if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'stopped while composing', { stoppedByOwner: true });
  }
  caretToEnd(ctx, target);
  await waitForEditorFrame(ctx, signal);
  if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'stopped while composing', { stoppedByOwner: true });

  if (String(target.tagName ?? '').toUpperCase() === 'TEXTAREA') {
    const view = target?.ownerDocument?.defaultView ?? ctx.window ?? globalThis.window;
    const setter = Object.getOwnPropertyDescriptor(view?.HTMLTextAreaElement?.prototype ?? {}, 'value')?.set;
    if (setter) setter.call(target, text);
    else target.value = text;
    try { target.dispatchEvent?.(new (view?.Event ?? Event)('input', { bubbles: true })); } catch { /* shim */ }
    await tickOf(ctx)(80, { signal });
    const rendered = readComposerText(target);
    const expected = expectedComposerText(text);
    if (rendered !== expected) {
      return refusal(`the composer holds "${rendered}" but the message was "${expected}"; nothing was sent`, { rendered, expected });
    }
    return success({ rendered, lines: text.split('\n').length, rtl: isRtlElement(target), editor: target, container: found.surface?.container ?? null });
  }

  if (readComposerText(target)) {
    caretToEnd(ctx, target, { selectAll: true });
    await waitForEditorFrame(ctx, signal);
    document.execCommand?.('selectAll');
    document.execCommand?.('delete');
    // Lexical can suppress an immediate insertText on the same tick after
    // handled selectAll/delete; let one short beat settle first.
    await tickOf(ctx)(60, { signal });
    if (readComposerText(target)) {
      caretToEnd(ctx, target, { selectAll: true });
      await waitForEditorFrame(ctx, signal);
      document.execCommand?.('selectAll');
      dispatchLexicalBeforeInput(ctx, target, null, 'deleteContentBackward');
      await tickOf(ctx)(60, { signal });
    }
    if (readComposerText(target)) {
      return refusal('the composer still holds text after clearing it; refusing to type on top of someone else\'s draft');
    }
    caretToEnd(ctx, target);
    await waitForEditorFrame(ctx, signal);
  }

  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'stopped while composing', { stoppedByOwner: true });
    if (index > 0) {
      const broke = document.execCommand?.('insertLineBreak');
      if (broke === false) {
        dispatchLexicalBeforeInput(ctx, target, null, 'insertLineBreak');
      }
    }
    const inserted = document.execCommand?.('insertText', false, lines[index]);
    if (inserted === false) {
      dispatchLexicalBeforeInput(ctx, target, lines[index], 'insertText');
    }
    await tickOf(ctx)(60 + Math.round(randomOf(ctx)() * 90), { signal });
  }
  await waitForEditorFrame(ctx, signal);

  // Fallback ladder for Chromium ISOLATED-world Lexical quirks where
  // execCommand returned without committing into Lexical's internal state.
  // Each fallback runs ONLY if the composer is still empty, so it can never
  // double an already-landed draft.
  if (!readComposerText(target)) {
    caretToEnd(ctx, target);
    await waitForEditorFrame(ctx, signal);
    if (dispatchPlainTextPaste(target, text)) {
      await waitForEditorFrame(ctx, signal);
      await tickOf(ctx)(80, { signal });
    }
  }
  if (!readComposerText(target)) {
    caretToEnd(ctx, target);
    await waitForEditorFrame(ctx, signal);
    if (dispatchLexicalBeforeInput(ctx, target, text, 'insertFromPaste')) {
      await waitForEditorFrame(ctx, signal);
      await tickOf(ctx)(80, { signal });
    }
  }
  if (!readComposerText(target)) {
    caretToEnd(ctx, target);
    await waitForEditorFrame(ctx, signal);
    if (dispatchLexicalBeforeInput(ctx, target, text, 'insertText')) {
      try {
        const view = target?.ownerDocument?.defaultView ?? ctx.window ?? globalThis.window ?? globalThis;
        const InputCtor = view?.InputEvent ?? globalThis.InputEvent;
        if (typeof InputCtor === 'function') {
          target.dispatchEvent?.(new InputCtor('input', {
            inputType: 'insertText',
            data: text,
            bubbles: true,
            composed: true,
          }));
        }
      } catch { /* shim */ }
      await waitForEditorFrame(ctx, signal);
      await tickOf(ctx)(80, { signal });
    }
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
  return success({ rendered, lines: lines.length, rtl: isRtlElement(target), editor: target, container: found.surface?.container ?? null });
}

/** The newest bubble in the open thread, or null. */
export function newestBubble(document, container = null) {
  const bubbles = threadBubbles(document, container);
  return bubbles.length ? bubbles[bubbles.length - 1] : null;
}

/**
 * Is the newest message in the open thread one of ours?
 *
 * Checks structured thread bubbles first (strictly scoped to the active DM
 * container), then falls back to an optimistic text node inside the DM
 * container outside the composer so freshly sent floating-dock messages are
 * verified reliably even before React attaches `role="article"`.
 */
export function newestIsOurs(document, message, container = null, editor = null) {
  const wanted = expectedComposerText(message);
  if (!wanted) return false;
  const bubble = newestBubble(document, container);
  if (bubble && collapse(bubble.textContent).includes(wanted)) return true;

  const checkLeafTextIn = (scope, excludeChrome = false) => {
    if (!scope || typeof scope.querySelectorAll !== 'function') return false;
    for (const node of [...scope.querySelectorAll('[dir="auto"], span, p, div')]) {
      if (editor && (node === editor || editor.contains?.(node) || node.contains?.(editor))) continue;
      if (node.closest?.('button, [role="button"], [contenteditable="true"], [contenteditable="plaintext-only"]')) continue;
      if (excludeChrome && node.closest?.('header, nav, article')) continue;
      const children = node.children ?? [];
      if (children.length > 2) continue;
      const txt = collapse(node.textContent);
      if (txt && txt.includes(wanted)) return true;
    }
    return false;
  };

  if (container && container !== document && container !== document?.body) {
    if (checkLeafTextIn(container, false)) return true;
  }
  // If the bubble rendered outside a narrow container (e.g. a split Comet
  // thread/composer wrapper), also check structured message bubbles anywhere
  // on the document outside the composer and feed articles.
  if (document && container !== document) {
    for (const node of [...(document.querySelectorAll?.('[role="article"], [role="row"]') ?? [])]) {
      if (editor && (node === editor || editor.contains?.(node) || node.contains?.(editor))) continue;
      if (node.closest?.('header, nav')) continue;
      if (collapse(node.textContent).includes(wanted)) return true;
    }
  }
  return false;
}

/** Has the thread been opened before? One existing bubble is enough to skip. */
export function hasExistingThread(document, container = null) {
  return threadBubbles(document, container).length > 0;
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
export function threadShowsSeen(document, container = null) {
  const bubbles = threadBubbles(document, container);
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

function restrictionToOutcome(restriction) {
  if (!restriction) return null;
  if (restriction.kind === 'invite_sent') {
    return halted(ActionOutcome.SKIPPED, restriction.reason, { inviteAlreadySent: true });
  }
  if (restriction.kind === 'unavailable') {
    return halted(ActionOutcome.SKIPPED, restriction.reason, { dmUnavailable: true });
  }
  return { ok: false, outcome: ActionOutcome.NOT_DONE, reason: restriction.reason };
}

/**
 * Open the DM thread for the account on the current page like a normal desktop
 * user, handling every 2026 Instagram exception:
 *
 *  1. Closes any stale floating bottom-right chat dock belonging to a different
 *     user before clicking Message on this profile.
 *  2. Prefers the `<header>` Message button when present.
 *  3. When no Message button is rendered in `<header>`, opens the `<header>`
 *     three-dots Options menu (`svg title="Options"`) and looks for
 *     "Send message" inside the resulting `[role="dialog"]`. If the Options menu
 *     contains no "Send message" item, closes the dialog and returns `SKIPPED`
 *     with `dmUnavailable: true` so the campaign moves smoothly to the next lead.
 *  4. Accepts BOTH outcomes after clicking Message / Send message:
 *       - the floating bottom-right Direct chat dock on the same profile page, OR
 *       - SPA navigation to `/direct/t/<threadId>/`, OR
 *       - a modal Direct dialog —
 *     while immediately catching restriction notices ("You can't message this
 *     account", "Invite sent") and action blocks.
 */
export async function openDm(ctx, options = {}) {
  const {
    document,
    location = null,
    username = null,
    viewerUsername = null,
    signal = null,
    timeoutMs = SETTLE_MS.dmOpen,
    readyTimeoutMs = 0,
  } = options;
  if (!document) return refusal('no document to act on');
  if (isActionBlocked(document)) {
    return halted(ActionOutcome.STOPPED, 'Instagram is showing an action-block dialog; the run must stop', { severity: 'account' });
  }
  if (isProfileUnavailable(document)) {
    return halted(ActionOutcome.SKIPPED, 'this profile is unavailable or was deleted', { profileUnavailable: true });
  }

  const currentPath = () => String(location?.pathname ?? ctx?.location?.pathname ?? document?.location?.pathname ?? '');
  const targetUser = String(username ?? '').trim().replace(/^@+/, '').toLowerCase() || null;
  const userMatchOpts = viewerUsername ? { viewerUsername } : {};

  // 1. Check for an already-open floating chat dock (could be THIS user or a
  //    stale dock left open from the previous lead!).
  let staleDockUser = null;
  let staleDockNode = null;
  const existingSurface = findDmSurface(document, currentPath());
  const existingDock = existingSurface?.kind === 'dock' ? existingSurface.container : findOpenDmDock(document);
  if (existingDock) {
    if (targetUser) {
      const match = dmContainerUserMatch(existingDock, targetUser, userMatchOpts);
      if (match.matched) {
        const restriction = detectDmRestriction(existingDock);
        if (restriction) return restrictionToOutcome(restriction);
        if (existingSurface?.editor) {
          return success({
            elapsedMs: 0,
            via: 'already-open-dock',
            surfaceKind: 'dock',
            existingThread: hasExistingThread(document, existingDock),
            composerFound: true,
          });
        }
      } else {
        // Stale floating dock belonging to another user (or unidentified): close
        // it cleanly before opening this profile's chat!
        if (match.foundUsers.length > 0) staleDockUser = match.foundUsers[0];
        staleDockNode = existingDock;
        const closeBtn = findDmDockCloseButton(existingDock);
        if (closeBtn) {
          ctx.virtualCursor?.label?.('Closing previous chat dock…');
          await humanClick(ctx, closeBtn, { signal, settleMs: 60, label: 'Closing previous chat…' });
          if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
          const closed = await waitFor(ctx, () => (!findOpenDmDock(document) && !findDmSurface(document, currentPath()) ? true : null), {
            timeoutMs: 2000,
            intervalMs: 100,
            signal,
            label: 'previous chat dock to close',
          });
          if (closed.found) {
            staleDockUser = null;
            staleDockNode = null;
          }
        }
      }
    }
  }

  // 2. Locate the profile header Message button, waiting for SPA profile hydration
  //    when needed.
  let hit = findProfileMessageButton(document);
  if (!hit && readyTimeoutMs > 0) {
    ctx.virtualCursor?.label?.('Waiting for profile…');
    const hydrated = await waitFor(ctx, () => {
      if (isActionBlocked(document) || isProfileUnavailable(document)) return { earlyExit: true };
      const msg = findProfileMessageButton(document);
      if (msg) return msg;
      // If the profile header already rendered Follow/Following or Options, we
      // know the header mounted (may still hide Message behind Options).
      const rel = readRelationshipState(document);
      const opt = findProfileOptionsButton(document);
      if (rel.button || opt) return { headerReady: true };
      return null;
    }, { timeoutMs: readyTimeoutMs, intervalMs: 150, signal, label: 'profile Message button' });
    if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
    if (isActionBlocked(document)) {
      return halted(ActionOutcome.STOPPED, 'Instagram is showing an action-block dialog; the run must stop', { severity: 'account' });
    }
    if (isProfileUnavailable(document)) {
      return halted(ActionOutcome.SKIPPED, 'this profile is unavailable or was deleted', { profileUnavailable: true });
    }
    if (hydrated.found && hydrated.value?.button) {
      hit = hydrated.value;
    } else {
      // Give Instagram one short extra beat in case Message renders right after Follow.
      if (hydrated.found && hydrated.value?.headerReady) {
        await tickOf(ctx)(250, { signal });
      }
      hit = findProfileMessageButton(document);
    }
  }

  let via = 'header-message';
  if (hit) {
    await humanClick(ctx, hit.button, { signal, label: 'Clicking Message…' });
    if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
  } else {
    // 3. Fallback: some profiles hide "Send message" inside the three-dots
    //    Options (`•••`) menu — and some disable messaging completely even there.
    const optionsBtn = findProfileOptionsButton(document);
    if (!optionsBtn) {
      return refusal('this profile renders no Message button', { needsNavigation: true });
    }
    via = 'options-menu';
    await humanClick(ctx, optionsBtn.button, { signal, label: 'Opening Options menu…' });
    if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });

    const menuWait = await waitFor(ctx, () => {
      if (isActionBlocked(document)) return { blocked: true };
      return findOptionsDialogSendMessage(document);
    }, { timeoutMs: SETTLE_MS.dialog, intervalMs: 120, signal, label: 'profile Options menu' });

    if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
    if (menuWait.value?.blocked || isActionBlocked(document)) {
      return halted(ActionOutcome.STOPPED, 'Instagram is showing an action-block dialog; the run must stop', { severity: 'account' });
    }
    if (!menuWait.found) {
      return { ok: false, outcome: ActionOutcome.NOT_DONE, reason: 'profile Options menu did not open' };
    }
    if (!menuWait.value.sendMessageButton) {
      // Confirmed: neither the profile header nor the three-dots Options menu
      // offers a way to message this account. Dismiss cleanly and skip!
      if (menuWait.value.cancelButton) {
        await humanClick(ctx, menuWait.value.cancelButton, { signal, settleMs: 40, label: 'Closing Options menu…' });
      } else {
        dispatchEscapeKey(ctx, document);
      }
      return halted(
        ActionOutcome.SKIPPED,
        'This account does not offer a Send message option on their profile or in the Options menu.',
        { dmUnavailable: true },
      );
    }
    await humanClick(ctx, menuWait.value.sendMessageButton, { signal, label: 'Clicking Send message…' });
    if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
  }

  // 4. Wait for whatever Instagram opens: floating bottom-right chat dock,
  //    `/direct/t/...` thread page, modal dialog, restriction notice, or block.
  ctx.virtualCursor?.label?.('Opening message thread…');
  const opened = await waitFor(ctx, () => {
    if (isActionBlocked(document)) return { blocked: true };
    const path = currentPath();
    const surface = findDmSurface(document, path);
    if (surface) {
      const restriction = detectDmRestriction(surface.container);
      if (restriction) return { restriction };
      // Only keep waiting if a STALE previous dock is still visibly showing the
      // old user without switching yet (never stall on a brand-new dock whose
      // header renders display name instead of a /username/ anchor!).
      if (targetUser && surface.kind === 'dock') {
        const match = dmContainerUserMatch(surface.container, targetUser, userMatchOpts);
        if (staleDockUser && match.foundUsers.includes(staleDockUser) && !match.matched) return null;
        if (staleDockNode && surface.container === staleDockNode && match.foundUsers.length > 0 && !match.matched) return null;
      }
      return { surface };
    }
    const dock = findOpenDmDock(document);
    if (dock) {
      const restriction = detectDmRestriction(dock);
      if (restriction) return { restriction };
    }
    if (path.startsWith('/direct')) {
      const mainScope = document.querySelector?.('main, [role="main"]') ?? document.body;
      const restriction = detectDmRestriction(mainScope);
      if (restriction) return { restriction };
    }
    for (const dlg of findDialogs(document)) {
      const restriction = detectDmRestriction(dlg);
      if (restriction) return { restriction };
    }
    return null;
  }, { timeoutMs, signal, label: 'DM composer' });

  if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
  if (opened.value?.blocked || isActionBlocked(document)) {
    return halted(ActionOutcome.STOPPED, 'Instagram blocked opening this chat; the run must stop', { severity: 'account' });
  }
  if (opened.value?.restriction) {
    return restrictionToOutcome(opened.value.restriction);
  }
  if (!opened.found || !opened.value?.surface) {
    return { ok: false, outcome: ActionOutcome.NOT_DONE, reason: opened.reason, needsNavigation: true };
  }

  const surface = opened.value.surface;

  // Give a freshly opened DM container a brief thread-history settle beat (and
  // wait out any loading spinner) so delayed message bubbles or restriction
  // banners hydrate BEFORE we check existingThread or begin typing.
  if (surface.container?.querySelector?.('[role="progressbar"]')) {
    await waitFor(ctx, () => {
      if (isActionBlocked(document)) return { blocked: true };
      const r = detectDmRestriction(surface.container);
      if (r) return { restriction: r };
      if (!surface.container.querySelector?.('[role="progressbar"]')) return { ready: true };
      return null;
    }, { timeoutMs: Math.min(2500, timeoutMs), intervalMs: 120, signal, label: 'thread history to finish loading' });
    if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
    if (isActionBlocked(document)) {
      return halted(ActionOutcome.STOPPED, 'Instagram blocked opening this chat; the run must stop', { severity: 'account' });
    }
  } else {
    await tickOf(ctx)(250, { signal });
    if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
  }

  const settledRestriction = detectDmRestriction(surface.container);
  if (settledRestriction) return restrictionToOutcome(settledRestriction);

  // The editor stays here: a DOM node cannot cross the storage bridge, and the
  // caller only needs to know the composer is open.
  return success({
    elapsedMs: opened.elapsedMs,
    via,
    openedByClick: true,
    surfaceKind: surface.kind,
    existingThread: hasExistingThread(document, surface.container),
    composerFound: true,
  });
}

/** Dismiss Instagram's benign "Turn on Notifications" modal if it overlays Direct. */
async function dismissNotificationsPrompt(ctx, document, signal = null) {
  for (const dialog of findDialogs(document)) {
    const txt = collapse(dialog.textContent ?? '');
    if (!/turn on notifications|تشغيل الإشعارات/i.test(txt)) continue;
    const buttons = [...(dialog.querySelectorAll?.('button, [role="button"]') ?? [])];
    const notNow = buttons.find((b) => /^(not now|ليس الآن)$/i.test(collapse(b.textContent ?? b.getAttribute?.('aria-label') ?? '')));
    if (notNow) {
      await humanClick(ctx, notNow, { signal, settleMs: 40, label: 'Dismissing notifications prompt…' });
      await tickOf(ctx)(150, { signal });
      return true;
    }
  }
  return false;
}

/**
 * Send one message to the open thread (floating dock, `/direct/t/` page,
 * Direct dialog, or any page hosting a visible DM composer).
 *
 * Refuses to send into a thread that already has messages unless `allowExisting`
 * is set, catches restriction notices, waits for React/Lexical to render the
 * Send button after typing, searches the composer bar + DM container + page
 * for the Send button, supports Enter-to-send for Lexical/message composers
 * (plus backup Enter if clicking Send fails to clear a Lexical box), and
 * verifies delivery inside the active thread.
 */
export async function executeDm(ctx, options = {}) {
  const {
    document,
    message,
    username = null,
    viewerUsername = null,
    trustedThread = false,
    signal = null,
    pathname = '',
    allowExisting = false,
    allowEnterSubmit = true,
    settleMs = SETTLE_MS.dmSend,
    sendButtonTimeoutMs = SETTLE_MS.dmSendButton,
  } = options;

  if (!document) return refusal('no document to act on');
  if (isActionBlocked(document)) {
    return halted(ActionOutcome.STOPPED, 'Instagram is showing an action-block dialog; the run must stop', { severity: 'account' });
  }
  await dismissNotificationsPrompt(ctx, document, signal);
  if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });

  const effectivePath = pathname || String(ctx?.location?.pathname ?? document?.location?.pathname ?? '');
  const surface = findDmSurface(document, effectivePath);
  const container = surface?.container ?? findOpenDmDock(document);

  const preRestriction = detectDmRestriction(container);
  if (preRestriction) return restrictionToOutcome(preRestriction);

  if (username && container && !trustedThread) {
    const match = dmContainerUserMatch(container, username, viewerUsername ? { viewerUsername } : {});
    if (match.foundUsers.length > 0 && !match.matched) {
      return {
        ok: false,
        outcome: ActionOutcome.NOT_DONE,
        reason: `open DM thread belongs to @${match.foundUsers[0]}, not @${String(username).replace(/^@+/, '')}; refusing to send to the wrong person`,
      };
    }
  }

  if (hasExistingThread(document, container) && !allowExisting) {
    return halted(ActionOutcome.SKIPPED, 'this thread already has messages; the funnel sends one first message only', { existingThread: true });
  }

  const composed = await composeMessage(ctx, {
    document,
    message,
    editor: surface?.editor ?? null,
    signal,
    pathname: effectivePath,
  });
  if (!composed.ok) return composed;
  const editor = composed.editor;
  const activeContainer = composed.container ?? container;

  if (isDoubled(readComposerText(editor), message)) {
    return refusal('the composer doubled the message after verification; nothing was sent');
  }

  // React/Lexical swaps Voice Clip / Photo / GIF for the Send button a frame or
  // two AFTER text lands in the composer. Wait briefly for Send to mount,
  // searching the composer bar beside `editor`, the DM container, and the page.
  let send = findSendButton(document, activeContainer, editor);
  const isLexicalEditor = editor.getAttribute?.('data-lexical-editor') === 'true';
  const canSubmitWithEnter = isLexicalEditor || hasMessageEditorCue(editor);
  if (!send && (canSubmitWithEnter || sendButtonTimeoutMs > 0)) {
    const waitedSend = await waitFor(ctx, () => {
      if (isActionBlocked(document)) return { blocked: true };
      return findSendButton(document, activeContainer, editor);
    }, {
      timeoutMs: canSubmitWithEnter ? sendButtonTimeoutMs : Math.min(sendButtonTimeoutMs, 200),
      intervalMs: 100,
      signal,
      label: 'Send button',
    });
    if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
    if (waitedSend.value?.blocked || isActionBlocked(document)) {
      return halted(ActionOutcome.STOPPED, 'Instagram blocked sending this message; the run must stop', { severity: 'account' });
    }
    if (waitedSend.found && waitedSend.value?.button) send = waitedSend.value;
  }

  // Real-browser Lexical self-heal: if execCommand wrote raw DOM text without
  // Lexical committing it into its internal state (`[data-lexical-text="true"]`
  // is missing AND Send never mounted), clear the uncommitted draft and paste
  // via real ClipboardEvent('paste') so Lexical commits it and mounts Send!
  if (
    !send
    && isLexicalEditor
    && !editor.querySelector?.('[data-lexical-text="true"]')
    && typeof (editor?.ownerDocument?.defaultView?.ClipboardEvent ?? globalThis.ClipboardEvent) === 'function'
  ) {
    caretToEnd(ctx, editor, { selectAll: true });
    await waitForEditorFrame(ctx, signal);
    document.execCommand?.('selectAll');
    document.execCommand?.('delete');
    await tickOf(ctx)(60, { signal });
    caretToEnd(ctx, editor);
    await waitForEditorFrame(ctx, signal);
    if (dispatchPlainTextPaste(editor, message)) {
      await waitForEditorFrame(ctx, signal);
      const rescued = await waitFor(ctx, () => {
        if (isActionBlocked(document)) return { blocked: true };
        return findSendButton(document, activeContainer, editor);
      }, { timeoutMs: Math.min(1000, sendButtonTimeoutMs || 1000), intervalMs: 100, signal, label: 'Send button after paste' });
      if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
      if (rescued.value?.blocked || isActionBlocked(document)) {
        return halted(ActionOutcome.STOPPED, 'Instagram blocked sending this message; the run must stop', { severity: 'account' });
      }
      if (rescued.found && rescued.value?.button) send = rescued.value;
    }
  }

  let submittedVia = 'send-button';
  if (send) {
    await humanClick(ctx, send.button, { signal, label: 'Clicking Send…' });
    if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
  } else if (allowEnterSubmit && canSubmitWithEnter) {
    // Floating-dock and Direct builds that omit an explicit Send button (or
    // render an unlabelled icon) submit natively on Enter once Lexical has an
    // active RangeSelection inside the paragraph.
    submittedVia = 'enter';
    ctx.virtualCursor?.label?.('Pressing Enter to send…');
    caretToEnd(ctx, editor);
    await waitForEditorFrame(ctx, signal);
    dispatchEnterKey(ctx, editor);
  } else {
    return { ok: false, outcome: ActionOutcome.NOT_DONE, reason: 'the composer holds the message but no Send button is rendered' };
  }

  ctx.virtualCursor?.label?.('Verifying delivery…');

  const resolveLiveEditor = () => {
    if (editor && editor.isConnected !== false) return editor;
    return findDmSurface(document, effectivePath)?.editor ?? null;
  };

  const checkCleared = () => {
    if (isActionBlocked(document)) return { blocked: true };
    const live = resolveLiveEditor();
    if (newestIsOurs(document, message, activeContainer, live ?? editor)) {
      return { cleared: true, alreadyDelivered: true };
    }
    const r = detectDmRestriction(activeContainer);
    if (r) {
      // On cold invites, Instagram delivers our message and immediately swaps
      // the composer for "Invite sent" — that confirms delivery, NOT a skip!
      if (r.kind === 'invite_sent') return { cleared: true, inviteConfirmed: true };
      return { restriction: r };
    }
    if (!live || readComposerText(live) === '') return { cleared: true };
    return null;
  };

  let cleared;
  if (submittedVia === 'send-button' && allowEnterSubmit && canSubmitWithEnter) {
    // Wait half the settle window after clicking Send; if a Lexical composer
    // still holds the exact draft, press Enter once as a backup trigger.
    const firstWaitMs = Math.min(2000, Math.max(400, Math.floor(settleMs / 2)));
    cleared = await waitFor(ctx, checkCleared, { timeoutMs: firstWaitMs, signal, label: 'composer cleared after send' });
    if (!cleared.found && !signal?.aborted) {
      const live = resolveLiveEditor();
      if (live && readComposerText(live)) {
        ctx.virtualCursor?.label?.('Pressing Enter to confirm send…');
        caretToEnd(ctx, live);
        await waitForEditorFrame(ctx, signal);
        dispatchEnterKey(ctx, live);
      }
      cleared = await waitFor(ctx, checkCleared, {
        timeoutMs: Math.max(800, settleMs - firstWaitMs),
        signal,
        label: 'composer cleared after send',
      });
    }
  } else {
    cleared = await waitFor(ctx, checkCleared, { timeoutMs: settleMs, signal, label: 'composer cleared after send' });
  }

  if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
  if (cleared.value?.blocked || isActionBlocked(document)) {
    return halted(ActionOutcome.STOPPED, 'Instagram blocked sending this message; the run must stop', { severity: 'account' });
  }
  if (cleared.value?.restriction) {
    return restrictionToOutcome(cleared.value.restriction);
  }
  if (!cleared.found) {
    const live = resolveLiveEditor();
    return { ok: false, outcome: ActionOutcome.NOT_DONE, reason: 'Send was clicked but the composer still holds the message', rendered: readComposerText(live ?? editor) };
  }

  let delivered = cleared.value?.alreadyDelivered
    ? { found: true, elapsedMs: 0, value: { delivered: true } }
    : await waitFor(ctx, () => {
      if (isActionBlocked(document)) return { blocked: true };
      const live = resolveLiveEditor();
      if (newestIsOurs(document, message, activeContainer, live ?? editor)) {
        return { delivered: true };
      }
      const r = detectDmRestriction(activeContainer);
      if (r && (r.kind === 'unavailable' || r.kind === 'send_failed')) {
        return { restriction: r };
      }
      if (r?.kind === 'invite_sent' && !live) {
        return { delivered: true, inviteSent: true };
      }
      return null;
    }, {
      timeoutMs: Math.max(1500, settleMs - cleared.elapsedMs),
      signal,
      label: 'message bubble in thread',
    });

  if (signal?.aborted) return halted(ActionOutcome.STOPPED, 'Stopped by owner.', { stoppedByOwner: true });
  if (delivered.value?.blocked || isActionBlocked(document)) {
    return halted(ActionOutcome.STOPPED, 'Instagram blocked sending this message; the run must stop', { severity: 'account' });
  }
  if (delivered.value?.restriction) {
    return restrictionToOutcome(delivered.value.restriction);
  }
  if (!delivered.found) {
    if (cleared.value?.inviteConfirmed) {
      delivered = { found: true, elapsedMs: delivered.elapsedMs, value: { delivered: true, inviteSent: true } };
    } else {
      return { ok: false, outcome: ActionOutcome.NOT_DONE, reason: 'the composer cleared but the message never appeared in the thread' };
    }
  }
  return success({
    clearedMs: cleared.elapsedMs,
    deliveredMs: delivered.elapsedMs,
    surfaceKind: surface?.kind ?? null,
    inviteSent: Boolean(delivered.value?.inviteSent || cleared.value?.inviteConfirmed),
    seen: threadShowsSeen(document, activeContainer),
    rtl: composed.rtl,
  });
}
