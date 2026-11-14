/**
 * EntropyPoolRNG — the only random source in the product.
 *
 * Why not Math.random(): a campaign that spaces its actions with the platform
 * default PRNG produces intervals a detector can model, and a hands-free run
 * (autopilot on, desk empty) has no human input at all to vary them. This
 * engine mixes four independent sources before every draw:
 *
 *   1. a 128-bit seed from the OS CSPRNG at construction;
 *   2. a 64-event ring buffer of passive cursor positions, digested so that a
 *      frozen cursor (all zeros) still avalanches instead of collapsing;
 *   3. the wall clock and its sub-millisecond fraction;
 *   4. a monotonically increasing draw counter.
 *
 * The stream itself is sfc32 and the digest is the MurmurHash3 finaliser, both
 * adapted from bryc/code (public domain, MIT fallback). Neither is used for
 * anything security-critical — the goal is unmodellable rhythm, not secrecy.
 *
 * Pure: no browser APIs. Clocks and the byte source are injectable so tests
 * can be deterministic.
 */

/** MurmurHash3 32-bit finaliser. One-bit input change flips ~half the output. */
export function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

/** How many cursor events the pool remembers. */
export const CURSOR_RING_SIZE = 64;

const UINT32 = 4294967296;

function defaultMicroClock() {
  const p = globalThis.performance;
  return p && typeof p.now === 'function' ? p.now() : Date.now();
}

function defaultRandomWords(count) {
  const out = new Uint32Array(count);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(out);
  } else {
    for (let i = 0; i < count; i += 1) out[i] = Math.floor(Math.random() * UINT32);
  }
  return out;
}

export class EntropyPoolRNG {
  /**
   * @param {{seed?: Uint32Array|number[], clock?: () => number,
   *          microClock?: () => number, randomWords?: (n: number) => Uint32Array}} options
   */
  constructor(options = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.microClock = options.microClock ?? defaultMicroClock;
    const randomWords = options.randomWords ?? defaultRandomWords;

    this.cursorRing = new Uint32Array(CURSOR_RING_SIZE);
    this.cursorIndex = 0;
    this.cursorCount = 0;
    this.drawCounter = 0;

    const seed = options.seed ?? randomWords(4);
    this.a = seed[0] >>> 0;
    this.b = seed[1] >>> 0;
    this.c = seed[2] >>> 0;
    this.d = seed[3] >>> 0;

    // Warm-up: the first sfc32 outputs still carry visible seed structure.
    for (let i = 0; i < 15; i += 1) this.step();
  }

  /** One sfc32 round over the instance state. Returns a uint32. */
  step() {
    let { a, b, c, d } = this;
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (a + b | 0) + d | 0;
    d = d + 1 | 0;
    a = b ^ (b >>> 9);
    b = c + (c << 3) | 0;
    c = (c << 21) | (c >>> 11);
    c = c + t | 0;
    this.a = a; this.b = b; this.c = c; this.d = d;
    return t >>> 0;
  }

  /**
   * Feed a passive pointer sample into the pool. Called from a pointermove
   * listener in the dashboard; never blocks, never allocates past the ring.
   */
  recordCursor(x, y, screenX = x, screenY = y, perfNow = this.microClock()) {
    const mixed = fmix32(
      (Math.round(x) ^ Math.imul(Math.round(y), 0x9e3779b1)
        ^ Math.imul(Math.round(screenX), 0x85ebca6b)
        ^ Math.imul(Math.round(screenY), 0xc2b2ae35)
        ^ Math.round(perfNow)) | 0,
    );
    this.cursorRing[this.cursorIndex] = mixed;
    this.cursorIndex = (this.cursorIndex + 1) % CURSOR_RING_SIZE;
    this.cursorCount += 1;
  }

  /** Digest of the cursor ring. A frozen cursor still changes the digest. */
  cursorDigest() {
    let h = 0x811c9dc5;
    for (let i = 0; i < CURSOR_RING_SIZE; i += 1) {
      h = Math.imul(h ^ this.cursorRing[i], 0x01000193) >>> 0;
    }
    return fmix32(h ^ this.cursorCount);
  }

  /** The four sources, folded into one word. */
  liveEntropy() {
    const micro = this.microClock();
    const fraction = Math.floor((micro % 1) * 1e9);
    return fmix32(
      this.cursorDigest()
        ^ fmix32(this.clock() | 0)
        ^ fmix32(fraction | 0)
        ^ fmix32(this.drawCounter | 0),
    );
  }

  /** Raw 32-bit draw, live entropy folded in first. */
  nextUint32() {
    this.a = (this.a ^ this.liveEntropy()) >>> 0;
    this.drawCounter += 1;
    return this.step();
  }

  /** Uniform in [0, 1). */
  nextDouble() {
    return this.nextUint32() / UINT32;
  }

  /**
   * Uniform integer in [0, maxExclusive), Lemire rejection sampling: modulo
   * without rejection is biased towards small values whenever 2^32 is not a
   * multiple of the range, and the bias is exactly what a detector measures.
   */
  nextInt(maxExclusive) {
    const m = Math.floor(maxExclusive);
    if (!(m > 0)) return 0;
    // Reject the partial top block: UINT32 is not a multiple of m, so the
    // remainder values would otherwise be drawn slightly too often. The
    // rejection rate is m / 2^32, i.e. never worth a second thought.
    const limit = UINT32 - (UINT32 % m);
    let x = this.nextUint32();
    while (x >= limit) x = this.nextUint32();
    return x % m;
  }

  /** Uniform integer in [min, max], inclusive. */
  nextInRange(min, max) {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    if (hi <= lo) return lo;
    return lo + this.nextInt(hi - lo + 1);
  }

  pick(pool) {
    const list = Array.from(pool ?? []);
    if (list.length === 0) return undefined;
    return list[this.nextInt(list.length)];
  }

  /**
   * Pick while refusing anything in the recent window, so the same template or
   * the same delay band never repeats back to back. If every candidate is
   * recent, the window has consumed the pool and the full pool is used rather
   * than starving the caller.
   */
  pickWithAntiStreak(pool, recentIds = [], idOf = (item) => item) {
    const list = Array.from(pool ?? []);
    if (list.length === 0) return undefined;
    const recent = new Set(recentIds);
    const candidates = recent.size === 0 ? list : list.filter((item) => !recent.has(idOf(item)));
    const source = candidates.length > 0 ? candidates : list;
    return source[this.nextInt(source.length)];
  }

  /**
   * A human-shaped delay in milliseconds, log-normal between the bounds.
   *
   * Uniform delays are the machine signature: a person's gaps skew long, with
   * a mode near the low end and a tail. Box-Muller in log space gives exactly
   * that shape; the geometric mean of the bounds is the mode's anchor and the
   * spread is sized so ~95% of draws land inside the requested range, with the
   * rest clamped rather than discarded (a retry loop here would thin the tail).
   */
  nextLogNormalMs({ minSec, maxSec }) {
    const min = Math.max(1, minSec) * 1000;
    const max = Math.max(min + 1, maxSec * 1000);
    const mu = Math.log(Math.sqrt(min * max));
    const sigma = (Math.log(max) - Math.log(min)) / 4;

    let value = Math.sqrt(min * max);
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const u1 = Math.max(this.nextDouble(), 1e-12);
      const u2 = this.nextDouble();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      value = Math.exp(mu + sigma * z);
      if (value >= min && value <= max) break;
    }
    return Math.round(Math.min(max, Math.max(min, value)));
  }
}
