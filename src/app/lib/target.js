/**
 * target.js — normalise and validate whatever the owner typed (or the launcher
 * derived from the page) into a clean collect request.
 *
 * Pure module: no DOM, no chrome.*, no imports. Both the dashboard collector and
 * the query-param boot path call parseTarget() before anything is sent, so an
 * unclean value never reaches Instagram as a raw username (which answers 404).
 *
 * The source strings mirror CollectSource in content/main.js and must not drift.
 */

/* ------------------------------------------------------------- source sets */

export const PROFILE_SOURCES = Object.freeze(['followers', 'following', 'profile_recent_likers']);
export const POST_SOURCES = Object.freeze(['post_likers', 'post_comments']);
export const HASHTAG_SOURCES = Object.freeze(['hashtag_grid']);
export const NO_FIELD_SOURCES = Object.freeze(['saved_grid', 'open_list_dialog', 'current_page']);

/** instagram.com first-path segments that are routes, never usernames. */
export const RESERVED_SEGMENTS = Object.freeze([
  'p', 'reel', 'reels', 'tv', 'explore', 'accounts', 'direct', 'stories', 'tags', 'locations',
]);
const RESERVED = new Set(RESERVED_SEGMENTS);
const POST_ROUTE = new Set(['p', 'reel', 'reels', 'tv']);

export const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
const SHORTCODE_RE = /^[A-Za-z0-9_-]{5,30}$/;
const TAG_RE = /^[\p{L}\p{N}_]{1,100}$/u;

/** Invisible zero-width / bidi characters that would silently break validation. */
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

/* ------------------------------------------------------- field descriptors */

/**
 * Per-source field metadata for the collect screen. `needsField:false` sources hide the
 * input entirely. `kind` drives which validation branch and which icon/label.
 */
export const SOURCE_FIELDS = Object.freeze({
  followers: { needsField: true, kind: 'account', label: 'Account', placeholder: 'username or link', helper: 'Paste a username (nike), @nike, or a profile link.' },
  following: { needsField: true, kind: 'account', label: 'Account', placeholder: 'username or link', helper: 'People this account follows.' },
  profile_recent_likers: { needsField: true, kind: 'account', label: 'Account', placeholder: 'username or link', helper: "People who liked this account's latest posts." },
  post_likers: { needsField: true, kind: 'post', label: 'Post link', placeholder: 'https://www.instagram.com/p/\u2026', helper: 'Open the post on Instagram, copy the link from the address bar, paste it here.' },
  post_comments: { needsField: true, kind: 'post', label: 'Post link', placeholder: 'https://www.instagram.com/p/\u2026', helper: 'Same as above. Posts and reels both work.' },
  hashtag_grid: { needsField: true, kind: 'tag', label: 'Hashtag', placeholder: '#linen', helper: 'Type the tag with or without #. Instagram will open in your tab.' },
  open_list_dialog: { needsField: false, kind: 'none', label: '', placeholder: '', helper: "In Instagram, open someone's Followers window and keep it open, then press Collect." },
  saved_grid: { needsField: false, kind: 'none', label: '', placeholder: '', helper: 'In Instagram, open your Saved page, then press Collect.' },
  current_page: { needsField: false, kind: 'none', label: '', placeholder: '', helper: 'Collects the people visible on the Instagram tab you are on.' },
});

/** The four plain "what do you want to collect from" groups. */
export const SOURCE_GROUPS = Object.freeze([
  { id: 'account', label: 'From an account', options: [
    { value: 'followers', label: 'Followers' },
    { value: 'following', label: 'Following' },
    { value: 'profile_recent_likers', label: 'Recent likers' },
  ] },
  { id: 'post', label: 'From a post', options: [
    { value: 'post_likers', label: 'Likers' },
    { value: 'post_comments', label: 'Commenters' },
  ] },
  { id: 'hashtag', label: 'From a hashtag', options: [
    { value: 'hashtag_grid', label: 'Hashtag' },
  ] },
  { id: 'open', label: 'From open tab', options: [
    { value: 'open_list_dialog', label: 'Open followers list' },
    { value: 'saved_grid', label: 'Saved posts' },
    { value: 'current_page', label: 'This page' },
  ] },
]);

/* ------------------------------------------------------------------ helpers */

function clean(raw) {
  return String(raw ?? '').replace(INVISIBLE_RE, '').trim();
}

/**
 * The username normalisation shared with the content layer: strip
 * zero-width/bidi characters and whitespace, a leading @, and a trailing slash.
 * Pure and import-safe so `content/adapters.js` runs the exact same cleaning the
 * dashboard does before it validates.
 */
export function normaliseUsername(raw) {
  return clean(raw).replace(/^@+/, '').replace(/\/+$/, '');
}

/** True when the value is a bare, valid Instagram handle. */
export function isValidUsername(name) {
  return USERNAME_RE.test(String(name ?? ''));
}

function looksLikeUrl(s) {
  return /^https?:\/\//i.test(s) || /^(www\.)?instagram\.com\//i.test(s);
}

/** Parse an instagram.com URL into its path segments, or a structured error. */
function readUrl(raw) {
  let href = clean(raw);
  if (!/^https?:\/\//i.test(href)) href = `https://${href}`;
  let url;
  try { url = new URL(href); } catch {
    return { ok: false, error: 'That link could not be read. Check it and try again.', code: 'bad_link' };
  }
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (host !== 'instagram.com' && !host.endsWith('.instagram.com')) {
    return { ok: false, error: 'That link is not from instagram.com.', code: 'not_instagram' };
  }
  const segments = url.pathname.split('/').filter(Boolean)
    .map((seg) => { try { return decodeURIComponent(seg); } catch { return seg; } });
  return { ok: true, segments };
}

function finishUsername(name) {
  const username = String(name ?? '');
  if (!USERNAME_RE.test(username)) {
    return { ok: false, error: 'That does not look like an Instagram username. Use letters, numbers, . and _ only.', code: 'invalid_username' };
  }
  return { ok: true, username, label: `@${username}` };
}

function finishShortcode(code) {
  const shortcode = String(code ?? '');
  if (!SHORTCODE_RE.test(shortcode)) {
    return { ok: false, error: 'That does not look like a post code. Open the post and copy its link.', code: 'invalid_shortcode' };
  }
  return { ok: true, shortcode, label: `p/${shortcode}` };
}

function finishTag(tag) {
  const t = String(tag ?? '').replace(/^#+/, '').trim();
  if (!t) return { ok: false, error: 'Enter a hashtag, with or without #.', code: 'empty' };
  if (/\s/.test(t)) return { ok: false, error: 'A hashtag cannot contain spaces.', code: 'invalid_tag' };
  if (!TAG_RE.test(t)) return { ok: false, error: 'That does not look like a hashtag. Use letters, numbers and _ only.', code: 'invalid_tag' };
  return { ok: true, tag: t, label: `#${t}` };
}

/* ------------------------------------------------------------ per-source */

function parseProfile(value) {
  if (!value) return { ok: false, error: 'Enter a username or paste a profile link.', code: 'empty' };
  if (looksLikeUrl(value)) {
    const url = readUrl(value);
    if (!url.ok) return url;
    const first = url.segments[0];
    if (!first) return { ok: false, error: 'That link has no account in it. Paste a profile link like instagram.com/username.', code: 'not_profile' };
    const lower = first.toLowerCase();
    if (RESERVED.has(lower)) {
      if (POST_ROUTE.has(lower)) {
        return { ok: false, error: 'That is a post link. Pick a post source, or paste the profile link.', code: 'post_link', hint: 'Likers and commenters of a post have their own source.' };
      }
      return { ok: false, error: 'That link is not a profile. Paste a profile link like instagram.com/username.', code: 'not_profile' };
    }
    return finishUsername(first);
  }
  const name = normaliseUsername(value);
  if (name.startsWith('#')) {
    return { ok: false, error: 'That does not look like an Instagram username. Use letters, numbers, . and _ only.', code: 'invalid_username', hint: 'For a hashtag, switch to the Hashtag source.' };
  }
  return finishUsername(name);
}

function parsePost(value) {
  if (!value) return { ok: false, error: 'Paste a post link like instagram.com/p/\u2026', code: 'empty' };
  if (looksLikeUrl(value)) {
    const url = readUrl(value);
    if (!url.ok) return url;
    const segs = url.segments;
    for (let i = 0; i < segs.length; i += 1) {
      if (POST_ROUTE.has(segs[i].toLowerCase()) && segs[i + 1]) return finishShortcode(segs[i + 1]);
    }
    if (segs[0] && !RESERVED.has(segs[0].toLowerCase())) {
      return { ok: false, error: 'That is an account. Paste a post link like instagram.com/p/\u2026', code: 'account_link' };
    }
    return { ok: false, error: 'That link is not a post. Paste a post link like instagram.com/p/\u2026', code: 'not_post' };
  }
  if (value.startsWith('@')) {
    return { ok: false, error: 'That is an account. Paste a post link like instagram.com/p/\u2026', code: 'account_link' };
  }
  return finishShortcode(value.replace(/\/+$/, ''));
}

function parseHashtag(value) {
  if (!value) return { ok: false, error: 'Enter a hashtag, with or without #.', code: 'empty' };
  if (looksLikeUrl(value)) {
    const url = readUrl(value);
    if (!url.ok) return url;
    const segs = url.segments;
    const ti = segs.findIndex((s) => s.toLowerCase() === 'tags');
    if (ti >= 0 && segs[ti + 1]) return finishTag(segs[ti + 1]);
    return { ok: false, error: 'That link is not a hashtag. Paste instagram.com/explore/tags/name/ or just type the tag.', code: 'not_tag' };
  }
  return finishTag(value);
}

/* ------------------------------------------------------------------- public */

/**
 * Turn the owner's raw input into a clean, validated request for one source.
 * @returns {{ok:true, username?:string, shortcode?:string, tag?:string, label:string}
 *          | {ok:false, error:string, hint?:string, code?:string}}
 */
export function parseTarget(source, raw) {
  const src = String(source ?? '');
  if (NO_FIELD_SOURCES.includes(src)) return { ok: true, label: 'this page', source: src };
  const value = clean(raw);
  if (PROFILE_SOURCES.includes(src)) return parseProfile(value);
  if (POST_SOURCES.includes(src)) return parsePost(value);
  if (HASHTAG_SOURCES.includes(src)) return parseHashtag(value);
  return { ok: false, error: 'Unknown collect source.', code: 'unknown_source' };
}

/** The human confirmation string shown under the target input. */
export function describeTarget(parsed) {
  if (!parsed || parsed.ok !== true) return '';
  if (parsed.username) return `Account: @${parsed.username}`;
  if (parsed.shortcode) return `Post: p/${parsed.shortcode}`;
  if (parsed.tag) return `Hashtag: #${parsed.tag}`;
  return 'This page';
}
