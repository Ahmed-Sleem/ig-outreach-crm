/**
 * Instagram read adapters — the only place in this codebase that forms a request
 * to Instagram or interprets a response from it.
 *
 * Three rules shape every function here:
 *
 *  1. Nothing is hardcoded that Instagram owns. App ids, ASBD ids and GraphQL
 *     doc_ids are read from the live page by `probe.js` and passed in. A stale
 *     doc_id is a silent 400 that looks exactly like a ban, so a 400 means "try
 *     the next candidate", never "retry harder".
 *  2. Every read is spaced by the pacer and checked by `classifyResponse`. A
 *     429 backs off; `feedback_required`, `challenge_required`,
 *     `checkpoint_required` or `"spam": true` stops the whole session, because
 *     those are account-level flags and continuing is how an account gets
 *     actioned.
 *  3. Every adapter reports honestly. An endpoint that refuses returns
 *     `{ ok: false, reason }` with the reason Instagram gave; it never returns
 *     an empty list, because "no leads" and "Instagram said no" must stay
 *     distinguishable in the UI.
 *
 * `fetchImpl`, `pacer` and `wait` are injectable so the whole chain is unit
 * tested against a fake transport.
 */

import { classifyResponse, interruptibleWait } from './pacing.js';
import { gridTileAuthors, userLinksFrom, usernameFromPath } from './selectors.js';

export const WWW_ORIGIN = 'https://www.instagram.com';
export const I_ORIGIN = 'https://i.instagram.com';

/** v1 friendships paging size. Instagram serves 12 to the UI; we ask modestly. */
export const FRIENDSHIP_PAGE_SIZE = 50;
/** Legacy web GraphQL hashes. Instagram answers these with empty edges since
 *  2026-09 on follower lists, so they are last-resort candidates only. */
export const LEGACY_QUERY_HASHES = Object.freeze({
  followers: 'c76146de99bb02f6415203be841dd25a',
  following: 'd04b0a864b4b54837c0d870b0e77e076',
});

export class ApiError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = info.status ?? null;
    this.reason = info.reason ?? null;
    this.severity = info.severity ?? 'unknown';
    this.url = info.url ?? null;
    this.body = info.body ?? null;
  }
}

/** Parse whatever the transport returned: an object, or text that may be JSON. */
export function parseBody(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  const text = String(raw);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Build the request function every adapter uses. Headers mirror what
 * instagram.com itself sends from a browser session; no custom user agent, no
 * forged client id — anything that looks like a non-browser client invites the
 * checkpoint flow.
 */
export function createApi({ fetchImpl, appId, asbd, csrfToken, defaultHeaders = {} } = {}) {
  const doFetch = fetchImpl ?? ((...args) => fetch(...args));
  return async function request(url, options = {}) {
    const headers = {
      accept: 'application/json',
      'x-ig-app-id': String(options.appId ?? appId ?? ''),
      ...(asbd ? { 'x-asbd-id': String(asbd) } : {}),
      ...(csrfToken ? { 'x-csrftoken': csrfToken } : {}),
      ...defaultHeaders,
      ...options.headers,
    };
    const res = await doFetch(url, {
      method: options.method ?? 'GET',
      credentials: 'include',
      headers,
      signal: options.signal ?? undefined,
      body: options.body,
    });
    const status = res?.status ?? 0;
    const raw = typeof res?.json === 'function' ? await res.json().catch(() => null) : (res?.body ?? null);
    return { url, status, body: parseBody(raw), headers: res?.headers ?? null, res };
  };
}

/**
 * One paced read. Returns the verdict instead of throwing, so a caller can pick
 * the next candidate; throws only when the pacer was stopped or Instagram
 * flagged the account, because in both cases nothing else may run.
 */
export async function spaceRead(ctx, url, options = {}) {
  const { pacer, wait = interruptibleWait, signal = null, classify = classifyResponse } = ctx ?? {};
  if (pacer?.stopped) throw new ApiError('Read session already stopped.', { reason: 'stopped', severity: 'stopped', url });
  if (typeof pacer?.nextDelay === 'function') {
    const delay = pacer.nextDelay();
    if (delay > 0) await wait(delay, { signal });
  }
  const response = await ctx.request(url, options);
  const verdict = classify({ status: response.status, body: response.body, headers: response.headers });
  if (verdict.action === 'abort-session') {
    pacer?.noteError?.(verdict);
    throw new ApiError(verdict.message, { status: response.status, reason: verdict.reason, severity: verdict.severity, url, body: response.body });
  }
  if (verdict.action === 'ok') pacer?.noteSuccess?.();
  else pacer?.noteError?.(verdict);
  return { ...response, verdict };
}

/** The cursor fields differ per endpoint; read whichever is present. */
export function cursorOf(body) {
  return body?.next_max_id ?? body?.page_info?.end_cursor ?? body?.data?.page_info?.end_cursor ?? null;
}

export function hasMoreOf(body) {
  return Boolean(body?.big_list ?? body?.has_more ?? body?.page_info?.has_next_page ?? body?.data?.page_info?.has_next_page);
}

/** One page of a `users: []` list (v1 friendships, likers, search results). */
export function rowsOfUserList(body) {
  if (Array.isArray(body?.users)) return body.users;
  if (Array.isArray(body?.items)) return body.items.map((item) => item?.user ?? item).filter(Boolean);
  return [];
}

/** One page of a legacy web GraphQL edge list. */
export function rowsOfEdges(body, path = 'edge_followed_by') {
  const edges = body?.data?.user?.[path]?.edges ?? body?.[path]?.edges ?? [];
  return edges.map((edge) => edge?.node).filter(Boolean);
}

/** Append the paging parameters a `users: []` endpoint understands. */
export function buildQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/**
 * Walk a paginated endpoint. This is the only pagination loop in the codebase:
 * one place to bound, one place to stop, one place to notice an endpoint that
 * keeps returning the same cursor.
 */
export async function walkPaged(ctx, options = {}) {
  const {
    url,
    pageParams = {},
    buildPageParams = null,
    cursorParam = 'max_id',
    parse = rowsOfUserList,
    cursor = cursorOf,
    hasMore = hasMoreOf,
    signal = null,
    limit = Infinity,
    onProgress = null,
    maxConsecutiveFailures = 3,
    label = 'read',
  } = options;

  const rows = [];
  const seen = new Set();
  let next = null;
  let page = 0;
  let failures = 0;

  while (rows.length < limit) {
    if (signal?.aborted) return { ok: true, stopped: true, rows, pages: page, reason: 'aborted' };
    page += 1;
    const params = typeof buildPageParams === 'function' ? buildPageParams(next) : { ...pageParams, [cursorParam]: next };
    const response = await spaceRead(ctx, `${url}${buildQuery(params)}`, { signal });
    const verdict = response.verdict;
    if (verdict.action !== 'ok') {
      failures += 1;
      if (verdict.action === 'backoff' || verdict.action === 'retry') {
        const backoff = verdict.retryAfterMs ?? 30_000 * failures;
        await (ctx.wait ?? interruptibleWait)(backoff, { signal });
        if (failures >= maxConsecutiveFailures) {
          return { ok: false, stopped: true, rows, pages: page, reason: `${label}: ${failures} consecutive ${verdict.reason} responses`, lastStatus: response.status };
        }
        page -= 1; // the retry replaces this attempt; do not count it twice
        continue;
      }
      return { ok: false, stopped: true, rows, pages: page, reason: `${label}: ${verdict.reason}`, lastStatus: response.status };
    }
    failures = 0;

    let fresh = 0;
    for (const row of parse(response.body)) {
      if (rows.length >= limit) break;
      const key = rowKeyOf(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
      fresh += 1;
    }

    const advanced = cursor(response.body);
    onProgress?.({ page, total: rows.length, fresh, nextCursor: advanced ?? null });
    if (!hasMore(response.body)) return { ok: true, stopped: false, rows, pages: page, reason: null };
    if (!advanced) return { ok: false, stopped: true, rows, pages: page, reason: `${label}: endpoint asked to continue but returned no cursor` };
    if (advanced === next && fresh === 0) return { ok: false, stopped: true, rows, pages: page, reason: `${label}: cursor did not advance` };
    next = advanced;
  }
  return { ok: true, stopped: true, rows, pages: page, reason: 'limit reached' };
}

/** Dedup key for any user-ish row from any endpoint shape. */
export function rowKeyOf(row) {
  const username = row?.username ?? row?.user?.username;
  if (username) return `u:${String(username).toLowerCase()}`;
  const id = row?.pk ?? row?.id ?? row?.user?.pk ?? row?.code ?? row?.pk_id;
  return `i:${String(id ?? JSON.stringify(row ?? null)).slice(0, 80)}`;
}

/* ---------------------------------------------------------------- friendship */

/**
 * Followers or following of `userId`, paged.
 *
 * Tier 1 is the same-origin web endpoint Instagram's own follower dialog calls.
 * Tier 2 is the mobile origin, which sometimes survives a checkpoint that Tier 1
 * does not. Tier 3 is the legacy web GraphQL, which Instagram still answers but
 * with empty edges since 2026-09 — kept only so a shape change back is detected
 * instead of guessed at. Tier 4 is the DOM dialog.
 */
export async function fetchFriendshipList(ctx, {
  userId,
  path,
  count = FRIENDSHIP_PAGE_SIZE,
  query = null,
  limit = Infinity,
  signal = null,
  onProgress = null,
}) {
  if (!userId) return { ok: false, rows: [], pages: 0, reason: 'no user id: resolve the profile first', strategy: null };
  if (path !== 'followers' && path !== 'following') return { ok: false, rows: [], pages: 0, reason: `unknown friendship path: ${path}`, strategy: null };

  const surface = { count, search_surface: 'follow_list_page' };
  const attempts = [
    { strategy: 'v1', url: `${WWW_ORIGIN}/api/v1/friendships/${userId}/${path}/`, pageParams: query ? { ...surface, query } : surface },
    { strategy: 'v1-mobile', url: `${I_ORIGIN}/api/v1/friendships/${userId}/${path}/`, pageParams: query ? { ...surface, query } : surface },
  ];
  if (!query) {
    const edge = path === 'followers' ? 'edge_followed_by' : 'edge_follow';
    attempts.push({
      strategy: 'graphql',
      url: `${WWW_ORIGIN}/graphql/query/`,
      pageParams: {},
      buildVariables: (cursor) => ({ id: String(userId), first: Math.min(50, count), include_reel: true, fetch_mutual: true, ...(cursor ? { after: cursor } : {}) }),
      queryHash: LEGACY_QUERY_HASHES[path],
      edge,
    });
  }

  const failures = [];
  for (const attempt of attempts) {
    const isGraphql = Boolean(attempt.queryHash);
    const result = await walkPaged(ctx, {
      url: attempt.url,
      signal,
      limit,
      onProgress,
      label: `${path}/${attempt.strategy}`,
      maxConsecutiveFailures: 2,
      cursorParam: isGraphql ? 'variables' : 'max_id',
      ...(isGraphql
        ? { pageParams: {}, buildPageParams: (cursor) => ({ query_hash: attempt.queryHash, variables: JSON.stringify(attempt.buildVariables(cursor)) }), parse: (body) => rowsOfEdges(body, attempt.edge) }
        : { pageParams: attempt.pageParams, parse: rowsOfUserList }),
    }).catch((error) => {
      const accountLevel = error instanceof ApiError && ['account', 'auth', 'blocked', 'stopped'].includes(error.severity);
      if (accountLevel) throw error;
      return { ok: false, rows: [], pages: 0, reason: `${attempt.strategy}: ${error.message}` };
    });

    if (result.ok && result.rows.length > 0) return { ...result, strategy: attempt.strategy };
    if (result.reason === 'aborted' || result.reason === 'limit reached') return { ...result, strategy: attempt.strategy };
    failures.push(`${attempt.strategy}: ${result.reason ?? 'empty list'}`);
    if (signal?.aborted) return { ...result, strategy: attempt.strategy };
  }
  return { ok: false, rows: [], pages: 0, reason: failures.join(' | '), strategy: null, attempts: failures };
}

/**
 * Does `username` follow `userId`? One targeted page instead of a full re-read:
 * the follow-list search endpoint answers with 12 rows and settles accept
 * detection for a handful of suspects at a fraction of the read budget.
 */
export async function lookupFollowship(ctx, { userId, username, path = 'followers', signal = null }) {
  const result = await fetchFriendshipList(ctx, { userId, path, query: username, limit: 12, signal });
  if (!result.ok) return { ok: false, found: false, reason: result.reason };
  const wanted = String(username).toLowerCase().replace(/\./g, '');
  const match = result.rows.find((row) => String(row?.username ?? '').toLowerCase().replace(/\./g, '') === wanted);
  return {
    ok: true,
    found: Boolean(match),
    user: match ? normaliseUserRow(match) : null,
    reason: match ? null : `${username} is not in the first page of ${path} results for that query`,
    rowsScanned: result.rows.length,
  };
}

/**
 * Read a follower/following count from any of the shapes Instagram returns —
 * and from this module's own output, so normalising twice is harmless. Losing a
 * count on the second pass would silently re-rank every lead collected from a
 * page that was read from the DOM.
 */
function countOf(user, keys) {
  for (const key of keys) {
    const value = key.includes('.')
      ? key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), user)
      : user?.[key];
    if (value === undefined || value === null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

/** The shape the rest of the app uses, from any of the four list shapes. */
export function normaliseUserRow(row) {
  const user = row?.user ?? row;
  return {
    id: String(user?.pk ?? user?.id ?? user?.pk_id ?? ''),
    username: String(user?.username ?? ''),
    fullName: String(user?.full_name ?? user?.fullName ?? ''),
    isPrivate: Boolean(user?.is_private ?? user?.isPrivate),
    isVerified: Boolean(user?.is_verified ?? user?.isVerified),
    hasAnonymousPic: Boolean(user?.has_anonymous_profile_picture ?? user?.hasAnonymousProfilePicture),
    profilePicUrl: String(user?.profile_pic_url ?? user?.profile_pic_url_hd ?? ''),
    followers: countOf(user, ['follower_count', 'followers', 'edge_followed_by.count']),
    following: countOf(user, ['follow_count', 'following', 'edge_follow.count']),
    friendship: user?.friendship_status ?? null,
    latestReelMedia: user?.latest_reel_media ?? null,
  };
}

export function normaliseUserRows(rows) {
  return rows.map(normaliseUserRow).filter((user) => user.username);
}

/* ------------------------------------------------------------------- profile */

/**
 * One profile. Username or id, whichever the caller has.
 *
 * `web_profile_info` is the endpoint the web bundle itself calls and is the only
 * one that carries the counts and the biography together. When it refuses, the
 * mobile `users/{id}/info/` endpoint is tried, then the DOM of an already-open
 * profile page. A profile that cannot be read returns `{ ok: false }` — the
 * caller must not treat that as "this account has no followers".
 */
export async function fetchProfileByUsername(ctx, { username, signal = null }) {
  const url = `${WWW_ORIGIN}/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const response = await spaceRead(ctx, url, { signal }).catch((error) => {
    if (error instanceof ApiError) throw error;
    return { verdict: { action: 'error', reason: error.message }, status: null, body: null };
  });
  const user = response.body?.data?.user;
  if (user) return { ok: true, user: normaliseProfile(user), source: 'web_profile_info' };
  return { ok: false, user: null, source: null, reason: `web_profile_info refused (${describeRefusal(response)})` };
}

export async function fetchProfileById(ctx, { userId, signal = null }) {
  const response = await spaceRead(ctx, `${I_ORIGIN}/api/v1/users/${encodeURIComponent(userId)}/info/`, { signal })
    .catch((error) => {
    if (error instanceof ApiError) throw error;
    return { verdict: { action: 'error', reason: error.message }, status: null, body: null };
  });
  const user = response.body?.user;
  if (user) return { ok: true, user: normaliseProfile(user), source: 'users_info' };
  return { ok: false, user: null, source: null, reason: `users/{id}/info refused (${describeRefusal(response)})` };
}

export function normaliseProfile(raw) {
  const user = raw?.user ?? raw;
  return {
    id: String(user?.id ?? user?.pk ?? user?.pk_id ?? ''),
    username: String(user?.username ?? ''),
    fullName: String(user?.full_name ?? ''),
    biography: String(user?.biography ?? ''),
    externalUrl: String(user?.external_url ?? user?.external_url_with_click_intent ?? '') || null,
    category: String(user?.category_name ?? user?.category ?? '') || null,
    isPrivate: Boolean(user?.is_private),
    isVerified: Boolean(user?.is_verified),
    isBusiness: Boolean(user?.is_business_account ?? user?.is_professional_account),
    followers: Number(user?.edge_followed_by?.count ?? user?.follower_count ?? 0) || 0,
    following: Number(user?.edge_follow?.count ?? user?.follow_count ?? 0) || 0,
    posts: Number(user?.edge_owner_to_timeline_media?.count ?? user?.media_count ?? 0) || 0,
    profilePicUrl: String(user?.profile_pic_url_hd ?? user?.profile_pic_url ?? ''),
    hasAnonymousPic: Boolean(user?.has_anonymous_profile_picture),
    publicEmail: String(user?.public_email ?? '') || null,
    publicPhone: String(user?.public_phone_number?.national_number ?? user?.contact_phone_number ?? '') || null,
    city: String(user?.city_name ?? user?.city_id ?? '') || null,
  };
}

/** One honest sentence about why a read produced nothing. */
function describeRefusal(response, fallback = 'no user in body') {
  const reason = response?.verdict?.reason;
  if (reason && reason !== 'ok') return reason;
  if (response?.status) return `HTTP ${response.status}`;
  return fallback;
}

/** Read a profile off an already-rendered profile page. Last resort, no request. */
export function scrapeProfileFromDom(document) {
  if (!document) return { ok: false, user: null, reason: 'no document' };
  const header = document.querySelector('header section, main header');
  const text = header ? header.textContent : '';
  const numbers = String(text ?? '').match(/[\d.,]+[KM]?\s*(Followers|Following|Posts|متابع|يتابع|منشور)/gi) ?? [];
  const parsed = {};
  for (const chunk of numbers) {
    const value = chunk.match(/[\d.,]+[KM]?/)?.[0] ?? '';
    const label = chunk.replace(value, '').trim().toLowerCase();
    parsed[label] = parseCountText(value);
  }
  const username = document.querySelector('h1, header h2')?.textContent?.trim() ?? null;
  if (!username) return { ok: false, user: null, reason: 'no username element found on the page' };
  return {
    ok: true,
    source: 'dom',
    user: {
      id: '',
      username,
      fullName: '',
      biography: document.querySelector('header section div')?.textContent?.trim() ?? '',
      followers: pickCount(parsed, ['followers', 'متابع', 'متابعين']) ?? 0,
      following: pickCount(parsed, ['following', 'يتابع', 'أتابعه']) ?? 0,
      posts: pickCount(parsed, ['posts', 'منشور', 'مشاركة']) ?? 0,
      isPrivate: false,
      isVerified: false,
    },
  };
}

/** "1,234" / "12.3K" / "١٢٣" -> number. Arabic-Indic digits included. */
export function parseCountText(text) {
  // Digits and separators are built from code points so this file stays pure
  // ASCII on disk and survives any editor or transport that mangles bidi text.
  const from = (start) => Array.from({ length: 10 }, (_, i) => String.fromCharCode(start + i));
  const arabicIndic = from(0x0660); // ARABIC-INDIC DIGIT ZERO..NINE
  const extendedArabic = from(0x06f0); // EXTENDED ARABIC-INDIC DIGIT ZERO..NINE
  // [character, replacement]: the Arabic thousands separator is dropped, the
  // Arabic decimal separator becomes a point. Order matters.
  const separators = [[',', ''], [String.fromCharCode(0x066c), ''], [String.fromCharCode(0x066b), '.']];
  const thousandsWords = [String.fromCharCode(0x0623) + String.fromCharCode(0x0644) + String.fromCharCode(0x0641)]; // "alf"
  const millionsWord = String.fromCharCode(0x0645) + String.fromCharCode(0x0644) + String.fromCharCode(0x064a) + String.fromCharCode(0x0648) + String.fromCharCode(0x0646); // "malyun"

  let normalised = String(text ?? '');
  arabicIndic.forEach((digit, index) => { normalised = normalised.split(digit).join(String(index)); });
  extendedArabic.forEach((digit, index) => { normalised = normalised.split(digit).join(String(index)); });
  for (const [separator, replacement] of separators) normalised = normalised.split(separator).join(replacement);
  normalised = normalised.trim();

  const match = normalised.match(/^(\d+(?:\.\d+)?)/);
  if (!match) return NaN;
  const value = Number(match[1]);
  const rest = normalised.slice(match[0].length).trim().toLowerCase();
  if (rest.startsWith('k') || thousandsWords.some((word) => rest.startsWith(word))) return Math.round(value * 1000);
  if (rest.startsWith('m') || rest.startsWith(millionsWord)) return Math.round(value * 1_000_000);
  return Math.round(value);
}

function pickCount(parsed, labels) {
  for (const label of labels) {
    for (const [key, value] of Object.entries(parsed)) {
      if (key.includes(label) && Number.isFinite(value)) return value;
    }
  }
  return null;
}

/* ------------------------------------------------------- comments and likers */

/**
 * Call a web GraphQL persisted query.
 *
 * doc_id values rotate every few weeks, so they are harvested from the live page
 * by `probe.js` and passed in as an ordered candidate list. A 400 means "this
 * doc_id is stale": the next candidate is tried, and only when every candidate
 * has failed does the adapter report failure — with the reasons, so the UI can
 * say "the comments endpoint moved" instead of showing zero comments.
 */
export async function callGraphql(ctx, { docIds = [], variables, signal = null, queryHash = null }) {
  const candidates = docIds.filter(Boolean);
  const reasons = [];
  for (const docId of candidates) {
    const url = `${WWW_ORIGIN}/api/graphql/?doc_id=${encodeURIComponent(docId)}`;
    const response = await spaceRead(ctx, url, {
      signal,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ variables: JSON.stringify(variables ?? {}) }).toString(),
    });
    if (response.verdict?.action === 'ok') return { ok: true, body: response.body, docId, reason: null };
    reasons.push(`${docId}: ${response.verdict?.reason ?? response.status ?? 'refused'}`);
    // Anything other than a stale signature is not fixed by another candidate.
    if (response.verdict?.reason && !/http_400|http_404/.test(response.verdict.reason)) break;
  }
  if (queryHash && reasons.length > 0) {
    const url = `${WWW_ORIGIN}/graphql/query/?query_hash=${encodeURIComponent(queryHash)}&variables=${encodeURIComponent(JSON.stringify(variables ?? {}))}`;
    const response = await spaceRead(ctx, url, { signal });
    if (response.verdict?.action === 'ok') return { ok: true, body: response.body, docId: null, queryHash, reason: null };
    reasons.push(`query_hash ${queryHash}: ${response.verdict?.reason ?? response.status ?? 'refused'}`);
  }
  return { ok: false, body: null, docId: null, reason: reasons.length ? reasons.join(' | ') : 'no doc_id candidates were harvested from the page' };
}

/** The first usable doc_id, or null. Nothing is invented: a guess is a 400. */
export function firstDocId(docIds = []) {
  return docIds.filter(Boolean)[0] ?? null;
}

/** Dig the first object out of a GraphQL body that carries the wanted key. */
export function findNodeWith(body, key) {
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 8 || seen.has(node)) return null;
    seen.add(node);
    if (node[key] && typeof node[key] === 'object') return node[key];
    for (const value of Object.values(node)) {
      const found = walk(value, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(body, 0);
}

/**
 * Comments on one post, paged, oldest to newest.
 * Requires the post's media id: the shortcode alone is not enough for the web
 * endpoint, so `fetchMediaIdForShortcode` runs first.
 */
export async function fetchComments(ctx, { mediaId, docIds = [], limit = 200, signal = null, onProgress = null }) {
  if (!mediaId) return { ok: false, rows: [], reason: 'no media id: resolve the shortcode first' };
  if (!firstDocId(docIds)) return { ok: false, rows: [], reason: 'no doc_id candidates harvested from the page: comments endpoint unavailable' };
  const result = await walkPaged(ctx, {
    url: `${WWW_ORIGIN}/api/graphql/`,
    buildPageParams: (cursor) => ({
      doc_id: firstDocId(docIds),
      variables: JSON.stringify({ first: 50, ...(cursor ? { after: cursor } : {}), UFI2CommentsProvider_commentsKey: `profileMediaCommentPage__${mediaId}`, feedbackSource: 0, mediaID: String(mediaId) }),
    }),
    label: 'comments',
    signal,
    limit,
    onProgress,
    parse: (body) => {
      const connection = findNodeWith(body, 'edge_owner_to_timeline_media') ?? findNodeWith(body, 'comments') ?? findNodeWith(body, 'edge_media_to_parent_comment');
      const edges = connection?.comments?.edges ?? connection?.edges ?? [];
      return edges.map((edge) => edge?.node).filter(Boolean);
    },
    cursor: (body) => {
      const connection = findNodeWith(body, 'comments') ?? findNodeWith(body, 'edge_media_to_parent_comment');
      return connection?.page_info?.end_cursor ?? null;
    },
    hasMore: (body) => {
      const connection = findNodeWith(body, 'comments') ?? findNodeWith(body, 'edge_media_to_parent_comment');
      return Boolean(connection?.page_info?.has_next_page);
    },
  }).catch((error) => ({ ok: false, rows: [], reason: error.message }));

  if (!result.ok && result.reason?.includes('no user in body')) return result;
  // `doc_id` cannot be invented: without candidates the call is pointless.
  if (!docIds.some(Boolean)) return { ok: false, rows: [], reason: 'no doc_id candidates harvested from the page: comments endpoint unavailable' };
  return { ...result, rows: (result.rows ?? []).map(normaliseComment) };
}

export function normaliseComment(raw) {
  const owner = raw?.owner ?? raw?.user ?? {};
  return {
    id: String(raw?.id ?? raw?.pk ?? ''),
    text: String(raw?.text ?? ''),
    username: String(owner?.username ?? ''),
    ownerName: String(owner?.full_name ?? ''),
    ownerId: String(owner?.id ?? owner?.pk ?? ''),
    likes: Number(raw?.comment_like_count ?? raw?.like_count ?? 0) || 0,
    createdAt: Number(raw?.created_at ?? raw?.created_at_utc ?? 0) || 0,
    didReportAsSpam: Boolean(raw?.did_report_as_spam),
  };
}

/** Likers of one post — the highest-intent audience that is still cheap to read. */
export async function fetchLikers(ctx, { mediaId, shortcode = null, docIds = [], limit = 200, signal = null, onProgress = null }) {
  if (!mediaId && !shortcode) return { ok: false, rows: [], reason: 'no media id or shortcode' };
  if (!firstDocId(docIds)) return { ok: false, rows: [], reason: 'no doc_id candidates harvested from the page: likers endpoint unavailable' };
  const variablesBase = mediaId ? { mediaID: String(mediaId) } : { shortcode: String(shortcode) };
  const result = await walkPaged(ctx, {
    url: `${WWW_ORIGIN}/api/graphql/`,
    buildPageParams: (cursor) => ({
      doc_id: firstDocId(docIds),
      variables: JSON.stringify({ first: 50, ...(cursor ? { after: cursor } : {}), ...variablesBase }),
    }),
    label: 'likers',
    signal,
    limit,
    onProgress,
    parse: (body) => {
      const likes = findNodeWith(body, 'likes') ?? findNodeWith(body, 'edge_liked_by');
      const edges = likes?.edges ?? [];
      if (edges.length) return edges.map((edge) => edge?.node).filter(Boolean);
      return Array.isArray(likes?.users) ? likes.users : [];
    },
    cursor: (body) => (findNodeWith(body, 'likes') ?? findNodeWith(body, 'edge_liked_by'))?.page_info?.end_cursor ?? null,
    hasMore: (body) => Boolean((findNodeWith(body, 'likes') ?? findNodeWith(body, 'edge_liked_by'))?.page_info?.has_next_page),
  }).catch((error) => ({ ok: false, rows: [], reason: error.message }));
  if (!docIds.some(Boolean)) return { ok: false, rows: [], reason: 'no doc_id candidates harvested from the page: likers endpoint unavailable' };
  return { ...result, rows: normaliseUserRows(result.rows ?? []) };
}

/** Shortcode -> media id, via the post page's embedded JSON. One read. */
export async function fetchMediaIdForShortcode(ctx, { shortcode, signal = null }) {
  const url = `${WWW_ORIGIN}/api/v1/media/${encodeURIComponent(shortcode)}/info/`;
  const response = await spaceRead(ctx, url, { signal }).catch((error) => {
    if (error instanceof ApiError) throw error;
    return { verdict: { action: 'error', reason: error.message }, status: null, body: null };
  });
  const item = response.body?.items?.[0] ?? null;
  if (item?.id || item?.pk) return { ok: true, mediaId: String(item.id ?? item.pk), takenAt: Number(item.taken_at ?? 0) * 1000 || null, caption: String(item.caption?.text ?? '') };
  return { ok: false, mediaId: null, reason: `media info refused (${describeRefusal(response, 'no item')})` };
}

/* --------------------------------------------------------- DOM-only adapters */

/**
 * Read the accounts rendered in an open list dialog (followers, following,
 * mutual friends). No request: this is what a human sees, so it is also the
 * fallback when every endpoint tier has been refused.
 *
 * Driven by `walkDomList`, which scrolls the dialog's own scrollable element in
 * human-sized steps and stops when three consecutive scrolls render nothing new.
 */
export async function scrapeModalUserList(ctx, {
  document,
  findList = null,
  limit = Infinity,
  signal = null,
  onProgress = null,
  maxStalledScrolls = 3,
  scrollStepRatio = 0.8,
  settleMs = 450,
} = {}) {
  if (!document) return { ok: false, rows: [], reason: 'no document' };
  const list = findList?.() ?? null;
  if (!list) return { ok: false, rows: [], reason: 'no open list dialog found' };

  const rows = [];
  const seen = new Set();
  let stalled = 0;
  let scrolls = 0;

  const collect = () => {
    let fresh = 0;
    for (const row of userLinksFrom(list)) {
      if (rows.length >= limit) break;
      const key = row.username.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ username: row.username, fullName: row.fullName, id: '', isPrivate: false, isVerified: false });
      fresh += 1;
    }
    return fresh;
  };

  collect();
  while (rows.length < limit && stalled < maxStalledScrolls) {
    if (signal?.aborted) return { ok: true, stopped: true, rows, scrolls, reason: 'aborted' };
    const room = (list.scrollHeight ?? 0) - (list.clientHeight ?? 0);
    if (room <= 0) break;
    const step = Math.max(60, Math.round((list.clientHeight || 400) * scrollStepRatio));
    list.scrollTop = Math.min(list.scrollTop + step, room);
    scrolls += 1;
    await (ctx.wait ?? interruptibleWait)(settleMs, { signal });
    const fresh = collect();
    stalled = fresh === 0 ? stalled + 1 : 0;
    onProgress?.({ scrolls, total: rows.length, fresh });
    if (list.scrollTop >= room) {
      // At the bottom: give the next page one more chance before declaring done.
      if (stalled >= 1) break;
    }
  }
  return { ok: true, stopped: rows.length >= limit, rows, scrolls, reason: rows.length ? null : 'the dialog rendered no account rows' };
}

/** Authors of tiles on a hashtag, explore or saved grid. */
export function scrapeGridAuthors(document, { limit = Infinity } = {}) {
  if (!document) return { ok: false, rows: [], reason: 'no document' };
  const rows = gridTileAuthors(document);
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (out.length >= limit) break;
    const key = row.username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ username: row.username, fullName: '', id: '', href: row.href });
  }
  return { ok: out.length > 0, rows: out, reason: out.length ? null : 'no account tiles rendered on this grid' };
}

/** The account a rendered profile page belongs to, read from the DOM only. */
export function scrapeOpenProfile(document, { location = null } = {}) {
  const href = location?.href ?? document?.location?.href ?? '';
  let pathname = '';
  try {
    pathname = new URL(href).pathname;
  } catch {
    pathname = String(href).replace(/^https?:\/\/[^/]+/, '');
  }
  const username = usernameFromPath(pathname);
  if (!username) return { ok: false, user: null, reason: 'this page is not a profile' };
  const scraped = scrapeProfileFromDom(document);
  return scraped.ok
    ? { ok: true, user: { ...scraped.user, username }, source: 'dom' }
    : { ok: false, user: null, reason: scraped.reason };
}

export { gridTileAuthors, userLinksFrom, usernameFromPath };
