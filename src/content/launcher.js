/**
 * The in-page launcher: a floating pill on instagram.com with context-aware
 * quick actions, live pacing feedback and an emergency stop.
 *
 * Two reasons this exists.
 *
 * 1. The action belongs on the page. Asking someone to hunt for a toolbar icon
 *    (often hidden behind the puzzle-piece menu) to act on the profile they are
 *    already looking at is a poor flow, and "collect the people who liked this
 *    post" is meaningless from a dashboard tab that cannot see the post.
 *
 * 2. Honest feedback. A collection is deliberately slow — reads are paced to
 *    look human, so a small one takes tens of seconds and a big one runs for
 *    minutes. Without visible progress in the tab doing the work, the extension
 *    looks frozen, and a frozen-looking extension gets closed mid-run. Every
 *    stage, pause and rate-limit wait is reported as it happens, in words that
 *    say the delay is on purpose.
 *
 * Constraints this file respects:
 *   - The host page's CSP governs this document, so there are no inline styles
 *     and no injected stylesheet URLs: every property is set through CSSOM on
 *     elements we create. The palette below duplicates design/tokens.css for
 *     that reason — a content script cannot load the extension's stylesheet
 *     into instagram.com, and a shadow root does not change what the page's CSP
 *     allows.
 *   - Instagram is a single-page app that rewrites its DOM constantly, so
 *     mounting is re-checked on navigation and on a slow interval rather than
 *     done once.
 *   - Everything here is built with createElement/createElementNS and
 *     textContent. No markup is ever assigned from a string that came from the
 *     page, because a username or a full name is exactly such a string.
 *   - All text is English, matching the rest of the UI. Content collected from
 *     the page (names, comments) may be Arabic and is rendered with dir="auto".
 */

import { usernameFromPath } from './selectors.js';

export const HOST_ID = 'ui-dock-root';

/** How often the pill re-checks the URL and its own existence. */
export const LAUNCHER_TICK_MS = 1000;

const PALETTE = {
  ink: '#111827',
  surface: '#ffffff',
  border: '#e7e9ee',
  accent: '#2563eb',
  accentText: '#ffffff',
  muted: '#4b5563',
  track: '#f0f2f5',
  warn: '#b91c1c',
  ok: '#15803d',
  managed: '#b45309',
  managedSurface: '#fff6e5',
};

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Routes that are chrome, not accounts, and the post/detail routes. */
const POST_SEGMENTS = Object.freeze(['p', 'reel', 'reels', 'tv']);

/**
 * What this page is, from its URL alone.
 *
 * Deliberately URL-driven rather than DOM-driven: the pill has to decide what to
 * offer before it reads anything, and reading Instagram's DOM to label a button
 * would put a scrape where the owner did not ask for one.
 */
export function pageContextFrom(pathname, href = '') {
  const path = String(pathname ?? '');
  const segments = path.split('/').filter(Boolean);
  const first = segments[0] ?? '';
  const username = usernameFromPath(path);
  const postCode = POST_SEGMENTS.includes(first.toLowerCase()) ? segments[1] ?? null : null;
  const lower = first.toLowerCase();
  const isDirect = lower === 'direct';
  // Hashtags live under /explore/tags/<tag>/, so "explore" alone is not enough.
  const isTag = lower === 'explore' && String(segments[1] ?? '').toLowerCase() === 'tags';
  const isExplore = lower === 'explore' && !isTag;
  const kind = username ? 'profile' : postCode ? 'post' : isDirect ? 'direct' : isTag ? 'tag' : isExplore ? 'explore' : 'other';
  return {
    kind,
    username,
    postCode,
    tag: isTag ? decodeURIComponent(segments[2] ?? '') : null,
    threadId: isDirect && segments[1] === 't' ? segments[2] ?? null : null,
    href: String(href ?? ''),
  };
}

/**
 * The quick actions this page can offer, in the order they should appear.
 *
 * Each one opens the dashboard with enough parameters to act on THIS page
 * without asking the owner to find it again in a list. The username always
 * travels with the request: opening a tab moves focus, so by the time the
 * dashboard looks for "the active Instagram tab" this one is no longer active,
 * and with several profiles open it would silently aim at the wrong one.
 */
export function quickActionsFor(context) {
  const actions = [];
  const here = { here: '1' };
  // Every collect action carries the page it came from (`from`) and `auto:'1'`, so
  // the dashboard can start THAT collection immediately and aim it at this exact
  // tab instead of making the owner retype a username they just clicked from.
  const collect = (extra) => ({ ...here, tab: 'collector', from: context.href, auto: '1', ...extra });
  const outreach = (extra) => ({ ...here, tab: 'outreach', from: context.href, ...extra });

  if (context.kind === 'profile' && context.username) {
    actions.push({
      id: 'collect-followers',
      tab: 'collector',
      label: 'Collect followers',
      hint: `People who follow @${context.username}`,
      params: collect({ source: 'followers', username: context.username }),
    });
    actions.push({
      id: 'collect-following',
      tab: 'collector',
      label: 'Collect following',
      hint: `People @${context.username} follows`,
      params: collect({ source: 'following', username: context.username }),
    });
    actions.push({
      id: 'collect-recent-likers',
      tab: 'collector',
      label: 'Collect recent likers',
      hint: 'People who liked the latest posts',
      params: collect({ source: 'profile_recent_likers', username: context.username }),
    });
    actions.push({
      id: 'add-to-outreach',
      tab: 'outreach',
      label: `Add @${context.username} to outreach`,
      hint: 'Queue a follow or a first message',
      params: outreach({ username: context.username, act: 'add' }),
    });
  }

  if (context.kind === 'post' && context.postCode) {
    actions.push({
      id: 'collect-post-likers',
      tab: 'collector',
      label: 'Collect likers',
      hint: 'Everyone who liked this post',
      params: collect({ source: 'post_likers', ref: context.postCode }),
    });
    actions.push({
      id: 'collect-post-commenters',
      tab: 'collector',
      label: 'Collect commenters',
      hint: 'Everyone who commented on this post',
      params: collect({ source: 'post_comments', ref: context.postCode }),
    });
  }

  if (context.kind === 'tag' && context.tag) {
    actions.push({
      id: 'collect-grid',
      tab: 'collector',
      label: 'Collect from this hashtag',
      hint: 'Authors of the posts on screen, in order',
      params: collect({ source: 'hashtag_grid', tag: context.tag }),
    });
  }

  if (context.kind === 'explore' || context.kind === 'other') {
    actions.push({
      id: 'collect-page',
      tab: 'collector',
      label: 'Collect the people on this page',
      hint: 'Whatever list or grid is open right now',
      params: collect({ source: 'current_page' }),
    });
  }

  if (context.kind === 'direct') {
    actions.push({
      id: 'open-thread',
      tab: 'outreach',
      label: 'Open this thread in the CRM',
      hint: 'See the relationship and what was already sent',
      params: outreach({ thread: context.threadId ?? '' }),
    });
  }

  // The emergency stop is not in this list: when this tab is being driven by the
  // dashboard it lives in its own banner, always visible, so the one thing that
  // must never be hard to find is never behind a click. "Open the CRM" is last and
  // carries no `auto`: it is a plain visit, not a started collection.
  actions.push({ id: 'open-dashboard', tab: 'collector', label: 'Open the CRM', hint: 'Leads, outreach, backups', params: { tab: 'collector' } });
  return actions;
}

/** What each progress phase is called in words. */
const PHASE_LABEL = Object.freeze({
  'their-following': 'Reading who they follow',
  'my-followers': 'Reading your followers',
  'my-following': 'Reading who you follow',
  'accept-check': 'Checking who follows you back',
  followers: 'Reading their followers',
  following: 'Reading who they follow',
  post_likers: 'Reading who liked the post',
  post_comments: 'Reading the comments',
  profile_recent_likers: 'Reading recent engagers',
  hashtag_grid: 'Reading the grid',
  saved_grid: 'Reading your saved posts',
  open_list_dialog: 'Reading the open list',
  current_page: 'Reading this page',
});

/**
 * One status row into words, a counter and a bar width.
 *
 * Pure on purpose: the pill renders this, the dashboard renders the same row,
 * and a test can check the sentence without a DOM. The delay is always named as
 * deliberate — "waiting 4.0s (human pacing)" — because an unexplained pause is
 * indistinguishable from a hang.
 */
export function describeStatus(status) {
  const idle = { stage: 'Idle', detail: '', counter: '', progress: null, tone: 'muted', running: false };
  if (!status || typeof status !== 'object') return idle;

  if (status.managed) {
    return {
      stage: 'Managed worker tab',
      detail: status.runKind ? `Running ${status.runKind} for the CRM.` : 'This tab is being driven by the CRM.',
      counter: '',
      progress: null,
      tone: 'managed',
      running: true,
    };
  }

  if (status.kind === 'run-end') {
    return {
      stage: status.ok ? 'Done' : 'Stopped',
      detail: status.ok ? (status.summary ?? 'Finished.') : String(status.reason ?? 'Ended without finishing.'),
      counter: '',
      progress: null,
      tone: status.ok ? 'ok' : 'warn',
      running: false,
    };
  }

  if (status.type) {
    const wait = Number.isFinite(status.waitMs) ? status.waitMs : null;
    const seconds = wait === null ? '' : `${(wait / 1000).toFixed(1)}s`;
    const counter = Number.isFinite(status.sessionCount)
      ? `${status.sessionCount} request${status.sessionCount === 1 ? '' : 's'} this run`
      : '';
    switch (status.type) {
      case 'paused':
        return { stage: 'Paused', detail: 'This tab is in the background, so the run is waiting.', counter, progress: null, tone: 'muted', running: true };
      case 'resumed':
        return { stage: 'Resumed', detail: status.note ?? 'Continuing.', counter, progress: null, tone: 'accent', running: true };
      case 'pacing':
        return { stage: 'Waiting', detail: `Waiting ${seconds} before the next read (human pacing).`, counter, progress: null, tone: 'muted', running: true };
      case 'throttled':
        return { stage: 'Rate limit', detail: `Per-minute limit reached — waiting ${seconds}.`, counter, progress: null, tone: 'warn', running: true };
      case 'backoff':
        return { stage: 'Backing off', detail: `Instagram pushed back — waiting ${seconds}${status.honouredRetryAfter ? ' (its own retry-after)' : ''}.`, counter, progress: null, tone: 'warn', running: true };
      case 'aborted':
        return { stage: 'Refused', detail: String(status.message ?? status.reason ?? 'Instagram refused the request.'), counter, progress: null, tone: 'warn', running: false };
      case 'stopped':
        return { stage: 'Stopped', detail: 'The run was stopped.', counter, progress: null, tone: 'warn', running: false };
      default:
        return { ...idle, detail: String(status.type) };
    }
  }

  if (status.phase) {
    const stage = PHASE_LABEL[status.phase] ?? status.note ?? 'Working';
    const total = Number.isFinite(status.total) ? status.total : (Number.isFinite(status.count) ? status.count : null);
    const parts = [];
    if (total !== null) parts.push(`${total} row${total === 1 ? '' : 's'} so far`);
    if (Number.isFinite(status.page)) parts.push(`page ${status.page}`);
    if (Number.isFinite(status.scrolls)) parts.push(`scroll ${status.scrolls}`);
    else if (Number.isFinite(status.step) && status.step > 0) parts.push(`step ${status.step}`);
    if (Number.isFinite(status.suspects)) parts.push(`${status.suspects} to check`);
    // A progress bar only when there is something honest to divide by: a
    // half-filled bar invented from a guess is worse than no bar.
    const progress = total !== null && Number.isFinite(status.limit) && status.limit > 0
      ? Math.max(0, Math.min(1, total / status.limit))
      : null;
    return {
      stage,
      detail: status.note ? String(status.note) : (status.source ? `From @${status.source}` : (status.post ? `Post ${status.post}` : '')),
      counter: parts.join(' · '),
      progress,
      tone: 'accent',
      running: true,
    };
  }

  return idle;
}

/** Routes where a floating pill would be noise, or where nothing can be done. */
const NO_PILL_SEGMENTS = Object.freeze([
  'accounts', 'challenge', 'legal', 'about', 'privacy', 'terms', 'developer',
  'developers', 'static', 'graphql', 'api', 'oauth', 'session', 'emailsignup',
  'favicon.ico', 'robots.txt', 'jobs',
]);

/** Whether the pill belongs on this route at all. */
export function shouldMount(pathname) {
  const first = String(pathname ?? '').split('/').filter(Boolean)[0] ?? '';
  if (!first) return true; // the feed: "collect the people on this page" still applies
  return !NO_PILL_SEGMENTS.includes(first.toLowerCase());
}

/** The two-word label on the collapsed pill, chosen from the page kind. */
export function pillLabel(context) {
  switch (context?.kind) {
    case 'profile': return 'Collect';
    case 'post': return 'Collect';
    case 'tag': return 'Collect';
    case 'explore': return 'Collect';
    case 'direct': return 'CRM';
    default: return 'CRM';
  }
}

function css(node, styles) {
  Object.assign(node.style, styles);
  return node;
}

function make(document, tag, styles, text) {
  const node = document.createElement(tag);
  if (styles) css(node, styles);
  if (text !== null && text !== undefined) node.textContent = String(text);
  return node;
}

/**
 * The product mark, drawn as SVG so it stays sharp at any zoom.
 *
 * Built with createElementNS rather than by assigning markup: this runs inside a
 * page we do not control, and putting a string into innerHTML in a content
 * script is the habit that turns into an injection bug later.
 */
export function logoMark(document, size, color, dotColor) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  css(svg, { display: 'block', flexShrink: '0' });

  const funnel = document.createElementNS(SVG_NS, 'path');
  funnel.setAttribute('d', 'M9.36 11.76 H38.64 L29.52 24.24 H18.48 Z');
  funnel.setAttribute('fill', color);
  const stem = document.createElementNS(SVG_NS, 'rect');
  stem.setAttribute('x', '18.48');
  stem.setAttribute('y', '24.24');
  stem.setAttribute('width', '11.04');
  stem.setAttribute('height', '7.2');
  stem.setAttribute('fill', color);
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', '24');
  dot.setAttribute('cy', '37.2');
  dot.setAttribute('r', '3.6');
  dot.setAttribute('fill', dotColor ?? color);
  svg.append(funnel, stem, dot);
  return svg;
}

const TONE_COLOR = Object.freeze({
  muted: PALETTE.muted,
  accent: PALETTE.accent,
  ok: PALETTE.ok,
  warn: PALETTE.warn,
  managed: PALETTE.managed,
});

/**
 * Build the pill and its panel inside a closed shadow root.
 *
 * A shadow root keeps Instagram's stylesheets from reaching our controls and
 * keeps ours from touching their page: without it, a site-wide `button { }` rule
 * can silently destroy the one control that must keep working.
 */
export function createLauncher(deps = {}) {
  const document = 'document' in deps ? deps.document : globalThis.document;
  const location = deps.location ?? globalThis.location;
  const openTab = deps.open ?? ((url) => globalThis.window?.open(url, '_blank'));
  const getURL = deps.getURL ?? ((path) => globalThis.chrome?.runtime?.getURL?.(path) ?? `chrome-extension://local/${path}`);
  const onAction = deps.onAction ?? null;
  const onStop = deps.onStop ?? null;
  const readStatus = deps.readStatus ?? null;
  const now = deps.now ?? (() => Date.now());

  let host = null;
  let root = null;
  let ui = null;
  let managed = false;
  let managedInfo = null;
  let expanded = false;
  let lastStatus = null;

  function context() {
    return pageContextFrom(location?.pathname ?? '', location?.href ?? '');
  }

  function dashboardUrl(params) {
    const query = new URLSearchParams(params ?? {}).toString();
    const path = getURL('app/index.html');
    return query ? `${path}?${query}` : path;
  }

  function runAction(action) {
    // A caller can own the action (the dashboard is already open in another tab,
    // or a test wants to see what was clicked). Returning false means "you open
    // it", which keeps the default behaviour honest in a real browser.
    if (onAction && onAction(action) === false) return false;
    if (action.id === 'open-dashboard' || action.tab) {
      const win = openTab(dashboardUrl(action.params));
      if (!win) {
        showError('Your browser blocked the new tab. Click the extension icon to open the CRM.');
        return false;
      }
    }
    return true;
  }

  function actionButton(action, index = 0) {
    const isPrimary = !action.emergency && index === 0 && action.tab === 'collector' && action.id !== 'open-dashboard';
    const button = make(document, 'button', {
      display: 'block',
      width: '100%',
      padding: action.emergency ? '9px 12px' : '8px 10px',
      margin: '0 0 6px 0',
      background: action.emergency ? PALETTE.warn : (isPrimary ? PALETTE.accent : PALETTE.surface),
      color: (action.emergency || isPrimary) ? PALETTE.accentText : PALETTE.ink,
      border: `1px solid ${action.emergency ? PALETTE.warn : (isPrimary ? PALETTE.accent : PALETTE.border)}`,
      borderRadius: '10px',
      fontSize: '12.5px',
      fontWeight: '600',
      cursor: 'pointer',
      fontFamily: 'inherit',
      textAlign: 'left',
    });
    button.setAttribute('type', 'button');
    button.setAttribute('data-action', action.id);
    const label = make(document, 'span', { display: 'block' }, action.label);
    button.append(label);
    if (action.hint) {
      const hint = make(document, 'span', {
        display: 'block',
        fontWeight: '400',
        fontSize: '11px',
        color: (action.emergency || isPrimary) ? PALETTE.accentText : PALETTE.muted,
        opacity: isPrimary ? '0.9' : '1',
        marginTop: '2px',
      }, action.hint);
      button.append(hint);
    }
    button.addEventListener('click', () => runAction(action));
    return button;
  }

  function renderActions() {
    if (!ui) return;
    ui.actions.replaceChildren(...quickActionsFor(context()).map((action, index) => actionButton(action, index)));
  }

  function renderManaged() {
    if (!ui) return;
    ui.banner.style.display = managed ? 'block' : 'none';
    if (!managed) return;
    ui.bannerText.textContent = managedInfo?.note ?? 'Managed worker tab: the CRM is driving this tab.';
    ui.pillLabel.textContent = 'Stop';
    ui.pill.style.background = PALETTE.managedSurface;
    ui.pill.style.borderColor = PALETTE.managed;
  }

  function renderStatus() {
    if (!ui) return;
    const view = describeStatus(managed && !lastStatus ? { managed: true, runKind: managedInfo?.runKind ?? null } : lastStatus);
    ui.stage.textContent = view.stage;
    ui.stage.style.color = TONE_COLOR[view.tone] ?? PALETTE.muted;
    ui.detail.textContent = view.detail;
    ui.detail.setAttribute('dir', 'auto');
    ui.counter.textContent = view.counter;
    ui.bar.style.width = view.progress === null ? '0%' : `${Math.max(4, Math.round(view.progress * 100))}%`;
    ui.bar.style.background = TONE_COLOR[view.tone] ?? PALETTE.accent;
    ui.progressRow.style.display = view.running || view.stage !== 'Idle' ? 'block' : 'none';
  }

  function setExpanded(on) {
    if (!ui) return;
    expanded = Boolean(on);
    ui.pill.style.display = expanded ? 'none' : 'flex';
    ui.panel.style.display = expanded ? 'block' : 'none';
  }

  function build() {
    host = make(document, 'div');
    host.setAttribute('id', HOST_ID);
    css(host, {
      // `all: initial` MUST come first. Object.assign applies keys in order and
      // this one resets every property, so at the end it silently wipes
      // position/right/top and leaves the host as a static inline element
      // scrolled off the page. It is here to shield us from Instagram's global
      // CSS, not to undo our own.
      all: 'initial',
      position: 'fixed',
      // Bottom-right corner with a 16px margin and safe-area insets so the compact
      // launcher stays out of Instagram's content and navigation bars.
      right: 'calc(16px + env(safe-area-inset-right, 0px))',
      bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
      zIndex: '2147483000',
    });

    root = host.attachShadow({ mode: 'closed' });

    const pill = make(document, 'button', {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '8px 12px',
      minHeight: '38px',
      background: PALETTE.surface,
      color: PALETTE.ink,
      border: `1px solid ${PALETTE.border}`,
      borderRadius: '999px',
      boxShadow: '0 4px 16px rgba(17, 24, 39, 0.12)',
      cursor: 'pointer',
      fontFamily: FONT,
      fontSize: '13px',
      fontWeight: '600',
      lineHeight: '1',
    });
    pill.setAttribute('type', 'button');
    pill.setAttribute('aria-label', 'Open IG Outreach CRM');
    pill.setAttribute('title', 'IG Outreach CRM');
    const pillLabelNode = make(document, 'span', { fontFamily: FONT }, pillLabel(context()));
    pill.append(logoMark(document, 16, PALETTE.accent, PALETTE.ok), pillLabelNode);
    pill.addEventListener('click', () => {
      if (managed) {
        stopRun();
        return;
      }
      setExpanded(true);
    });

    const panel = make(document, 'div', {
      fontFamily: FONT,
      fontSize: '13px',
      lineHeight: '1.45',
      color: PALETTE.ink,
      background: PALETTE.surface,
      border: `1px solid ${PALETTE.border}`,
      borderRadius: '12px',
      boxShadow: '0 12px 32px rgba(17, 24, 39, 0.12)',
      padding: '12px',
      width: '280px',
      maxWidth: 'calc(100vw - 32px)',
      boxSizing: 'border-box',
      display: 'none',
    });

    const titleRow = make(document, 'div', { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' });
    const title = make(document, 'div', { fontWeight: '600', fontSize: '13px', flex: '1' }, 'IG Outreach CRM');
    const collapse = make(document, 'button', {
      background: 'transparent',
      border: '0',
      color: PALETTE.muted,
      cursor: 'pointer',
      fontSize: '16px',
      lineHeight: '1',
      padding: '2px 4px',
      fontFamily: 'inherit',
    }, '\u00d7');
    collapse.setAttribute('type', 'button');
    collapse.setAttribute('aria-label', 'Collapse');
    collapse.addEventListener('click', () => setExpanded(false));
    titleRow.append(logoMark(document, 16, PALETTE.accent, PALETTE.ok), title, collapse);

    const subtitle = make(document, 'div', { color: PALETTE.muted, fontSize: '12px', marginBottom: '10px' }, 'Everything runs on this device. Nothing is uploaded anywhere.');
    subtitle.setAttribute('dir', 'auto');

    const banner = make(document, 'div', {
      display: 'none',
      background: PALETTE.managedSurface,
      border: `1px solid ${PALETTE.managed}`,
      color: PALETTE.managed,
      borderRadius: '10px',
      padding: '8px 10px',
      fontSize: '12px',
      marginBottom: '8px',
    });
    const bannerText = make(document, 'span', { display: 'block', marginBottom: '6px' });
    bannerText.setAttribute('dir', 'auto');
    const bannerStop = make(document, 'button', {
      background: PALETTE.warn,
      color: PALETTE.accentText,
      border: '0',
      borderRadius: '8px',
      padding: '6px 10px',
      fontSize: '12px',
      fontWeight: '700',
      cursor: 'pointer',
      fontFamily: 'inherit',
    }, 'Emergency stop');
    bannerStop.setAttribute('type', 'button');
    bannerStop.addEventListener('click', () => stopRun());
    banner.append(bannerText, bannerStop);

    const actions = make(document, 'div', { marginBottom: '8px' });

    const progressRow = make(document, 'div', { display: 'none', borderTop: `1px solid ${PALETTE.border}`, paddingTop: '8px' });
    const stage = make(document, 'div', { fontWeight: '600', fontSize: '12px', color: PALETTE.muted }, 'Idle');
    const detail = make(document, 'div', { fontSize: '11.5px', color: PALETTE.muted, marginTop: '2px' });
    detail.setAttribute('dir', 'auto');
    const track = make(document, 'div', { height: '4px', background: PALETTE.track, borderRadius: '2px', margin: '6px 0 4px 0', overflow: 'hidden' });
    const bar = make(document, 'div', { height: '100%', width: '0%', background: PALETTE.accent, borderRadius: '2px' });
    track.append(bar);
    const counter = make(document, 'div', { fontSize: '11px', color: PALETTE.muted });
    progressRow.append(stage, detail, track, counter);

    panel.append(titleRow, subtitle, banner, actions, progressRow);
    root.append(pill, panel);

    ui = { pill, pillLabel: pillLabelNode, panel, title, subtitle, collapse, banner, bannerText, bannerStop, actions, progressRow, stage, detail, bar, counter, track };
    return ui;
  }

  function stopRun() {
    if (onStop) onStop();
    // Not an error: the owner asked for this. It reads as a stop, in the stop
    // colour, and the next real status row replaces it.
    lastStatus = { kind: 'run-end', ok: false, reason: 'Stop requested from this tab. The run ends after the current step.' };
    setExpanded(true);
    renderStatus();
  }

  function mount() {
    if (host && host.parentNode) return ui;
    if (!document || !document.body) return null;
    if (document.getElementById(HOST_ID) && !host) {
      // A previous install left a host behind (Instagram re-rendered, or the
      // script ran twice). Remove it rather than stacking two pills.
      document.getElementById(HOST_ID).remove();
    }
    build();
    document.body.append(host);
    renderActions();
    renderManaged();
    renderStatus();
    setExpanded(expanded);
    return ui;
  }

  function unmount() {
    if (host) host.remove();
    host = null;
    root = null;
    ui = null;
  }

  function showError(message) {
    if (!ui) return;
    setExpanded(true);
    ui.stage.textContent = 'Problem';
    ui.stage.style.color = PALETTE.warn;
    ui.detail.textContent = message;
    ui.progressRow.style.display = 'block';
  }

  function showDone(summary) {
    lastStatus = { kind: 'run-end', ok: true, summary: summary ?? null };
    renderStatus();
  }

  return {
    mount,
    unmount,
    /** Re-mount if the SPA dropped us, and re-render for the new URL. */
    sync() {
      if (!shouldMount(location?.pathname ?? '')) {
        if (host) unmount();
        return false;
      }
      if (!host || !host.parentNode) mount();
      else {
        ui.pillLabel.textContent = managed ? 'Stop' : pillLabel(context());
        renderActions();
        renderStatus();
      }
      return true;
    },
    /** Pull the latest status row from the bridge and render it. */
    async refresh() {
      if (!readStatus) return null;
      const status = await readStatus();
      if (status) this.showStatus(status);
      return status;
    },
    showStatus(status) {
      lastStatus = status ?? null;
      // The dashboard marks this tab as its managed worker by posting a status
      // row with `managed`; it clears it the same way. The pill becomes the stop
      // button for as long as that row stands.
      if (status?.managed) this.setManaged(true, status);
      else if (status && status.managed === false) this.setManaged(false);
      renderStatus();
      return describeStatus(status);
    },
    showDone,
    showError,
    setManaged(on, info = null) {
      managed = Boolean(on);
      managedInfo = info;
      renderManaged();
      if (ui) ui.pillLabel.textContent = managed ? 'Stop' : pillLabel(context());
      return managed;
    },
    setExpanded,
    stopRun,
    runAction,
    get isOpen() { return expanded; },
    get isMounted() { return Boolean(host && host.parentNode); },
    get isManaged() { return managed; },
    get context() { return context(); },
    get status() { return lastStatus; },
    get root() { return root; },
    get host() { return host; },
    get ui() { return ui; },
    get lastSeenAt() { return now(); },
  };
}

/**
 * Keep the pill alive on a single-page app.
 *
 * Instagram rewrites its DOM on navigation and the URL changes without a page
 * load, so mounting once is not enough. Both are covered: a slow interval and a
 * `popstate` listener. The interval is deliberately slow — a MutationObserver on
 * Instagram's body fires constantly and would spend the owner's CPU on a button
 * that only needs to reappear within a second or so.
 */
export function installLauncher(deps = {}) {
  const location = deps.location ?? globalThis.location;
  const chromeApi = deps.chrome ?? (typeof globalThis.chrome !== 'undefined' ? globalThis.chrome : null);
  const launcher = deps.launcher ?? createLauncher(deps);
  const setIntervalFn = deps.setInterval ?? globalThis.setInterval;
  const clearIntervalFn = deps.clearInterval ?? globalThis.clearInterval;
  const addEventListener = deps.addEventListener ?? ((type, fn) => globalThis.window?.addEventListener?.(type, fn));
  const tickMs = Number.isFinite(deps.tickMs) ? deps.tickMs : LAUNCHER_TICK_MS;

  let lastUrl = location?.href ?? '';
  let stopped = false;
  let timer = null;

  const stop = () => {
    stopped = true;
    if (timer !== null && timer !== undefined) clearIntervalFn(timer);
    timer = null;
    launcher.unmount();
  };

  const tick = async () => {
    if (stopped) return { mounted: false, navigated: false };
    // If this tab's extension runtime was invalidated by an extension reload,
    // stop polling and unmount cleanly instead of throwing storage errors.
    if (chromeApi?.runtime && ('id' in chromeApi.runtime) && !chromeApi.runtime.id) {
      stop();
      return { mounted: false, navigated: false };
    }
    const href = location?.href ?? '';
    const navigated = href !== lastUrl;
    if (navigated) {
      lastUrl = href;
      // A new page means new quick actions. Collapsing keeps the panel from
      // describing a page the owner has already left — unless this tab is being
      // driven, in which case the stop control must stay where it was.
      if (!launcher.isManaged) launcher.setExpanded(false);
    }
    const mounted = launcher.sync();
    if (mounted) {
      try {
        await launcher.refresh();
      } catch {
        if (chromeApi?.runtime && ('id' in chromeApi.runtime) && !chromeApi.runtime.id) stop();
      }
    }
    return { mounted, navigated };
  };

  void tick();
  timer = setIntervalFn(tick, tickMs);
  if (addEventListener) addEventListener('popstate', () => { void tick(); });

  return {
    launcher,
    tick,
    stop,
  };
}
