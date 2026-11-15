/**
 * The two run loops: collecting a profile, and working a queue.
 *
 * A view calls one function and then watches events. Nothing here touches
 * `chrome.*`, the DOM or IndexedDB directly: everything goes through the api
 * client, which is why the whole autopilot is testable with a fake channel.
 *
 * The rules this file exists to enforce, in the order they matter:
 *
 *  1. Nothing is decided by asking Instagram about a person we already know.
 *     Whether someone was followed or messaged comes from our own rows, checked
 *     again immediately before every single action — not once when the queue was
 *     built. A run of 200 actions takes hours; a queue built at the start is
 *     stale by the middle, and acting on a stale queue is how a person gets
 *     messaged twice.
 *  2. The governor is asked before every action, with fresh state, and its
 *     refusal ends the run rather than being retried around.
 *  3. Every wait is interruptible, so Stop lands inside a second even when the
 *     plan called for a nine-minute break.
 *  4. Every delay, every action, every refusal and every remaining budget is
 *     published as an event. An autopilot the owner cannot watch is an
 *     autopilot he cannot trust.
 */

import { CommandType } from '../../storage/bridge.js';
import {
  QueueMode,
  buildQueue,
  candidateVerdict,
  gateSentence,
  humanDurationMs,
} from '../../core/queue.js';
import {
  ActionType,
  canExecute,
  clampLimits,
  countersFor,
  hourKey,
  initialGovernorState,
  planNextDelay,
  scheduleState,
  warmupFactor,
} from '../../core/governor.js';
import { EntropyPoolRNG } from '../../core/random.js';
import { renderMessageTemplate } from '../../core/templates.js';
import { MESSAGE_BYTE_LIMIT } from '../../core/linter.js';
import { extractSalutationName } from '../../core/text.js';
import { pickTab as pickTabFrom } from './api.js';

/** What a run is doing. The UI renders a badge from this and nothing else. */
export const RunPhase = Object.freeze({
  IDLE: 'idle',
  PREPARING: 'preparing',
  RUNNING: 'running',
  WAITING: 'waiting',
  STOPPING: 'stopping',
  DONE: 'done',
  CAPPED: 'capped',
  BLOCKED: 'blocked',
  FAILED: 'failed',
  STOPPED: 'stopped',
});

/** How a wait is sliced so a Stop is honoured quickly. */
export const STOP_POLL_MS = 400;

/** A delay longer than this is reported with a countdown, not just once. */
export const COUNTDOWN_EVERY_MS = 15_000;

/** How many templates back the anti-streak picker looks. */
export const TEMPLATE_MEMORY = 4;

function byteLength(text) {
  const encoder = globalThis.TextEncoder;
  if (encoder) return new encoder().encode(String(text ?? '')).length;
  return String(text ?? '').length;
}

/**
 * What is left of today's budget, per action type.
 *
 * One source of truth for the numbers the owner sees before pressing Start and
 * while the run is going: the same caps, the same warm-up factor and the same
 * schedule the governor itself will use when it decides.
 */
export function budgetFor(governorState, { settings = {}, now = Date.now(), workspaceKey = '' } = {}) {
  const at = new Date(now);
  const state = countersFor(structuredClone(governorState ?? {}), at);
  const { limits } = clampLimits(settings?.limits ?? {});
  const factor = warmupFactor(state.warmupDay, {
    enabled: state.warmupEnabled !== false && settings?.schedule?.warmupRampEnabled !== false,
    postBreaker: state.postBreaker,
  });
  const hour = state.hourly[hourKey(at)] ?? { follows: 0, unfollows: 0, warmDms: 0, coldInvites: 0 };
  const capped = (value) => Math.max(1, Math.floor(value * factor));

  const row = (used, hourlyCap, dailyCap) => ({
    used,
    hourlyCap,
    dailyCap: capped(dailyCap),
    remainingToday: Math.max(0, capped(dailyCap) - used.daily),
    remainingThisHour: Math.max(0, hourlyCap - used.hourly),
  });

  const schedule = scheduleState(settings ?? {}, at, workspaceKey);
  return {
    warmupDay: state.warmupDay,
    warmupFactor: factor,
    postBreaker: state.postBreaker,
    lockedUntil: state.lockedUntil && state.lockedUntil > now ? state.lockedUntil : null,
    lockReason: state.lockedUntil && state.lockedUntil > now ? state.lockReason : null,
    scheduleOpen: Boolean(schedule.open),
    scheduleBroken: Boolean(schedule.broken),
    windowOpensAt: schedule.open ? null : (schedule.next?.opensAt ?? null),
    window: schedule.window ?? null,
    combinedRemainingToday: Math.max(0, capped(limits.combinedMutationsPerDay) - state.daily.combined),
    follow: row({ daily: state.daily.follows, hourly: hour.follows }, limits.followsPerHour, limits.followsPerDay),
    unfollow: row({ daily: state.daily.unfollows, hourly: hour.unfollows }, limits.unfollowsPerHour, limits.unfollowsPerDay),
    warmDm: row({ daily: state.daily.warmDms, hourly: hour.warmDms }, limits.warmDmsPerHour, limits.warmDmsPerDay),
    coldDm: row({ daily: state.daily.coldInvites, hourly: hour.coldInvites }, limits.coldInvitesPerHour, limits.coldInvitesPerDay),
    limits,
  };
}

/** The budget line for one action type, as the governor sees it. */
export function budgetLineFor(actionType, budget) {
  switch (actionType) {
    case ActionType.FOLLOW: return budget?.follow ?? null;
    case ActionType.UNFOLLOW: return budget?.unfollow ?? null;
    case ActionType.DM_WARM: return budget?.warmDm ?? null;
    case ActionType.DM_COLD: return budget?.coldDm ?? null;
    default: return null;
  }
}

/** The variables a message template may use, from a lead row. */
export function messageContextFor(lead, { viewerUsername = null } = {}) {
  const fullName = String(lead?.fullName ?? '').trim();
  return {
    username: String(lead?.username ?? '').replace(/^@/, ''),
    full_name: fullName,
    // A business name is not a first name: "Salam Al-Khayyat Studio" greeted as
    // "Salam" reads fine, but "Cairo Linen Export" greeted as "Cairo" reads like
    // a mail merge, which is exactly what it must not look like.
    first_name: extractSalutationName(fullName, ''),
    account: viewerUsername ? String(viewerUsername).replace(/^@/, '') : '',
  };
}

/** Three page-level failures in a row end a run: the queue is not a punching bag. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** The pause between pressing Start and the first action. */
export const FIRST_ACTION_SETTLE_MS = Object.freeze({ min: 2_000, max: 6_000 });

/**
 * One run controller: the collect loop, the outreach loop, and the Stop button.
 *
 * @param {{api: object, rng?: object, now?: () => number,
 *          sleep?: (ms: number) => Promise<void>, onEvent?: (event: object) => void}} deps
 */
export function createRunController(deps = {}) {
  const api = deps.api;
  if (!api) throw new Error('createRunController needs an api client');
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    if (typeof timer?.unref === 'function') timer.unref();
  }));
  const rng = deps.rng ?? new EntropyPoolRNG();
  const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null;

  const state = {
    phase: RunPhase.IDLE,
    kind: null,
    mode: null,
    stopRequested: false,
    stopReason: null,
    runId: null,
    sessionId: null,
    tabId: null,
    startedAt: null,
    endedAt: null,
    counts: { attempted: 0, done: 0, refused: 0, skipped: 0, failed: 0 },
    lastError: null,
    lastAction: null,
    consecutiveFailures: 0,
  };

  function emit(event) {
    if (!onEvent) return;
    try {
      onEvent({ at: now(), ...event });
    } catch {
      /* a listener that throws must never take a run down with it */
    }
  }

  function phase(next, detail = {}) {
    state.phase = next;
    emit({ type: 'phase', phase: next, kind: state.kind, ...detail });
  }

  /**
   * A wait that ends the moment Stop is pressed.
   *
   * Sliced rather than handed to one long timer: a nine-minute break that cannot
   * be interrupted is nine minutes of an owner staring at a tab he cannot stop,
   * which is how an extension gets uninstalled mid-run.
   */
  async function wait(ms, { label = null, countdown = true } = {}) {
    const total = Math.max(0, Math.round(Number(ms) || 0));
    if (total === 0) return { ok: true, waitedMs: 0, stopped: false };
    const deadline = now() + total;
    const startedAt = now();
    let nextNote = COUNTDOWN_EVERY_MS;
    // A clock that does not advance must not spin forever: the slice count is
    // bounded even if `now` is a stub that never moves.
    let guard = Math.ceil(total / STOP_POLL_MS) * 2 + 8;
    while (guard > 0) {
      guard -= 1;
      if (state.stopRequested) return { ok: false, waitedMs: now() - startedAt, stopped: true };
      const remaining = deadline - now();
      if (remaining <= 0) break;
      const slice = Math.min(STOP_POLL_MS, remaining);
      if (countdown && total - remaining >= nextNote) {
        nextNote += COUNTDOWN_EVERY_MS;
        emit({ type: 'waiting', label, remainingMs: Math.max(0, remaining), human: humanDurationMs(remaining) });
      }
      await sleep(slice);
    }
    return { ok: !state.stopRequested, waitedMs: now() - startedAt, stopped: state.stopRequested };
  }

  /* ---------------------------------------------------------------- collecting */

  /**
   * Collect one source into a preview. Nothing is written to the library here.
   *
   * The owner sees the ranked list first and presses Save to put it in a bucket:
   * a collection is 200 strangers, and writing them into the permanent library
   * before anyone has looked is how a table fills with people nobody meant to
   * contact.
   */
  async function collect(options = {}) {
    if (state.phase === RunPhase.RUNNING || state.phase === RunPhase.PREPARING || state.phase === RunPhase.WAITING) {
      return { ok: false, reason: `a ${state.kind} run is already in progress`, phase: state.phase };
    }
    const source = options.source ?? null;
    if (!source) return { ok: false, reason: 'no source was chosen' };

    state.kind = 'collect';
    state.stopRequested = false;
    state.stopReason = null;
    state.startedAt = now();
    state.endedAt = null;
    state.lastError = null;
    phase(RunPhase.PREPARING, { source });

    const settings = options.settings ?? await api.settings();
    const weights = options.weights ?? settings?.rankingWeights ?? {};
    const tab = await chooseTab(options);
    if (!tab.ok) return finishCollect({ ok: false, reason: tab.reason, phase: RunPhase.FAILED });

    const run = await api.startRun({
      source,
      sourceAccount: options.username ?? options.sourceAccount ?? null,
      tabId: tab.tabId,
    });
    state.runId = run.runId;
    state.tabId = tab.tabId;
    emit({ type: 'run', runId: run.runId, source, tabId: tab.tabId, tabLabel: tab.label });

    const watcher = api.watch((row) => emit({ type: 'status', status: row }), { intervalMs: options.statusIntervalMs ?? 1_000 });
    try {
      const answer = await api.sendWithNavigation(CommandType.COLLECT_LEADS, {
        source,
        targetUsername: options.username ?? null,
        targetUserId: options.userId ?? null,
        shortcode: options.shortcode ?? null,
        tag: options.tag ?? null,
        limit: options.limit ?? 200,
        weights,
        workspaceId: api.workspaceId,
        pacing: options.pacing ?? null,
        // A hashtag grid needs the tab to settle on the tag page before the resend
        // scrapes it, so it gets a longer wait than the default navigation settle.
        // 'hashtag_grid' is the frozen CollectSource value (the runner stays free of
        // a content-layer import for one string).
      }, { tabId: tab.tabId, ...(source === 'hashtag_grid' ? { settleMs: 2500 } : {}) });

      if (state.stopRequested) {
        await api.finishRun(run.runId, { status: 'stopped', reason: state.stopReason ?? 'stopped by the owner' });
        return finishCollect({ ok: false, reason: state.stopReason ?? 'stopped', phase: RunPhase.STOPPED, runId: run.runId });
      }
      if (!answer.ok) {
        state.lastError = answer.reason;
        await api.finishRun(run.runId, { status: 'failed', reason: answer.reason, severity: answer.severity ?? null });
        return finishCollect({ ok: false, reason: answer.reason, phase: RunPhase.FAILED, severity: answer.severity ?? null, runId: run.runId });
      }
      const result = answer.value ?? {};
      const leads = Array.isArray(result.leads) ? result.leads : [];
      await api.finishRun(run.runId, {
        status: leads.length ? 'collected' : 'empty',
        counts: { leads: leads.length, edges: Array.isArray(result.edges) ? result.edges.length : 0, pages: result.pages ?? 0 },
        reason: leads.length ? null : (result.reason ?? 'the source returned nobody'),
      });
      emit({ type: 'collected', runId: run.runId, count: leads.length, sourceAccount: result.sourceAccount ?? null });
      return finishCollect({
        ok: leads.length > 0,
        runId: run.runId,
        result,
        count: leads.length,
        reason: leads.length ? null : (result.reason ?? 'the source returned nobody'),
        phase: leads.length ? RunPhase.DONE : RunPhase.CAPPED,
      });
    } finally {
      watcher?.dispose?.();
    }
  }

  function finishCollect(outcome) {
    state.endedAt = now();
    phase(outcome.phase ?? (outcome.ok ? RunPhase.DONE : RunPhase.FAILED), { reason: outcome.reason ?? null });
    state.kind = null;
    state.runId = null;
    return outcome;
  }

  /** Write a previewed collection into the library, into a bucket. */
  async function commit(options = {}) {
    const result = options.result ?? null;
    if (!result) return { ok: false, reason: 'there is nothing to save' };
    const saved = await api.saveCollected({
      result,
      groupName: options.groupName ?? null,
      groupId: options.groupId ?? null,
      runId: options.runId ?? null,
    });
    emit({ type: 'saved', ...saved });
    return saved;
  }

  /** Throw a preview away, and say so in the run history. */
  async function discard(options = {}) {
    if (!options.runId) return { ok: false, reason: 'no collection was named' };
    const row = await api.finishRun(options.runId, { status: 'discarded', reason: options.reason ?? 'the owner did not save this collection' });
    emit({ type: 'discarded', runId: options.runId });
    return { ok: true, run: row };
  }

  /**
   * Which tab does the work.
   *
   * A collection runs in the tab the owner is looking at, because "the people
   * who liked this post" only exists there. An outreach run uses the managed
   * worker window, because it navigates from profile to profile for hours and
   * must not hijack the tab he is reading.
   */
  async function chooseTab(options = {}) {
    if (options.tabId !== null && options.tabId !== undefined) {
      const tab = await api.tabs.tabById(options.tabId);
      if (!tab) return { ok: false, reason: 'the chosen Instagram tab was closed' };
      return { ok: true, tabId: tab.id, label: tab.url ?? 'the chosen tab', tab };
    }
    if (options.useWorker) {
      const worker = await api.tabs.ensureWorker({ url: options.workerUrl ?? 'https://www.instagram.com/' });
      if (!worker?.tab?.id) return { ok: false, reason: 'the worker window could not be opened' };
      return { ok: true, tabId: worker.tab.id, label: 'the worker window', tab: worker.tab, created: worker.created };
    }
    const tabs = await api.tabs.listTabs();
    const worker = await api.tabs.worker();
    const picked = pickTabFrom(tabs, { tabId: null, username: options.username ?? null, workerTabId: worker?.id ?? null });
    if (!picked?.tab) return { ok: false, reason: 'no Instagram tab is open; open the profile you want to collect from' };
    return { ok: true, tabId: picked.tab.id, label: picked.tab.url ?? 'the Instagram tab', tab: picked.tab };
  }

  function stop(reason = 'stopped by the owner') {
    if (state.phase === RunPhase.IDLE || state.phase === RunPhase.DONE) return { ok: false, reason: 'nothing is running' };
    state.stopRequested = true;
    state.stopReason = reason;
    phase(RunPhase.STOPPING, { reason });
    // Tell the tab as well as the loop: a collection in flight is pacing reads
    // inside the page, and only the page can abort those.
    void api.stop(reason);
    return { ok: true, reason };
  }

  return {
    state,
    collect,
    commit,
    discard,
    outreach: (options = {}) => runOutreach({ api, state, emit, wait, phase, chooseTab, rng, now, sleep, onEvent, ...options }),
    stop,
    budget: (governorState, options = {}) => budgetFor(governorState, { now: now(), ...options }),
  };
}

/* ------------------------------------------------------------------ planning */

/** A message preview short enough for one table cell. */
export function messagePreview(text, max = 90) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * One action's message, chosen at random from the enabled pool.
 *
 * Random per recipient, and anti-streak across recipients: the same opening
 * line going to eleven people in a row is the pattern a spam classifier looks
 * for, and it is also the pattern a person would notice.
 */
export function chooseMessage({ templates = [], lead = null, rng, recent = [], viewerUsername = null, maxAttempts = 8 } = {}) {
  const pool = (templates ?? []).filter((row) => row && row.enabled !== false && String(row.body ?? '').trim());
  if (pool.length === 0) return { ok: false, reason: 'no enabled message template', message: null };
  if (!rng || typeof rng.pickWithAntiStreak !== 'function') return { ok: false, reason: 'no random engine to choose a template with', message: null };

  let lastReason = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const template = rng.pickWithAntiStreak(pool, recent, (row) => row.templateId);
    if (!template) continue;
    let message = null;
    try {
      message = renderMessageTemplate(template.body, messageContextFor(lead, { viewerUsername }), rng);
    } catch (error) {
      lastReason = `the template could not be rendered (${error?.message ?? error})`;
      continue;
    }
    if (!String(message).trim()) { lastReason = 'the template rendered empty text'; continue; }
    const bytes = byteLength(message);
    if (bytes > MESSAGE_BYTE_LIMIT) {
      lastReason = `the rendered message is ${bytes} bytes, over the ${MESSAGE_BYTE_LIMIT}-byte limit`;
      continue;
    }
    return { ok: true, message, bytes, templateId: template.templateId, label: template.label ?? null };
  }
  return { ok: false, reason: lastReason ?? 'no template produced a sendable message', message: null };
}

/**
 * The queue, the gate and the budget for one outreach mode, without acting.
 *
 * This is what the owner sees before pressing Start: who will be contacted, in
 * what order, how long it will take, how many refusals there were and why, and
 * how much of today's budget is left. A run he cannot preview is a run he
 * cannot consent to.
 */
export async function planOutreach({
  api,
  mode = QueueMode.FOLLOW,
  groupId = null,
  policy = {},
  limit = 100,
  now = Date.now(),
  rng = null,
  settings = null,
  leads = null,
  workspace = null,
  templates = null,
} = {}) {
  const settingsRow = settings ?? await api.settings();
  const leadRows = leads ?? await api.leads({ limit: 20_000 });
  const workspaceRow = workspace ?? await api.workspace();
  const governorState = workspaceRow?.governorState ?? initialGovernorState();
  const workspaceKey = String(workspaceRow?.workspaceId ?? api.workspaceId ?? '');
  const pool = templates ?? (await api.templates()).filter((row) => row.enabled !== false);

  const plan = buildQueue({
    leads: leadRows,
    mode,
    settings: settingsRow,
    governorState,
    workspaceKey,
    now,
    limit,
    policy,
    groupId,
    templateCount: mode === QueueMode.DM ? pool.length : null,
    rng,
    followingCount: Number(workspaceRow?.viewerFollowing ?? 0),
  });

  return {
    ...plan,
    settings: settingsRow,
    workspace: workspaceRow,
    templates: pool,
    workspaceKey,
    budget: budgetFor(governorState, { settings: settingsRow, now, workspaceKey }),
  };
}

/**
 * One mailbox answer into the result shape the ledger records.
 *
 * A lost answer (the tab closed, the mailbox timed out) is recorded as
 * "not done" with the attempt counted, never as a success: we did not see it
 * happen. Re-attempting that person later is safe rather than duplicative,
 * because the page-level actions read the button and the thread first and
 * report "already following" / "this thread already has messages" instead of
 * clicking again.
 */
export function resultFromAnswer(answer) {
  const value = answer?.value && typeof answer.value === 'object' ? answer.value : {};
  const ok = Boolean(answer?.ok) && value.ok !== false;
  return {
    ...value,
    ok,
    outcome: value.outcome ?? (ok ? 'done' : 'not_done'),
    reason: value.reason ?? (ok ? null : (answer?.reason ?? null)),
    severity: value.severity ?? answer?.severity ?? null,
  };
}

/* ----------------------------------------------------------------- outreach */

/**
 * Close a run: the session row, the phase, and one summary the UI can render.
 *
 * Every exit path goes through here, including the ones that end badly. A
 * session left `running` in the database is a lie the owner reads the next
 * morning ("the autopilot was still going"), and an unended session is also the
 * one thing that makes `reconcileSessions` guess at what happened.
 */
async function endOutreach(ctx, { ok, phase: nextPhase, reason = null, plan = null, session = null, gate = null, severity = null, stopTab = false }) {
  const { api, state, emit, phase } = ctx;
  if (stopTab) { try { await api.stop(reason ?? 'the run ended'); } catch { /* the tab is already gone */ } }
  let ended = null;
  if (session?.sessionId) {
    try {
      ended = await api.endSession(session.sessionId, {
        status: nextPhase === RunPhase.STOPPED ? 'stopped'
          : nextPhase === RunPhase.BLOCKED ? 'blocked'
            : nextPhase === RunPhase.FAILED ? 'failed'
              : nextPhase === RunPhase.CAPPED ? 'capped'
                : 'done',
        reason,
        severity,
      });
    } catch (error) {
      emit({ type: 'warning', reason: `the session could not be closed cleanly (${error?.message ?? error})` });
    }
  }
  state.endedAt = ctx.now();
  state.lastError = ok ? null : reason;
  phase(nextPhase, { reason, counts: { ...state.counts } });
  emit({ type: 'summary', ok, reason, counts: { ...state.counts }, sessionId: session?.sessionId ?? null, severity });
  const summary = {
    ok,
    reason,
    severity,
    phase: nextPhase,
    counts: { ...state.counts },
    sessionId: session?.sessionId ?? null,
    session: ended,
    gate: gate ?? null,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    elapsedMs: Math.max(0, state.endedAt - (state.startedAt ?? state.endedAt)),
    queued: plan?.counts?.queued ?? 0,
    skippedByCode: plan?.counts?.byCode ?? {},
  };
  state.kind = null;
  state.mode = null;
  state.sessionId = null;
  state.runId = null;
  return summary;
}



/** Which mailbox command one governor action type becomes. */
export function commandFor(actionType) {
  if (actionType === ActionType.FOLLOW) return CommandType.EXECUTE_FOLLOW;
  if (actionType === ActionType.UNFOLLOW) return CommandType.EXECUTE_UNFOLLOW;
  if (actionType === ActionType.DM_WARM || actionType === ActionType.DM_COLD) return CommandType.EXECUTE_DM;
  return null;
}

/** How one answer moves the session's counters. */
export function countBucketFor(outcome) {
  if (outcome === 'done') return 'done';
  if (outcome === 'skipped') return 'skipped';
  if (outcome === 'refused') return 'refused';
  return 'failed';
}

/**
 * The outreach loop: one action at a time, decided again each time.
 *
 * The queue is a plan, not a permission. Between building it and reaching the
 * fortieth name, hours pass: the owner may have followed someone by hand, a
 * previous session may have messaged them, the daily budget may have been spent
 * by the tab next door, or Instagram may have locked the account. Every one of
 * those is re-checked from our own stored rows immediately before the action,
 * and the governor is asked again with the state as it now stands.
 */
async function runOutreach(ctx) {
  const { api, state, emit, wait, phase, chooseTab, now } = ctx;
  const mode = ctx.mode ?? QueueMode.FOLLOW;
  if (!Object.values(QueueMode).includes(mode)) return { ok: false, reason: `unknown outreach mode: ${mode}` };
  if ([RunPhase.RUNNING, RunPhase.PREPARING, RunPhase.WAITING, RunPhase.STOPPING].includes(state.phase)) {
    return { ok: false, reason: `a ${state.kind} run is already in progress`, phase: state.phase };
  }

  const rng = ctx.rng ?? new EntropyPoolRNG();
  const policy = ctx.policy ?? {};
  state.kind = 'outreach';
  state.mode = mode;
  state.stopRequested = false;
  state.stopReason = null;
  state.startedAt = now();
  state.endedAt = null;
  state.lastError = null;
  state.lastAction = null;
  state.consecutiveFailures = 0;
  state.counts = { attempted: 0, done: 0, refused: 0, skipped: 0, failed: 0 };
  phase(RunPhase.PREPARING, { mode });

  let plan;
  try {
    plan = await planOutreach({
      api,
      mode,
      groupId: ctx.groupId ?? null,
      policy,
      limit: ctx.limit ?? 100,
      now: now(),
      rng,
      settings: ctx.settings ?? null,
    });
  } catch (error) {
    // A database or settings failure must not leave the controller believing a
    // run is in flight: the Start button would stay disabled forever.
    state.lastError = `${error?.name ?? 'Error'}: ${error?.message ?? error}`;
    return endOutreach(ctx, { ok: false, phase: RunPhase.FAILED, reason: state.lastError });
  }

  emit({
    type: 'plan',
    mode,
    queued: plan.counts.queued,
    ready: plan.counts.ready,
    skipped: plan.counts.skipped,
    byCode: plan.counts.byCode,
    outsideGroup: plan.counts.outsideGroup,
    estimate: plan.estimate,
    gateMessage: plan.gateMessage,
    canStart: plan.canStart,
    budget: plan.budget,
    top: plan.queue.slice(0, 5).map((entry) => ({
      rank: entry.rank,
      username: entry.lead.username,
      priorityScore: entry.lead.priorityScore,
      warmthTier: entry.lead.warmthTier,
    })),
  });

  if (ctx.dryRun) {
    phase(RunPhase.IDLE, { dryRun: true });
    state.kind = null;
    return { ok: true, dryRun: true, plan, counts: { ...state.counts } };
  }
  if (plan.queue.length === 0) {
    return endOutreach(ctx, {
      ok: true,
      phase: RunPhase.CAPPED,
      reason: plan.counts.ready === 0
        ? 'nobody is waiting for this action: everyone in this bucket was already actioned, is protected, or is inside a spacing delay'
        : 'the queue is empty',
      plan,
    });
  }
  if (!plan.canStart) {
    return endOutreach(ctx, { ok: false, phase: RunPhase.BLOCKED, reason: plan.gateMessage, plan, severity: plan.gate?.reason === 'circuit breaker' ? 'account' : null });
  }

  const tab = await chooseTab({ ...ctx, useWorker: ctx.useWorker !== false, tabId: ctx.tabId ?? null });
  if (!tab.ok) return endOutreach(ctx, { ok: false, phase: RunPhase.FAILED, reason: tab.reason, plan, severity: 'tab' });
  state.tabId = tab.tabId;

  const session = await api.startSession({ mode, groupId: ctx.groupId ?? null, tabId: tab.tabId, policy, planned: plan.queue.length });
  state.sessionId = session.sessionId;
  emit({ type: 'session', sessionId: session.sessionId, planned: plan.queue.length, tabId: tab.tabId, tabLabel: tab.label });
  phase(RunPhase.RUNNING, { planned: plan.queue.length });

  const recentTemplates = [];
  let actionsSinceBreak = 0;
  let index = 0;

  try {
  for (const entry of plan.queue) {
    index += 1;
    if (state.stopRequested) return endOutreach(ctx, { ok: true, phase: RunPhase.STOPPED, reason: state.stopReason ?? 'stopped', plan, session });

    const leadKey = entry.lead.leadKey;
    // Re-read our own row. This is the check that keeps a resumed run from
    // messaging someone twice, and it is made against the database, never
    // against Instagram: asking the platform "have I already done this?" is one
    // more request per action, and the answer we trust is the one we wrote down
    // when we verified the action ourselves.
    const fresh = await api.lead(leadKey);
    if (!fresh) {
      state.counts.skipped += 1;
      emit({ type: 'skip', rank: entry.rank, leadKey, reason: 'this person is no longer in the library' });
      continue;
    }
    const verdict = candidateVerdict(fresh, { mode, now: now(), policy });
    if (!verdict.ok) {
      state.counts.skipped += 1;
      emit({ type: 'skip', rank: entry.rank, username: fresh.username, code: verdict.code, reason: verdict.reason, waitMs: verdict.waitMs ?? null });
      await api.bumpSession(session.sessionId, { counts: { ...state.counts }, lastActionAt: now() });
      continue;
    }

    const workspaceRow = await api.workspace();
    const governorState = workspaceRow?.governorState ?? initialGovernorState();
    const gate = canExecute(verdict.actionType, {
      now: new Date(now()),
      governorState,
      settings: plan.settings,
      workspaceKey: plan.workspaceKey,
      followingCount: Number(workspaceRow?.viewerFollowing ?? 0),
      nextEligibleAt: Number(fresh.nextEligibleAt ?? 0) || null,
    });
    if (!gate.ok) {
      if (gate.reason === 'spacing' && Number(gate.waitMs) > 0) {
        state.counts.skipped += 1;
        emit({ type: 'skip', rank: entry.rank, username: fresh.username, code: 'SPACING', reason: gateSentence(gate), waitMs: gate.waitMs });
        continue;
      }
      return endOutreach(ctx, {
        ok: true,
        phase: gate.reason === 'circuit breaker' ? RunPhase.BLOCKED : RunPhase.CAPPED,
        reason: gateSentence(gate),
        gate,
        plan,
        session,
        severity: gate.reason === 'circuit breaker' ? 'account' : null,
      });
    }

    const delay = index === 1
      ? { ms: rng.nextInRange(FIRST_ACTION_SETTLE_MS.min, FIRST_ACTION_SETTLE_MS.max), kind: 'settle', breakEvery: null }
      : planNextDelay({ settings: plan.settings, rng, actionsSinceBreak });

    emit({
      type: 'delay',
      rank: entry.rank,
      index,
      total: plan.queue.length,
      username: fresh.username,
      actionType: verdict.actionType,
      ms: delay.ms,
      kind: delay.kind,
      human: humanDurationMs(delay.ms),
      nextAt: now() + delay.ms,
    });
    phase(RunPhase.WAITING, { ms: delay.ms, human: humanDurationMs(delay.ms), username: fresh.username, kind: delay.kind });
    const waited = await wait(delay.ms, { label: `${verdict.actionType} @${fresh.username}` });
    if (waited.stopped || state.stopRequested) {
      return endOutreach(ctx, { ok: true, phase: RunPhase.STOPPED, reason: state.stopReason ?? 'stopped', plan, session });
    }
    actionsSinceBreak = delay.kind === 'break' ? 0 : actionsSinceBreak + 1;
    phase(RunPhase.RUNNING, { index, total: plan.queue.length });

    let message = null;
    if (verdict.actionType === ActionType.DM_WARM || verdict.actionType === ActionType.DM_COLD) {
      const chosen = chooseMessage({
        templates: plan.templates,
        lead: fresh,
        rng,
        recent: recentTemplates,
        viewerUsername: workspaceRow?.viewerUsername ?? null,
      });
      if (!chosen.ok) {
        state.counts.refused += 1;
        emit({ type: 'refusal', rank: entry.rank, username: fresh.username, reason: chosen.reason });
        await api.bumpSession(session.sessionId, { counts: { ...state.counts }, lastActionAt: now() });
        continue;
      }
      message = chosen.message;
      recentTemplates.push(chosen.templateId);
      while (recentTemplates.length > TEMPLATE_MEMORY) recentTemplates.shift();
    }

    const command = commandFor(verdict.actionType);
    if (!command) {
      state.counts.failed += 1;
      emit({ type: 'refusal', rank: entry.rank, username: fresh.username, reason: `no command exists for ${verdict.actionType}` });
      continue;
    }

    state.counts.attempted += 1;
    emit({
      type: 'action',
      rank: entry.rank,
      index,
      total: plan.queue.length,
      leadKey,
      username: fresh.username,
      fullName: fresh.fullName ?? '',
      actionType: verdict.actionType,
      cleanupAction: verdict.cleanupAction ?? null,
      priorityScore: fresh.priorityScore ?? 0,
      scoreParts: fresh.scoreParts ?? {},
      warmthTier: fresh.warmthTier ?? null,
      messagePreview: message ? messagePreview(message) : null,
      messageBytes: message ? byteLength(message) : null,
    });

    const answer = await api.sendWithNavigation(command, {
      username: fresh.username,
      message,
      allowExisting: Boolean(policy.allowExistingThread),
      pacing: ctx.pacing ?? null,
      cleanupAction: verdict.cleanupAction ?? null,
    }, { tabId: state.tabId });

    const result = resultFromAnswer(answer);
    const applied = await api.applyOutcome({
      leadKey,
      actionType: verdict.actionType,
      result,
      sessionId: session.sessionId,
      at: now(),
      severity: result.severity ?? null,
    });

    const bucket = countBucketFor(result.outcome);
    state.counts[bucket] += 1;
    state.lastAction = { username: fresh.username, actionType: verdict.actionType, outcome: result.outcome, at: now() };
    if (bucket === 'failed') state.consecutiveFailures += 1;
    else state.consecutiveFailures = 0;

    const budget = budgetFor(applied?.governorState ?? governorState, { settings: plan.settings, now: now(), workspaceKey: plan.workspaceKey });
    emit({
      type: 'outcome',
      rank: entry.rank,
      index,
      total: plan.queue.length,
      leadKey,
      username: fresh.username,
      actionType: verdict.actionType,
      ok: Boolean(applied?.ok),
      outcome: result.outcome,
      observed: applied?.outcome?.observed ?? null,
      reason: result.reason ?? null,
      warnings: applied?.outcome?.warnings ?? [],
      counts: { ...state.counts },
      remainingToday: budgetLineFor(verdict.actionType, budget)?.remainingToday ?? null,
      combinedRemainingToday: budget.combinedRemainingToday,
      elapsedMs: answer.elapsedMs ?? null,
    });
    await api.bumpSession(session.sessionId, { counts: { ...state.counts }, lastActionAt: now() });

    if (applied?.flagged || result.stopRun || result.outcome === 'stopped') {
      state.lastError = result.reason ?? 'Instagram refused the action';
      return endOutreach(ctx, {
        ok: false,
        phase: RunPhase.BLOCKED,
        reason: state.lastError,
        plan,
        session,
        severity: result.severity ?? 'account',
        stopTab: true,
      });
    }
    if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      state.lastError = `${state.consecutiveFailures} actions in a row did not land; the page has probably changed shape`;
      return endOutreach(ctx, { ok: false, phase: RunPhase.FAILED, reason: state.lastError, plan, session, severity: 'page' });
    }
    if (state.stopRequested) {
      return endOutreach(ctx, { ok: true, phase: RunPhase.STOPPED, reason: state.stopReason ?? 'stopped', plan, session });
    }
  }

  return endOutreach(ctx, {
    ok: true,
    phase: RunPhase.DONE,
    reason: state.counts.attempted === 0 ? 'the queue was exhausted without a single action' : null,
    plan,
    session,
  });
  } catch (error) {
    state.lastError = `${error?.name ?? 'Error'}: ${error?.message ?? error}`;
    return endOutreach(ctx, { ok: false, phase: RunPhase.FAILED, reason: state.lastError, plan, session, severity: 'unknown' });
  }
}
