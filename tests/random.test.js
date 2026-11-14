import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CURSOR_RING_SIZE, EntropyPoolRNG, fmix32 } from '../src/core/random.js';

const fixed = (seed = [1, 2, 3, 4]) => new EntropyPoolRNG({
  seed,
  clock: () => 1700000000000,
  microClock: () => 1234.5678,
});

describe('fmix32 avalanche', () => {
  test('flipping one input bit changes about half the output bits', () => {
    let total = 0;
    const samples = 4000;
    for (let i = 0; i < samples; i += 1) {
      const base = (i * 2654435761) >>> 0;
      const bit = 1 << (i % 32);
      const a = fmix32(base);
      const b = fmix32(base ^ bit);
      let diff = a ^ b;
      while (diff) { total += diff & 1; diff >>>= 1; }
    }
    const mean = total / samples;
    assert.ok(mean > 12 && mean < 20, `mean bit difference ${mean} is not avalanche`);
  });

  test('is a uint32 and stable', () => {
    assert.equal(fmix32(0), fmix32(0));
    assert.ok(fmix32(12345) <= 0xffffffff);
  });
});

describe('EntropyPoolRNG stream', () => {
  test('same seed and same clocks reproduce the same stream', () => {
    const a = fixed();
    const b = fixed();
    for (let i = 0; i < 500; i += 1) assert.equal(a.nextUint32(), b.nextUint32());
  });

  test('different seeds diverge immediately', () => {
    const a = fixed([1, 1, 1, 1]);
    const b = fixed([1, 1, 1, 2]);
    const draws = Array.from({ length: 8 }, () => a.nextUint32());
    const other = Array.from({ length: 8 }, () => b.nextUint32());
    assert.notDeepEqual(draws, other);
  });

  test('nextInt is uniform (chi-squared over 10 buckets)', () => {
    const rng = fixed([7, 7, 7, 7]);
    const buckets = new Array(10).fill(0);
    const draws = 100000;
    for (let i = 0; i < draws; i += 1) {
      const v = rng.nextInt(10);
      assert.ok(v >= 0 && v < 10);
      buckets[v] += 1;
    }
    const expected = draws / 10;
    const chi = buckets.reduce((sum, c) => sum + ((c - expected) ** 2) / expected, 0);
    // 9 degrees of freedom: 16.92 at p=0.05, 21.67 at p=0.01.
    assert.ok(chi < 21.67, `chi-squared ${chi.toFixed(2)} rejects uniformity`);
  });

  test('nextInt respects inclusive ranges and degenerate input', () => {
    const rng = fixed();
    for (let i = 0; i < 2000; i += 1) {
      const v = rng.nextInRange(3, 7);
      assert.ok(v >= 3 && v <= 7);
    }
    assert.equal(rng.nextInRange(5, 5), 5);
    assert.equal(rng.nextInt(0), 0);
    assert.equal(rng.nextInt(-4), 0);
  });

  test('a frozen cursor and frozen clocks still produce varying draws', () => {
    // The hands-free failure mode: autopilot running with nobody at the desk,
    // so cursor, wall clock and sub-millisecond clock are all constant. The
    // draw counter must keep the stream moving on its own.
    const rng = fixed();
    for (let i = 0; i < CURSOR_RING_SIZE; i += 1) rng.recordCursor(0, 0, 0, 0, 0);
    const draws = new Set();
    for (let i = 0; i < 500; i += 1) draws.add(rng.nextUint32());
    assert.equal(draws.size, 500, 'draws repeated with every entropy source frozen');
  });

  test('cursor movement changes the digest', () => {
    const a = fixed();
    const b = fixed();
    for (let i = 0; i < 10; i += 1) a.recordCursor(i, i * 2);
    assert.notEqual(a.cursorDigest(), b.cursorDigest());
  });

  test('anti-streak refuses the recent window until the pool is exhausted', () => {
    const rng = fixed();
    const pool = ['a', 'b', 'c', 'd'];
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) seen.add(rng.pickWithAntiStreak(pool, ['a', 'b'], (x) => x));
    assert.deepEqual([...seen].sort(), ['c', 'd']);
    // When everything is recent the caller still gets an answer.
    assert.ok(pool.includes(rng.pickWithAntiStreak(pool, pool)));
    assert.equal(rng.pickWithAntiStreak([]), undefined);
  });

  test('log-normal delays stay inside the requested bounds', () => {
    const rng = fixed();
    for (let i = 0; i < 3000; i += 1) {
      const ms = rng.nextLogNormalMs({ minSec: 45, maxSec: 150 });
      assert.ok(ms >= 45000 && ms <= 150000, `delay ${ms} outside bounds`);
    }
  });

  test('log-normal delays are skewed, not uniform', () => {
    const rng = fixed([3, 3, 3, 3]);
    const draws = Array.from({ length: 4000 }, () => rng.nextLogNormalMs({ minSec: 45, maxSec: 150 }) / 1000);
    const mean = draws.reduce((s, v) => s + v, 0) / draws.length;
    const median = [...draws].sort((a, b) => a - b)[2000];
    // A log-normal over these bounds has median below mean only when the tail
    // is on the right; here clamping puts the mode low: median < arithmetic mid.
    assert.ok(median < 90, `median ${median} looks uniform, not skewed`);
    assert.ok(mean > median, 'mean should sit above the median for a right skew');
  });
});
