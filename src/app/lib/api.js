/**
 * The dashboard's one door to the outside world.
 *
 * There is no service worker in this extension, and that is deliberate: when
 * Chrome refuses to register a worker ("Status code: 2", usually a corrupted
 * browser profile rather than anything wrong with the extension), every feature
 * dies at once and the owner can do nothing about it. Nothing here needed one:
 *
 *   - storage/db.js is plain IndexedDB, available to any extension page;
 *   - settings live in chrome.storage.local, available to any extension page;
 *   - core/ is pure computation with no Chrome dependency at all;
 *   - reaching a tab needs chrome.tabs and chrome.scripting, which this page has.
 *
 * An extension PAGE is also strictly better for a long job: it is a normal tab
 * that lives until it is closed, while MV3 terminates idle workers and offers no
 * supported way to hold one open for the hours an outreach run needs.
 *
 * Talking to the Instagram tab goes through the storage mailbox in
 * storage/bridge.js rather than chrome.tabs.sendMessage. A message channel has
 * one failure mode that matters here: if the content script keeps the channel
 * open and then never answers — it threw, the page navigated, the tab was
 * discarded — the promise never settles and every caller hangs behind a spinner
 * forever. A mailbox row is persisted, carries its own deadline, can be
 * withdrawn by the sender, and survives the tab reloading mid-run.
 *
 * Every function that touches Chrome takes it as a parameter, so the whole
 * surface is testable without a browser.
 */

import { ACTIVE_WORKSPACE_KEY, CommandType, createBridge, chromeStorageAdapter } from '../../storage/bridge.js';
import {
  countEnabledTemplates,
  deleteGroup,
  finishScrapeRun,
  getGroup,
  getLead,
  getWorkspace,
  groupRecord,
  leadRecord,
  listActions,
  listGroups,
  listLeads,
  listOutreachSessions,
  listScrapeRuns,
  listTemplates,
  logAction,
  putGroup,
  putOutreachSession,
  putScrapeRun,
  putWorkspace,
  runRecord,
  sessionRecord,
  setLeadGroup,
  updateOutreachSession,
  updateWorkspace,
  upsertEdge,
  upsertLead,
} from '../../storage/db.js';
import { loadSettings, saveSettings } from '../../storage/settings.js';
import { DmEvent, RelEvent, RelState, applyDmEvent, applyRelEvent } from '../../core/lifecycle.js';
import {
  ActionType,
  countersFor,
  initialGovernorState,
  recordAction,
  tripCircuitBreaker,
} from '../../core/governor.js';

/** Where the content script looks to find out which workspace it serves. */
export { ACTIVE_WORKSPACE_KEY };

/**
 * The managed Instagram window: small, parked beside the dashboard, reused.
 *
 * A dedicated window beats driving whatever tab the owner happens to have open,
 * because the owner keeps browsing while a run works, and a run that follows the
 * active tab would navigate away from the page they are reading.
 */
export const WORKER_WINDOW = Object.freeze({ width: 480, height: 780, left: 40, top: 40 });

const IG_URL_PATTERNS = Object.freeze(['*://www.instagram.com/*', '*://i.instagram.com/*']);

/**
 * How long each command may take before the dashboard says so.
 *
 * These are ceilings that convert an infinite hang into a sentence, not budgets:
 * a collection is deliberately slow because reads are paced to look human, so a
 * full follower list legitimately runs for many minutes.
 */
export const COMMAND_TIMEOUT_MS = Object.freeze({
  [CommandType.PING]: 8_000,
  [CommandType.GET_CONTEXT]: 8_000,
  [CommandType.PROBE]: 30_000,
  [CommandType.COLLECT_LEADS]: 30 * 60_000,
  [CommandType.SYNC_RELATIONSHIPS]: 20 * 60_000,
  [CommandType.EXECUTE_FOLLOW]: 90_000,
  [CommandType.EXECUTE_UNFOLLOW]: 90_000,
  [CommandType.EXECUTE_DM]: 120_000,
  [CommandType.OPEN_THREAD]: 90_000,
  [CommandType.STOP]: 10_000,
  __default: 30_000,
});

export function timeoutFor(type) {
  return COMMAND_TIMEOUT_MS[type] ?? COMMAND_TIMEOUT_MS.__default;
}

const PROFILE_URL = /^https?:\/\/(?:www\.)?instagram\.com\/([^/?#]+)/i;

/** Routes that are chrome, not accounts: "/explore" is not a lead called explore. */
const NON_USERNAME = new Set([
  'p', 'reel', 'reels', 'tv', 'explore', 'accounts', 'direct', 'stories', 'about',
  'legal', 'privacy', 'terms', 'developer', 'developers', 'challenge', 'api',
  'graphql', 'oauth', 'session', 'static', 'web', 'tags', 'saved', 'inbox',
]);

/** The username in an Instagram URL, or null when the URL is not a profile. */
export function usernameFromUrl(url) {
  const match = PROFILE_URL.exec(String(url ?? ''));
  if (!match) return null;
  const name = match[1];
  if (NON_USERNAME.has(name.toLowerCase())) return null;
  return name;
}

export function isInstagramUrl(url) {
  return /^https?:\/\/(?:www|i)\.instagram\.com\//i.test(String(url ?? ''));
}

/** One tab, described the way the tab picker and the UI need it. */
export function describeTab(tab) {
  const url = String(tab?.url ?? '');
  return {
    id: tab?.id ?? null,
    windowId: tab?.windowId ?? null,
    url,
    title: String(tab?.title ?? ''),
    active: Boolean(tab?.active),
    status: tab?.status ?? null,
    username: usernameFromUrl(url),
    instagram: isInstagramUrl(url),
    discarded: Boolean(tab?.discarded),
  };
}

/**
 * Which open tab should do the work.
 *
 * Preference order: the tab the owner asked for, then the managed worker window,
 * then an Instagram tab showing the right profile, then any Instagram tab. Picking
 * "the active tab" is what silently aims a follow at the wrong person when the
 * owner has five profiles open and clicks into the dashboard.
 */
export function pickTab(tabs, { tabId = null, username = null, workerTabId = null } = {}) {
  const described = (tabs ?? []).map(describeTab).filter((tab) => tab.instagram);
  if (tabId !== null && tabId !== undefined) {
    const wanted = described.find((tab) => tab.id === Number(tabId));
    if (wanted) return { tab: wanted, reason: 'requested' };
  }
  if (workerTabId !== null && workerTabId !== undefined) {
    const worker = described.find((tab) => tab.id === Number(workerTabId));
    if (worker) return { tab: worker, reason: 'worker' };
  }
  if (username) {
    const exact = described.find((tab) => tab.username === username);
    if (exact) return { tab: exact, reason: 'profile' };
  }
  const active = described.find((tab) => tab.active);
  if (active) return { tab: active, reason: 'active' };
  if (described.length) return { tab: described[0], reason: 'any' };
  return { tab: null, reason: 'none' };
}

const defaultSleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  // Node only: a pending timer keeps the process alive, so an abandoned wait
  // would hold `node --test` open long after the tests finished.
  if (typeof timer?.unref === 'function') timer.unref();
});

/** Where the remembered worker window is kept between dashboard sessions. */
export const WORKER_WINDOW_KEY = 'ig_crm_worker_window_v1';

/**
 * The managed Instagram window and the tabs inside it.
 *
 * Everything here is injected (`chromeApi`, `sleep`) because a controller that
 * can only be exercised in a real browser is a controller nobody tests, and the
 * failure it hides — aiming a follow at the wrong tab — is the expensive one.
 */
export function createTabController({
  chromeApi = null,
  sleep = defaultSleep,
  now = () => Date.now(),
  windowShape = WORKER_WINDOW,
} = {}) {
  const chrome = chromeApi ?? globalThis.chrome;
  if (!chrome?.tabs) throw new Error('chrome.tabs is unavailable: the dashboard must run as an extension page');

  const readMemory = async () => {
    try {
      return (await chrome.storage?.local?.get(WORKER_WINDOW_KEY))?.[WORKER_WINDOW_KEY] ?? null;
    } catch {
      return null;
    }
  };
  const writeMemory = async (value) => {
    try {
      await chrome.storage?.local?.set({ [WORKER_WINDOW_KEY]: value });
    } catch { /* a failed memo costs a new window next time, nothing more */ }
  };

  const tabById = async (tabId) => {
    if (tabId === null || tabId === undefined) return null;
    try {
      return describeTab(await chrome.tabs.get(Number(tabId)));
    } catch {
      return null; // the tab is gone: closed, crashed or discarded
    }
  };

  return {
    /** Every Instagram tab currently open, described and de-duplicated. */
    async listTabs() {
      const tabs = await chrome.tabs.query({ url: [...IG_URL_PATTERNS] });
      return (tabs ?? []).map(describeTab);
    },

    /**
     * The managed worker window, created once and reused.
     *
     * `focused: false` matters: stealing focus from the dashboard every time a
     * run starts is how an extension gets closed in frustration.
     */
    async ensureWorker({ url = 'https://www.instagram.com/', reuse = true } = {}) {
      const remembered = reuse ? await readMemory() : null;
      if (remembered?.tabId) {
        const existing = await tabById(remembered.tabId);
        if (existing) {
          if (url && existing.url !== url) await chrome.tabs.update(existing.id, { url });
          return { tab: existing, created: false };
        }
      }
      const win = await chrome.windows.create({
        url,
        type: 'popup',
        width: windowShape.width,
        height: windowShape.height,
        left: windowShape.left,
        top: windowShape.top,
        focused: false,
      });
      const tab = describeTab((win?.tabs ?? [])[0] ?? { id: win?.id, windowId: win?.id, url });
      await writeMemory({ windowId: win?.id ?? null, tabId: tab.id, createdAt: now() });
      return { tab, created: true, windowId: win?.id ?? null };
    },

    /** The remembered worker tab if it still exists, without creating one. */
    async worker() {
      const remembered = await readMemory();
      if (!remembered?.tabId) return null;
      return tabById(remembered.tabId);
    },

    /**
     * Bring an Instagram tab into view so the owner can watch the browser
     * automation work right in front of them.
     */
    async focus(tabId) {
      if (tabId === null || tabId === undefined) return { ok: false, reason: 'no tab id' };
      try {
        const tab = await chrome.tabs.update(Number(tabId), { active: true });
        if (tab?.windowId !== undefined && tab?.windowId !== null && typeof chrome.windows?.update === 'function') {
          try { await chrome.windows.update(Number(tab.windowId), { focused: true }); } catch { /* window focus may be disallowed */ }
        }
        return { ok: true, tab: describeTab(tab) };
      } catch (error) {
        return { ok: false, reason: String(error?.message ?? error) };
      }
    },

    /** Open a normal visible Instagram tab when none is open yet. */
    async openInstagram(url = 'https://www.instagram.com/', options = {}) {
      try {
        const created = await chrome.tabs.create({ url, active: options.active !== false });
        const tab = describeTab(created);
        if (options.waitForLoad !== false && tab.id !== null) {
          const loaded = await this.waitForLoad(tab.id, options);
          return { ok: loaded.ok, tab: loaded.tab ?? tab, created: true, reason: loaded.reason ?? null };
        }
        return { ok: true, tab, created: true };
      } catch (error) {
        return { ok: false, tab: null, created: false, reason: String(error?.message ?? error) };
      }
    },

    /**
     * Move a tab and wait for it to arrive.
     *
     * `chrome.tabs.update` throws for a discarded or crashed tab, and an uncaught
     * throw here would surface as "the dashboard broke" instead of "that tab is
     * gone", so the failure is returned like every other.
     */
    async navigate(tabId, url, options = {}) {
      try {
        const update = options.focus ? { url, active: true } : { url };
        const updated = await chrome.tabs.update(Number(tabId), update);
        if (options.focus && updated?.windowId !== undefined && typeof chrome.windows?.update === 'function') {
          try { await chrome.windows.update(Number(updated.windowId), { focused: true }); } catch { /* best-effort focus */ }
        }
      } catch (error) {
        return { ok: false, reason: `the tab could not be moved (${String(error?.message ?? error)})` };
      }
      return this.waitForLoad(tabId, options);
    },

    /** Wait for a tab to finish loading, with a ceiling instead of a hang. */
    async waitForLoad(tabId, { timeoutMs = 20_000, intervalMs = 250 } = {}) {
      const deadline = now() + timeoutMs;
      let tab = await tabById(tabId);
      while (now() < deadline) {
        tab = await tabById(tabId);
        if (!tab) return { ok: false, reason: 'the tab was closed while it was loading' };
        if (tab.status === 'complete') return { ok: true, tab };
        await sleep(intervalMs);
      }
      return { ok: false, reason: `the tab was still loading after ${Math.round(timeoutMs / 1000)}s`, tab };
    },

    /**
     * Put the content script in a tab that does not have it.
     *
     * A tab opened before the extension was installed or reloaded never ran the
     * manifest's content script, and without this the dashboard would report
     * "the tab is not responding" for a page that is perfectly healthy. The
     * loader guards against running twice, so injecting into a live tab is safe.
     */
    async inject(tabId) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: Number(tabId) }, files: ['content/content.js'] });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: String(error?.message ?? error) };
      }
    },

    async closeWorker() {
      const remembered = await readMemory();
      await writeMemory(null);
      if (!remembered?.windowId) return { closed: false };
      try {
        await chrome.windows.remove(Number(remembered.windowId));
        return { closed: true };
      } catch {
        return { closed: false };
      }
    },

    tabById,
  };
}

/**
 * One command's failure, in a sentence the owner can act on.
 *
 * The bridge already distinguishes a timeout from "no handler answered"; this
 * turns that distinction into advice, because "reload the Instagram tab" and
 * "wait for the active window to open" are different actions.
 */
export function explainFailure(type, posted, { tabLabel = 'the Instagram tab' } = {}) {
  if (!posted || posted.ok) return null;
  const reason = String(posted.reason ?? 'no answer');
  const seconds = Math.round(Number(posted.elapsedMs ?? 0) / 1000);
  if (posted.timedOut || /no reply within|timed out|timeout/i.test(reason)) {
    return `${tabLabel} stopped answering a ${type} command after ${seconds}s. `
      + 'Reload the Instagram tab, make sure you are still logged in, and try again.';
  }
  if (/no handler|cannot handle/i.test(reason)) {
    return `${tabLabel} is not running this extension's content script. Reload the tab (or let the dashboard inject it) and try again.`;
  }
  if (/withdrawn/i.test(reason)) return `The ${type} command was withdrawn because it outlived its deadline.`;
  return reason;
}

/* ------------------------------------------------------- outcomes to states */

/**
 * Walk a lead through a list of lifecycle events, in order.
 *
 * An event that is not valid from the current state is skipped with a warning
 * rather than throwing: a run that follows 200 people must not die because one
 * record was already where the event would have put it, and the warning is what
 * the session log shows afterwards.
 */
export function applyEvents({ lead, relEvents = [], dmEvents = [] }) {
  let relState = lead?.relState ?? RelState.NONE;
  let dmState = lead?.dmState ?? 'NONE';
  const warnings = [];
  for (const event of relEvents) {
    const step = applyRelEvent(relState, event);
    if (step.ok) relState = step.next;
    else warnings.push(step.reason);
  }
  for (const event of dmEvents) {
    const step = applyDmEvent(dmState, event);
    if (step.ok) dmState = step.next;
    else warnings.push(step.reason);
  }
  return { relState, dmState, warnings };
}

/**
 * What an action's verified result means for one lead.
 *
 * Pure, and the single place where an Instagram outcome becomes a database fact.
 * Two rules matter more than the rest:
 *
 *   - A success is only recorded as a success when the content script verified
 *     it (`outcome: 'done'` means the button settled, or the message appeared in
 *     the thread). An unverified click is recorded as a failure, because
 *     believing a follow landed when it did not is how a campaign sends two.
 *   - Something the page told us but we did not do is recorded as an observation:
 *     the state moves to what Instagram shows, and `followedViaExtension` stays
 *     false, so the cleaner never unfollows a friend the owner followed by hand.
 */
export function eventsForOutcome({ actionType, result, lead, now = Date.now() }) {
  const dm = lead?.dmState ?? 'NONE';
  const outcome = result?.outcome ?? (result?.ok ? 'done' : 'not_done');
  const relEvents = [];
  const dmEvents = [];
  const patch = {};
  const warnings = [];
  let observed = null;
  let stopRun = false;

  const armDm = () => {
    if (dm === 'NONE') dmEvents.push(DmEvent.FUNNEL_ARMED, DmEvent.DM_CONDITION_MET);
    else if (dm === 'WAITING_FOR_ACCEPT' || dm === 'DM_FAILED') dmEvents.push(DmEvent.DM_CONDITION_MET);
  };

  if (actionType === ActionType.FOLLOW) {
    if (outcome === 'done') {
      const requested = Boolean(result?.requested);
      relEvents.push(RelEvent.QUEUE_FOLLOW, requested ? RelEvent.FOLLOW_CLICKED_PRIVATE : RelEvent.FOLLOW_CLICKED_PUBLIC);
      patch.followedViaExtension = true;
      if (requested) patch.requestedAt = now;
      else patch.followedAt = now;
      patch.lastError = null;
    } else if (outcome === 'skipped') {
      // "Already following" / "a request is pending": true on the page, absent
      // from our records. Adopt the page's truth without claiming the action.
      observed = /request/i.test(String(result?.reason ?? '')) ? 'requested' : 'following';
      relEvents.push(RelEvent.QUEUE_FOLLOW, observed === 'requested' ? RelEvent.FOLLOW_CLICKED_PRIVATE : RelEvent.FOLLOW_CLICKED_PUBLIC);
      if (observed === 'requested' && !lead?.requestedAt) patch.requestedAt = now;
      patch.followedViaExtension = false;
    } else if (outcome === 'stopped') {
      stopRun = true;
      patch.lastError = String(result?.reason ?? 'the run was stopped');
    } else {
      patch.attempts = Number(lead?.attempts ?? 0) + 1;
      patch.lastError = String(result?.reason ?? 'the follow did not land');
    }
  } else if (actionType === ActionType.UNFOLLOW) {
    if (outcome === 'done') {
      relEvents.push(RelEvent.QUEUE_UNFOLLOW, RelEvent.UNFOLLOW_EXECUTED);
      patch.unfollowedAt = now;
      patch.lastError = null;
    } else if (outcome === 'skipped') {
      observed = 'not-following';
      patch.lastError = null;
    } else if (outcome === 'stopped') {
      stopRun = true;
      patch.lastError = String(result?.reason ?? 'the run was stopped');
    } else {
      patch.attempts = Number(lead?.attempts ?? 0) + 1;
      patch.lastError = String(result?.reason ?? 'the unfollow did not land');
    }
  } else {
    // A message: DM_WARM spends the warm budget, DM_COLD the invite budget, and
    // both are recorded the same way because the one-message lock applies to both.
    const sentEvent = actionType === ActionType.DM_WARM ? DmEvent.DM_SENT_PRIMARY : DmEvent.DM_SENT_REQUEST;
    if (outcome === 'done') {
      armDm();
      dmEvents.push(sentEvent);
      patch.messagedAt = now;
      patch.attempts = Number(lead?.attempts ?? 0) + 1;
      patch.lastError = null;
    } else if (outcome === 'skipped' && result?.existingThread) {
      armDm();
      dmEvents.push(DmEvent.DM_EXISTING_THREAD);
      observed = 'existing-thread';
    } else if (outcome === 'stopped') {
      stopRun = true;
      patch.lastError = String(result?.reason ?? 'the run was stopped');
    } else {
      armDm();
      dmEvents.push(DmEvent.DM_FAILED);
      patch.attempts = Number(lead?.attempts ?? 0) + 1;
      patch.lastError = String(result?.reason ?? 'the message did not appear in the thread');
    }
  }

  const states = applyEvents({ lead, relEvents, dmEvents });
  return {
    ok: outcome === 'done',
    outcome,
    observed,
    stopRun,
    relEvents,
    dmEvents,
    warnings: [...warnings, ...states.warnings],
    patch: { ...patch, relState: states.relState, dmState: states.dmState },
  };
}

/** The workspace used before the logged-in account id is known. */
export const BOOTSTRAP_WORKSPACE_ID = 'default';

/**
 * Fields a re-collection must never overwrite.
 *
 * Collecting the same profile twice updates the evidence (score, edges, name,
 * avatar) and leaves the funnel alone. Overwriting `relState` here would forget
 * that we already followed someone, and the next run would follow them again —
 * the exact mistake the local-record check exists to prevent.
 */
const PRESERVED_ON_RECOLLECT = Object.freeze([
  'relState', 'dmState', 'followedAt', 'requestedAt', 'acceptedAt', 'messagedAt',
  'repliedAt', 'unfollowedAt', 'nextEligibleAt', 'attempts', 'lastError',
  'isWhitelisted', 'isProtectedBaseline', 'doNotContactReason', 'groupIds',
  'followedViaExtension', 'firstSeenAt',
]);

/** Merge a freshly collected lead over the stored one. Pure. */
export function mergeLead(existing, incoming) {
  if (!existing) return incoming;
  const preserved = {};
  for (const field of PRESERVED_ON_RECOLLECT) {
    if (existing[field] !== undefined && existing[field] !== null) preserved[field] = existing[field];
  }
  return { ...incoming, ...preserved };
}

/**
 * The command channel: post to the mailbox, wait for the answer, keep the tab
 * ready, and report a failure in words.
 */
export function createCommandChannel({
  storage,
  tabs,
  state,
  bridgeFor,
  now = () => Date.now(),
  sleep = defaultSleep,
} = {}) {
  const bridge = () => bridgeFor(state.workspaceId);

  return {
    /** Point everything at one workspace, and tell the tabs which one it is. */
    async setWorkspace(workspaceId, extra = {}) {
      const id = String(workspaceId ?? BOOTSTRAP_WORKSPACE_ID);
      state.workspaceId = id;
      await storage.set(ACTIVE_WORKSPACE_KEY, { workspaceId: id, at: now(), ...extra });
      return id;
    },

    async rememberedWorkspace() {
      const row = await storage.get(ACTIVE_WORKSPACE_KEY);
      return row?.workspaceId ? String(row.workspaceId) : null;
    },

    /** Make sure a tab can answer: loaded, content script present, bridge alive. */
    async prepare(tabId, { timeoutMs = 8_000 } = {}) {
      if (tabId === null || tabId === undefined) return { ok: false, reason: 'no Instagram tab was chosen' };
      const tab = await tabs.tabById(tabId);
      if (!tab) return { ok: false, reason: 'the Instagram tab was closed' };
      if (tab.status !== 'complete') {
        const loaded = await tabs.waitForLoad(tabId, { timeoutMs });
        if (!loaded.ok) return loaded;
      }
      await tabs.inject(tabId);
      // The loader is asynchronous: the script is injected before the module has
      // finished importing, so the first ping can legitimately find nobody home.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const ping = await bridge().postCommand(CommandType.PING, {}, { timeoutMs: Math.min(timeoutMs, 6_000) });
        // postCommand's `result` IS the answer's value: the ok/reason/severity
        // fields are lifted out of the row, so digging for `.value` again reads
        // a healthy tab as a dead one.
        if (ping?.ok) return { ok: true, tab, context: ping.result ?? null };
        await sleep(400);
      }
      return { ok: false, reason: 'the content script is in the tab but nothing answered; reload the Instagram tab and try again', tab };
    },

    /** One command, one answer, one honest failure. */
    async send(type, payload = {}, options = {}) {
      const timeoutMs = options.timeoutMs ?? timeoutFor(type);
      if (options.tabId !== undefined && options.tabId !== null) {
        const ready = await this.prepare(options.tabId, { timeoutMs: options.prepareTimeoutMs ?? 8_000 });
        if (!ready.ok && !options.allowUnprepared) return { ok: false, reason: ready.reason, value: null, severity: 'tab' };
      }
      const posted = await bridge().postCommand(type, payload, { timeoutMs, signal: options.signal ?? null });
      if (!posted) return { ok: false, reason: 'the mailbox returned nothing', value: null, severity: 'tab', elapsedMs: 0, commandId: null };
      return {
        ok: Boolean(posted.ok),
        reason: posted.ok ? null : explainFailure(type, posted),
        raw: posted.ok ? null : (posted.reason ?? null),
        value: posted.result ?? null,
        severity: posted.severity ?? (posted.ok ? null : 'unknown'),
        elapsedMs: posted.elapsedMs ?? 0,
        commandId: posted.commandId ?? null,
        timedOut: Boolean(posted.timedOut),
      };
    },

    /**
     * A command that may need the tab moved first.
     *
     * The content script refuses to click on a profile that is not on screen and
     * answers `{ needsNavigation, url }` instead. Moving the tab is the
     * dashboard's job (it owns chrome.tabs), so the command is re-sent once after
     * the move — one retry, because a second would mean guessing.
     */
    async sendWithNavigation(type, payload = {}, options = {}) {
      const tabId = options.tabId;
      const first = await this.send(type, payload, options);
      const wanted = first?.value?.url ?? null;
      if (first?.ok || !first?.value?.needsNavigation || !wanted || tabId === null || tabId === undefined) return first;
      const moved = await tabs.navigate(tabId, wanted, { focus: Boolean(options.focus) });
      if (!moved.ok) return { ...first, reason: `${first.reason} — and the tab could not be moved there (${moved.reason})` };
      await sleep(options.settleMs ?? 2000);
      const second = await this.send(type, payload, { ...options, tabId });
      return { ...second, navigated: true, firstReason: first.reason };
    },

    /** Stop whatever the tab is doing. Never times out into silence. */
    async stop(reason = 'stopped from the dashboard') {
      const posted = await bridge().postStop(reason);
      return {
        ok: Boolean(posted?.ok),
        reason: posted?.ok ? null : String(posted?.reason ?? 'the tab did not answer the stop'),
        value: posted?.result ?? null,
      };
    },

    /**
     * Follow the tab's status rows until `dispose()` is called.
     *
     * Polling rather than `chrome.storage.onChanged` keeps one mechanism for both
     * sides of the mailbox, and the interval is the bridge's own poll rate, so a
     * status is never seen here before the command that produced it.
     */
    watch(onStatus, { intervalMs = 1_000, signal = null } = {}) {
      let stopped = false;
      let lastAt = 0;
      const loop = async () => {
        while (!stopped && !signal?.aborted) {
          const row = await bridge().waitForStatus({ newerThan: lastAt, timeoutMs: intervalMs * 2 });
          if (stopped || signal?.aborted) return;
          if (row && Number(row.at ?? 0) > lastAt) {
            lastAt = Number(row.at);
            try {
              onStatus(row);
            } catch { /* a listener that throws must not kill the watch */ }
          }
          await sleep(intervalMs);
        }
      };
      void loop();
      return { dispose() { stopped = true; } };
    },

    /**
     * Work out which account this browser is logged into, and own its workspace.
     *
     * The workspace id is Instagram's numeric user id, so two accounts in one
     * browser profile never share leads, quotas or campaign state. A remembered
     * id is verified against the tab rather than trusted: switching accounts is
     * the one mistake that quietly merges two businesses into one table.
     */
    async resolveWorkspace({ force = false, tabId = null } = {}) {
      const remembered = force ? null : await this.rememberedWorkspace();
      if (remembered) {
        await this.setWorkspace(remembered);
        if (tabId !== null) {
          const context = await this.send(CommandType.GET_CONTEXT, {}, { tabId, timeoutMs: 10_000, allowUnprepared: true });
          const viewerId = context?.value?.viewerId ?? context?.value?.viewer?.id ?? null;
          const viewerUsername = context?.value?.viewerUsername ?? context?.value?.viewer?.username ?? null;
          const viewer = (viewerId || viewerUsername)
            ? { id: viewerId ? String(viewerId) : '', username: viewerUsername ?? '' }
            : (context?.value?.viewer ?? null);
          if (context.ok && viewerId && String(viewerId) !== remembered) {
            return this.resolveWorkspace({ force: true, tabId });
          }
          if (context.ok) {
            if (viewerUsername) await this.setWorkspace(remembered, { viewerUsername });
            return { ok: true, workspaceId: remembered, viewer, remembered: true };
          }
        } else {
          return { ok: true, workspaceId: remembered, viewer: null, remembered: true };
        }
      }

      await this.setWorkspace(BOOTSTRAP_WORKSPACE_ID);
      const probe = await this.send(CommandType.PROBE, {}, { tabId, allowUnprepared: tabId === null });
      if (!probe.ok) return { ok: false, workspaceId: BOOTSTRAP_WORKSPACE_ID, reason: probe.reason, viewer: null };
      const viewer = probe.value?.viewer ?? null;
      const resolvedId = viewer?.id || probe.value?.session?.sessionUserId || null;
      if (!resolvedId && !viewer?.username) {
        return {
          ok: false,
          workspaceId: BOOTSTRAP_WORKSPACE_ID,
          reason: probe.value?.session?.loggedIn
            ? 'Instagram did not say which account this is; reload the tab and try again'
            : 'this tab is not logged in to Instagram',
          viewer: null,
        };
      }
      const nextWorkspaceId = resolvedId ? String(resolvedId) : BOOTSTRAP_WORKSPACE_ID;
      await this.setWorkspace(nextWorkspaceId, { viewerUsername: viewer?.username ?? null });
      return { ok: true, workspaceId: nextWorkspaceId, viewer: { ...(viewer ?? {}), id: nextWorkspaceId }, remembered: false };
    },
  };
}

/**
 * The ledger: every read and write the views need, against one workspace.
 *
 * Split from the command channel on purpose. The channel talks to a browser tab
 * and can fail because of the network, the page or the account; the ledger talks
 * to IndexedDB and fails only if the disk does. Keeping them apart is what lets a
 * run keep recording what it did after the tab it was driving stops answering.
 */
export const DEFAULT_BUCKET_NAME = 'Default';

export function defaultBucketIdFor(workspaceId) {
  return `${String(workspaceId)}:default`;
}

export function isDefaultBucket(group, workspaceId = null) {
  if (!group) return false;
  if (group.isDefault === true) return true;
  if (workspaceId && String(group.groupId) === defaultBucketIdFor(workspaceId)) return true;
  return String(group.groupId ?? '').endsWith(':default');
}

export function createLedger({ state, now = () => Date.now() } = {}) {
  const ws = () => String(state.workspaceId ?? BOOTSTRAP_WORKSPACE_ID);

  async function ensureDefaultBucket() {
    const workspaceId = ws();
    const defaultId = defaultBucketIdFor(workspaceId);
    const existing = await listGroups(workspaceId);
    const found = existing.find((g) => isDefaultBucket(g, workspaceId) || g.name.toLowerCase() === DEFAULT_BUCKET_NAME.toLowerCase());
    if (found) {
      if (!found.isDefault) {
        const patched = { ...found, isDefault: true };
        await putGroup(patched);
        return patched;
      }
      return found;
    }
    const created = {
      ...groupRecord({ workspaceId, name: DEFAULT_BUCKET_NAME, note: 'Ready default bucket', groupId: defaultId }),
      isDefault: true,
    };
    await putGroup(created);
    return created;
  }

  return {
    /** Create the workspace row if this is the first time the account is seen. */
    async ensureWorkspace({ workspaceId = null, viewerUsername = null, viewer = null } = {}) {
      const id = String(workspaceId ?? ws());
      const existing = await getWorkspace(id);
      if (existing) {
        const patch = {};
        if (viewerUsername && existing.viewerUsername !== viewerUsername) patch.viewerUsername = viewerUsername;
        if (viewer?.followers !== undefined) patch.viewerFollowers = viewer.followers;
        if (viewer?.following !== undefined) patch.viewerFollowing = viewer.following;
        if (Object.keys(patch).length) await updateWorkspace(id, patch);
        state.workspaceId = id;
        await ensureDefaultBucket();
        return { ...existing, ...patch, created: false };
      }
      const row = {
        workspaceId: id,
        viewerUsername: viewerUsername ?? viewer?.username ?? null,
        viewerFollowers: viewer?.followers ?? null,
        viewerFollowing: viewer?.following ?? null,
      };
      await putWorkspace(row);
      state.workspaceId = id;
      await ensureDefaultBucket();
      return { ...(await getWorkspace(id)), created: true };
    },

    /* ------------------------------------------------------------- the library */

    leads: (options = {}) => listLeads(ws(), options),
    lead: (leadKey) => getLead(String(leadKey)),
    ensureDefaultBucket,
    async groups() {
      const workspaceId = ws();
      await ensureDefaultBucket();
      const all = await listGroups(workspaceId);
      return all.sort((a, b) => {
        const aDef = isDefaultBucket(a, workspaceId) ? 0 : 1;
        const bDef = isDefaultBucket(b, workspaceId) ? 0 : 1;
        if (aDef !== bDef) return aDef - bDef;
        return a.name.localeCompare(b.name);
      });
    },
    templates: (options = {}) => listTemplates(ws(), options),
    enabledTemplateCount: (poolId = null) => countEnabledTemplates(ws(), { poolId }),
    runs: (options = {}) => listScrapeRuns(ws(), options),
    sessions: (options = {}) => listOutreachSessions(ws(), options),
    actions: (options = {}) => listActions(ws(), options),

    async createGroup({ name, note = '', groupId = null }) {
      const trimmed = String(name ?? '').trim();
      const existing = await listGroups(ws());
      const match = existing.find((g) => g.name.toLowerCase() === trimmed.toLowerCase());
      if (match && !groupId) return match;
      const group = groupRecord({ workspaceId: ws(), name: trimmed, note, groupId });
      await putGroup(group);
      return group;
    },

    async renameGroup(groupId, name) {
      const id = String(groupId);
      const trimmed = String(name ?? '').trim();
      if (!trimmed) throw new Error('a bucket needs a name');
      const existing = await getGroup(id);
      if (!existing) throw new Error('bucket not found');
      const updated = { ...existing, name: trimmed, updatedAt: now() };
      await putGroup(updated);
      return updated;
    },

    async deleteGroup(groupId) {
      const id = String(groupId);
      const existing = await getGroup(id);
      if (!existing) return { deleted: false, untagged: 0 };
      if (isDefaultBucket(existing, ws())) {
        return { deleted: false, untagged: 0, reason: 'The Default bucket stays ready and cannot be removed.' };
      }
      return deleteGroup(id);
    },

    setLeadGroup: (leadKey, groupId, options = { on: true }) => setLeadGroup(String(leadKey), String(groupId), options),

    /* ------------------------------------------------------------ collections */

    startRun: (options = {}) => {
      const run = runRecord({ workspaceId: ws(), ...options });
      return putScrapeRun(run).then(() => run);
    },

    finishRun: (runId, patch = {}) => finishScrapeRun(String(runId), patch),

    /**
     * The owner pressed "save": write one collection into the library.
     *
     * Leads are merged, not replaced (`mergeLead`), edges are upserted on their
     * idempotent key, and the bucket tag is applied to everything saved (falling
     * back to the ready Default bucket when none is chosen).
     */
    async saveCollected({ result, groupId = null, groupName = null, runId = null }) {
      const workspaceId = ws();
      let bucket = groupId ? String(groupId) : null;
      if (!bucket && groupName && String(groupName).trim()) {
        bucket = (await this.createGroup({ name: groupName })).groupId;
      }
      if (!bucket) {
        bucket = (await ensureDefaultBucket()).groupId;
      }

      const entries = result?.leads ?? [];
      let saved = 0;
      let updated = 0;
      let edges = 0;
      for (const entry of entries) {
        const incoming = entry?.lead ?? entry;
        if (!incoming?.username) continue;
        const leadKey = `${workspaceId}:${String(incoming.username).toLowerCase()}`;
        const existing = await getLead(leadKey);
        const row = leadRecordSafe({ workspaceId, username: incoming.username }, { ...incoming, leadKey });
        const merged = mergeLead(existing, row);
        if (bucket && !(merged.groupIds ?? []).includes(bucket)) merged.groupIds = [...(merged.groupIds ?? []), bucket];
        await upsertLead(merged);
        if (existing) updated += 1;
        else saved += 1;
        for (const edge of entry?.edges ?? []) {
          await upsertEdge({ ...edge, workspaceId, leadKey });
          edges += 1;
        }
      }

      if (runId) await finishScrapeRun(String(runId), { status: 'saved', counts: { leads: entries.length, edges, pages: result?.pages ?? 0 } });
      return { ok: true, saved, updated, edges, groupId: bucket, runId: runId ?? null, total: entries.length };
    },

    /* --------------------------------------------------------------- sessions */

    async startSession({ mode, groupId = null, tabId = null, policy = {}, planned = 0 }) {
      const session = sessionRecord({ workspaceId: ws(), mode, groupId, tabId, policy });
      await putOutreachSession({ ...session, planned });
      return { ...session, planned };
    },

    bumpSession: (sessionId, patch = {}) => updateOutreachSession(String(sessionId), patch),

    async endSession(sessionId, { status = 'stopped', reason = null, severity = null } = {}) {
      return updateOutreachSession(String(sessionId), { status, reason, severity, endedAt: now() });
    },

    /* ---------------------------------------------------------------- governor */

    async workspace() {
      const row = await getWorkspace(ws());
      if (!row) return this.ensureWorkspace({});
      return row;
    },

    /** Today's counters, for the telemetry strip that is always on screen. */
    async counters() {
      const row = await this.workspace();
      return countersFor(row?.governorState ?? initialGovernorState(), new Date(now()));
    },

    /* ---------------------------------------------------------------- outcomes */

    /**
     * Record one action's verified result: the lead, the log and the counters.
     *
     * Counters move only on a verified success. Counting an unverified click
     * would spend the day's budget on actions that may not have happened, and the
     * budget is the thing standing between the owner and a limited account.
     */
    async applyOutcome({ leadKey, actionType, result, sessionId = null, at = null, severity = null }) {
      const timestamp = Number(at ?? now());
      const workspaceId = ws();
      const lead = await getLead(String(leadKey));
      if (!lead) return { ok: false, reason: `no lead ${leadKey} in this workspace`, outcome: null };

      const outcome = eventsForOutcome({ actionType, result, lead, now: timestamp });
      await upsertLead({ ...lead, ...outcome.patch });

      await logAction({
        workspaceId,
        leadKey: lead.leadKey,
        usernameSnapshot: lead.username,
        actionType,
        verifiedOk: outcome.ok,
        outcome: outcome.outcome,
        observed: outcome.observed,
        detail: result?.reason ?? null,
        severity: severity ?? result?.severity ?? null,
        sessionId: sessionId ? String(sessionId) : null,
        warnings: outcome.warnings,
        timestamp,
      });

      const row = await this.workspace();
      let governorState = row?.governorState ?? initialGovernorState();
      if (outcome.ok) governorState = recordAction(governorState, actionType, new Date(timestamp));
      // An action block or a challenge is the platform saying stop. The lock is
      // persisted, so reloading the dashboard or restarting the browser does not
      // clear it, and retrying during the lock only extends its patience.
      const flagged = outcome.stopRun || severity === 'account' || result?.severity === 'account' || severity === 'challenge';
      if (flagged) {
        governorState = tripCircuitBreaker(
          governorState,
          String(result?.reason ?? severity ?? 'Instagram refused the action'),
          new Date(timestamp),
          severity === 'challenge' || result?.severity === 'challenge' ? 'challenge' : 'feedback',
        );
      }
      await updateWorkspace(workspaceId, { governorState });

      return { ok: outcome.ok, outcome, lead: { ...lead, ...outcome.patch }, governorState, flagged };
    },

    /* --------------------------------------------------------------- settings */

    settings: () => loadSettings(),
    saveSettings: (patch) => saveSettings(patch),
  };
}

/**
 * `leadRecord` with the workspace already filled in.
 *
 * A collected row carries its own workspaceId, and the two must agree: a lead
 * written under the wrong workspace is invisible in the table and untouchable by
 * the cleaner, which reads as data loss to the owner.
 */
function leadRecordSafe(identity, patch) {
  return leadRecord({ workspaceId: identity.workspaceId, username: identity.username }, patch);
}

/**
 * The client the views use: one object, one workspace, one place where a
 * browser API is touched.
 *
 * `createApiClient()` is called once by app/main.js and handed to every view, so
 * a view never reaches for `chrome.*` itself. That is what keeps the views
 * testable and what stops two views from disagreeing about which account is
 * loaded.
 */
export function createApiClient({
  chromeApi = null,
  workspaceId = null,
  storage = null,
  tabs = null,
  now = () => Date.now(),
  sleep = defaultSleep,
  pollMs = undefined,
  commandTimeoutMs = undefined,
} = {}) {
  const chrome = chromeApi ?? globalThis.chrome;
  // chromeStorageAdapter takes the whole chrome object and reaches into
  // storage.local itself: handing it the area already unwrapped reads as
  // "no storage here" and throws before a single command is posted.
  const adapter = storage ?? chromeStorageAdapter(chrome);
  const state = { workspaceId: String(workspaceId ?? BOOTSTRAP_WORKSPACE_ID) };

  const bridges = new Map();
  const bridgeFor = (id) => {
    const key = String(id ?? BOOTSTRAP_WORKSPACE_ID);
    if (!bridges.has(key)) {
      bridges.set(key, createBridge({
        storage: adapter,
        workspaceId: key,
        ...(pollMs === undefined ? {} : { pollMs }),
        ...(commandTimeoutMs === undefined ? {} : { commandTimeoutMs }),
        now,
        sleep,
      }));
    }
    return bridges.get(key);
  };

  const controller = tabs ?? createTabController({ chromeApi: chrome, now, sleep });
  const channel = createCommandChannel({ storage: adapter, tabs: controller, state, bridgeFor, now, sleep });
  const ledger = createLedger({ state, now });

  return {
    ...channel,
    ...ledger,
    state,
    tabs: controller,
    bridge: () => bridgeFor(state.workspaceId),
    get workspaceId() {
      return state.workspaceId;
    },
    /**
     * Check open Instagram tabs without API calls and sync the signed-in account.
     *
     * Queries open instagram.com tabs, injects the content script if the tab was
     * opened before the extension loaded, reads the live DOM + session cookies via
     * PING / GET_CONTEXT, and persists the detected workspace + @username so the
     * dashboard never gets stuck showing "Not connected".
     */
    async detectConnection({ openIfMissing = false, focusTab = false, timeoutMs = 6_000 } = {}) {
      let tabsList = [];
      try {
        tabsList = await controller.listTabs();
      } catch {
        return { connected: false, loggedIn: false, tabFound: false, tabId: null, viewerUsername: null, viewerId: null, reason: 'Could not inspect browser tabs.' };
      }

      if (!tabsList.length) {
        if (!openIfMissing) {
          return { connected: false, loggedIn: false, tabFound: false, tabId: null, viewerUsername: null, viewerId: null, reason: 'No Instagram tab is open yet.' };
        }
        const opened = await controller.openInstagram('https://www.instagram.com/', { active: true });
        if (!opened?.ok || !opened.tab) {
          return { connected: false, loggedIn: false, tabFound: false, tabId: null, viewerUsername: null, viewerId: null, reason: opened?.reason ?? 'Could not open instagram.com.' };
        }
        tabsList = [opened.tab];
      }

      const worker = typeof controller.worker === 'function' ? await controller.worker() : null;
      const picked = pickTab(tabsList, { workerTabId: worker?.id ?? null });
      const targetTab = picked?.tab ?? tabsList[0];
      if (!targetTab?.id) {
        return { connected: false, loggedIn: false, tabFound: false, tabId: null, viewerUsername: null, viewerId: null, reason: 'No usable Instagram tab found.' };
      }

      if (focusTab && typeof controller.focus === 'function') {
        await controller.focus(targetTab.id);
      }

      const ready = await channel.prepare(targetTab.id, { timeoutMs });
      if (!ready.ok) {
        return {
          connected: false,
          loggedIn: false,
          tabFound: true,
          tabId: targetTab.id,
          tabUrl: targetTab.url ?? null,
          viewerUsername: null,
          viewerId: null,
          reason: ready.reason ?? 'Reload the Instagram tab to connect.',
        };
      }

      let ctx = ready.context ?? null;
      if (!ctx || (!ctx.viewerUsername && !ctx.viewerId && ctx.loggedIn !== false)) {
        const probe = await channel.send(CommandType.PROBE, {}, { tabId: targetTab.id, timeoutMs: 8_000, allowUnprepared: true });
        if (probe.ok && probe.value) {
          ctx = {
            ...(ctx ?? {}),
            loggedIn: Boolean(probe.value.session?.loggedIn || probe.value.viewer?.username || probe.value.viewer?.id),
            viewerUsername: probe.value.viewer?.username || ctx?.viewerUsername || null,
            viewerId: probe.value.viewer?.id || probe.value.session?.sessionUserId || ctx?.viewerId || null,
          };
        }
      }

      const loggedIn = Boolean(ctx?.loggedIn || ctx?.viewerUsername || ctx?.viewerId);
      const viewerId = ctx?.viewerId ? String(ctx.viewerId) : null;
      const viewerUsername = ctx?.viewerUsername ? String(ctx.viewerUsername) : null;

      if (loggedIn) {
        const nextWsId = viewerId || state.workspaceId || BOOTSTRAP_WORKSPACE_ID;
        if (nextWsId !== state.workspaceId || viewerUsername) {
          await channel.setWorkspace(nextWsId, { viewerUsername });
        }
        await ledger.ensureWorkspace({
          workspaceId: nextWsId,
          viewerUsername,
          viewer: { id: nextWsId, username: viewerUsername ?? '' },
        });
      }

      return {
        connected: loggedIn,
        loggedIn,
        tabFound: true,
        tabId: targetTab.id,
        tabUrl: targetTab.url ?? null,
        viewerId,
        viewerUsername,
        reason: loggedIn ? null : 'Instagram is open, but you are not logged in yet.',
      };
    },

    /** Everything the top bar needs in one call. */
    async overview() {
      const [workspace, counters, groups, enabledTemplates] = await Promise.all([
        this.workspace(),
        this.counters(),
        this.groups(),
        this.enabledTemplateCount(),
      ]);
      // A lock whose time has passed is not a lock: `lockedUntil` starts at 0 and
      // stays behind after the circuit breaker expires, and showing "locked until
      // 1970" in the top bar would be worse than showing nothing.
      const lockedUntil = Number(workspace?.governorState?.lockedUntil ?? 0);
      const locked = lockedUntil > now();
      return {
        workspaceId: state.workspaceId,
        viewerUsername: workspace?.viewerUsername ?? null,
        followers: workspace?.viewerFollowers ?? null,
        following: workspace?.viewerFollowing ?? null,
        counters,
        lockedUntil: locked ? lockedUntil : null,
        lockReason: locked ? (workspace?.governorState?.lockReason ?? null) : null,
        groups,
        enabledTemplates,
      };
    },
  };
}
