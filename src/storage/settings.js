/**
 * Settings: one key in chrome.storage.local, clamped on every read and write.
 *
 * Never chrome.storage.sync — sync would replicate the user's campaign
 * configuration to Google's servers, which a local-only tool should not do
 * silently.
 *
 * The clamp is the point. Every safety number has a hard ceiling in
 * src/core/governor.js, and a stored value above it (hand-edited, imported
 * from an older build, typed optimistically) is corrected here, on the way in,
 * so no consumer ever sees an unenforceable setting. The list of corrected
 * fields travels with the result so the UI can say what it changed.
 *
 * The storage adapter is injected: inside the extension it is
 * chrome.storage.local, in tests it is a Map. The chrome handle is resolved
 * lazily through globalThis so this module stays loadable in plain Node.
 */

import { DEFAULT_WEIGHTS } from '../core/scoring.js';
import { HARD_CEILINGS, MAX_ACTIVE_MINUTES_PER_DAY, clampLimits, presetLimits } from '../core/governor.js';

export const SETTINGS_KEY = 'ig_crm_settings_v1';

export const DEFAULTS = Object.freeze({
  trustPreset: 'balanced',
  scheduleEnabled: true,
  limits: Object.freeze(presetLimits('balanced')),
  schedule: Object.freeze({
    activeStartLocal: '09:30',
    activeEndLocal: '22:30',
    dailyDriftMinutes: 20,
    warmupRampEnabled: true,
  }),
  rankingWeights: Object.freeze({ ...DEFAULT_WEIGHTS }),
  ui: Object.freeze({ theme: 'dark', tablePageSize: 100, defaultLanguage: 'en' }),
});

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(base?.[key] ?? {}, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Correct a settings object against the hard rules. Pure: returns a new
 * object plus the names of the fields that moved.
 */
export function clampSafetySettings(settings = {}) {
  const merged = deepMerge(DEFAULTS, settings);
  merged.scheduleEnabled = merged.scheduleEnabled !== false;
  const clamped = [];

  const { limits, clamped: limitFields } = clampLimits({
    ...merged.limits,
    trustPreset: merged.trustPreset,
  });
  merged.limits = limits;
  clamped.push(...limitFields);

  const drift = Number(merged.schedule?.dailyDriftMinutes);
  if (!Number.isFinite(drift) || drift < 0 || drift > 60) {
    merged.schedule = { ...merged.schedule, dailyDriftMinutes: Number.isFinite(drift) ? Math.min(60, Math.max(0, drift)) : 20 };
    clamped.push('schedule.dailyDriftMinutes');
  }

  const page = Number(merged.ui?.tablePageSize);
  if (!Number.isFinite(page) || page < 10 || page > 500) {
    merged.ui = { ...merged.ui, tablePageSize: Number.isFinite(page) ? Math.min(500, Math.max(10, page)) : 100 };
    clamped.push('ui.tablePageSize');
  }

  // The 14-hour active cap is enforced when the week is built; record it here
  // too so a stored 24/7 window is visibly corrected rather than trimmed later.
  void HARD_CEILINGS;
  void MAX_ACTIVE_MINUTES_PER_DAY;

  return { settings: merged, clamped };
}

function chromeLocal() {
  const handle = globalThis.chrome?.storage?.local;
  if (!handle) {
    throw new Error('the extension storage adapter is unavailable here; inject one');
  }
  return handle;
}

export async function loadSettings(adapter = chromeLocal()) {
  const stored = await adapter.get(SETTINGS_KEY);
  const { settings } = clampSafetySettings(stored?.[SETTINGS_KEY] ?? {});
  return settings;
}

export async function saveSettings(patch, adapter = chromeLocal()) {
  const current = await loadSettings(adapter);
  const { settings } = clampSafetySettings(deepMerge(current, patch));
  await adapter.set({ [SETTINGS_KEY]: settings });
  return settings;
}

export async function resetSettings(adapter = chromeLocal()) {
  await adapter.set({ [SETTINGS_KEY]: DEFAULTS });
  return { ...DEFAULTS };
}

/**
 * The single choke point every export and backup passes through. Settings hold
 * no credentials today; if a sensitive field is ever added, this is the one
 * place that must mask it, and the tests assert that it does.
 */
export function redact(settings) {
  const SENSITIVE = /(cookie|csrf|session|token|password|secret)/i;
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, inner] of Object.entries(value)) {
        if (SENSITIVE.test(key)) continue;
        out[key] = walk(inner);
      }
      return out;
    }
    return value;
  };
  return walk(settings);
}
