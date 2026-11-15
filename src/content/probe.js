/**
 * Runtime identity and capability probe.
 *
 * Everything this extension sends to Instagram depends on values that Instagram
 * owns and rotates: the web app id, the ASBD ids, the CSRF token and the logged
 * in viewer. None of them may be hardcoded, because a stale value is a silent
 * 400 that looks exactly like an account block. This module reads them from the
 * live page on every session and reports, honestly, which acquisition paths are
 * actually available right now.
 *
 * Page-scoped by design: it touches `document` and `location`, so the modules
 * that consume its output take the values as arguments and stay unit-testable.
 */

/** Web app id Instagram's own bundle uses. Read from the page first. */
export const APP_ID_CANDIDATES = Object.freeze(['936619743392459', '1217981644879628']);

/** ASBD ids seen in the web bundle. Best effort: a wrong one still works. */
export const ASBD_CANDIDATES = Object.freeze(['129477', '129424', '129475']);

export const Path = Object.freeze({
  INTERNAL_API: 'internal_api',
  EMBEDDED_JSON: 'embedded_json',
  DOM: 'dom',
});

function scriptsOf(document) {
  try {
    return [...document.querySelectorAll('script')];
  } catch {
    return [];
  }
}

/** Read the app id from the live page rather than trusting a constant. */
export function detectAppId(document) {
  for (const script of scriptsOf(document)) {
    const text = script.textContent;
    if (!text || text.length > 4_000_000) continue;
    const match = text.match(/"X-IG-App-ID"\s*:\s*"(\d+)"/) ??
      text.match(/x-ig-app-id["']?\s*[:=]\s*["'](\d{10,})["']/i) ??
      text.match(/appId["']?\s*[:=]\s*["'](\d{10,})["']/);
    if (match) return { appId: match[1], source: 'page' };
  }
  return { appId: APP_ID_CANDIDATES[0], source: 'fallback-constant' };
}

/**
 * Harvest GraphQL doc_ids from the page's own scripts. NEVER hardcode one:
 * Instagram rotates them every few weeks and a stale doc_id is a silent 400.
 */
export function harvestDocIds(document) {
  const found = new Set();
  for (const script of scriptsOf(document)) {
    const text = script.textContent;
    if (!text || text.length > 4_000_000) continue;
    for (const match of text.matchAll(/"doc_id"\s*:\s*"?(\d{6,})"?/g)) found.add(match[1]);
    for (const match of text.matchAll(/doc_id=(\d{6,})/g)) found.add(match[1]);
  }
  return [...found];
}

/** Cookie reader. Split on `;` so a value containing `=` survives intact. */
export function readCookies(cookieString) {
  const out = {};
  for (const part of String(cookieString ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key) out[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

/** Is a logged-in session present? Changes both capability and risk posture. */
export function detectSession(cookieString) {
  const cookies = readCookies(cookieString);
  const loggedIn = Boolean(cookies.sessionid || cookies.ds_user_id);
  return {
    loggedIn,
    csrfToken: cookies.csrftoken ?? null,
    sessionUserId: cookies.ds_user_id ?? null,
    asbd: cookies.asbd ?? null,
    note: loggedIn
      ? 'Logged in. Requests carry your session, so anything this extension does is attributable to your account.'
      : 'Logged out. Reads are limited and no action can be taken.',
  };
}

/** ASBD id: the cookie when present, otherwise the first known candidate. */
export function detectAsbd(cookieString) {
  const fromCookie = readCookies(cookieString).asbd;
  if (fromCookie) return { asbd: fromCookie, source: 'cookie' };
  return { asbd: ASBD_CANDIDATES[0], source: 'fallback-constant' };
}

/**
 * Page tokens (`lsd`, `fb_dtsg`) that some web endpoints still expect in the
 * body. Read from an inline script, never stored across sessions.
 */
export function detectPageTokens(document) {
  const tokens = { lsd: null, fbDtsg: null };
  for (const script of scriptsOf(document)) {
    const text = script.textContent;
    if (!text || text.length > 4_000_000) continue;
    if (!tokens.lsd) {
      tokens.lsd = text.match(/\[\s*"LSD"\s*\]\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/)?.[1]
        ?? text.match(/"LSD"[\s\S]{0,40}?"token"\s*:\s*"([^"]+)"/)?.[1]
        ?? text.match(/\blsd["']?\s*[:=]\s*["']([\w-]{6,})["']/i)?.[1]
        ?? null;
    }
    if (!tokens.fbDtsg) {
      tokens.fbDtsg = text.match(/\[\s*"DTSGInitialData"\s*\]\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/)?.[1]
        ?? text.match(/DTSGInitialData[\s\S]{0,40}?"token"\s*:\s*"([^"]+)"/)?.[1]
        ?? null;
    }
    if (tokens.lsd && tokens.fbDtsg) break;
  }
  return tokens;
}

/** Locate embedded JSON blobs. `window._sharedData` and `?__a=1` are dead. */
export function findEmbeddedJson(document) {
  const results = [];
  for (const script of scriptsOf(document).filter((s) => (s.getAttribute?.('type') ?? '') === 'application/json')) {
    const text = script.textContent;
    if (!text || text.length < 50) continue;
    if (/"viewer"|"user"|"profile_pic_url"|"xdt_api"/.test(text)) {
      results.push({ id: script.id || null, length: text.length });
    }
  }
  return results;
}

/** Do the DOM selectors we depend on still match anything? */
export function probeDom(document) {
  const checks = {
    profileHeader: 'header section, main header',
    postLinks: 'a[href^="/p/"], a[href^="/reel/"]',
    counts: 'header li span, main section span',
    dialogs: '[role="dialog"]',
    composer: '[contenteditable="true"]',
  };
  const out = {};
  for (const [name, selector] of Object.entries(checks)) {
    let count = -1;
    try {
      count = document.querySelectorAll(selector).length;
    } catch {
      count = -1;
    }
    out[name] = { selector, count, ok: count > 0 };
  }
  return out;
}

/**
 * The logged-in viewer, from the endpoint Instagram's own bundle calls.
 * Returns null when logged out or when the endpoint refuses: callers must treat
 * a null viewer as "no session", never as "no leads".
 */
/**
 * Unwrap one response.
 *
 * `createApi` returns `{ url, status, body, headers }` so a caller can inspect
 * the HTTP status; a hand-rolled test request usually returns the parsed body
 * directly. Both are accepted here rather than forcing every caller to adapt,
 * because guessing wrong silently reads as "not logged in".
 */
function responseBody(result) {
  if (result && typeof result === 'object' && typeof result.status === 'number' && 'body' in result) return result.body;
  return result;
}

export async function probeViewer({ request, appId, asbd, signal }) {
  const url = 'https://www.instagram.com/api/v1/users/web_profile_info/?username=me';
  try {
    const body = responseBody(await request(url, { appId, asbd, signal, headers: { 'x-ig-www-claim': '0' } }));
    const viewer = body?.data?.user ?? null;
    if (!viewer) {
      // The username=me alias is not universal; fall back to the accounts API.
      const account = responseBody(await request('https://i.instagram.com/api/v1/accounts/current_user/?edit=true', { appId, asbd, signal }));
      const user = account?.user;
      if (!user) return null;
      return {
        id: String(user.pk ?? user.pk_id ?? ''),
        username: user.username ?? '',
        fullName: user.full_name ?? '',
        followers: Number(user.follower_count ?? 0),
        following: Number(user.following_count ?? 0),
        isPrivate: Boolean(user.is_private),
        isVerified: Boolean(user.is_verified),
        source: 'accounts_current_user',
      };
    }
    return {
      id: String(viewer.id ?? ''),
      username: viewer.username ?? '',
      fullName: viewer.full_name ?? '',
      followers: Number(viewer.edge_followed_by?.count ?? 0),
      following: Number(viewer.edge_follow?.count ?? 0),
      isPrivate: Boolean(viewer.is_private),
      isVerified: Boolean(viewer.is_verified),
      source: 'web_profile_info',
    };
  } catch {
    return null;
  }
}

/** Full probe. Cheap and read-only apart from the optional viewer lookup. */
export async function runProbe({ document, location, cookieString, request = null } = {}) {
  const session = detectSession(cookieString ?? document?.cookie ?? '');
  const { appId, source: appIdSource } = detectAppId(document);
  const { asbd, source: asbdSource } = detectAsbd(cookieString ?? document?.cookie ?? '');
  const docIds = harvestDocIds(document);
  const embedded = findEmbeddedJson(document);
  const dom = probeDom(document);
  const tokens = detectPageTokens(document);

  const paths = {
    [Path.INTERNAL_API]: {
      available: session.loggedIn && Boolean(appId),
      confidence: appIdSource === 'page' ? 'high' : 'low',
      detail: !session.loggedIn
        ? 'Not logged in: the internal API will refuse everything.'
        : appIdSource === 'page'
          ? 'App id read from the live page.'
          : 'App id not found in page scripts; using a documented constant that may be stale.',
    },
    [Path.EMBEDDED_JSON]: {
      available: embedded.length > 0,
      confidence: 'medium',
      detail: embedded.length ? `${embedded.length} candidate JSON blob(s) in the page.` : 'No embedded profile JSON found.',
    },
    [Path.DOM]: {
      available: Object.values(dom).some((d) => d.ok),
      confidence: 'low',
      detail: 'DOM reading is the last resort: Instagram obfuscates class names and renames them without notice.',
    },
  };

  const viewer = request ? await probeViewer({ request, appId, asbd }) : null;

  return {
    probedAt: new Date().toISOString(),
    url: location?.href ?? null,
    session,
    appId,
    appIdSource,
    asbd,
    asbdSource,
    tokens,
    docIds,
    docIdCount: docIds.length,
    embedded,
    dom,
    viewer,
    paths,
    anyPathAvailable: Object.values(paths).some((p) => p.available),
    caveat:
      'Endpoints and field names are read from the live page on every session and are never cached. If a path reports available but returns nothing, Instagram changed its internals — that is expected over time.',
  };
}
