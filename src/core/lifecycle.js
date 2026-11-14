/**
 * The lead lifecycle: one authoritative state machine for both axes.
 *
 * A lead carries exactly one pair (relState, dmState). Tab 1, Tab 2 and the
 * content script all read and write through these transitions, which is what
 * makes "Queued -> Requested -> Accepted -> Messaged" mean the same thing
 * everywhere. Anything not listed here is refused with a reason, so an illegal
 * state is a visible error rather than a corrupted row.
 *
 * Two rules are enforced here and nowhere else:
 *  - the one-message lock on unaccepted requests (Instagram allows a single
 *    text-only message to a non-follower, and hides the composer after it);
 *  - unfollow eligibility, including the 48-hour grace floor and the
 *    protections for repliers, the whitelist and the baseline snapshot.
 *
 * Pure. Timestamps arrive from the caller.
 */

export const RelState = Object.freeze({
  NONE: 'NONE',
  FOLLOW_QUEUED: 'FOLLOW_QUEUED',
  FOLLOW_REQUESTED: 'FOLLOW_REQUESTED',
  FOLLOWING: 'FOLLOWING',
  MUTUAL: 'MUTUAL',
  FOLLOWED_BY_ONLY: 'FOLLOWED_BY_ONLY',
  REQUEST_WITHDRAWN: 'REQUEST_WITHDRAWN',
  UNFOLLOW_QUEUED: 'UNFOLLOW_QUEUED',
  UNFOLLOWED: 'UNFOLLOWED',
});

export const DmState = Object.freeze({
  NONE: 'NONE',
  WAITING_FOR_ACCEPT: 'WAITING_FOR_ACCEPT',
  DM_QUEUED: 'DM_QUEUED',
  DM_SENT_PRIMARY: 'DM_SENT_PRIMARY',
  DM_SENT_REQUEST: 'DM_SENT_REQUEST',
  DM_REPLIED: 'DM_REPLIED',
  DM_EXISTING_THREAD_SKIPPED: 'DM_EXISTING_THREAD_SKIPPED',
  DM_UNAVAILABLE: 'DM_UNAVAILABLE',
  DM_SKIPPED_NO_ACCEPT: 'DM_SKIPPED_NO_ACCEPT',
  DM_FAILED: 'DM_FAILED',
});

export const RelEvent = Object.freeze({
  OBSERVED_FOLLOWED_BY: 'OBSERVED_FOLLOWED_BY',
  QUEUE_FOLLOW: 'QUEUE_FOLLOW',
  FOLLOW_CLICKED_PRIVATE: 'FOLLOW_CLICKED_PRIVATE',
  FOLLOW_CLICKED_PUBLIC: 'FOLLOW_CLICKED_PUBLIC',
  ACCEPT_DETECTED: 'ACCEPT_DETECTED',
  FOLLOW_BACK_DETECTED: 'FOLLOW_BACK_DETECTED',
  REQUEST_DECLINED: 'REQUEST_DECLINED',
  QUEUE_UNFOLLOW: 'QUEUE_UNFOLLOW',
  UNFOLLOW_EXECUTED: 'UNFOLLOW_EXECUTED',
});

export const DmEvent = Object.freeze({
  FUNNEL_ARMED: 'FUNNEL_ARMED',
  DM_CONDITION_MET: 'DM_CONDITION_MET',
  DM_CONDITION_TIMEOUT: 'DM_CONDITION_TIMEOUT',
  DM_EXISTING_THREAD: 'DM_EXISTING_THREAD',
  DM_UNAVAILABLE: 'DM_UNAVAILABLE',
  DM_SENT_PRIMARY: 'DM_SENT_PRIMARY',
  DM_SENT_REQUEST: 'DM_SENT_REQUEST',
  DM_FAILED: 'DM_FAILED',
  DM_REPLY_SEEN: 'DM_REPLY_SEEN',
});

const REL_TRANSITIONS = Object.freeze({
  [RelEvent.OBSERVED_FOLLOWED_BY]: { from: [RelState.NONE], to: RelState.FOLLOWED_BY_ONLY },
  // A withdrawn or previously unfollowed account may re-enter the queue: the
  // campaign, not the state machine, decides whether retrying is wise.
  [RelEvent.QUEUE_FOLLOW]: { from: [RelState.NONE, RelState.FOLLOWED_BY_ONLY, RelState.UNFOLLOWED, RelState.REQUEST_WITHDRAWN], to: RelState.FOLLOW_QUEUED },
  [RelEvent.FOLLOW_CLICKED_PRIVATE]: { from: [RelState.FOLLOW_QUEUED], to: RelState.FOLLOW_REQUESTED },
  [RelEvent.FOLLOW_CLICKED_PUBLIC]: { from: [RelState.FOLLOW_QUEUED], to: RelState.FOLLOWING },
  [RelEvent.ACCEPT_DETECTED]: { from: [RelState.FOLLOW_REQUESTED], to: RelState.FOLLOWING },
  [RelEvent.FOLLOW_BACK_DETECTED]: { from: [RelState.FOLLOWING, RelState.FOLLOW_REQUESTED], to: RelState.MUTUAL },
  [RelEvent.REQUEST_DECLINED]: { from: [RelState.FOLLOW_REQUESTED], to: RelState.REQUEST_WITHDRAWN },
  [RelEvent.QUEUE_UNFOLLOW]: { from: [RelState.FOLLOWING, RelState.MUTUAL], to: RelState.UNFOLLOW_QUEUED },
  [RelEvent.UNFOLLOW_EXECUTED]: { from: [RelState.UNFOLLOW_QUEUED], to: RelState.UNFOLLOWED },
});

const DM_TRANSITIONS = Object.freeze({
  [DmEvent.FUNNEL_ARMED]: { from: [DmState.NONE], to: DmState.WAITING_FOR_ACCEPT },
  [DmEvent.DM_CONDITION_MET]: { from: [DmState.WAITING_FOR_ACCEPT, DmState.DM_FAILED], to: DmState.DM_QUEUED },
  [DmEvent.DM_CONDITION_TIMEOUT]: { from: [DmState.WAITING_FOR_ACCEPT], to: DmState.DM_SKIPPED_NO_ACCEPT },
  [DmEvent.DM_EXISTING_THREAD]: { from: [DmState.DM_QUEUED], to: DmState.DM_EXISTING_THREAD_SKIPPED },
  [DmEvent.DM_UNAVAILABLE]: { from: [DmState.DM_QUEUED, DmState.WAITING_FOR_ACCEPT], to: DmState.DM_UNAVAILABLE },
  [DmEvent.DM_SENT_PRIMARY]: { from: [DmState.DM_QUEUED], to: DmState.DM_SENT_PRIMARY },
  [DmEvent.DM_SENT_REQUEST]: { from: [DmState.DM_QUEUED], to: DmState.DM_SENT_REQUEST },
  [DmEvent.DM_FAILED]: { from: [DmState.DM_QUEUED], to: DmState.DM_FAILED },
  [DmEvent.DM_REPLY_SEEN]: { from: [DmState.DM_SENT_PRIMARY, DmState.DM_SENT_REQUEST], to: DmState.DM_REPLIED },
});

function apply(table, current, event, axis) {
  const rule = table[event];
  if (!rule) return { ok: false, reason: `unknown ${axis} event: ${event}` };
  if (!rule.from.includes(current)) {
    return { ok: false, reason: `${axis} event ${event} is not valid from ${current}` };
  }
  return { ok: true, next: rule.to };
}

export function applyRelEvent(relState, event) {
  return apply(REL_TRANSITIONS, relState ?? RelState.NONE, event, 'relationship');
}

export function applyDmEvent(dmState, event) {
  return apply(DM_TRANSITIONS, dmState ?? DmState.NONE, event, 'messaging');
}

/**
 * May this lead enter the DM queue right now?
 *
 * The one-message lock: once a request message is logged for someone who does
 * not follow the sender, a second message is refused until they follow back or
 * reply. Instagram enforces this in its composer; enforcing it here too means
 * the queue never even builds an intent the platform will reject.
 */
export function canQueueDm(lead) {
  const dm = lead?.dmState ?? DmState.NONE;
  const rel = lead?.relState ?? RelState.NONE;

  if (dm === DmState.DM_SENT_REQUEST && rel !== RelState.MUTUAL && rel !== RelState.FOLLOWED_BY_ONLY && dm !== DmState.DM_REPLIED) {
    return { ok: false, reason: 'one-message lock: a request message was already sent and not answered' };
  }
  if ([DmState.DM_REPLIED, DmState.DM_EXISTING_THREAD_SKIPPED, DmState.DM_UNAVAILABLE, DmState.DM_SKIPPED_NO_ACCEPT].includes(dm)) {
    return { ok: false, reason: `messaging closed for this lead (${dm})` };
  }
  if (lead?.doNotContactReason) {
    return { ok: false, reason: `do-not-contact: ${lead.doNotContactReason}` };
  }
  return { ok: true, reason: null };
}

/** Repliers, the whitelist and the baseline snapshot are never campaign targets. */
export function isProtected(lead) {
  return Boolean(
    lead?.isWhitelisted
    || lead?.isProtectedBaseline
    || (lead?.dmState ?? DmState.NONE) === DmState.DM_REPLIED
    || lead?.doNotContactReason,
  );
}

/** 48 hours: same-day follow/unfollow cycling is an immediate platform flag. */
export const MIN_UNFOLLOW_GRACE_MS = 48 * 60 * 60 * 1000;

export const CleanupMode = Object.freeze({
  NON_RESPONDERS: 'non_responders',
  FULL_CYCLE: 'full_cycle',
  STALE_REQUESTS: 'stale_requests',
});

/**
 * May the cleaner queue an unfollow (or a request withdrawal) for this lead?
 *
 * @param {object} lead
 * @param {{mode?: string, graceMs?: number, staleRequestMs?: number,
 *          campaignFinished?: boolean, now: number}} policy
 */
export function isEligibleForCleanup(lead, policy) {
  const now = policy?.now ?? Date.now();
  const mode = policy?.mode ?? CleanupMode.NON_RESPONDERS;
  const rel = lead?.relState ?? RelState.NONE;

  if (isProtected(lead)) {
    return { ok: false, reason: 'protected: replier, whitelist, baseline or do-not-contact' };
  }

  if (mode === CleanupMode.STALE_REQUESTS) {
    const staleMs = Math.max(policy?.staleRequestMs ?? 10 * 86400000, MIN_UNFOLLOW_GRACE_MS);
    if (rel !== RelState.FOLLOW_REQUESTED) return { ok: false, reason: 'not a pending follow request' };
    const age = now - (lead?.followedAt ?? now);
    if (age < staleMs) return { ok: false, reason: 'request is not stale yet' };
    return { ok: true, action: 'WITHDRAW_REQUEST', reason: null };
  }

  if (lead?.followedViaExtension !== true) {
    return { ok: false, reason: 'not followed by this extension' };
  }
  const graceMs = Math.max(policy?.graceMs ?? 5 * 86400000, MIN_UNFOLLOW_GRACE_MS);
  const age = now - (lead?.followedAt ?? now);
  if (age < graceMs) return { ok: false, reason: 'inside the grace window' };

  if (mode === CleanupMode.NON_RESPONDERS) {
    if (rel !== RelState.FOLLOWING) return { ok: false, reason: 'they followed back; non-responder cleanup leaves mutuals alone' };
  } else if (mode === CleanupMode.FULL_CYCLE) {
    if (!policy?.campaignFinished) return { ok: false, reason: 'full-cycle cleanup needs the campaign marked finished' };
    if (rel !== RelState.FOLLOWING && rel !== RelState.MUTUAL) return { ok: false, reason: 'not currently followed' };
  } else {
    return { ok: false, reason: `unknown cleanup mode: ${mode}` };
  }

  return { ok: true, action: 'UNFOLLOW', reason: null };
}
