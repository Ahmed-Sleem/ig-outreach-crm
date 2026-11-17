/**
 * The outreach queue: who is next, who is skipped, and why.
 *
 * Pure, like the rest of core/. It reads lead records that are already in the
 * database and never asks Instagram anything, which is the whole point: the
 * "have I already followed this person?" check must be answered from our own
 * records. Asking the platform costs a request, risks a rate limit, and — worst
 * — can be wrong in the direction that matters, because a profile that fails to
 * load reads as "not following" and gets followed a second time.
 *
 * Every refusal carries a code and a sentence. The UI shows both, because an
 * autopilot that silently skips people is indistinguishable from one that is
 * broken.
 */

import { ActionType, canExecute, planNextDelay } from './governor.js';
import { CleanupMode, DmState, RelState, canQueueDm, isEligibleForCleanup, isProtected } from './lifecycle.js';

/** What the autopilot is being asked to do. */
export const QueueMode = Object.freeze({
  FOLLOW: 'FOLLOW',
  DM: 'DM',
  UNFOLLOW: 'UNFOLLOW',
});

/** Why a lead did not make the queue. Stable ids: the UI filters on them. */
export const SkipCode = Object.freeze({
  PROTECTED: 'PROTECTED',
  ALREADY_DONE: 'ALREADY_DONE',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',
  SPACING: 'SPACING',
  DO_NOT_CONTACT: 'DO_NOT_CONTACT',
  NO_TEMPLATE: 'NO_TEMPLATE',
});

const DONE_REL_STATES = Object.freeze([RelState.FOLLOWING, RelState.MUTUAL, RelState.FOLLOW_REQUESTED]);
const WARM_REL_STATES = Object.freeze([RelState.MUTUAL, RelState.FOLLOWED_BY_ONLY]);

/** Which governor counter a lead will spend, decided before anything runs. */
export function actionTypeFor(lead, mode) {
  if (mode === QueueMode.FOLLOW) return ActionType.FOLLOW;
  if (mode === QueueMode.UNFOLLOW) return ActionType.UNFOLLOW;
  return WARM_REL_STATES.includes(lead?.relState ?? RelState.NONE) ? ActionType.DM_WARM : ActionType.DM_COLD;
}

/**
 * One lead, one verdict.
 *
 * `policy` carries the campaign's own choices: `mutualOnly` (opt-in — off by
 * default so leads can be messaged directly within the cold-invite cap; turn on
 * to restrict DMs to people who follow us back for primary-inbox delivery),
 * `allowRefollow`, `maxAttempts`, and the cleaner's `mode`/`graceMs`.
 */
export function candidateVerdict(lead, { mode, now = Date.now(), policy = {} } = {}) {
  const rel = lead?.relState ?? RelState.NONE;
  const dm = lead?.dmState ?? DmState.NONE;
  const refuse = (code, reason, extra = {}) => ({ ok: false, code, reason, actionType: null, ...extra });

  if (lead?.doNotContactReason) {
    return refuse(SkipCode.DO_NOT_CONTACT, `do-not-contact: ${lead.doNotContactReason}`);
  }
  if (isProtected(lead)) {
    return refuse(SkipCode.PROTECTED, 'protected: replier, whitelist, baseline friend or do-not-contact');
  }

  const spacing = Number(lead?.nextEligibleAt ?? 0);
  if (spacing > now) return refuse(SkipCode.SPACING, 'waiting out the spacing delay', { waitMs: spacing - now });

  if (mode === QueueMode.FOLLOW) {
    if (DONE_REL_STATES.includes(rel)) {
      return refuse(SkipCode.ALREADY_DONE, rel === RelState.FOLLOW_REQUESTED ? 'a follow request is already pending' : 'already following');
    }
    if (lead?.followedAt || lead?.requestedAt) {
      // The state machine and the timestamps disagree. Believe the timestamps:
      // they were written when the action was verified, and re-following on a
      // stale state is exactly the churn the platform watches for.
      return refuse(SkipCode.ALREADY_DONE, 'already followed or requested (recorded locally)');
    }
    if (rel === RelState.UNFOLLOWED && policy.allowRefollow !== true) {
      return refuse(SkipCode.NOT_ELIGIBLE, 'we unfollowed this person; following back looks like churn');
    }
    return { ok: true, code: null, reason: null, actionType: ActionType.FOLLOW };
  }

  if (mode === QueueMode.UNFOLLOW) {
    const cleanup = isEligibleForCleanup(lead, {
      mode: policy.cleanupMode ?? CleanupMode.NON_RESPONDERS,
      graceMs: policy.graceMs,
      staleRequestMs: policy.staleRequestMs,
      campaignFinished: policy.campaignFinished ?? false,
      now,
    });
    if (!cleanup.ok) return refuse(SkipCode.NOT_ELIGIBLE, cleanup.reason);
    return {
      ok: true,
      code: null,
      reason: null,
      actionType: ActionType.UNFOLLOW,
      cleanupAction: cleanup.action ?? 'UNFOLLOW',
    };
  }

  // QueueMode.DM
  const dmGate = canQueueDm(lead);
  if (!dmGate.ok) {
    const code = /one-message lock/.test(dmGate.reason) ? SkipCode.ALREADY_DONE
      : /do-not-contact/.test(dmGate.reason) ? SkipCode.DO_NOT_CONTACT
        : SkipCode.NOT_ELIGIBLE;
    return refuse(code, dmGate.reason);
  }
  if (dm === DmState.DM_SENT_PRIMARY) {
    return refuse(SkipCode.ALREADY_DONE, 'the first message was already sent');
  }
  if (dm === DmState.DM_FAILED && Number(lead?.attempts ?? 0) >= Number(policy.maxAttempts ?? 1)) {
    return refuse(SkipCode.NOT_ELIGIBLE, `sending failed ${lead.attempts} time(s); not retrying automatically`);
  }
  if (policy.mutualOnly === true && !WARM_REL_STATES.includes(rel)) {
    return refuse(SkipCode.NOT_ELIGIBLE, 'waiting for a follow-back before the first message');
  }
  return { ok: true, code: null, reason: null, actionType: actionTypeFor(lead, QueueMode.DM) };
}

/** Most important first: score, then breadth of evidence, then name. */
export function sortCandidates(leads) {
  return [...leads].sort((a, b) => {
    const score = Number(b?.priorityScore ?? 0) - Number(a?.priorityScore ?? 0);
    if (score !== 0) return score;
    const edges = Number(b?.edgeCount ?? 0) - Number(a?.edgeCount ?? 0);
    if (edges !== 0) return edges;
    return String(a?.username ?? '').localeCompare(String(b?.username ?? ''));
  });
}

/** A millisecond count in words, for the "this will take about…" line. */
export function humanDurationMs(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.round(total % 60);
  if (hours > 0) return `${hours} hr ${minutes} min`;
  if (minutes > 0) return `${minutes} min ${seconds} sec`;
  return `${seconds} sec`;
}

/** `HH:MM` in local time, for "the window opens at …". */
export function clockAt(timestamp) {
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) return null;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * One governor refusal into a sentence the owner can act on.
 *
 * The governor already refuses in words; this adds the numbers that make the
 * refusal actionable (when the window opens, how long the lock lasts) without
 * inventing a reason it did not give.
 */
export function gateSentence(gate) {
  if (!gate || gate.ok) return null;
  const reason = String(gate.reason ?? 'not allowed right now');
  if (gate.reason === 'outside the active window' && gate.opensAt) {
    return `${reason} — it opens at ${clockAt(gate.opensAt)}`;
  }
  if (gate.reason === 'circuit breaker' && gate.lockedUntil) {
    return `Everything is locked until ${clockAt(gate.lockedUntil)} (${gate.lockReason ?? 'safety lock'}). Starting again early only extends the platform's patience.`;
  }
  if (gate.reason === 'spacing' && gate.waitMs) {
    return `${reason} — next action in ${humanDurationMs(gate.waitMs)}`;
  }
  return reason;
}

/**
 * Build the queue for one mode.
 *
 * The result is split in two on purpose: `queue` is what will happen, `skipped`
 * is what will not and why. Showing only the queue would hide the fact that 400
 * of 500 people were already followed, which is the difference between "the
 * autopilot is careful" and "the autopilot is broken".
 */
export function buildQueue({
  leads = [],
  mode = QueueMode.FOLLOW,
  settings = {},
  governorState = null,
  workspaceKey = '',
  now = Date.now(),
  limit = 200,
  policy = {},
  groupId = null,
  templateCount = null,
  rng = null,
  followingCount = 0,
} = {}) {
  const inGroup = groupId === null || groupId === undefined
    ? leads
    : leads.filter((lead) => Array.isArray(lead?.groupIds) && lead.groupIds.includes(String(groupId)));

  const queue = [];
  const skipped = [];
  const byCode = {};

  // Leads outside the selected bucket are counted, not listed: with a bucket of
  // 40 inside a library of 5,000, five thousand "not in this bucket" rows would
  // bury the four refusals that actually matter.
  for (const lead of sortCandidates(inGroup)) {
    const verdict = candidateVerdict(lead, { mode, now, policy });
    if (!verdict.ok) {
      skipped.push({ lead, code: verdict.code, reason: verdict.reason, waitMs: verdict.waitMs ?? null });
      byCode[verdict.code] = (byCode[verdict.code] ?? 0) + 1;
      continue;
    }
    queue.push({ lead, actionType: verdict.actionType, cleanupAction: verdict.cleanupAction ?? null, rank: queue.length + 1 });
  }

  const dominant = queue[0]?.actionType ?? (mode === QueueMode.DM ? ActionType.DM_COLD : actionTypeFor({}, mode));
  const gate = canExecute(dominant, { now: new Date(now), governorState, settings, workspaceKey, followingCount });

  // A message run with no templates has nothing to send. Refusing to start beats
  // opening an empty composer, and the reason is shown next to the Start button.
  const missingTemplates = mode === QueueMode.DM && Number(templateCount ?? 0) < 1;
  const canStart = gate.ok && !missingTemplates;
  // The queue stays visible even when the gate is shut: an owner who cannot see
  // the 24 people waiting cannot tell a closed window from an empty database.
  const limited = queue.slice(0, Math.max(0, Number(limit) || 0));

  return {
    mode,
    actionType: dominant,
    queue: limited,
    candidates: queue,
    skipped,
    counts: {
      considered: inGroup.length,
      outsideGroup: leads.length - inGroup.length,
      queued: limited.length,
      ready: queue.length,
      skipped: skipped.length,
      byCode,
    },
    gate,
    canStart,
    gateMessage: missingTemplates ? 'Add at least one message template before starting a message run.' : gateSentence(gate),
    blocked: !canStart,
    estimate: limited.length && rng ? estimateSession({ count: limited.length, settings, rng }) : null,
  };
}

/**
 * How long a run of `count` actions will take, with the governor's own delay
 * planner: log-normal gaps, a 10% chance of a long distraction and a real break
 * every 8–12 actions. An estimate the owner sees before pressing Start is what
 * makes a three-hour run a choice rather than a surprise.
 */
export function estimateSession({ count, settings = {}, rng, actionsSinceBreak = 0, cap = 5000 } = {}) {
  const total = Math.max(0, Math.min(Number(count) || 0, cap));
  if (!rng || total === 0) return null;
  let ms = 0;
  let sinceBreak = actionsSinceBreak;
  let breaks = 0;
  let distractions = 0;
  for (let index = 0; index < total; index += 1) {
    const plan = planNextDelay({ settings, rng, actionsSinceBreak: sinceBreak });
    ms += plan.ms;
    if (plan.kind === 'break') {
      breaks += 1;
      sinceBreak = 0;
    } else {
      if (plan.kind === 'distraction') distractions += 1;
      sinceBreak += 1;
    }
  }
  return {
    actionCount: total,
    totalMs: ms,
    humanReadable: humanDurationMs(ms),
    breaks,
    distractions,
    averageMs: Math.round(ms / total),
    truncated: Number(count) > cap,
  };
}
