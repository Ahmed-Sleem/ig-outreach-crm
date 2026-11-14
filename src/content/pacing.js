/**
 * Request pacing for READS. THE SINGLE READ-PACING IMPLEMENTATION IN THIS CODEBASE.
 *
 * verify.sh enforces that no other module contains a sleep/backoff loop. If pacing
 * exists in two places, one of them will be the lenient one, and it will be the one
 * that gets the user's Instagram account actioned.
 *
 * Write actions (follow, unfollow, message) do not use this pacer: their spacing is
 * decided by src/core/governor.js and spent through interruptibleWait() below, so
 * the safety model for writes stays in one module while the mechanics of waiting
 * stay in one function.
 *
 * Threat model. Because the extension runs inside the user's logged-in
 * browser, IP reputation and TLS fingerprinting — the two layers commercial
 * scrapers spend money on — are already passed. What remains is BEHAVIOURAL
 * detection, and the asset at risk is not a disposable IP but the user's actual
 * Instagram account. So this file is deliberately slow, and every knob that could
 * make it faster is capped.
 *
 * Vendor-published figures (~200 req/h per IP) were measured against server-side
 * clients and do NOT transfer to this context: they were never measured here. Absent
 * trustworthy numbers, defaults approximate human reading speed rather than any
 * published ceiling.
 *
 * Research notes that shaped the code below:
 *  - Uniform delays are themselves a fingerprint. Randomised intervals are the
 *    single most repeated recommendation across sources; hence `jitter`.
 *  - Humans are bursty: they read, pause, get distracted. A pure uniform random
 *    draw is still statistically flat, so `longPauseChance` occasionally injects a
 *    much longer "distraction" gap.
 *  - `Retry-After` is authoritative when present and outranks our own backoff.
 *  - Backoff must carry jitter, or many clients retry in lockstep.
 *  - Instagram signals trouble at two different levels, and conflating them is a
 *    real mistake: HTTP 429 is an IP/session rate limit that decays in minutes,
 *    whereas `feedback_required` and `challenge_required` are ACCOUNT-level flags.
 *    A 429 justifies waiting; an account flag justifies stopping the session
 *    outright and telling the user to leave Instagram alone for a day or two.
 *    See classifyResponse() / AccountFlagged.
 */

/** Defaults are conservative on purpose. Settings may adjust them within guard rails. */
export const DEFAULT_PACING = Object.freeze({
  minDelayMs: 2500,
  maxDelayMs: 6000,
  jitter: true,
  /** Chance per request of an extra "human got distracted" pause. */
  longPauseChance: 0.1,
  longPauseMinMs: 5000,
  longPauseMaxMs: 15000,
  perMinuteCap: 12,
  perSessionCap: 300,
  backoffBaseMs: 5000,
  backoffMaxMs: 300000,
  cooldownAfterErrors: 3,
  /**
   * Pause while the tab is hidden: a background tab making steady requests is a
   * pattern no human produces.
   *
   * BOUNDED ON PURPOSE. The Instagram tab is hidden for the entire scan in the
   * normal flow — the user starts the scan from the dashboard and watches the
   * dashboard, so the profile tab is never the active one. An unbounded pause
   * therefore deadlocked every single scan: the user pressed the button and
   * nothing happened, forever, with no error. See hiddenGraceMs.
   */
  pauseWhenHidden: true,
  /**
   * How long to wait for the tab to come back before giving up on the pause and
   * proceeding anyway. Hidden tabs are throttled by Chrome but can still fetch,
   * so continuing is correct; waiting forever is not.
   */
  hiddenGraceMs: 20000,
});

/** Hard guard rails. Settings cannot go faster than this, whatever the user types. */
export const PACING_FLOOR = Object.freeze({
  minDelayMs: 1000,
  perMinuteCap: 30,
  perSessionCap: 1000,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Clamp user-supplied pacing to the guard rails and repair inverted ranges.
 * Exported because Settings shows the corrected values back to the user rather
 * than silently accepting a number it will not honour.
 */
export function clampPacing(input = {}) {
  const o = { ...DEFAULT_PACING, ...input };
  const notes = [];

  let minDelayMs = Number(o.minDelayMs);
  if (!Number.isFinite(minDelayMs)) minDelayMs = DEFAULT_PACING.minDelayMs;
  if (minDelayMs < PACING_FLOOR.minDelayMs) {
    notes.push(`Minimum delay raised to ${PACING_FLOOR.minDelayMs}ms — the floor exists to protect your account.`);
    minDelayMs = PACING_FLOOR.minDelayMs;
  }

  let maxDelayMs = Number(o.maxDelayMs);
  if (!Number.isFinite(maxDelayMs)) maxDelayMs = DEFAULT_PACING.maxDelayMs;
  if (maxDelayMs < minDelayMs) {
    notes.push('Maximum delay was below the minimum; both set to the minimum.');
    maxDelayMs = minDelayMs;
  }

  let perMinuteCap = Number(o.perMinuteCap);
  if (!Number.isFinite(perMinuteCap) || perMinuteCap < 1) perMinuteCap = DEFAULT_PACING.perMinuteCap;
  if (perMinuteCap > PACING_FLOOR.perMinuteCap) {
    notes.push(`Per-minute cap lowered to ${PACING_FLOOR.perMinuteCap}.`);
    perMinuteCap = PACING_FLOOR.perMinuteCap;
  }

  let perSessionCap = Number(o.perSessionCap);
  if (!Number.isFinite(perSessionCap) || perSessionCap < 1) perSessionCap = DEFAULT_PACING.perSessionCap;
  if (perSessionCap > PACING_FLOOR.perSessionCap) {
    notes.push(`Per-session cap lowered to ${PACING_FLOOR.perSessionCap}.`);
    perSessionCap = PACING_FLOOR.perSessionCap;
  }

  return { ...o, minDelayMs, maxDelayMs, perMinuteCap, perSessionCap, notes };
}

/**
 * Classify a response before deciding what to do about it. Kept pure and exported
 * so it can be unit-tested without a network: the difference between "wait" and
 * "stop and warn the user" is the most consequential branch in the extension.
 *
 * @param {{status?: number, headers?: {get(name: string): string|null}, body?: any}} res
 */
export function classifyResponse(res = {}) {
  const status = res.status;
  const body = res.body;
  const bodyText = typeof body === 'string' ? body : body ? JSON.stringify(body) : '';

  // Account-level flags. These can arrive with a 200 or 400 status, so the body is
  // checked first and independently of the status code.
  if (/feedback_required/i.test(bodyText)) {
    return {
      action: 'abort-session',
      severity: 'account',
      reason: 'feedback_required',
      message:
        'Instagram returned "feedback_required" — that is an account-level flag, not a simple rate limit. '
        + 'The scan has stopped. Do not re-run it today: use Instagram normally for 24–72 hours first.',
    };
  }
  if (/challenge_required/i.test(bodyText)) {
    return {
      action: 'abort-session',
      severity: 'account',
      reason: 'challenge_required',
      message:
        'Instagram is asking your account to complete a verification challenge. The scan has stopped. '
        + 'Open Instagram directly, complete the challenge, and leave scanning alone for a day.',
    };
  }
  if (/checkpoint_required/i.test(bodyText)) {
    return {
      action: 'abort-session',
      severity: 'account',
      reason: 'checkpoint_required',
      message:
        'Instagram is asking this session for a security checkpoint. Everything has stopped. '
        + 'Complete it by hand in a normal tab and leave automation off for a day afterwards.',
    };
  }
  if (/"spam"\s*:\s*true/i.test(bodyText) || /\bspam:\s*true/i.test(bodyText)) {
    return {
      action: 'abort-session',
      severity: 'account',
      reason: 'spam_true',
      message:
        'Instagram silently rolled the action back as spam. The campaign has stopped and the '
        + 'action is recorded as not-done. Do not retry today.',
    };
  }
  if (/login_required/i.test(bodyText) || status === 401) {
    return {
      action: 'abort-session',
      severity: 'auth',
      reason: 'login_required',
      message: 'Your Instagram session is not logged in (or expired). Log in normally in this tab, then scan again.',
    };
  }

  if (status === 429) {
    return {
      action: 'backoff',
      severity: 'rate',
      reason: 'http_429',
      retryAfterMs: retryAfterMs(res),
      message: 'Instagram rate-limited the request (HTTP 429). Backing off.',
    };
  }
  if (status === 403) {
    return {
      action: 'abort-session',
      severity: 'blocked',
      reason: 'http_403',
      message: 'Instagram refused the request (HTTP 403). Stopping rather than retrying into a harder block.',
    };
  }
  if (status === 400) {
    // Typically a stale doc_id, which the adapter chain handles by trying the next
    // candidate. Not a safety event.
    return { action: 'next-candidate', severity: 'none', reason: 'http_400', message: 'Endpoint signature is stale.' };
  }
  if (typeof status === 'number' && status >= 500) {
    return { action: 'retry', severity: 'server', reason: `http_${status}`, message: 'Instagram server error. Retrying once with backoff.' };
  }
  if (typeof status === 'number' && status >= 200 && status < 300) {
    return { action: 'ok', severity: 'none', reason: 'ok', message: '' };
  }
  return { action: 'retry', severity: 'unknown', reason: `http_${status ?? 'none'}`, message: 'Unexpected response.' };
}

/** Parse Retry-After in both delta-seconds and HTTP-date forms. Returns null if absent. */
export function retryAfterMs(res = {}) {
  const raw = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  if (raw === null || raw === undefined || raw === '') return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - Date.now());
}

export class Pacer {
  constructor(options = {}) {
    this.opts = clampPacing(options);
    this.timestamps = [];
    this.sessionCount = 0;
    this.consecutiveErrors = 0;
    this.stopped = false;
    this.listeners = new Set();
    /** Injectable for tests; production uses the real clock and RNG. */
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? sleep;
    this.isHidden = options.isHidden
      ?? (() => (typeof document !== 'undefined' ? document.visibilityState === 'hidden' : false));
  }

  onStatus(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(status) {
    this.listeners.forEach((fn) => {
      try {
        fn(status);
      } catch {
        /* a broken listener must never abort a scan */
      }
    });
  }

  stop() {
    this.stopped = true;
    this.emit({ type: 'stopped' });
  }

  get remainingInSession() {
    return Math.max(0, this.opts.perSessionCap - this.sessionCount);
  }

  /**
   * Human-ish delay. A perfectly regular interval is itself a signal, and so is a
   * perfectly flat random one — real attention is bursty, so a minority of gaps are
   * much longer than the rest.
   */
  nextDelay() {
    const { minDelayMs, maxDelayMs, jitter, longPauseChance, longPauseMinMs, longPauseMaxMs } = this.opts;
    if (!jitter) return minDelayMs;
    let delay = minDelayMs + this.random() * Math.max(0, maxDelayMs - minDelayMs);
    if (this.random() < longPauseChance) {
      delay += longPauseMinMs + this.random() * Math.max(0, longPauseMaxMs - longPauseMinMs);
    }
    return Math.round(delay);
  }

  async waitForSlot() {
    if (this.stopped) throw new PacingStopped();

    if (this.sessionCount >= this.opts.perSessionCap) {
      throw new PacingLimit(
        `Session cap reached (${this.opts.perSessionCap} requests). Stopping here on purpose: continuing is what gets accounts flagged. Reopen the dashboard to start a new session.`,
      );
    }

    // A hidden tab issuing steady requests is a pattern no human produces.
    if (this.opts.pauseWhenHidden) {
      // Bounded wait. The profile tab is hidden for the whole scan in the normal
      // flow (the user is looking at the dashboard), so an unbounded loop here
      // hung every scan with no error and no progress. Wait briefly in case the
      // user is switching tabs, then continue: a hidden tab can still fetch.
      // Measure WALL-CLOCK time, never iteration count. Chrome budget-throttles
      // timers in a hidden tab after ~10s and drops them to one wake per MINUTE
      // once the tab has been hidden for 5 minutes. A loop that assumed each
      // `sleep(1000)` really took 1000ms therefore needed 20 *minutes* to spend a
      // 20-second grace on the second scan of a session — measured at 2000ms per
      // 1000ms tick even early on. Wall-clock accounting exits on the first tick
      // past the deadline, so the worst case is one throttled tick, not 20.
      const grace = Number.isFinite(this.opts.hiddenGraceMs) ? this.opts.hiddenGraceMs : 20000;
      const startedAt = this.now();
      let waited = 0;
      while (this.isHidden() && !this.stopped && waited < grace) {
        if (waited === 0) this.emit({ type: 'paused', reason: 'tab hidden' });
        await this.sleep(1000);
        waited = this.now() - startedAt;
      }
      if (this.stopped) throw new PacingStopped();
      if (waited > 0) {
        this.emit(
          this.isHidden()
            ? { type: 'resumed', hiddenMs: waited, note: 'continuing while the tab is in the background' }
            : { type: 'resumed', hiddenMs: waited },
        );
      }
    }

    // Re-check after every wait: the user may have pressed Stop while the tab was
    // hidden, and a Stop that is swallowed here becomes one more real request.
    if (this.stopped) throw new PacingStopped();

    // Sliding one-minute window.
    const now = this.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
    if (this.timestamps.length >= this.opts.perMinuteCap) {
      const waitMs = 60_000 - (now - this.timestamps[0]) + 250;
      this.emit({ type: 'throttled', waitMs, reason: 'per-minute cap' });
      await this.sleep(waitMs);
    }

    const delay = this.nextDelay();
    this.emit({ type: 'pacing', waitMs: delay, sessionCount: this.sessionCount });
    await this.sleep(delay);

    if (this.stopped) throw new PacingStopped();
    this.timestamps.push(this.now());
    this.sessionCount += 1;
  }

  /**
   * Exponential backoff with full jitter, capped. `retryAfterMs` from the server
   * outranks our computed delay whenever it is present.
   */
  async backoff(attempt, retryAfter = null) {
    const ceiling = Math.min(this.opts.backoffBaseMs * 2 ** attempt, this.opts.backoffMaxMs);
    const computed = Math.round(ceiling / 2 + this.random() * (ceiling / 2));
    const ms = Number.isFinite(retryAfter) && retryAfter !== null
      ? Math.min(retryAfter, this.opts.backoffMaxMs)
      : computed;
    this.emit({ type: 'backoff', waitMs: ms, attempt, honouredRetryAfter: retryAfter !== null });
    await this.sleep(ms);
    return ms;
  }

  noteSuccess() {
    this.consecutiveErrors = 0;
  }

  /**
   * Decide whether the caller must abort. Accepts either a bare status code (legacy
   * callers) or the object returned by classifyResponse().
   * Returns true when the whole scan must stop.
   */
  noteError(statusOrVerdict) {
    this.consecutiveErrors += 1;
    const verdict = typeof statusOrVerdict === 'object' && statusOrVerdict !== null
      ? statusOrVerdict
      : classifyResponse({ status: statusOrVerdict });

    if (verdict.action === 'abort-session') {
      this.stopped = true;
      this.emit({ type: 'aborted', reason: verdict.reason, message: verdict.message, severity: verdict.severity });
      return true;
    }
    if (verdict.action === 'backoff') return true;
    return this.consecutiveErrors >= this.opts.cooldownAfterErrors;
  }
}

export class PacingStopped extends Error {
  constructor() {
    super('Scan stopped by user.');
    this.name = 'PacingStopped';
    this.userFacing = true;
  }
}

export class PacingLimit extends Error {
  constructor(message) {
    super(message);
    this.name = 'PacingLimit';
    this.userFacing = true;
  }
}

export class AccountFlagged extends Error {
  constructor(verdict) {
    super(verdict.message);
    this.name = 'AccountFlagged';
    this.reason = verdict.reason;
    this.severity = verdict.severity;
    this.userFacing = true;
  }
}

/**
 * Estimate wall-clock time before a scan starts, so the user can consent to the
 * real cost. A scan that silently takes 20 minutes is a scan the user will
 * interrupt halfway, which is the worst outcome for their account.
 */
export function estimateDuration(requestCount, options = {}) {
  const o = clampPacing(options);
  const avgDelay = (o.minDelayMs + o.maxDelayMs) / 2
    + o.longPauseChance * ((o.longPauseMinMs + o.longPauseMaxMs) / 2);
  let ms = requestCount * avgDelay;
  const minuteBlocks = Math.floor(requestCount / o.perMinuteCap);
  ms += minuteBlocks * 5000;
  return {
    requestCount,
    estimatedMs: ms,
    humanReadable: humanDuration(ms),
    exceedsSessionCap: requestCount > o.perSessionCap,
  };
}

export function humanDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m} min ${rem} sec` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} hr ${m % 60} min`;
}

/**
 * Spend a delay in one-second ticks so a stop button always lands within a
 * second, and a stopped campaign never sleeps through its cooldown.
 *
 * Wall-clock accounted, like the hidden-tab grace above: a throttled timer must
 * not turn a 90-second gap into a three-minute one, and must not turn a stop
 * into a wait.
 *
 * @param {number} ms
 * @param {{signal?: {aborted: boolean}, tickMs?: number, now?: () => number,
 *          sleep?: (ms: number) => Promise<void>}} options
 */
export async function interruptibleWait(ms, options = {}) {
  const signal = options.signal ?? null;
  const tick = Math.max(50, Number(options.tickMs) || 1000);
  const now = options.now ?? (() => Date.now());
  const sleepFn = options.sleep ?? sleep;
  const startedAt = now();
  const deadline = startedAt + Math.max(0, ms);

  while (!signal?.aborted) {
    const remaining = deadline - now();
    if (remaining <= 0) return { completed: true, waitedMs: now() - startedAt };
    await sleepFn(Math.min(tick, remaining));
  }
  throw new PacingStopped();
}
