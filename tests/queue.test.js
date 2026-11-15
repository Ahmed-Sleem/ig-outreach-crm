import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  QueueMode,
  SkipCode,
  actionTypeFor,
  buildQueue,
  candidateVerdict,
  clockAt,
  estimateSession,
  gateSentence,
  humanDurationMs,
  sortCandidates,
} from '../src/core/queue.js';
import { EntropyPoolRNG } from '../src/core/random.js';
import { initialGovernorState } from '../src/core/governor.js';

/** Noon on a Wednesday: inside the default 09:30–22:30 active window. */
const NOW = new Date(2026, 0, 7, 12, 0, 0).getTime();
const DAY = 86400000;

const lead = (patch = {}) => ({
  leadKey: `1:${(patch.username ?? 'someone').toLowerCase()}`,
  workspaceId: '1',
  username: patch.username ?? 'someone',
  relState: 'NONE',
  dmState: 'NONE',
  priorityScore: 0,
  edgeCount: 0,
  groupIds: [],
  followedAt: null,
  requestedAt: null,
  messagedAt: null,
  nextEligibleAt: null,
  attempts: 0,
  isWhitelisted: false,
  isProtectedBaseline: false,
  doNotContactReason: null,
  followedViaExtension: false,
  ...patch,
});

const verdict = (patch, mode, options = {}) =>
  candidateVerdict(lead(patch), { mode, now: NOW, policy: options.policy ?? {} });

const rng = () => new EntropyPoolRNG({
  seed: [11, 22, 33, 44],
  clock: () => NOW,
  microClock: () => 1,
  randomWords: () => new Uint32Array([11, 22, 33, 44]),
});

describe('follow queue', () => {
  test('a person we have never touched is queued, most important first', () => {
    const fresh = verdict({}, QueueMode.FOLLOW);
    assert.equal(fresh.ok, true);
    assert.equal(fresh.actionType, 'FOLLOW');
    // They follow us and we do not follow them: a follow-back is the warmest
    // first action there is.
    assert.equal(verdict({ relState: 'FOLLOWED_BY_ONLY' }, QueueMode.FOLLOW).ok, true);
    assert.equal(verdict({ relState: 'FOLLOW_QUEUED' }, QueueMode.FOLLOW).ok, true);
  });

  test('nobody is followed twice, and the local record is the authority', () => {
    for (const relState of ['FOLLOWING', 'MUTUAL']) {
      const result = verdict({ relState }, QueueMode.FOLLOW);
      assert.equal(result.ok, false);
      assert.equal(result.code, SkipCode.ALREADY_DONE);
      assert.match(result.reason, /already following/);
    }
    const pending = verdict({ relState: 'FOLLOW_REQUESTED' }, QueueMode.FOLLOW);
    assert.equal(pending.code, SkipCode.ALREADY_DONE);
    assert.match(pending.reason, /request is already pending/);
  });

  test('a timestamp beats a stale state machine', () => {
    // relState says NONE but the log says we followed them. Following again on
    // the state alone is exactly the churn the platform watches for.
    const byFollow = verdict({ relState: 'NONE', followedAt: NOW - DAY }, QueueMode.FOLLOW);
    assert.equal(byFollow.ok, false);
    assert.equal(byFollow.code, SkipCode.ALREADY_DONE);
    assert.match(byFollow.reason, /recorded locally/);
    const byRequest = verdict({ requestedAt: NOW - DAY }, QueueMode.FOLLOW);
    assert.equal(byRequest.code, SkipCode.ALREADY_DONE);
  });

  test('someone we unfollowed is not re-followed unless the owner says so', () => {
    // An imported record can say UNFOLLOWED without a followedAt timestamp; the
    // state alone still has to stop a re-follow.
    const refused = verdict({ relState: 'UNFOLLOWED', unfollowedAt: NOW - DAY }, QueueMode.FOLLOW);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, SkipCode.NOT_ELIGIBLE);
    assert.match(refused.reason, /looks like churn/);
    assert.equal(verdict({ relState: 'UNFOLLOWED', unfollowedAt: NOW - DAY }, QueueMode.FOLLOW, { policy: { allowRefollow: true } }).ok, true);
    // With our own timestamp on record the earlier rule answers first.
    assert.equal(verdict({ relState: 'UNFOLLOWED', followedAt: NOW - 9 * DAY }, QueueMode.FOLLOW).code, SkipCode.ALREADY_DONE);
  });

  test('protected people and do-not-contact rows are never campaign targets', () => {
    assert.equal(verdict({ isWhitelisted: true }, QueueMode.FOLLOW).code, SkipCode.PROTECTED);
    assert.equal(verdict({ isProtectedBaseline: true }, QueueMode.FOLLOW).code, SkipCode.PROTECTED);
    assert.equal(verdict({ dmState: 'DM_REPLIED' }, QueueMode.FOLLOW).code, SkipCode.PROTECTED);
    const dnc = verdict({ doNotContactReason: 'existing customer' }, QueueMode.FOLLOW);
    assert.equal(dnc.code, SkipCode.DO_NOT_CONTACT);
    assert.match(dnc.reason, /existing customer/);
  });

  test('spacing is honoured with the wait named', () => {
    const waiting = verdict({ nextEligibleAt: NOW + 90000 }, QueueMode.FOLLOW);
    assert.equal(waiting.code, SkipCode.SPACING);
    assert.equal(waiting.waitMs, 90000);
    assert.equal(verdict({ nextEligibleAt: NOW - 1 }, QueueMode.FOLLOW).ok, true);
  });
});

describe('message queue', () => {
  test('a follow-back opens the conversation, and it spends the warm budget', () => {
    for (const relState of ['MUTUAL', 'FOLLOWED_BY_ONLY']) {
      const result = verdict({ relState }, QueueMode.DM);
      assert.equal(result.ok, true, relState);
      assert.equal(result.actionType, 'DM_WARM');
    }
    assert.equal(actionTypeFor(lead({ relState: 'MUTUAL' }), QueueMode.DM), 'DM_WARM');
    assert.equal(actionTypeFor(lead({ relState: 'NONE' }), QueueMode.DM), 'DM_COLD');
  });

  test('the default funnel waits for a follow-back before the first message', () => {
    const cold = verdict({ relState: 'NONE' }, QueueMode.DM);
    assert.equal(cold.ok, false);
    assert.equal(cold.code, SkipCode.NOT_ELIGIBLE);
    assert.match(cold.reason, /waiting for a follow-back/);
    const allowed = verdict({ relState: 'NONE' }, QueueMode.DM, { policy: { mutualOnly: false } });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.actionType, 'DM_COLD');
  });

  test('one message per person, checked from our own records', () => {
    const locked = verdict({ relState: 'NONE', dmState: 'DM_SENT_REQUEST' }, QueueMode.DM);
    assert.equal(locked.code, SkipCode.ALREADY_DONE);
    assert.match(locked.reason, /one-message lock/);
    const sent = verdict({ relState: 'MUTUAL', dmState: 'DM_SENT_PRIMARY', messagedAt: NOW - DAY }, QueueMode.DM);
    assert.equal(sent.code, SkipCode.ALREADY_DONE);
    assert.match(sent.reason, /already sent/);
    for (const dmState of ['DM_REPLIED', 'DM_EXISTING_THREAD_SKIPPED', 'DM_UNAVAILABLE', 'DM_SKIPPED_NO_ACCEPT']) {
      const result = verdict({ relState: 'MUTUAL', dmState }, QueueMode.DM);
      assert.equal(result.ok, false, dmState);
    }
  });

  test('a failed send is retried once at most, and never silently forever', () => {
    const first = verdict({ relState: 'MUTUAL', dmState: 'DM_FAILED', attempts: 1 }, QueueMode.DM);
    assert.equal(first.ok, false);
    assert.match(first.reason, /not retrying automatically/);
    assert.equal(verdict({ relState: 'MUTUAL', dmState: 'DM_FAILED', attempts: 0 }, QueueMode.DM).ok, true);
    assert.equal(verdict({ relState: 'MUTUAL', dmState: 'DM_FAILED', attempts: 1 }, QueueMode.DM, { policy: { maxAttempts: 3 } }).ok, true);
  });

  test('a replier is protected even from a message', () => {
    assert.equal(verdict({ relState: 'MUTUAL', dmState: 'DM_REPLIED' }, QueueMode.DM).code, SkipCode.PROTECTED);
  });
});

describe('unfollow queue', () => {
  test('only people this extension followed are ever unfollowed', () => {
    const byHand = verdict({ relState: 'FOLLOWING', followedAt: NOW - 30 * DAY }, QueueMode.UNFOLLOW);
    assert.equal(byHand.ok, false);
    assert.match(byHand.reason, /not followed by this extension/);
    const ours = verdict({ relState: 'FOLLOWING', followedAt: NOW - 30 * DAY, followedViaExtension: true }, QueueMode.UNFOLLOW);
    assert.equal(ours.ok, true);
    assert.equal(ours.actionType, 'UNFOLLOW');
    assert.equal(ours.cleanupAction, 'UNFOLLOW');
  });

  test('the 48 hour grace is a floor, not a default', () => {
    const tooSoon = verdict({ relState: 'FOLLOWING', followedAt: NOW - 2 * DAY, followedViaExtension: true }, QueueMode.UNFOLLOW);
    assert.equal(tooSoon.ok, false);
    assert.match(tooSoon.reason, /grace window/);
    // Asking for a 1 hour grace must not be honoured: same-day cycling is an
    // immediate platform flag, so 48 hours is a floor and not a default.
    const forced = verdict(
      { relState: 'FOLLOWING', followedAt: NOW - 12 * 3600000, followedViaExtension: true },
      QueueMode.UNFOLLOW,
      { policy: { graceMs: 3600000 } },
    );
    assert.equal(forced.ok, false);
    assert.match(forced.reason, /grace window/);
  });

  test('non-responder cleanup leaves mutuals alone, full cycle does not', () => {
    const mutual = { relState: 'MUTUAL', followedAt: NOW - 30 * DAY, followedViaExtension: true };
    assert.match(verdict(mutual, QueueMode.UNFOLLOW).reason, /leaves mutuals alone/);
    const needsFinish = verdict(mutual, QueueMode.UNFOLLOW, { policy: { cleanupMode: 'full_cycle' } });
    assert.match(needsFinish.reason, /campaign marked finished/);
    assert.equal(verdict(mutual, QueueMode.UNFOLLOW, { policy: { cleanupMode: 'full_cycle', campaignFinished: true } }).ok, true);
  });

  test('a stale pending request is withdrawn rather than unfollowed', () => {
    const stale = verdict(
      { relState: 'FOLLOW_REQUESTED', requestedAt: NOW - 20 * DAY, followedAt: NOW - 20 * DAY, followedViaExtension: true },
      QueueMode.UNFOLLOW,
      { policy: { cleanupMode: 'stale_requests', staleRequestMs: 10 * DAY } },
    );
    assert.equal(stale.ok, true);
    assert.equal(stale.cleanupAction, 'WITHDRAW_REQUEST');
    const young = verdict(
      { relState: 'FOLLOW_REQUESTED', followedAt: NOW - 2 * DAY, followedViaExtension: true },
      QueueMode.UNFOLLOW,
      { policy: { cleanupMode: 'stale_requests' } },
    );
    assert.equal(young.ok, false);
  });

  test('a protected person is never cleaned up', () => {
    const protectedLead = { relState: 'FOLLOWING', followedAt: NOW - 30 * DAY, followedViaExtension: true, isWhitelisted: true };
    assert.equal(verdict(protectedLead, QueueMode.UNFOLLOW).code, SkipCode.PROTECTED);
  });
});

describe('building a queue', () => {
  const leads = [
    lead({ username: 'cold_one', priorityScore: 5 }),
    lead({ username: 'warm_one', priorityScore: 90, relState: 'MUTUAL' }),
    lead({ username: 'done_one', priorityScore: 99, relState: 'FOLLOWING', followedAt: NOW - DAY, followedViaExtension: true }),
    lead({ username: 'grouped', priorityScore: 40, groupIds: ['grp_a'] }),
    lead({ username: 'tied_b', priorityScore: 40, edgeCount: 3 }),
    lead({ username: 'tied_a', priorityScore: 40, edgeCount: 3 }),
  ];

  test('the queue is ranked and the skipped list explains itself', () => {
    const built = buildQueue({ leads, mode: QueueMode.FOLLOW, now: NOW, governorState: initialGovernorState() });
    // warm_one is MUTUAL, so we already follow them: the highest score in the
    // library still does not earn a second follow.
    // All three of the top rows score 40, so breadth of evidence breaks the tie.
    assert.deepEqual(built.queue.map((row) => row.lead.username), ['tied_a', 'tied_b', 'grouped', 'cold_one']);
    assert.equal(built.queue[0].rank, 1);
    assert.deepEqual(built.skipped.map((row) => row.lead.username), ['done_one', 'warm_one']);
    assert.equal(built.skipped[0].code, SkipCode.ALREADY_DONE);
    assert.deepEqual(built.counts, { considered: 6, outsideGroup: 0, queued: 4, ready: 4, skipped: 2, byCode: { ALREADY_DONE: 2 } });
    assert.equal(built.canStart, true);
    assert.equal(built.gateMessage, null);
  });

  test('equal scores fall back to breadth of evidence, then to the name', () => {
    const scores = buildQueue({
      leads: [
        lead({ username: 'zeta', priorityScore: 10, edgeCount: 1 }),
        lead({ username: 'alpha', priorityScore: 10, edgeCount: 1 }),
        lead({ username: 'beta', priorityScore: 10, edgeCount: 4 }),
      ],
      mode: QueueMode.FOLLOW,
      now: NOW,
    });
    assert.deepEqual(scores.queue.map((row) => row.lead.username), ['beta', 'alpha', 'zeta']);
    assert.deepEqual(sortCandidates([lead({ username: 'b', priorityScore: 1 }), lead({ username: 'a', priorityScore: 2 })]).map((row) => row.username), ['a', 'b']);
  });

  test('a bucket narrows the queue and reports the rest as a count', () => {
    const built = buildQueue({ leads, mode: QueueMode.FOLLOW, now: NOW, groupId: 'grp_a' });
    assert.deepEqual(built.queue.map((row) => row.lead.username), ['grouped']);
    assert.equal(built.counts.considered, 1);
    assert.equal(built.counts.outsideGroup, 5);
    assert.equal(built.counts.skipped, 0);
    assert.equal(built.skipped.length, 0, 'five thousand "not in this bucket" rows would bury the real refusals');
  });

  test('the limit caps what will run, while the ready count stays honest', () => {
    const built = buildQueue({ leads, mode: QueueMode.FOLLOW, now: NOW, limit: 2 });
    assert.equal(built.queue.length, 2);
    assert.equal(built.counts.ready, 4);
    assert.equal(built.candidates.length, 4);
    assert.equal(built.counts.queued, 2);
  });

  test('a shut gate keeps the queue visible but refuses to start', () => {
    const outsideWindow = new Date(2026, 0, 7, 3, 0, 0).getTime();
    const built = buildQueue({ leads, mode: QueueMode.FOLLOW, now: outsideWindow });
    assert.equal(built.canStart, false);
    assert.equal(built.blocked, true);
    assert.equal(built.queue.length, 4, 'the owner must still see who is waiting');
    assert.match(built.gateMessage, /outside the active window — it opens at \d\d:\d\d/);
  });

  test('a locked account explains the lock instead of showing an empty queue', () => {
    const locked = { ...initialGovernorState(), lockedUntil: NOW + 3600000, lockReason: 'action block' };
    const built = buildQueue({ leads, mode: QueueMode.FOLLOW, now: NOW, governorState: locked });
    assert.equal(built.canStart, false);
    assert.match(built.gateMessage, /locked until \d\d:\d\d \(action block\)/);
  });

  test('a message run without templates cannot start', () => {
    const built = buildQueue({ leads, mode: QueueMode.DM, now: NOW, templateCount: 0 });
    assert.equal(built.canStart, false);
    assert.equal(built.gateMessage, 'Add at least one message template before starting a message run.');
    const withTemplates = buildQueue({ leads, mode: QueueMode.DM, now: NOW, templateCount: 3 });
    assert.equal(withTemplates.canStart, true);
    assert.deepEqual(withTemplates.queue.map((row) => row.lead.username), ['warm_one']);
    assert.equal(withTemplates.actionType, 'DM_WARM');
  });

  test('the estimate is computed for what will actually run', () => {
    const built = buildQueue({ leads, mode: QueueMode.FOLLOW, now: NOW, rng: rng(), limit: 3 });
    assert.equal(built.estimate.actionCount, 3);
    assert.ok(built.estimate.totalMs > 0);
    assert.match(built.estimate.humanReadable, /(sec|min|hr)/);
    assert.ok(built.estimate.averageMs > 30000, 'the floor on an action delay is 35s');
    assert.equal(buildQueue({ leads, mode: QueueMode.FOLLOW, now: NOW }).estimate, null, 'no rng, no invented number');
  });
});

describe('session estimate and wording', () => {
  test('breaks and distractions are counted, not averaged away', () => {
    const plan = estimateSession({ count: 30, rng: rng(), settings: {} });
    assert.equal(plan.actionCount, 30);
    assert.ok(plan.breaks >= 2, 'a break every 8-12 actions over 30 actions');
    assert.ok(plan.totalMs > 30 * 35000);
    assert.equal(plan.truncated, false);
  });

  test('an estimate is never invented for zero actions or without entropy', () => {
    assert.equal(estimateSession({ count: 0, rng: rng() }), null);
    assert.equal(estimateSession({ count: 10 }), null);
    const capped = estimateSession({ count: 9000, rng: rng(), cap: 100 });
    assert.equal(capped.actionCount, 100);
    assert.equal(capped.truncated, true);
  });

  test('durations read the way a person says them', () => {
    assert.equal(humanDurationMs(0), '0 sec');
    assert.equal(humanDurationMs(45000), '45 sec');
    assert.equal(humanDurationMs(90000), '1 min 30 sec');
    assert.equal(humanDurationMs(3720000), '1 hr 2 min');
    assert.equal(humanDurationMs(-5), '0 sec');
    assert.equal(humanDurationMs(NaN), '0 sec');
  });

  test('a gate sentence adds the number the refusal implies', () => {
    assert.equal(gateSentence(null), null);
    assert.equal(gateSentence({ ok: true }), null);
    assert.equal(gateSentence({ ok: false, reason: 'daily follow cap reached' }), 'daily follow cap reached');
    const spacing = gateSentence({ ok: false, reason: 'spacing', waitMs: 90000 });
    assert.equal(spacing, 'spacing — next action in 1 min 30 sec');
    assert.equal(clockAt(NaN), null);
    assert.match(clockAt(NOW), /^\d\d:\d\d$/);
  });
});
