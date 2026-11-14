import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AccountFlagged,
  DEFAULT_PACING,
  PACING_FLOOR,
  Pacer,
  PacingLimit,
  PacingStopped,
  clampPacing,
  classifyResponse,
  estimateDuration,
  humanDuration,
  interruptibleWait,
  retryAfterMs,
} from '../src/content/pacing.js';

/** A clock the test drives, so nothing here depends on real time. */
function fakeClock({ hidden = false } = {}) {
  const clock = { t: 0, sleeps: [], hidden, events: [] };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => { clock.sleeps.push(ms); clock.t += ms; };
  clock.isHidden = () => clock.hidden;
  return clock;
}

function makePacer(clock, options = {}) {
  const pacer = new Pacer({ now: clock.now, sleep: clock.sleep, isHidden: clock.isHidden, ...options });
  pacer.onStatus((status) => clock.events.push(status));
  return pacer;
}

/** Deterministic "random": returns the values in order, then 0.5 forever. */
function scripted(values) {
  let index = 0;
  return () => (index < values.length ? values[index++] : 0.5);
}

const headersWith = (name, value) => ({ get: (key) => (key.toLowerCase() === name ? value : null) });

describe('clampPacing', () => {
  test('the floor cannot be negotiated away', () => {
    const result = clampPacing({ minDelayMs: 0, perMinuteCap: 600, perSessionCap: 100000 });
    assert.equal(result.minDelayMs, PACING_FLOOR.minDelayMs);
    assert.equal(result.perMinuteCap, PACING_FLOOR.perMinuteCap);
    assert.equal(result.perSessionCap, PACING_FLOOR.perSessionCap);
    assert.ok(result.notes.length >= 3);
  });

  test('an inverted range is repaired, not honoured', () => {
    const result = clampPacing({ minDelayMs: 9000, maxDelayMs: 2000 });
    assert.equal(result.maxDelayMs, result.minDelayMs);
    assert.ok(result.notes.some((n) => /below the minimum/.test(n)));
  });

  test('garbage falls back to defaults', () => {
    const result = clampPacing({ minDelayMs: NaN, perMinuteCap: 'fast', perSessionCap: null });
    assert.equal(result.minDelayMs, DEFAULT_PACING.minDelayMs);
    assert.equal(result.perMinuteCap, DEFAULT_PACING.perMinuteCap);
    assert.equal(result.perSessionCap, DEFAULT_PACING.perSessionCap);
  });

  test('defaults are already inside the guard rails', () => {
    const result = clampPacing({});
    assert.ok(result.minDelayMs >= PACING_FLOOR.minDelayMs);
    assert.ok(result.perMinuteCap <= PACING_FLOOR.perMinuteCap);
    assert.ok(result.perSessionCap <= PACING_FLOOR.perSessionCap);
    assert.deepEqual(result.notes, []);
  });
});

describe('classifyResponse', () => {
  test('account flags stop the session even on a 200', () => {
    for (const [body, reason] of [
      [{ message: 'feedback_required' }, 'feedback_required'],
      [{ message: 'challenge_required' }, 'challenge_required'],
      [{ message: 'checkpoint_required' }, 'checkpoint_required'],
      [{ spam: true }, 'spam_true'],
    ]) {
      const verdict = classifyResponse({ status: 200, body });
      assert.equal(verdict.action, 'abort-session', reason);
      assert.equal(verdict.severity, 'account', reason);
      assert.equal(verdict.reason, reason);
      assert.ok(verdict.message.length > 20);
    }
  });

  test('a stringified body is inspected too', () => {
    assert.equal(classifyResponse({ status: 200, body: '{"message":"feedback_required"}' }).action, 'abort-session');
  });

  test('a missing session is an auth stop, not a rate limit', () => {
    assert.equal(classifyResponse({ status: 401, body: {} }).severity, 'auth');
    assert.equal(classifyResponse({ status: 200, body: { message: 'login_required' } }).severity, 'auth');
  });

  test('429 backs off and carries Retry-After', () => {
    const verdict = classifyResponse({ status: 429, body: {}, headers: headersWith('retry-after', '30') });
    assert.equal(verdict.action, 'backoff');
    assert.equal(verdict.severity, 'rate');
    assert.equal(verdict.retryAfterMs, 30000);
  });

  test('403 stops rather than retrying into a harder block', () => {
    const verdict = classifyResponse({ status: 403, body: {} });
    assert.equal(verdict.action, 'abort-session');
    assert.equal(verdict.severity, 'blocked');
  });

  test('400 is a stale signature: try the next candidate', () => {
    const verdict = classifyResponse({ status: 400, body: {} });
    assert.equal(verdict.action, 'next-candidate');
    assert.equal(verdict.severity, 'none');
  });

  test('5xx retries, 2xx is ok, anything else is unknown', () => {
    assert.equal(classifyResponse({ status: 503, body: {} }).action, 'retry');
    assert.equal(classifyResponse({ status: 200, body: {} }).action, 'ok');
    assert.equal(classifyResponse({ status: 418, body: {} }).action, 'retry');
    assert.equal(classifyResponse({}).severity, 'unknown');
  });

  test('retryAfterMs reads both delta-seconds and HTTP-date forms', () => {
    assert.equal(retryAfterMs({ headers: headersWith('retry-after', '12') }), 12000);
    assert.equal(retryAfterMs({ headers: headersWith('retry-after', '0') }), 0);
    assert.equal(retryAfterMs({ headers: headersWith('retry-after', 'nonsense') }), null);
    assert.equal(retryAfterMs({}), null);
    const future = new Date(Date.now() + 60000).toUTCString();
    const delta = retryAfterMs({ headers: headersWith('retry-after', future) });
    assert.ok(delta > 50000 && delta <= 61000, `got ${delta}`);
  });

  test('an AccountFlagged error carries the verdict to the UI', () => {
    const verdict = classifyResponse({ status: 200, body: { message: 'feedback_required' } });
    const error = new AccountFlagged(verdict);
    assert.equal(error.reason, 'feedback_required');
    assert.equal(error.severity, 'account');
    assert.equal(error.userFacing, true);
  });
});

describe('Pacer.waitForSlot', () => {
  test('each slot consumes the session budget and emits its delay', async () => {
    const clock = fakeClock();
    const pacer = makePacer(clock, { random: () => 0, jitter: true, longPauseChance: 0, minDelayMs: 2000, maxDelayMs: 2000, pauseWhenHidden: false });
    await pacer.waitForSlot();
    await pacer.waitForSlot();
    assert.equal(pacer.sessionCount, 2);
    assert.equal(pacer.remainingInSession, pacer.opts.perSessionCap - 2);
    assert.deepEqual(clock.sleeps, [2000, 2000]);
    assert.deepEqual(clock.events.map((e) => e.type), ['pacing', 'pacing']);
  });

  test('a stopped pacer refuses to hand out another slot', async () => {
    const clock = fakeClock();
    const pacer = makePacer(clock, { pauseWhenHidden: false });
    pacer.stop();
    await assert.rejects(() => pacer.waitForSlot(), PacingStopped);
    assert.deepEqual(clock.events.map((e) => e.type), ['stopped']);
  });

  test('the session cap throws a user-facing limit, not a hang', async () => {
    const clock = fakeClock();
    const pacer = makePacer(clock, { perSessionCap: 2, pauseWhenHidden: false, random: () => 0, minDelayMs: 1000, maxDelayMs: 1000 });
    await pacer.waitForSlot();
    await pacer.waitForSlot();
    await assert.rejects(() => pacer.waitForSlot(), (error) => {
      assert.ok(error instanceof PacingLimit);
      assert.equal(error.userFacing, true);
      assert.match(error.message, /Session cap reached/);
      return true;
    });
  });

  test('the per-minute cap throttles on a sliding window', async () => {
    const clock = fakeClock();
    const pacer = makePacer(clock, { perMinuteCap: 2, pauseWhenHidden: false, random: () => 0, minDelayMs: 1000, maxDelayMs: 1000 });
    await pacer.waitForSlot();
    await pacer.waitForSlot();
    await pacer.waitForSlot();
    const throttled = clock.events.filter((e) => e.type === 'throttled');
    assert.equal(throttled.length, 1);
    assert.ok(throttled[0].waitMs > 50000, `waited ${throttled[0].waitMs}`);
  });

  test('a hidden tab pauses, but only for the bounded grace', async () => {
    const clock = fakeClock({ hidden: true });
    const pacer = makePacer(clock, { hiddenGraceMs: 3000, pauseWhenHidden: true, random: () => 0, minDelayMs: 1000, maxDelayMs: 1000 });
    await pacer.waitForSlot();
    assert.deepEqual(clock.events.map((e) => e.type), ['paused', 'resumed', 'pacing']);
    assert.equal(clock.events[1].hiddenMs >= 3000, true);
    assert.match(clock.events[1].note, /background/);
    assert.equal(pacer.sessionCount, 1);
  });

  test('the hidden grace is wall-clock, not a loop count', async () => {
    const clock = fakeClock({ hidden: true });
    // Chrome throttles a hidden tab: each 1000ms sleep really takes 60000ms.
    clock.sleep = async (ms) => { clock.sleeps.push(ms); clock.t += 60000; };
    const pacer = makePacer(clock, { hiddenGraceMs: 20000, pauseWhenHidden: true, random: () => 0, minDelayMs: 1000, maxDelayMs: 1000 });
    await pacer.waitForSlot();
    const hiddenSleeps = clock.sleeps.filter((ms) => ms === 1000);
    assert.equal(hiddenSleeps.length, 1, `grace looped ${hiddenSleeps.length} times under throttling`);
  });

  test('becoming visible ends the pause immediately', async () => {
    const clock = fakeClock({ hidden: true });
    let ticks = 0;
    clock.sleep = async (ms) => { clock.sleeps.push(ms); clock.t += ms; ticks += 1; if (ticks === 2) clock.hidden = false; };
    const pacer = makePacer(clock, { hiddenGraceMs: 60000, pauseWhenHidden: true, random: () => 0, minDelayMs: 1000, maxDelayMs: 1000 });
    await pacer.waitForSlot();
    assert.equal(clock.events.filter((e) => e.type === 'paused').length, 1);
    assert.ok(clock.t < 10000);
  });

  test('stopping during a hidden pause throws rather than continuing', async () => {
    const clock = fakeClock({ hidden: true });
    let pacer = null;
    // The stop lands inside the first hidden-pause tick: the pacer must not go
    // on to spend a delay and issue the request anyway.
    clock.sleep = async (ms) => { clock.sleeps.push(ms); clock.t += ms; pacer.stop(); };
    pacer = makePacer(clock, { hiddenGraceMs: 60000, pauseWhenHidden: true });
    await assert.rejects(() => pacer.waitForSlot(), PacingStopped);
    assert.equal(clock.events.some((e) => e.type === 'paused'), true);
  });
});

describe('Pacer delays and backoff', () => {
  test('jitter stays inside the configured range', () => {
    const pacer = new Pacer({ minDelayMs: 2000, maxDelayMs: 6000, longPauseChance: 0, random: scripted([0.5, 0.9]) });
    const delay = pacer.nextDelay();
    assert.ok(delay >= 2000 && delay <= 6000, `got ${delay}`);
  });

  test('the occasional long pause is what makes the pattern human', () => {
    const pacer = new Pacer({ minDelayMs: 2000, maxDelayMs: 3000, longPauseChance: 1, longPauseMinMs: 5000, longPauseMaxMs: 15000, random: scripted([0.5, 0.5, 0.5]) });
    const delay = pacer.nextDelay();
    assert.ok(delay >= 2000 + 5000, `got ${delay}`);
    assert.ok(delay <= 3000 + 15000, `got ${delay}`);
  });

  test('no jitter means the minimum, exactly', () => {
    const pacer = new Pacer({ minDelayMs: 3000, jitter: false });
    assert.equal(pacer.nextDelay(), 3000);
  });

  test('backoff doubles, jitters and is capped', async () => {
    const clock = fakeClock();
    const pacer = makePacer(clock, { backoffBaseMs: 5000, backoffMaxMs: 300000, random: () => 0 });
    const first = await pacer.backoff(0);
    const third = await pacer.backoff(3);
    const huge = await pacer.backoff(30);
    assert.equal(first, 2500);
    assert.equal(third, 20000);
    assert.equal(huge, 150000);
  });

  test('Retry-After outranks the computed backoff but is still capped', async () => {
    const clock = fakeClock();
    const pacer = makePacer(clock, { backoffBaseMs: 5000, backoffMaxMs: 60000, random: () => 0 });
    assert.equal(await pacer.backoff(0, 30000), 30000);
    assert.equal(await pacer.backoff(0, 900000), 60000);
    assert.equal(clock.events.filter((e) => e.honouredRetryAfter).length, 2);
  });

  test('an account flag stops the pacer through noteError', () => {
    const clock = fakeClock();
    const pacer = makePacer(clock);
    const mustAbort = pacer.noteError(classifyResponse({ status: 200, body: { message: 'feedback_required' } }));
    assert.equal(mustAbort, true);
    assert.equal(pacer.stopped, true);
    assert.equal(clock.events.at(-1).type, 'aborted');
    assert.equal(clock.events.at(-1).severity, 'account');
  });

  test('a bare status code is still understood', () => {
    const pacer = new Pacer({});
    assert.equal(pacer.noteError(429), true);
    assert.equal(pacer.stopped, false);
  });

  test('success clears the consecutive error count', () => {
    const pacer = new Pacer({ cooldownAfterErrors: 3 });
    pacer.noteError(500);
    pacer.noteError(500);
    pacer.noteSuccess();
    assert.equal(pacer.consecutiveErrors, 0);
    assert.equal(pacer.noteError(500), false);
    pacer.noteError(500);
    assert.equal(pacer.noteError(500), true);
  });

  test('a broken status listener never aborts a scan', () => {
    const pacer = new Pacer({});
    pacer.onStatus(() => { throw new Error('listener bug'); });
    let sawStatus = false;
    pacer.onStatus(() => { sawStatus = true; });
    pacer.stop();
    assert.equal(sawStatus, true);
    assert.equal(pacer.stopped, true);
  });
});

describe('estimates', () => {
  test('a scan cost is estimated before it starts', () => {
    const estimate = estimateDuration(100, { minDelayMs: 2000, maxDelayMs: 4000, longPauseChance: 0 });
    assert.ok(estimate.estimatedMs >= 300_000 && estimate.estimatedMs <= 420_000, `got ${estimate.estimatedMs}`);
    assert.equal(estimate.requestCount, 100);
    assert.match(estimate.humanReadable, /min/);
  });

  test('an estimate larger than the session cap is flagged', () => {
    const estimate = estimateDuration(5000, { perSessionCap: 300 });
    assert.equal(estimate.exceedsSessionCap, true);
    assert.equal(estimateDuration(10, {}).exceedsSessionCap, false);
  });

  test('estimates are rendered for humans', () => {
    assert.equal(humanDuration(45_000), '45 sec');
    assert.equal(humanDuration(5 * 60_000), '5 min');
    assert.equal(humanDuration(90_000), '1 min 30 sec');
    assert.equal(humanDuration(3_600_000), '1 hr 0 min');
    assert.equal(humanDuration(0), '0 sec');
  });
});

describe('interruptibleWait', () => {
  test('it returns once the wall-clock deadline has passed', async () => {
    const clock = fakeClock();
    const result = await interruptibleWait(3000, { now: clock.now, sleep: clock.sleep });
    assert.equal(result.completed, true);
    assert.equal(result.waitedMs, 3000);
    assert.deepEqual(clock.sleeps, [1000, 1000, 1000]);
  });

  test('no tick is longer than a second, so a stop lands quickly', async () => {
    const clock = fakeClock();
    await interruptibleWait(2500, { now: clock.now, sleep: clock.sleep });
    assert.ok(clock.sleeps.every((ms) => ms <= 1000), JSON.stringify(clock.sleeps));
    assert.equal(clock.sleeps.at(-1), 500);
  });

  test('an already-aborted signal does not wait at all', async () => {
    const clock = fakeClock();
    await assert.rejects(() => interruptibleWait(60000, { signal: { aborted: true }, now: clock.now, sleep: clock.sleep }), PacingStopped);
    assert.deepEqual(clock.sleeps, []);
  });

  test('aborting mid-wait throws immediately', async () => {
    const clock = fakeClock();
    const signal = { aborted: false };
    let ticks = 0;
    clock.sleep = async (ms) => { clock.t += ms; ticks += 1; if (ticks === 2) signal.aborted = true; };
    await assert.rejects(() => interruptibleWait(600000, { signal, now: clock.now, sleep: clock.sleep }), PacingStopped);
    assert.equal(ticks, 2);
  });

  test('a throttled clock still spends the right amount of wall time', async () => {
    const clock = fakeClock();
    clock.sleep = async (ms) => { clock.sleeps.push(ms); clock.t += ms * 60; };
    const result = await interruptibleWait(5000, { now: clock.now, sleep: clock.sleep });
    assert.equal(result.completed, true);
    assert.equal(clock.sleeps.length, 1);
  });

  test('a zero or negative wait completes at once', async () => {
    const clock = fakeClock();
    const result = await interruptibleWait(0, { now: clock.now, sleep: clock.sleep });
    assert.equal(result.completed, true);
    assert.deepEqual(clock.sleeps, []);
  });
});
