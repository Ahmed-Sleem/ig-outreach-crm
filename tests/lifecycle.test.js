import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CleanupMode,
  DmEvent,
  DmState,
  MIN_UNFOLLOW_GRACE_MS,
  RelEvent,
  RelState,
  applyDmEvent,
  applyRelEvent,
  canQueueDm,
  isEligibleForCleanup,
  isProtected,
} from '../src/core/lifecycle.js';

const DAY = 86400000;
const NOW = 40 * DAY;

describe('relationship axis', () => {
  test('the private-account path walks the documented states', () => {
    let state = RelState.NONE;
    for (const event of [RelEvent.QUEUE_FOLLOW, RelEvent.FOLLOW_CLICKED_PRIVATE, RelEvent.ACCEPT_DETECTED, RelEvent.FOLLOW_BACK_DETECTED]) {
      const result = applyRelEvent(state, event);
      assert.equal(result.ok, true, `${event} from ${state}: ${result.reason}`);
      state = result.next;
    }
    assert.equal(state, RelState.MUTUAL);
  });

  test('the public-account path has no request step', () => {
    let state = RelState.NONE;
    for (const event of [RelEvent.QUEUE_FOLLOW, RelEvent.FOLLOW_CLICKED_PUBLIC]) {
      state = applyRelEvent(state, event).next;
    }
    assert.equal(state, RelState.FOLLOWING);
    assert.equal(applyRelEvent(state, RelEvent.ACCEPT_DETECTED).ok, false);
  });

  test('illegal events are refused with a reason, never silent', () => {
    const result = applyRelEvent(RelState.NONE, RelEvent.UNFOLLOW_EXECUTED);
    assert.equal(result.ok, false);
    assert.match(result.reason, /not valid from NONE/);
    assert.equal(applyRelEvent(RelState.MUTUAL, 'NOT_AN_EVENT').ok, false);
  });

  test('a declined request can be re-queued later', () => {
    let state = RelState.FOLLOW_REQUESTED;
    state = applyRelEvent(state, RelEvent.REQUEST_DECLINED).next;
    assert.equal(state, RelState.REQUEST_WITHDRAWN);
    assert.equal(applyRelEvent(state, RelEvent.QUEUE_FOLLOW).next, RelState.FOLLOW_QUEUED);
  });
});

describe('messaging axis', () => {
  test('the funnel walks arm -> condition -> send -> reply', () => {
    let state = DmState.NONE;
    for (const event of [DmEvent.FUNNEL_ARMED, DmEvent.DM_CONDITION_MET, DmEvent.DM_SENT_REQUEST, DmEvent.DM_REPLY_SEEN]) {
      const result = applyDmEvent(state, event);
      assert.equal(result.ok, true, result.reason);
      state = result.next;
    }
    assert.equal(state, DmState.DM_REPLIED);
  });

  test('every skip reason is a terminal, distinct state', () => {
    assert.equal(applyDmEvent(DmState.WAITING_FOR_ACCEPT, DmEvent.DM_CONDITION_TIMEOUT).next, DmState.DM_SKIPPED_NO_ACCEPT);
    assert.equal(applyDmEvent(DmState.DM_QUEUED, DmEvent.DM_EXISTING_THREAD).next, DmState.DM_EXISTING_THREAD_SKIPPED);
    assert.equal(applyDmEvent(DmState.DM_QUEUED, DmEvent.DM_UNAVAILABLE).next, DmState.DM_UNAVAILABLE);
    assert.equal(applyDmEvent(DmState.DM_QUEUED, DmEvent.DM_FAILED).next, DmState.DM_FAILED);
  });

  test('a failed send may retry once through the queue', () => {
    assert.equal(applyDmEvent(DmState.DM_FAILED, DmEvent.DM_CONDITION_MET).next, DmState.DM_QUEUED);
  });
});

describe('the one-message lock', () => {
  test('a second request message is refused until answered', () => {
    const lead = { dmState: DmState.DM_SENT_REQUEST, relState: RelState.FOLLOWING };
    const result = canQueueDm(lead);
    assert.equal(result.ok, false);
    assert.match(result.reason, /one-message lock/);
  });

  test('the lock releases on follow-back or reply', () => {
    assert.equal(canQueueDm({ dmState: DmState.DM_SENT_REQUEST, relState: RelState.MUTUAL }).ok, true);
    assert.equal(canQueueDm({ dmState: DmState.DM_REPLIED, relState: RelState.FOLLOWING }).ok, false); // closed, not locked
  });

  test('do-not-contact wins over everything', () => {
    assert.equal(canQueueDm({ dmState: DmState.NONE, doNotContactReason: 'source_owner' }).ok, false);
  });
});

describe('cleanup eligibility', () => {
  const base = {
    relState: RelState.FOLLOWING,
    dmState: DmState.DM_SENT_REQUEST,
    followedViaExtension: true,
    followedAt: NOW - 6 * DAY,
  };

  test('a non-responder past grace is eligible', () => {
    assert.equal(isEligibleForCleanup(base, { now: NOW }).ok, true);
  });

  test('inside grace is not eligible', () => {
    assert.equal(isEligibleForCleanup({ ...base, followedAt: NOW - DAY }, { now: NOW }).ok, false);
  });

  test('the 48h floor cannot be configured away', () => {
    const result = isEligibleForCleanup({ ...base, followedAt: NOW - 10 * 3600000 }, { now: NOW, graceMs: 1000 });
    assert.equal(result.ok, false);
    assert.equal(MIN_UNFOLLOW_GRACE_MS, 48 * 3600000);
  });

  test('mutuals are left alone in non-responder mode', () => {
    assert.equal(isEligibleForCleanup({ ...base, relState: RelState.MUTUAL }, { now: NOW }).ok, false);
  });

  test('full-cycle mode needs the campaign marked finished', () => {
    const mutual = { ...base, relState: RelState.MUTUAL };
    assert.equal(isEligibleForCleanup(mutual, { now: NOW, mode: CleanupMode.FULL_CYCLE }).ok, false);
    assert.equal(isEligibleForCleanup(mutual, { now: NOW, mode: CleanupMode.FULL_CYCLE, campaignFinished: true }).ok, true);
  });

  test('repliers, whitelist, baseline and do-not-contact are protected', () => {
    assert.equal(isEligibleForCleanup({ ...base, dmState: DmState.DM_REPLIED }, { now: NOW }).ok, false);
    assert.equal(isEligibleForCleanup({ ...base, isWhitelisted: true }, { now: NOW }).ok, false);
    assert.equal(isEligibleForCleanup({ ...base, isProtectedBaseline: true }, { now: NOW }).ok, false);
    assert.equal(isEligibleForCleanup({ ...base, doNotContactReason: 'self' }, { now: NOW }).ok, false);
    assert.equal(isProtected({ ...base, dmState: DmState.DM_REPLIED }), true);
  });

  test('accounts this extension never followed are untouched', () => {
    assert.equal(isEligibleForCleanup({ ...base, followedViaExtension: false }, { now: NOW }).ok, false);
  });

  test('stale pending requests withdraw after the stale window', () => {
    const pending = { relState: RelState.FOLLOW_REQUESTED, followedViaExtension: true, followedAt: NOW - 12 * DAY };
    const result = isEligibleForCleanup(pending, { now: NOW, mode: CleanupMode.STALE_REQUESTS });
    assert.equal(result.ok, true);
    assert.equal(result.action, 'WITHDRAW_REQUEST');
    assert.equal(
      isEligibleForCleanup({ ...pending, followedAt: NOW - DAY }, { now: NOW, mode: CleanupMode.STALE_REQUESTS }).ok,
      false,
    );
  });
});
