/**
 * Dashboard shell.
 *
 * Owns the three things every view needs but none should build: the api client,
 * the run controller, and the cross-tab sync bus. It renders the slim top bar —
 * identity on the left, the two-tab switcher (Collect / Outreach) in the middle,
 * and a connection status with a single overflow menu (Settings, Backup & export)
 * on the right — plus a run banner that appears under the bar only while a run is
 * active, and swaps the collector and outreach views underneath it.
 *
 * There is no background service worker. This page does the work itself, so
 * nothing can fail to register and take the whole extension down with it. The
 * one piece that runs off-page is a dedicated Web Worker metronome, which keeps
 * the countdown ticking once a second even when this tab is backgrounded next to
 * the managed Instagram window.
 */

import { $, banner, btn, clear, drawer, el, menu, note, toast } from './lib/ui.js';
import { createApiClient } from './lib/api.js';
import { RunPhase, createRunController } from './lib/runner.js';
import { createSyncBus } from '../storage/sync.js';
import { createCollectorView } from './views/tab1-collector.js';
import { createOutreachView } from './views/tab2-outreach.js';
import { createSettingsView } from './views/settings-view.js';
import { createBackupView } from './views/backup-export.js';

const LOGO_SVG = 'M9 6c0-1.65685 1.3431-3 3-3s3 1.34315 3 3M9 6c0 1.04349.53275 1.96254 1.3411 2.5M9 6C7.34315 6 6 7.34315 6 9c0 1.6569 1.34315 3 3 3m6.3893 0c1.6568 0 3-1.3431 3-3 0-1.65685-1.3432-3-3-3-.6134 0-1.1838.18408-1.6589.5M8 12h8l-4 9-4-9Z';

const PHASE_LABEL = {
  [RunPhase.IDLE]: 'Idle',
  [RunPhase.PREPARING]: 'Preparing…',
  [RunPhase.RUNNING]: 'Running',
  [RunPhase.WAITING]: 'Waiting',
  [RunPhase.STOPPING]: 'Stopping…',
  [RunPhase.DONE]: 'Finished',
  [RunPhase.CAPPED]: 'Capped',
  [RunPhase.BLOCKED]: 'Blocked',
  [RunPhase.FAILED]: 'Failed',
  [RunPhase.STOPPED]: 'Stopped',
};

/**
 * Parse the dashboard deep link the in-page pill opens: which tab to land on and,
 * for a collect action, what to collect, from which page, and whether to start at
 * once. `tab=collect` is accepted as an alias for the real id `collector`.
 */
function readLaunchParams(deps = {}) {
  let params;
  try {
    params = new URLSearchParams(deps.location?.search ?? globalThis.location?.search ?? '');
  } catch {
    params = new URLSearchParams();
  }
  const rawTab = params.get('tab');
  const tab = rawTab === 'collect' ? 'collector' : rawTab;
  const source = params.get('source');
  const username = params.get('username');
  const ref = params.get('ref');
  const tag = params.get('tag');
  const from = params.get('from');
  const auto = params.get('auto');
  const hasRequest = Boolean(source || username || ref || tag || auto);
  return {
    tab,
    initialRequest: hasRequest ? { source, username, shortcode: ref, tag, from, auto } : null,
  };
}

/**
 * @param {{chromeApi?: object, document?: Document}} deps
 */
export function createApp(deps = {}) {
  const doc = deps.document ?? (typeof document !== 'undefined' ? document : null);
  const chromeApi = deps.chromeApi ?? (typeof chrome !== 'undefined' ? chrome : null);
  if (!doc) throw new Error('createApp needs a document');

  // Read the pill's deep link once, before any view is built, so the collector can
  // pre-fill its source and target and (with auto='1') start immediately. start()
  // clears the query string afterwards so a refresh never launches a second run.
  const launch = readLaunchParams(deps);

  const api = deps.api ?? createApiClient({ chromeApi });
  const runHandlers = new Set();
  const syncHandlers = new Set();

  const controller = createRunController({
    api,
    onEvent: (event) => {
      handleRunEvent(event);
      for (const handler of runHandlers) { try { handler(event); } catch { /* a view that throws must not stop the run */ } }
    },
  });

  const bus = deps.bus ?? createSyncBus();

  // Shared context handed to every view.
  const ctx = {
    api,
    controller,
    bus,
    toast,
    // What the in-page pill asked for (null on a plain dashboard open). The
    // collector reads this once to pre-fill and, with auto='1', start.
    initialRequest: launch.initialRequest,
    // The live governor budget, so a screen can render the quota meters itself.
    budget: () => cachedBudget,
    onRunEvent: (handler) => { runHandlers.add(handler); return () => runHandlers.delete(handler); },
    onSync: (handler) => { syncHandlers.add(handler); return () => syncHandlers.delete(handler); },
    onChanged: () => { void refreshShell(); },
    setBadge: (tab, counts) => { badges[tab] = counts; renderTabs(); },
    openSettings: () => openSettingsDrawer(),
    openBackup: () => openBackupDrawer(),
    navigate: (tab) => navigate(tab),
  };

  const views = {
    collector: createCollectorView(ctx),
    outreach: createOutreachView(ctx),
  };
  const badges = { collector: null, outreach: null };

  let activeTab = launch.tab && views[launch.tab] ? launch.tab : 'collector';
  let nextActionAt = null;
  let cachedBudget = null;
  let tickCount = 0;
  let worker = null;
  let fallbackTimer = null;
  let statusWatcher = null;

  /* ------------------------------------------------------------ top bar */

  function brand() {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'logo-mark');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('d', LOGO_SVG);
    svg.append(path);
    return el('div', { class: 'brand' }, [
      el('div', { class: 'brand__logo' }, [svg]),
      el('div', {}, [
        el('div', { class: 'brand__title', text: 'Outreach CRM' }),
        el('div', { class: 'brand__sub', text: 'Runs locally' }),
      ]),
    ]);
  }

  /** The one-line connection status shown at the right of the header. */
  function connectionStatus(overview) {
    if (overview?.lockedUntil) {
      const when = new Date(overview.lockedUntil).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
      return { variant: 'danger', text: `Locked until ${when}` };
    }
    if (overview?.viewerUsername) return { variant: 'ok', text: `Connected as @${overview.viewerUsername}` };
    return { variant: 'warn', text: 'Not connected' };
  }

  /**
   * Header right: a status dot with one line of text, and a single overflow menu
   * holding Settings and Backup & export. The quota meters, the phase read-out and
   * the Stop button no longer live here — the meters moved to the Outreach screen
   * and Stop lives in the run banner, which exists only while a run is active.
   */
  function renderHeaderRight(overview) {
    const host = $('#shell-right', doc);
    if (!host) return;
    clear(host);
    const status = connectionStatus(overview);
    const pill = el('div', { class: `session-pill session-pill--${status.variant}`, id: 'session-pill' }, [
      el('span', { class: 'session-pill__dot' }),
      el('span', { class: 'session-pill__text', text: status.text }),
    ]);
    const overflow = menu('⋯', [
      { label: 'Settings', onClick: () => openSettingsDrawer() },
      { label: 'Backup & export', onClick: () => openBackupDrawer() },
    ], { align: 'end', triggerLabel: 'More options' });
    host.append(pill, overflow);
  }

  function renderTabs() {
    const host = $('#shell-center', doc);
    if (!host) return;
    clear(host);
    const items = [
      { id: 'collector', label: 'Collect', count: badges.collector?.total ?? undefined },
      { id: 'outreach', label: 'Outreach', count: badges.outreach?.ready ?? undefined },
    ];
    const bar = el('div', { class: 'tabs', role: 'tablist' });
    for (const item of items) {
      bar.append(el('button', {
        class: `tab ${item.id === activeTab ? 'tab--on' : ''}`, role: 'tab', type: 'button',
        'aria-selected': item.id === activeTab ? 'true' : 'false',
        onclick: () => navigate(item.id),
      }, [el('span', { text: item.label }), item.count === undefined ? null : el('span', { class: 'tab__count', text: String(item.count) })]));
    }
    host.append(bar);
  }

  const BUSY_PHASES = [RunPhase.PREPARING, RunPhase.RUNNING, RunPhase.WAITING, RunPhase.STOPPING];

  /** A short, plain sentence about what the run is doing right now. */
  function progressSentence() {
    const counts = controller.state.counts ?? {};
    const kind = controller.state.kind === 'outreach' ? 'outreach run' : 'collection';
    const parts = [];
    if (counts.done) parts.push(`${counts.done} done`);
    if (counts.refused) parts.push(`${counts.refused} refused`);
    if (counts.skipped) parts.push(`${counts.skipped} skipped`);
    if (counts.failed) parts.push(`${counts.failed} failed`);
    const label = PHASE_LABEL[controller.state.phase] ?? 'Working';
    return parts.length ? `${label} — ${parts.join(', ')}` : `${label} the ${kind}`;
  }

  /**
   * The run banner under the header. It exists only while a run is active; when
   * idle the slot is cleared so it takes up no vertical space.
   */
  function renderRunBanner() {
    const host = $('#run-banner', doc);
    if (!host) return;
    clear(host);
    if (!BUSY_PHASES.includes(controller.state.phase)) return;
    const stopBtn = btn('Stop', {
      variant: 'danger',
      onClick: () => { controller.stop('stopped by the owner'); toast('Stopping after the current action…'); },
    });
    const node = banner('', { variant: 'info', actions: [stopBtn] });
    const text = node.querySelector('.banner__text');
    if (text) {
      clear(text);
      text.append(
        el('span', { class: 'entropy-dot entropy-dot--live' }),
        el('span', { text: progressSentence() }),
        el('span', { class: 'telemetry__count', id: 'telemetry-countdown' }),
      );
    }
    host.append(node);
    paintCountdown();
  }

  function paintCountdown() {
    const node = $('#telemetry-countdown', doc);
    if (!node) return;
    if (nextActionAt && (controller.state.phase === RunPhase.WAITING || controller.state.phase === RunPhase.RUNNING)) {
      const left = Math.max(0, nextActionAt - Date.now());
      node.textContent = left > 0 ? ` · next in ${formatCountdown(left)}` : '';
    } else {
      node.textContent = '';
    }
  }

  function formatCountdown(ms) {
    const total = Math.round(ms / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  /* --------------------------------------------------------- run events */

  function handleRunEvent(event) {
    if (event.type === 'delay') nextActionAt = (event.nextAt ?? Date.now() + (event.ms ?? 0));
    if (event.type === 'action' || event.type === 'outcome') nextActionAt = null;
    if (['phase', 'delay', 'action', 'outcome', 'summary', 'session'].includes(event.type)) {
      renderRunBanner();
    }
    if (event.type === 'summary' || event.type === 'outcome') void refreshShell();
    if (event.type === 'refusal' && event.severity === 'account') toast(event.reason ?? 'Instagram refused an action.', 'error');
  }

  /* ------------------------------------------------------------ routing */

  // Mount the active view into the live root. Both views stay alive across
  // switches so a tab change never loses a scroll position, a filter or a
  // half-written template; only the active one is attached to the DOM.
  function mountActive() {
    const root = $('#view-root', doc);
    if (!root) return;
    clear(root);
    views[activeTab].mount(root);
  }

  function navigate(tab) {
    if (!views[tab]) return;          // unknown tab: ignore rather than crash
    if (tab === activeTab) return;    // re-clicking the active tab is a no-op
    activeTab = tab;
    renderTabs();
    mountActive();
  }

  function openSettingsDrawer() {
    const view = createSettingsView({ api, toast, onSaved: () => { void refreshShell(); } });
    const body = el('div');
    const close = drawer({ title: 'Safety & ranking settings', body, actions: [btn('Close', { variant: 'ghost', onClick: () => close() })] });
    view.mount(body);
  }

  function openBackupDrawer() {
    const view = createBackupView({ api, toast, onChanged: () => { void refreshShell(); } });
    const body = el('div');
    const close = drawer({ title: 'Save · Import · Export', body, actions: [btn('Close', { variant: 'ghost', onClick: () => close() })] });
    view.mount(body);
  }

  /* --------------------------------------------------------- shell data */

  async function refreshShell() {
    let overview = null;
    try {
      overview = await api.overview();
    } catch (error) {
      toast(`Could not read the workspace: ${error?.message ?? error}`, 'error');
    }
    try {
      // overview() summarises the workspace but does not carry the governor state,
      // and the budget is computed from that state, so read the row directly.
      const [workspace, settings] = await Promise.all([api.workspace(), api.settings()]);
      cachedBudget = controller.budget(workspace?.governorState ?? null, { settings, workspaceKey: api.workspaceId });
    } catch { cachedBudget = null; }
    renderHeaderRight(overview);
    renderRunBanner();
  }

  /* --------------------------------------------------------- metronome */

  function startScheduler() {
    const onTick = () => {
      tickCount += 1;
      paintCountdown();
      // A full telemetry re-read once every ten seconds keeps the quota meters
      // honest without hammering IndexedDB on every beat.
      if (tickCount % 10 === 0) void refreshShell();
    };
    try {
      const url = chromeApi?.runtime?.getURL?.('app/lib/scheduler.worker.js');
      if (!url || typeof Worker === 'undefined') throw new Error('no worker');
      worker = new Worker(url);
      worker.onmessage = (event) => { if (event?.data?.type === 'tick') onTick(); };
      worker.postMessage({ type: 'start', intervalMs: 1000 });
    } catch {
      // No worker available (or blocked): fall back to a page timer. It throttles
      // when the tab is hidden, but the countdown still moves when it is visible.
      fallbackTimer = setInterval(onTick, 1000);
      if (typeof fallbackTimer?.unref === 'function') fallbackTimer.unref();
    }
  }

  function stopScheduler() {
    try { worker?.postMessage({ type: 'stop' }); worker?.terminate?.(); } catch { /* already gone */ }
    worker = null;
    if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
  }

  /* ------------------------------------------------------------- lifecycle */

  async function start() {
    const left = $('#shell-left', doc);
    if (left) clear(left).append(brand());
    renderTabs();
    renderHeaderRight(null);
    renderRunBanner();

    // Watch the tabs for account switches and blocks so the guardrail pill and a
    // toast reflect what the content script sees, without a page refresh.
    statusWatcher = api.watch?.((row) => {
      if (row?.accountSwitched) toast('The Instagram account changed in the worker tab. The run was stopped.', 'error');
      if (row?.blocked) toast(row.reason ?? 'Instagram blocked an action; the autopilot is locked.', 'error');
      void refreshShell();
    }, { intervalMs: 1000 });

    if (bus?.subscribe) bus.subscribe((message) => {
      for (const handler of syncHandlers) { try { handler(message); } catch { /* ignore */ } }
      if (message?.type === 'CIRCUIT_BREAKER_TRIPPED') toast(message.reason ?? 'The circuit breaker tripped.', 'error');
      void refreshShell();
    });

    // The tab deep link (?tab=outreach from the popup, or the pill's
    // ?tab=collector&auto=1) was already read into activeTab and ctx.initialRequest
    // at construction. Clear the query string now so a refresh neither re-runs an
    // auto-started collection nor re-deep-links.
    try {
      const loc = globalThis.location;
      if (globalThis.history?.replaceState && loc && (loc.search || loc.hash)) {
        globalThis.history.replaceState(null, '', loc.pathname);
      }
    } catch { /* a browser without replaceState simply keeps the query */ }

    startScheduler();
    await refreshShell();
    // Not navigate(): activeTab is already the target, and navigate() no-ops on the
    // current tab. Render the tab bar to reflect it and mount the view directly.
    renderTabs();
    mountActive();
  }

  function destroy() {
    stopScheduler();
    statusWatcher?.dispose?.();
    bus?.close?.();
    views.collector.destroy();
    views.outreach.destroy();
  }

  return { start, destroy, navigate, refreshShell, api, controller, bus, get activeTab() { return activeTab; } };
}

/* Auto-start when this module is the dashboard page. The roots are in index.html;
 * if they are absent (a unit test importing this module) nothing is mounted. */
if (typeof document !== 'undefined' && document.getElementById?.('view-root')) {
  const app = createApp({});
  app.start().catch((error) => {
    const root = document.getElementById('view-root');
    if (root) {
      clear(root).append(note(`The dashboard could not start: ${error?.message ?? error}. Reload this tab; if it persists, remove and re-load the extension.`, 'danger'));
    }
  });
}
