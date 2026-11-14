/**
 * The safety governor: the single authority on whether an action may run now.
 *
 * Everything Instagram-side that protects the account lives here — hourly and
 * daily caps, the shared follow+unfollow budget, the cold-invite sub-cap, the
 * circadian window, the warm-up ramp and the circuit breaker — so that no view,
 * queue or worker can invent its own idea of "allowed".
 *
 * The circadian machinery (parseSchedule / scheduleState / scheduleJitter) is
 * adapted from fluidextension (MIT), where it lived inside a settings module
 * that needed a stubbed `chrome` to test. Here it is pure: the clock arrives as
 * an argument, which is what makes the midnight-wraparound tests possible.
 *
 * Rules that cannot be overridden from the UI:
 *  - the active window is capped at 14 hours, so a schedule can never describe
 *    a 24/7 account;
 *  - the grace before unfollowing has a 48-hour floor (lifecycle.js);
 *  - one pushback signal locks writes for 48 hours, persisted, and reloading
 *    the dashboard does not clear it because the lock lives in the workspace.
 */

export const SCHEDULE_DAYS = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

/** A day of automation longer than this is a 24/7 account wearing a costume. */
export const MAX_ACTIVE_MINUTES_PER_DAY = 14 * 60;

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "09:30" -> 570 minutes. Null for anything that is not a time. */
export function minuteOfDay(hhmm) {
  const m = HHMM.exec(String(hhmm ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 570 -> "09:30". Minutes past 1440 wrap, so an overnight end prints as itself. */
export function clockOf(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * The stored week as minutes, or a list of what is wrong with it.
 *
 * Strict on purpose: a schedule silently read as "no windows" takes the
 * campaign dark with nothing in the log, and one silently read as "always"
 * runs an account around the clock. A malformed week is an error the caller
 * can refuse and show, never a value. `from === to` is rejected rather than
 * read as 24 hours, because with `to < from` already meaning "into tomorrow",
 * a zero-length window is the one input whose intent cannot be guessed.
 */
export function parseSchedule(value) {
  const days = SCHEDULE_DAYS.map(() => []);
  const errors = [];
  if (value === undefined || value === null) return { ok: true, days, errors };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, days, errors: ['the schedule is not a set of days'] };
  }

  for (const [key, windows] of Object.entries(value)) {
    const index = SCHEDULE_DAYS.indexOf(String(key).toLowerCase());
    if (index < 0) {
      errors.push(`"${key}" is not a day`);
      continue;
    }
    if (!Array.isArray(windows)) {
      errors.push(`${key}: the windows are not a list`);
      continue;
    }
    for (const pair of windows) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        errors.push(`${key}: a window must be a [from, to] pair`);
        continue;
      }
      const from = minuteOfDay(pair[0]);
      const to = minuteOfDay(pair[1]);
      if (from === null || to === null) {
        errors.push(`${key}: "${pair[0]}"-"${pair[1]}" is not a pair of times`);
        continue;
      }
      if (from === to) {
        errors.push(`${key}: ${pair[0]}-${pair[1]} is a window of no length`);
        continue;
      }
      days[index].push([from, to]);
    }
    days[index].sort((a, b) => a[0] - b[0]);
  }

  return { ok: errors.length === 0, days, errors };
}

/**
 * A week from the settings contract: one daily window applied to all seven
 * days, or an explicit per-day week when the caller provides `days`.
 * Windows longer than MAX_ACTIVE_MINUTES_PER_DAY are shortened, and the
 * correction is reported so the UI can show the number it will honour.
 */
export function buildWeek(schedule) {
  if (schedule && schedule.days) return parseSchedule(schedule.days);

  const from = minuteOfDay(schedule?.activeStartLocal ?? '09:30');
  const to = minuteOfDay(schedule?.activeEndLocal ?? '22:30');
  if (from === null || to === null) {
    return { ok: false, days: SCHEDULE_DAYS.map(() => []), errors: ['the active window is not a pair of times'] };
  }
  if (from === to) {
    return { ok: false, days: SCHEDULE_DAYS.map(() => []), errors: ['the active window has no length'] };
  }

  let end = to;
  const length = end > from ? end - from : end + 1440 - from;
  const clamped = length > MAX_ACTIVE_MINUTES_PER_DAY;
  if (clamped) end = (from + MAX_ACTIVE_MINUTES_PER_DAY) % 1440;

  const days = SCHEDULE_DAYS.map(() => [[from, end]]);
  return { ok: true, days, errors: [], clamped };
}

/**
 * Local midnight `ahead` days from `now`, plus `minutes`.
 *
 * Built from calendar fields, never by adding milliseconds: a day is not
 * reliably 86,400,000 ms — twice a year it is an hour more or less — so
 * `now + 24h` lands at 08:00 or 10:00 around a clock change, and a "09:30"
 * window would open an hour late for half the year.
 */
function localAt(now, ahead, minutes) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead, 0, 0, 0, 0);
  d.setMinutes(minutes);
  return d.getTime();
}

/**
 * How many minutes after the hour this workspace opens.
 *
 * Derived from who and when, not drawn: a random offset would have to be
 * remembered or it re-rolls every tick, and a start time re-rolled every
 * minute is one that wanders. Hashing the workspace and the window opening
 * gives a stable-per-day offset that differs per account and needs no storage.
 */
export function scheduleJitter(dailyDriftMinutes, workspaceKey, windowStartMs) {
  const span = Math.max(0, Math.min(60, Math.round(Number(dailyDriftMinutes) || 0)));
  if (!span) return 0;
  const seed = `${workspaceKey ?? ''}|${windowStartMs}`;
  // FNV-1a. Not a security hash; it only has to spread accounts out.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % (span + 1);
}

/**
 * Where the campaign stands against its own week, right now.
 *
 * One answer read by everything: the tick that starts and stops the autopilot,
 * the telemetry strip, and the governor itself. `broken` fails closed — an
 * unreadable week is the one case where the two mistakes are not equal, so
 * nothing acts until it is fixed.
 */
export function scheduleState(settings, now = new Date(), workspaceKey = '') {
  const base = { enabled: settings?.scheduleEnabled !== false, broken: false, errors: [], window: null, next: null, clamped: false };
  if (!base.enabled) return { ...base, open: true };

  const week = buildWeek(settings?.schedule);
  if (!week.ok) return { ...base, broken: true, open: false, errors: week.errors };

  const drift = settings?.schedule?.dailyDriftMinutes ?? 20;
  const today = now.getDay();
  const at = now.getHours() * 60 + now.getMinutes();

  // Yesterday is checked too, and only because one of its windows can still be
  // open: a window that started at 22:00 belongs to yesterday and runs to 02:00.
  let active = null;
  for (const back of [0, 1]) {
    const day = (today - back + 7) % 7;
    for (const [from, to] of week.days[day]) {
      const end = to > from ? to : to + 1440;
      const minute = at + back * 1440;
      if (minute >= from && minute < end) {
        const startAt = localAt(now, -back, from);
        active = {
          day,
          from: clockOf(from),
          to: clockOf(to),
          startAt,
          endAt: localAt(now, -back, end),
          opensAt: startAt + scheduleJitter(drift, workspaceKey, startAt) * 60000,
        };
        break;
      }
    }
    if (active) break;
  }

  let next = null;
  for (let ahead = 0; ahead <= 7 && !next; ahead += 1) {
    const day = (today + ahead) % 7;
    for (const [from] of week.days[day]) {
      const startAt = localAt(now, ahead, from);
      if (startAt > now.getTime()) {
        next = {
          day,
          from: clockOf(from),
          startAt,
          opensAt: startAt + scheduleJitter(drift, workspaceKey, startAt) * 60000,
        };
        break;
      }
    }
  }

  return { ...base, clamped: Boolean(week.clamped), open: Boolean(active), window: active, next };
}

/* ------------------------------------------------------------ caps & presets */

/**
 * Hard ceilings. The settings UI may not raise a value past these; a stored
 * value above one is clamped on every read, and the corrected number is what
 * the UI shows back.
 */
export const HARD_CEILINGS = Object.freeze({
  followsPerHour: 18,
  followsPerDay: 140,
  unfollowsPerHour: 18,
  unfollowsPerDay: 140,
  combinedMutationsPerDay: 160,
  warmDmsPerHour: 10,
  warmDmsPerDay: 75,
  coldInvitesPerHour: 5,
  coldInvitesPerDay: 25,
  minActionDelaySec: 35,
  maxActionDelaySec: 600,
  activeMinutesPerDay: MAX_ACTIVE_MINUTES_PER_DAY,
});

/** Pause the follow queue just short of Instagram's 7500 following limit. */
export const FOLLOWING_PAUSE_AT = 7450;

export const TrustPreset = Object.freeze({
  CONSERVATIVE: 'conservative',
  BALANCED: 'balanced',
  ESTABLISHED: 'established',
  CUSTOM: 'custom',
});

const PRESET_LIMITS = Object.freeze({
  conservative: Object.freeze({
    followsPerHour: 5, followsPerDay: 20, unfollowsPerHour: 5, unfollowsPerDay: 20,
    combinedMutationsPerDay: 30, warmDmsPerHour: 3, warmDmsPerDay: 10,
    coldInvitesPerHour: 1, coldInvitesPerDay: 3,
    minActionDelaySec: 120, maxActionDelaySec: 300,
    postAcceptMinMin: 45, postAcceptMaxMin: 120, unfollowGraceDays: 7, staleRequestDays: 10,
  }),
  balanced: Object.freeze({
    followsPerHour: 10, followsPerDay: 50, unfollowsPerHour: 10, unfollowsPerDay: 50,
    combinedMutationsPerDay: 75, warmDmsPerHour: 6, warmDmsPerDay: 25,
    coldInvitesPerHour: 3, coldInvitesPerDay: 8,
    minActionDelaySec: 75, maxActionDelaySec: 190,
    postAcceptMinMin: 25, postAcceptMaxMin: 120, unfollowGraceDays: 5, staleRequestDays: 10,
  }),
  established: Object.freeze({
    followsPerHour: 14, followsPerDay: 90, unfollowsPerHour: 14, unfollowsPerDay: 90,
    combinedMutationsPerDay: 130, warmDmsPerHour: 9, warmDmsPerDay: 45,
    coldInvitesPerHour: 4, coldInvitesPerDay: 15,
    minActionDelaySec: 45, maxActionDelaySec: 140,
    postAcceptMinMin: 25, postAcceptMaxMin: 90, unfollowGraceDays: 4, staleRequestDays: 10,
  }),
});

export function presetLimits(name) {
  return { ...(PRESET_LIMITS[name] ?? PRESET_LIMITS.balanced) };
}

/**
 * Clamp a limits object against the hard ceilings. Returns the corrected
 * limits and the names of the fields that moved, so the UI can say "you asked
 * for 200 follows a day; the ceiling is 140" instead of silently disagreeing.
 */
export function clampLimits(limits = {}) {
  const base = limits.trustPreset && limits.trustPreset !== TrustPreset.CUSTOM
    ? presetLimits(limits.trustPreset)
    : presetLimits(TrustPreset.BALANCED);
  const merged = { ...base, ...limits };
  const clamped = [];

  for (const [key, ceiling] of Object.entries(HARD_CEILINGS)) {
    if (key === 'activeMinutesPerDay') continue;
    const value = Number(merged[key]);
    if (!Number.isFinite(value)) continue;
    const next = key === 'minActionDelaySec'
      ? Math.max(value, ceiling)
      : Math.min(value, ceiling);
    if (next !== value) {
      merged[key] = next;
      clamped.push(key);
    }
  }
  if (merged.maxActionDelaySec < merged.minActionDelaySec) {
    merged.maxActionDelaySec = merged.minActionDelaySec;
    clamped.push('maxActionDelaySec');
  }
  delete merged.trustPreset;
  return { limits: merged, clamped };
}

/* ------------------------------------------------------------------ warm-up */

/**
 * Day 1 runs at 40% of the configured daily caps, +10% per clean day, 100% from
 * day 7. After a circuit breaker the ramp restarts at 25%.
 */
export function warmupFactor(warmupDay, { enabled = true, postBreaker = false } = {}) {
  if (!enabled) return 1;
  const day = Math.max(1, Math.round(warmupDay || 1));
  const base = postBreaker ? 0.25 : 0.4;
  return Math.min(1, base + 0.1 * (day - 1));
}

/* ------------------------------------------------------------------ counters */

export const ActionType = Object.freeze({
  FOLLOW: 'FOLLOW',
  UNFOLLOW: 'UNFOLLOW',
  DM_WARM: 'DM_WARM',
  DM_COLD: 'DM_COLD',
});

function dayKey(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function hourKey(now) {
  return `${dayKey(now)}T${String(now.getHours()).padStart(2, '0')}`;
}

/** The persisted governor state of a workspace, initialised on first read. */
export function initialGovernorState() {
  return {
    lockedUntil: 0,
    lockReason: null,
    warmupDay: 1,
    warmupEnabled: true,
    postBreaker: false,
    daily: { date: '', follows: 0, unfollows: 0, combined: 0, warmDms: 0, coldInvites: 0 },
    hourly: {},
    inFlightAction: null,
  };
}

/** Counters rolled to the current day/hour. Mutates and returns the state. */
export function countersFor(state, now) {
  const s = state ?? initialGovernorState();
  const d = dayKey(now);
  if (s.daily.date !== d) {
    // An empty date means first use, not a day change: the ramp must not skip
    // day 1 because the counters happened to be touched before any action ran.
    if (s.daily.date !== '') s.warmupDay = (s.warmupDay || 1) + 1;
    s.daily = { date: d, follows: 0, unfollows: 0, combined: 0, warmDms: 0, coldInvites: 0 };
  }
  const h = hourKey(now);
  if (!s.hourly[h]) s.hourly[h] = { follows: 0, unfollows: 0, warmDms: 0, coldInvites: 0 };
  // Keep only the current and previous hour; the rest is dead weight.
  for (const key of Object.keys(s.hourly)) {
    if (key !== h && key < hourKey(new Date(now.getTime() - 3600000))) delete s.hourly[key];
  }
  return s;
}

/* -------------------------------------------------------------- the decision */

/**
 * May this action run right now? One function, called by the autopilot before
 * every write, and by the UI to render the reason it cannot.
 */
export function canExecute(actionType, ctx) {
  const now = ctx?.now ?? new Date();
  const state = countersFor(ctx?.governorState ?? initialGovernorState(), now);
  const { limits } = clampLimits(ctx?.settings?.limits ?? {});
  const factor = warmupFactor(state.warmupDay, {
    enabled: state.warmupEnabled !== false && ctx?.settings?.schedule?.warmupRampEnabled !== false,
    postBreaker: state.postBreaker,
  });

  if (state.lockedUntil && now.getTime() < state.lockedUntil) {
    return { ok: false, reason: 'circuit breaker', lockedUntil: state.lockedUntil, lockReason: state.lockReason };
  }

  const schedule = scheduleState(ctx?.settings ?? {}, now, ctx?.workspaceKey ?? '');
  if (schedule.broken) return { ok: false, reason: 'schedule is unreadable', errors: schedule.errors };
  if (!schedule.open) {
    return { ok: false, reason: 'outside the active window', opensAt: schedule.next?.opensAt ?? null };
  }

  if (ctx?.nextEligibleAt && now.getTime() < ctx.nextEligibleAt) {
    return { ok: false, reason: 'spacing', waitMs: ctx.nextEligibleAt - now.getTime() };
  }

  const daily = (cap) => Math.max(1, Math.floor(cap * factor));
  const hour = state.hourly[hourKey(now)];

  switch (actionType) {
    case ActionType.FOLLOW: {
      if ((ctx?.followingCount ?? 0) >= FOLLOWING_PAUSE_AT) {
        return { ok: false, reason: 'following list is at the platform cap; run the cleaner first' };
      }
      if (hour.follows >= limits.followsPerHour) return { ok: false, reason: 'hourly follow cap reached' };
      if (state.daily.follows >= daily(limits.followsPerDay)) return { ok: false, reason: 'daily follow cap reached' };
      if (state.daily.combined >= daily(limits.combinedMutationsPerDay)) return { ok: false, reason: 'shared follow+unfollow budget spent' };
      return { ok: true, factor };
    }
    case ActionType.UNFOLLOW: {
      if (hour.unfollows >= limits.unfollowsPerHour) return { ok: false, reason: 'hourly unfollow cap reached' };
      if (state.daily.unfollows >= daily(limits.unfollowsPerDay)) return { ok: false, reason: 'daily unfollow cap reached' };
      if (state.daily.combined >= daily(limits.combinedMutationsPerDay)) return { ok: false, reason: 'shared follow+unfollow budget spent' };
      return { ok: true, factor };
    }
    case ActionType.DM_WARM: {
      if (hour.warmDms >= limits.warmDmsPerHour) return { ok: false, reason: 'hourly warm-message cap reached' };
      if (state.daily.warmDms >= daily(limits.warmDmsPerDay)) return { ok: false, reason: 'daily warm-message cap reached' };
      return { ok: true, factor };
    }
    case ActionType.DM_COLD: {
      if (hour.coldInvites >= limits.coldInvitesPerHour) return { ok: false, reason: 'hourly cold-invite cap reached' };
      if (state.daily.coldInvites >= daily(limits.coldInvitesPerDay)) return { ok: false, reason: 'daily cold-invite cap reached' };
      return { ok: true, factor };
    }
    default:
      return { ok: false, reason: `unknown action type: ${actionType}` };
  }
}

/** Record a completed action in the counters. */
export function recordAction(state, actionType, now) {
  const s = countersFor(state ?? initialGovernorState(), now ?? new Date());
  const hour = s.hourly[hourKey(now ?? new Date())];
  switch (actionType) {
    case ActionType.FOLLOW:
      s.daily.follows += 1; s.daily.combined += 1; hour.follows += 1; break;
    case ActionType.UNFOLLOW:
      s.daily.unfollows += 1; s.daily.combined += 1; hour.unfollows += 1; break;
    case ActionType.DM_WARM:
      s.daily.warmDms += 1; hour.warmDms += 1; break;
    case ActionType.DM_COLD:
      s.daily.coldInvites += 1; hour.coldInvites += 1; break;
    default:
      break;
  }
  return s;
}

/**
 * Halt everything. The lock is persisted in the workspace, so reloading the
 * dashboard or restarting the browser does not clear it, and retrying during
 * the lock only extends the platform's own patience.
 */
export function tripCircuitBreaker(state, reason, now, kind = 'feedback') {
  const s = state ?? initialGovernorState();
  const hours = kind === 'challenge' ? 24 : 48;
  s.lockedUntil = (now ?? new Date()).getTime() + hours * 3600000;
  s.lockReason = reason;
  s.warmupDay = 1;
  s.postBreaker = true;
  return s;
}

/* ------------------------------------------------------------- delay shape */

/**
 * The gap before the next write action: log-normal inside the configured
 * bounds, with a 10% chance of a 45-180 s distraction and a 6-15 minute break
 * every 8-12 actions. Fixed intervals are the most recognisable machine
 * signature there is; this is the shape that is not one.
 */
export function planNextDelay({ settings, rng, actionsSinceBreak = 0 }) {
  const { limits } = clampLimits(settings?.limits ?? {});
  let ms = rng.nextLogNormalMs({ minSec: limits.minActionDelaySec, maxSec: limits.maxActionDelaySec });
  let kind = 'action';

  if (rng.nextDouble() < 0.1) {
    ms += rng.nextInRange(45, 180) * 1000;
    kind = 'distraction';
  }
  const breakEvery = rng.nextInRange(8, 12);
  if (actionsSinceBreak + 1 >= breakEvery) {
    ms += rng.nextInRange(6, 15) * 60000;
    kind = 'break';
  }
  return { ms, kind, breakEvery };
}
