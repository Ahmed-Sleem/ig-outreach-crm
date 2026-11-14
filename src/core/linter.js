/**
 * Pre-flight message linter.
 *
 * Instagram does not tell a sender why a message disappeared into Hidden
 * Requests. What is known from observed enforcement is that near-identical
 * repeated messages, public link shorteners, and certain promotional phrases
 * are the inputs to its spam-similarity and hidden-words classifiers. This
 * module checks a template pool against those inputs before a campaign starts,
 * so the failure happens in the studio with an explanation, not silently in a
 * request folder.
 *
 * Levels: an error blocks sending; a warning is shown and can be accepted.
 * Pure, like everything in src/core.
 */

import { jaccard, normaliseText, trigramSet } from './text.js';
import { countMessageVariations, variableNames } from './templates.js';

/** Instagram's documented ceiling for one text-only request message. */
export const MESSAGE_BYTE_LIMIT = 1000;

/** Public shorteners. Every one of them is a known spam classifier trigger. */
export const URL_SHORTENERS = Object.freeze([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'cutt.ly', 'rb.gy', 'ow.ly',
  'buff.ly', 'rebrand.ly', 'is.gd', 'clck.ru', 'short.link', 'lnkd.in',
]);

/**
 * Phrases that trip hidden-word style classifiers. Deliberately small and
 * conservative: a long list would flag ordinary sentences and train the user
 * to ignore the linter, which is worse than missing an edge case.
 */
export const HIDDEN_WORD_TRIGGERS = Object.freeze([
  'giveaway', 'free money', 'get rich', 'click here', 'dm me', 'message me now',
  'act now', 'limited time offer', 'you have been selected', 'congratulations you won',
  'crypto', 'forex signal', 'passive income',
]);

/** A pool smaller than this reads as one message repeated, whatever it looks like. */
export const MIN_POOL_TEMPLATES = 5;
/** Distinct renders across the pool; below this the diversity figure is thin. */
export const MIN_POOL_VARIATIONS = 24;
/** Pairwise similarity above which two templates are the same message wearing hats. */
export const MAX_PAIRWISE_SIMILARITY = 0.8;

const LINK_RE = /(https?:\/\/|www\.)[^\s]+/gi;

function utf8ByteLength(text) {
  const encoder = globalThis.TextEncoder;
  if (encoder) return new encoder().encode(text).length;
  // Fallback for environments without TextEncoder: encodeURIComponent renders
  // every non-ASCII character as its %XX bytes, which is the UTF-8 length.
  return text.length + (encodeURIComponent(text).length - text.length) / 2;
}

function shortenerHit(text) {
  const lower = text.toLowerCase();
  return URL_SHORTENERS.find((host) => lower.includes(host)) ?? null;
}

function hiddenWordHits(text) {
  const norm = ` ${normaliseText(text).toLowerCase()} `;
  return HIDDEN_WORD_TRIGGERS.filter((phrase) => norm.includes(` ${phrase} `) || norm.endsWith(` ${phrase} `) || norm.startsWith(` ${phrase} `));
}

/**
 * Check one template.
 *
 * @param {{body?: string, title?: string, active?: boolean}} template
 * @param {{cold?: boolean}} options cold = the message may reach someone who
 *        does not follow the sender, where the rules are strictest.
 */
export function lintTemplate(template, { cold = true } = {}) {
  const errors = [];
  const warnings = [];
  const body = String(template?.body ?? '');
  const label = template?.title || 'Untitled template';

  if (body.trim() === '') {
    errors.push(`${label}: the template is empty`);
    return { errors, warnings, bytes: 0, variations: 0 };
  }

  const bytes = utf8ByteLength(body);
  if (bytes > MESSAGE_BYTE_LIMIT) {
    errors.push(`${label}: ${bytes} UTF-8 bytes, over the ${MESSAGE_BYTE_LIMIT}-byte message limit`);
  }

  const shortener = shortenerHit(body);
  if (shortener) {
    errors.push(`${label}: link shortener "${shortener}" — shorteners are a spam-classifier trigger`);
  }

  const links = body.match(LINK_RE) ?? [];
  if (links.length > 0 && !shortener) {
    const message = `${label}: contains a link (${links[0]})`;
    if (cold) errors.push(`${message} — cold requests with links are filtered aggressively`);
    else warnings.push(message);
  }

  const words = hiddenWordHits(body);
  if (words.length > 0) {
    warnings.push(`${label}: promotional phrasing (${words.join(', ')}) reads as spam to hidden-word filters`);
  }

  const variations = countMessageVariations(body);
  if (variations === 1 && variableNames(body).length === 0) {
    warnings.push(`${label}: a single fixed sentence with no spintax and no variables`);
  }

  return { errors, warnings, bytes, variations };
}

/**
 * Check a whole pool: per-template results plus the pool-level rules that only
 * make sense across templates (size, combined diversity, pairwise similarity).
 */
export function lintPool(templates, options = {}) {
  const active = (templates ?? []).filter((t) => t.active !== false);
  const perTemplate = active.map((t) => ({ template: t, ...lintTemplate(t, options) }));
  const pool = { errors: [], warnings: [] };

  if (active.length === 0) {
    pool.errors.push('the pool has no active templates');
  } else if (active.length < MIN_POOL_TEMPLATES) {
    pool.warnings.push(
      `${active.length} active template(s); ${MIN_POOL_TEMPLATES} structurally different messages is the floor for an active campaign`,
    );
  }

  const totalVariations = perTemplate.reduce((sum, r) => sum + r.variations, 0);
  if (active.length > 0 && totalVariations < MIN_POOL_VARIATIONS) {
    pool.warnings.push(
      `${totalVariations} distinct renders across the pool; under ${MIN_POOL_VARIATIONS} the spam-similarity model has one shape to match`,
    );
  }

  for (let i = 0; i < perTemplate.length; i += 1) {
    for (let j = i + 1; j < perTemplate.length; j += 1) {
      const a = perTemplate[i].template;
      const b = perTemplate[j].template;
      const score = jaccard(trigramSet(a.body), trigramSet(b.body));
      if (score > MAX_PAIRWISE_SIMILARITY) {
        pool.warnings.push(
          `"${a.title || i + 1}" and "${b.title || j + 1}" are ${Math.round(score * 100)}% similar by trigram overlap`,
        );
      }
    }
  }

  return {
    perTemplate,
    pool,
    errors: [...pool.errors, ...perTemplate.flatMap((r) => r.errors)],
    warnings: [...pool.warnings, ...perTemplate.flatMap((r) => r.warnings)],
  };
}
