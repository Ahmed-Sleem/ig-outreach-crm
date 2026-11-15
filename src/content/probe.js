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

/** Reserved Instagram routes that are navigation chrome, never usernames. */
const VIEWER_RESERVED_PATHS = new Set([
  'accounts', 'explore', 'reels', 'reel', 'direct', 'p', 'tv', 'stories',
  'create', 'saved', 'notifications', 'activity', 'settings', 'about', 'legal',
  'privacy', 'terms', 'help', 'developer', 'developers', 'threads', 'meta',
  'lite', 'nametag', 'session', 'challenge', 'consent', 'oauth', 'api', 'graphql',
  'a', 'c', 's', 'web', 'your_activity', 'archive', 'close_friends',
]);

function validViewerUsername(raw) {
  const clean = String(raw ?? '').trim().replace(/^@/, '').replace(/^\/+|\/+$/g, '');
  if (!clean || clean.length > 30) return null;
  if (!/^[A-Za-z0-9._]+$/.test(clean)) return null;
  if (VIEWER_RESERVED_PATHS.has(clean.toLowerCase())) return null;
  return clean;
}

function usernameFromLinkHref(href) {
  const raw = String(href ?? '').trim();
  if (!raw) return null;
  let path = raw;
  try {
    if (/^https?:/i.test(raw)) path = new URL(raw).pathname;
  } catch { /* relative path */ }
  const parts = path.split('?')[0].split('#')[0].split('/').filter(Boolean);
  if (parts.length !== 1) return null;
  return validViewerUsername(parts[0]);
}

function usernameFromProfilePicAlt(alt) {
  const text = String(alt ?? '').trim();
  if (!text) return null;
  // English: "my_shop's profile picture" or "Profile picture of my_shop"
  const en = text.match(/^([A-Za-z0-9._]{1,30})['’]s\s+profile\s+picture/i)
    ?? text.match(/profile\s+picture\s+(?:of|for)\s+([A-Za-z0-9._]{1,30})/i);
  if (en) return validViewerUsername(en[1]);
  // Arabic: "صورة الملف الشخصي لـ my_shop" or "صورة الملف الشخصي لmy_shop"
  const ar = text.match(/صورة\s+الملف\s+الشخصي\s+ل[ـ\s]*([A-Za-z0-9._]{1,30})/i);
  if (ar) return validViewerUsername(ar[1]);
  return null;
}

/**
 * Detect the logged-in Instagram viewer strictly from the open page DOM and
 * cookies — ZERO network or API requests.
 *
 * Checks, in order:
 *   1. Left/bottom navigation Profile link (`a[href="/<username>/"]`) with a
 *      profile-picture `<img>` or "Profile" / "الملف الشخصي" label.
 *   2. Any `<img alt="<username>'s profile picture">` inside `<nav>` /
 *      `[role="navigation"]`.
 *   3. Embedded page `<script>` JSON already loaded by Instagram (`PolarisViewer`
 *      / `CurrentUserInitialData` / `"viewer":{...}`), read locally without fetch.
 *   4. The `ds_user_id` cookie alone (proves logged in even before sidebar renders).
 */
export function detectViewerFromDom(document, cookieString = '') {
  const cookies = readCookies(cookieString ?? document?.cookie ?? '');
  const cookieId = cookies.ds_user_id ? String(cookies.ds_user_id) : '';
  const loggedIn = Boolean(cookies.sessionid || cookieId);
  let username = '';
  let fullName = '';
  let id = cookieId;
  let source = null;

  if (document && typeof document.querySelectorAll === 'function') {
    // 1. Navigation rail / bottom bar Profile link
    const navScopes = [
      ...document.querySelectorAll('nav, [role="navigation"], header'),
    ];
    const scopes = navScopes.length ? navScopes : [document];

    for (const scope of scopes) {
      let links = [];
      try { links = [...scope.querySelectorAll('a[href]')]; } catch { links = []; }
      for (const link of links) {
        const candidate = usernameFromLinkHref(link.getAttribute?.('href') ?? link.href ?? '');
        if (!candidate) continue;
        const text = String(link.textContent ?? '').trim().toLowerCase();
        const aria = String(link.getAttribute?.('aria-label') ?? '').trim().toLowerCase();
        const img = link.querySelector?.('img[alt]');
        const imgAlt = String(img?.getAttribute?.('alt') ?? '');
        const looksLikeProfile =
          /\bprofile\b|الملف الشخصي/i.test(text)
          || /\bprofile\b|الملف الشخصي/i.test(aria)
          || /profile\s+picture|صورة\s+الملف/i.test(imgAlt);
        if (looksLikeProfile) {
          username = candidate;
          source = 'dom_nav_profile';
          break;
        }
      }
      if (username) break;

      // 2. Profile picture alt inside nav even if href structure changed
      let imgs = [];
      try { imgs = [...scope.querySelectorAll('img[alt]')]; } catch { imgs = []; }
      for (const img of imgs) {
        const candidate = usernameFromProfilePicAlt(img.getAttribute?.('alt'));
        if (candidate) {
          username = candidate;
          source = 'dom_nav_avatar';
          break;
        }
      }
      if (username) break;
    }

    // 3. Embedded page script JSON (read-only DOM text, zero network calls)
    if (!username || !id) {
      for (const script of scriptsOf(document)) {
        const text = script.textContent;
        if (!text || text.length < 40 || text.length > 4_000_000) continue;
        if (!/viewer|CurrentUserInitialData|PolarisViewer|USER_ID/.test(text)) continue;

        if (!username) {
          const viewerMatch =
            text.match(/"viewer"\s*:\s*\{[^{}]{0,600}?"username"\s*:\s*"([A-Za-z0-9._]{1,30})"/)
            ?? text.match(/"PolarisViewer"[^{}]{0,200}\{[^{}]{0,600}?"username"\s*:\s*"([A-Za-z0-9._]{1,30})"/)
            ?? text.match(/"CurrentUserInitialData"[\s\S]{0,400}?"USERNAME"\s*:\s*"([A-Za-z0-9._]{1,30})"/);
          const candidate = validViewerUsername(viewerMatch?.[1]);
          if (candidate) {
            username = candidate;
            source = source ?? 'embedded_dom_json';
          }
        }
        if (!fullName) {
          const fnMatch = text.match(/"viewer"\s*:\s*\{[^{}]{0,600}?"full_name"\s*:\s*"([^"\\]{1,80})"/);
          if (fnMatch) fullName = fnMatch[1];
        }
        if (!id) {
          const idMatch =
            text.match(/"viewer"\s*:\s*\{[^{}]{0,600}?"id"\s*:\s*"(\d{4,})"/)
            ?? text.match(/"USER_ID"\s*:\s*"(\d{4,})"/);
          if (idMatch) id = idMatch[1];
        }
        if (username && id) break;
      }
    }
  }

  // Only return a viewer object when DOM actually identified a viewer (username
  // or embedded viewer JSON). When only `ds_user_id` cookie is present, callers
  // still have `session.loggedIn === true` and `session.sessionUserId === id`.
  if (!username) return null;

  return {
    id: String(id || ''),
    username,
    fullName,
    followers: null,
    following: null,
    isPrivate: false,
    isVerified: false,
    source: source ?? 'dom',
  };
}

/** Full probe. Cheap and 100% read-only; detects viewer from live DOM first with zero API calls. */
export async function runProbe({ document, location, cookieString, request = null } = {}) {
  const effectiveCookies = cookieString ?? document?.cookie ?? '';
  const session = detectSession(effectiveCookies);
  const { appId, source: appIdSource } = detectAppId(document);
  const { asbd, source: asbdSource } = detectAsbd(effectiveCookies);
  const docIds = harvestDocIds(document);
  const embedded = findEmbeddedJson(document);
  const dom = probeDom(document);
  const tokens = detectPageTokens(document);

  const domViewer = detectViewerFromDom(document, effectiveCookies);
  // Prefer zero-API DOM detection. Only call `request` if explicitly passed AND DOM did not identify the viewer.
  let viewer = domViewer;
  if ((!viewer || !viewer.username) && typeof request === 'function') {
    const apiViewer = await probeViewer({ request, appId, asbd });
    if (apiViewer) {
      viewer = {
        ...(domViewer ?? {}),
        ...apiViewer,
        id: apiViewer.id || domViewer?.id || '',
        username: apiViewer.username || domViewer?.username || '',
      };
    }
  }

  const effectiveLoggedIn = Boolean(session.loggedIn || viewer?.username || viewer?.id);
  const effectiveSession = effectiveLoggedIn && !session.loggedIn
    ? {
      ...session,
      loggedIn: true,
      sessionUserId: session.sessionUserId ?? (viewer?.id || null),
      note: 'Logged in (detected from live Instagram page DOM).',
    }
    : session;

  const paths = {
    [Path.DOM]: {
      available: Object.values(dom).some((d) => d.ok) || effectiveLoggedIn,
      confidence: 'high',
      detail: 'Primary path: visible browser automation reading the live Instagram DOM directly (no API calls).',
    },
    [Path.EMBEDDED_JSON]: {
      available: embedded.length > 0,
      confidence: 'medium',
      detail: embedded.length ? `${embedded.length} embedded JSON blob(s) already in the page.` : 'No embedded profile JSON found.',
    },
    [Path.INTERNAL_API]: {
      available: effectiveLoggedIn && Boolean(appId),
      confidence: appIdSource === 'page' ? 'high' : 'low',
      detail: !effectiveLoggedIn
        ? 'Not logged in.'
        : appIdSource === 'page'
          ? 'App id read from the live page (unused by browser-driven collection).'
          : 'App id not found in page scripts; fallback constant may be stale (unused by browser-driven collection).',
    },
  };

  return {
    probedAt: new Date().toISOString(),
    url: location?.href ?? null,
    session: effectiveSession,
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
      'All collection and outreach operate directly in your visible Instagram browser tab without calling Instagram private APIs.',
  };
}
