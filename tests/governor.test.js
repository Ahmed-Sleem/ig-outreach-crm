import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionType,
  FOLLOWING_PAUSE_AT,
  HARD_CEILINGS,
  MAX_ACTIVE_MINUTES_PER_DAY,
  buildWeek,
  canExecute,
  clampLimits,
  clockOf,
  countersFor,
  initialGovernorState,
  minuteOfDay,
  parseSchedule,
  planNextDelay,
  recordAction,
  scheduleJitter,
  scheduleState,
  tripCircuitBreaker,
  warmupFactor,
} from '../src/core/governor.js';
import { EntropyPoolRNG } from '../src/core/random.js';

const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi, 0, 0);
const settings = (over = {}) => ({
  scheduleEnabled: true,
  schedule: { activeStartLocal: '09:30', activeEndLocal: '22:30', dailyDriftMinutes: 0, warmupRampEnabled: false },
  limits: { trustPreset: 'balanced' },
  ...over,
});

describe('clock helpers', () => {
  test('minuteOfDay and clockOf round-trip', () => {
    assert.equal(minuteOfDay('09:30'), 570);
    assert.equal(clockOf(570), '09:30');
    assert.equal(clockOf(1440 + 90), '01:30');
    assert.equal(minuteOfDay('25:00'), null);
    assert.equal(minuteOfDay('nope'), null);
  });
});

describe('parseSchedule', () => {
  test('accepts a well-formed week, including overnight windows', () => {
    const week = parseSchedule({ mon: [['09:00', '17:00']], fri: [['22:00', '02:00']] });
    assert.equal(week.ok, true);
    assert.deepEqual(week.days[1], [[540, 1020]]);
    assert.deepEqual(week.days[5], [[1320, 120]]);
  });

  test('refuses what it cannot read, with a reason per problem', () => {
    const week = parseSchedule({
      monday: [['09:00', '17:00']],
      tue: '09:00',
      wed: [['09:00']],
      thu: [['09:00', '09:00']],
      fri: [['ab:cd', '17:00']],
    });
    assert.equal(week.ok, false);
    assert.equal(week.errors.length, 5);
  });

  test('an empty or missing schedule is valid and open', () => {
    assert.equal(parseSchedule(null).ok, true);
    assert.equal(parseSchedule(undefined).days.length, 7);
  });
});

describe('the 14-hour active cap', () => {
  test('a 24/7 window is shortened and reported', () => {
    const week = buildWeek({ activeStartLocal: '00:00', activeEndLocal: '23:59' });
    assert.equal(week.clamped, true);
    assert.equal(week.days[0][0][1] - week.days[0][0][0], MAX_ACTIVE_MINUTES_PER_DAY);
  });

  test('an ordinary window passes untouched', () => {
    const week = buildWeek({ activeStartLocal: '09:30', activeEndLocal: '22:30' });
    assert.equal(week.clamped, false);
    assert.equal(week.days[0][0][1] - week.days[0][0][0], 780);
  });

  test('a nonsense window is an error, never a value', () => {
    assert.equal(buildWeek({ activeStartLocal: 'xx', activeEndLocal: '22:30' }).ok, false);
    assert.equal(buildWeek({ activeStartLocal: '09:00', activeEndLocal: '09:00' }).ok, false);
  });
});

describe('scheduleState', () => {
  test('closed outside the window, open inside it', () => {
    assert.equal(scheduleState(settings(), at(2026, 10, 2, 8, 0), 'w').open, false);
    assert.equal(scheduleState(settings(), at(2026, 10, 2, 12, 0), 'w').open, true);
    assert.equal(scheduleState(settings(), at(2026, 10, 2, 23, 0), 'w').open, false);
  });

  test('an overnight window is still open after midnight', () => {
    const s = settings({ schedule: { activeStartLocal: '22:00', activeEndLocal: '02:00', dailyDriftMinutes: 0 } });
    const state = scheduleState(s, at(2026, 10, 2, 1, 15), 'w');
    assert.equal(state.open, true);
    assert.equal(state.window.from, '22:00');
    assert.equal(state.window.to, '02:00');
  });

  test('midnight wraparound: the next opening after 23:59 is tomorrow', () => {
    const state = scheduleState(settings(), at(2026, 10, 1, 23, 59), 'w');
    assert.equal(state.open, false);
    const next = new Date(state.next.opensAt);
    assert.equal(next.getDate(), 2);
    assert.equal(clockOf(next.getHours() * 60 + next.getMinutes()), '09:30');
  });

  test('a broken week fails closed instead of failing dark', () => {
    const s = settings({ schedule: { days: { mon: [['09:00', '09:00']] } } });
    const state = scheduleState(s, at(2026, 10, 2, 12, 0), 'w');
    assert.equal(state.open, false);
    assert.equal(state.broken, true);
    assert.ok(state.errors.length > 0);
  });

  test('a disabled schedule is open: the question is "may it act"', () => {
    assert.equal(scheduleState(settings({ scheduleEnabled: false }), at(2026, 10, 2, 3, 0), 'w').open, true);
  });
});

describe('daily jitter', () => {
  test('is stable for one workspace and window, and within the drift', () => {
    const start = at(2026, 10, 2, 9, 30).getTime();
    const a = scheduleJitter(20, 'w1', start);
    assert.equal(scheduleJitter(20, 'w1', start), a);
    assert.ok(a >= 0 && a <= 20);
  });

  test('spreads workspaces out', () => {
    const start = at(2026, 10, 2, 9, 30).getTime();
    const values = new Set(['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].map((w) => scheduleJitter(20, w, start)));
    assert.ok(values.size > 1, 'every workspace opens at the same minute');
  });

  test('zero drift means zero jitter', () => {
    assert.equal(scheduleJitter(0, 'w1', 123), 0);
  });
});

describe('warm-up ramp', () => {
  test('40% on day one, +10% per clean day, 100% from day seven', () => {
    assert.equal(warmupFactor(1).toFixed(2), '0.40');
    assert.equal(warmupFactor(4).toFixed(2), '0.70');
    assert.equal(warmupFactor(7), 1);
    assert.equal(warmupFactor(30), 1);
  });

  test('after a breaker the ramp restarts at 25%', () => {
    assert.equal(warmupFactor(1, { postBreaker: true }).toFixed(2), '0.25');
  });

  test('opting out of warm-up runs at full caps', () => {
    assert.equal(warmupFactor(1, { enabled: false }), 1);
  });
});

describe('clamping', () => {
  test('no stored value can exceed a hard ceiling', () => {
    const { limits, clamped } = clampLimits({
      trustPreset: 'custom',
      followsPerDay: 9999,
      coldInvitesPerDay: 500,
      minActionDelaySec: 1,
    });
    assert.equal(limits.followsPerDay, HARD_CEILINGS.followsPerDay);
    assert.equal(limits.coldInvitesPerDay, HARD_CEILINGS.coldInvitesPerDay);
    assert.equal(limits.minActionDelaySec, HARD_CEILINGS.minActionDelaySec);
    assert.deepEqual(clamped.sort(), ['coldInvitesPerDay', 'followsPerDay', 'minActionDelaySec']);
  });

  test('max delay never sits below min delay', () => {
    const { limits } = clampLimits({ trustPreset: 'custom', minActionDelaySec: 300, maxActionDelaySec: 40 });
    assert.equal(limits.maxActionDelaySec, 300);
  });
});

describe('canExecute', () => {
  const ctx = (over = {}) => ({ settings: settings(), governorState: initialGovernorState(), now: at(2026, 10, 2, 12, 0), ...over });

  test('allowed inside the window with fresh counters', () => {
    assert.equal(canExecute(ActionType.FOLLOW, ctx()).ok, true);
  });

  test('a tripped breaker locks writes for 48 hours, persisted', () => {
    const state = tripCircuitBreaker(initialGovernorState(), 'feedback_required', at(2026, 10, 2, 12, 0));
    const locked = canExecute(ActionType.FOLLOW, ctx({ governorState: state, now: at(2026, 10, 4, 11, 0) }));
    assert.equal(locked.ok, false);
    assert.equal(locked.reason, 'circuit breaker');
    const free = canExecute(ActionType.FOLLOW, ctx({ governorState: state, now: at(2026, 10, 4, 13, 0) }));
    assert.equal(free.ok, true);
  });

  test('a challenge lock is 24 hours', () => {
    const state = tripCircuitBreaker(initialGovernorState(), 'challenge_required', at(2026, 10, 2, 12, 0), 'challenge');
    assert.equal(canExecute(ActionType.FOLLOW, ctx({ governorState: state, now: at(2026, 10, 3, 13, 0) })).ok, true);
  });

  test('outside the active window the answer names the next opening', () => {
    const result = canExecute(ActionType.FOLLOW, ctx({ now: at(2026, 10, 2, 23, 30) }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'outside the active window');
    assert.ok(result.opensAt > 0);
  });

  test('spacing is honoured with the wait it owes', () => {
    const now = at(2026, 10, 2, 12, 0);
    const result = canExecute(ActionType.FOLLOW, ctx({ now, nextEligibleAt: now.getTime() + 60000 }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'spacing');
    assert.equal(result.waitMs, 60000);
  });

  test('the hourly follow cap stops the tenth follow of the hour', () => {
    const state = initialGovernorState();
    const now = at(2026, 10, 2, 12, 0);
    for (let i = 0; i < 10; i += 1) recordAction(state, ActionType.FOLLOW, now);
    const result = canExecute(ActionType.FOLLOW, ctx({ governorState: state, now }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /hourly follow cap/);
    // Unfollows have their own hourly bucket.
    assert.equal(canExecute(ActionType.UNFOLLOW, ctx({ governorState: state, now })).ok, true);
  });

  test('the daily cap is scaled by the warm-up factor', () => {
    // Day one at 40% of 50 is 20 follows, not 50.
    const state = initialGovernorState();
    const now = at(2026, 10, 2, 12, 0);
    for (let h = 8; h < 12; h += 1) {
      for (let i = 0; i < 5; i += 1) recordAction(state, ActionType.FOLLOW, at(2026, 10, 2, h, 0));
    }
    const result = canExecute(ActionType.FOLLOW, ctx({ governorState: state, now, settings: settings({ schedule: { activeStartLocal: '07:00', activeEndLocal: '22:30', dailyDriftMinutes: 0, warmupRampEnabled: true } }) }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /daily follow cap/);
  });

  test('follows and unfollows share one mutation budget', () => {
    const state = initialGovernorState();
    const now = at(2026, 10, 2, 12, 0);
    const warm = settings({ schedule: { activeStartLocal: '06:00', activeEndLocal: '22:30', dailyDriftMinutes: 0, warmupRampEnabled: true } });
    // Day one spends 40% of the 75 combined cap: 30 mutations, here split
    // evenly between the two action types so neither private cap is touched.
    for (let h = 6; h < 12; h += 1) {
      for (let i = 0; i < 3; i += 1) recordAction(state, ActionType.FOLLOW, at(2026, 10, 2, h, 0));
      for (let i = 0; i < 2; i += 1) recordAction(state, ActionType.UNFOLLOW, at(2026, 10, 2, h, 30));
    }
    assert.match(canExecute(ActionType.UNFOLLOW, ctx({ governorState: state, now, settings: warm })).reason, /shared/);
    assert.match(canExecute(ActionType.FOLLOW, ctx({ governorState: state, now, settings: warm })).reason, /shared/);
    // The same counters do not block messaging, which has its own budget.
    assert.equal(canExecute(ActionType.DM_WARM, ctx({ governorState: state, now, settings: warm })).ok, true);
  });

  test('cold invites carry their own strict sub-cap', () => {
    const state = initialGovernorState();
    const now = at(2026, 10, 2, 12, 0);
    for (let i = 0; i < 3; i += 1) recordAction(state, ActionType.DM_COLD, now);
    assert.equal(canExecute(ActionType.DM_COLD, ctx({ governorState: state, now })).ok, false);
    assert.equal(canExecute(ActionType.DM_WARM, ctx({ governorState: state, now })).ok, true);
  });

  test('the follow queue pauses at the platform following cap', () => {
    const result = canExecute(ActionType.FOLLOW, ctx({ followingCount: FOLLOWING_PAUSE_AT }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /platform cap/);
  });
});

describe('counters', () => {
  test('a new day resets daily counters and advances the ramp', () => {
    const state = initialGovernorState();
    recordAction(state, ActionType.FOLLOW, at(2026, 10, 2, 12, 0));
    assert.equal(state.daily.follows, 1);
    countersFor(state, at(2026, 10, 3, 9, 0));
    assert.equal(state.daily.follows, 0);
    assert.equal(state.warmupDay, 2);
  });

  test('the first touch of the counters is not a day change', () => {
    const state = initialGovernorState();
    countersFor(state, at(2026, 10, 2, 12, 0));
    assert.equal(state.warmupDay, 1);
  });
});

describe('delay shape', () => {
  test('stays inside the configured bounds when no pause applies', () => {
    const rng = new EntropyPoolRNG({ seed: [2, 2, 2, 2], clock: () => 1, microClock: () => 0.25 });
    for (let i = 0; i < 300; i += 1) {
      const { ms } = planNextDelay({ settings: settings(), rng, actionsSinceBreak: 0 });
      // Bounds plus the largest possible distraction (180 s).
      assert.ok(ms >= 75000 && ms <= 190000 + 180000, `delay ${ms} out of shape`);
    }
  });

  test('a break is scheduled at the end of a work set', () => {
    const rng = new EntropyPoolRNG({ seed: [6, 6, 6, 6], clock: () => 1, microClock: () => 0.25 });
    const { ms, kind, breakEvery } = planNextDelay({ settings: settings(), rng, actionsSinceBreak: breakAt(rng) });
    function breakAt(r) { return 100; }
    assert.equal(kind, 'break');
    assert.ok(ms > 6 * 60000);
    assert.ok(breakEvery >= 8 && breakEvery <= 12);
  });
});
