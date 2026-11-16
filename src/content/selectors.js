/**
 * The single source of Instagram UI strings and element finders.
 *
 * Instagram renders different labels per locale. Hardcoding `textContent ===
 * 'Follow'` fails completely on an Arabic session, and substring matching
 * (`.includes('Follow')`) misclicks "Following" when you meant "Follow". Every
 * label here is matched exactly, after trimming and whitespace collapse, in
 * every supported language, and adding a language means adding rows here and
 * nowhere else.
 *
 * Pure DOM: no network, no chrome APIs, so the finders are unit-testable
 * against the DOM shim.
 */

export const Label = Object.freeze({
  FOLLOW: 'follow',
  FOLLOWING: 'following',
  REQUESTED: 'requested',
  FOLLOW_BACK: 'followBack',
  MESSAGE: 'message',
  SEND: 'send',
  UNFOLLOW: 'unfollow',
  CANCEL: 'cancel',
  TRY_AGAIN_LATER: 'tryAgainLater',
  CONFIRM: 'confirm',
});

/** Exact trimmed labels per language. Order matters only for readability. */
export const LABEL_TEXT = Object.freeze({
  [Label.FOLLOW]: ['Follow', 'متابعة'],
  [Label.FOLLOWING]: ['Following', 'أتابعه', 'تتابعه'],
  [Label.REQUESTED]: ['Requested', 'تم الطلب'],
  [Label.FOLLOW_BACK]: ['Follow Back', 'رد المتابعة'],
  [Label.MESSAGE]: ['Message', 'مراسلة'],
  [Label.SEND]: ['Send', 'إرسال'],
  [Label.UNFOLLOW]: ['Unfollow', 'إلغاء المتابعة'],
  [Label.CANCEL]: ['Cancel', 'إلغاء'],
  [Label.TRY_AGAIN_LATER]: ['Try Again Later', 'حاول لاحقًا', 'حاولي لاحقًا'],
  [Label.CONFIRM]: ['Confirm', 'تأكيد'],
});

const LABEL_LOOKUP = (() => {
  const map = new Map();
  for (const [kind, texts] of Object.entries(LABEL_TEXT)) {
    for (const text of texts) map.set(collapse(text), kind);
  }
  return map;
})();

export function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Which label kind this visible text is, or null. Exact match, never substring. */
export function labelKind(text) {
  return LABEL_LOOKUP.get(collapse(text)) ?? null;
}

/**
 * Routes that are chrome, not accounts. `/explore` is not a lead called
 * "explore", and treating it as one would queue a follow to a page that does
 * not exist.
 */
export const RESERVED_SEGMENTS = Object.freeze([
  'explore', 'reels', 'reel', 'p', 'tv', 'stories', 'direct', 'accounts',
  'about', 'developer', 'legal', 'emailsignup', 'api', 'challenge',
  'privacy', 'terms', 'jobs', 'developers', 'settings', 'notifications',
  'inbox', 'session', 'oauth', 'static', 'graphql', 'web', 'graphs',
  'favicon.ico', 'robots.txt', 'saved', 'tag', 'tags', 'create', 'activity',
  'your_activity', 'archive', 'close_friends', 'threads', 'meta', 'lite',
  'nametag', 'consent', 'a', 'c', 's', 'collections', 'followers', 'following',
  'liked_by', 'tagged', 'channel', 'audio', 'locations', 'popular', 'help',
]);

export function isReservedSegment(segment) {
  return RESERVED_SEGMENTS.includes(String(segment ?? '').toLowerCase());
}

/** True when `raw` matches Instagram's username grammar and is not a chrome route. */
export function isValidIgUsername(raw) {
  const clean = String(raw ?? '').trim().replace(/^@/, '').replace(/^\/+|\/+$/g, '');
  if (!clean || clean.length > 30) return false;
  if (!/^[A-Za-z0-9._]+$/.test(clean)) return false;
  if (clean.startsWith('.') || clean.endsWith('.') || clean.includes('..')) return false;
  return !isReservedSegment(clean);
}

/** Username from a pathname like "/sara_shop/?hl=en", or null when reserved. */
export function usernameFromPath(pathname) {
  const cleanPath = String(pathname ?? '').split('?')[0].split('#')[0];
  const segments = cleanPath.split('/').filter(Boolean);
  const first = segments[0] ?? '';
  let name = '';
  try { name = decodeURIComponent(first).replace(/\.+$/, ''); } catch { name = first.replace(/\.+$/, ''); }
  if (!name || isReservedSegment(name)) return null;
  return name;
}

/** Strict single-segment profile link parser (`/username/` only — rejects `/username/followers/`). */
export function profileLinkUsername(href) {
  let raw = String(href ?? '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (!/instagram\.com$/i.test(parsed.hostname)) return null;
      raw = parsed.pathname;
    } catch { return null; }
  }
  if (!raw.startsWith('/')) return null;
  const segments = raw.split('?')[0].split('#')[0].split('/').filter(Boolean);
  if (segments.length !== 1) return null;
  const candidate = segments[0];
  return isValidIgUsername(candidate) ? candidate : null;
}

/** Safe array conversion for `querySelectorAll` (real Chrome returns a non-Array `NodeList`). */
function qsa(root, selector) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  try {
    return [...root.querySelectorAll(selector)];
  } catch {
    return [];
  }
}

/** Buttons whose exact label is one of the requested kinds. */
export function findButtonsByLabel(root, kinds) {
  const wanted = new Set(kinds);
  const out = [];
  for (const button of qsa(root, 'button, [role="button"]')) {
    const kind = labelKind(button.textContent);
    if (kind && wanted.has(kind)) out.push({ button, kind });
  }
  return out;
}

/** The first button with one of these labels, preferring the kinds' order. */
export function findButtonByLabel(root, kinds) {
  const found = findButtonsByLabel(root, kinds);
  for (const kind of kinds) {
    const hit = found.find((f) => f.kind === kind);
    if (hit) return hit;
  }
  return null;
}

/** Any open modal dialog (always returned as a plain Array). */
export function findDialogs(root) {
  return qsa(root, '[role="dialog"]');
}

/**
 * The Lexical DM composer, or null.
 *
 * Scoped on purpose: instagram.com carries other contenteditable boxes (post
 * comments, reply fields), and typing a campaign message into one of those is
 * a public post, not a DM. The composer must sit inside a direct thread: a
 * dialog on /direct/, or the thread column of the direct page itself.
 */
export function composerScope(root, pathname = '') {
  const editors = qsa(root, '[contenteditable="true"]');
  const onDirect = String(pathname || root?.location?.pathname || '').startsWith('/direct');
  for (const editor of editors) {
    if (editor.closest('[role="dialog"]')) return editor;
    if (onDirect && editor.closest('main, [role="main"], section')) return editor;
  }
  return null;
}

/** Rendered message bubbles of the open thread, in DOM order. */
export function threadBubbles(root) {
  const dialogs = findDialogs(root);
  const scope = dialogs.length > 0 ? dialogs[dialogs.length - 1] : root;
  return qsa(scope, '[role="article"]');
}

/** The unfollow/confirm dialog Instagram opens after an Unfollow click. */
export function findConfirmDialog(root) {
  for (const dialog of findDialogs(root)) {
    const buttons = findButtonsByLabel(dialog, [Label.UNFOLLOW, Label.CONFIRM]);
    if (buttons.length > 0) return { dialog, confirm: buttons[0].button, kind: buttons[0].kind };
  }
  return null;
}

/** A visible "Try Again Later"-style action-block dialog. */
export function findActionBlockDialog(root) {
  for (const dialog of findDialogs(root)) {
    if (labelKind(dialog.textContent) === Label.TRY_AGAIN_LATER) return dialog;
    if (qsa(dialog, 'button, [role="button"]').some((b) => labelKind(b.textContent) === Label.TRY_AGAIN_LATER)) return dialog;
    const text = collapse(dialog.textContent);
    if (LABEL_TEXT[Label.TRY_AGAIN_LATER].some((t) => text === t || text.startsWith(`${t} `))) return dialog;
  }
  return null;
}

function overflowYOf(node) {
  if (!node) return '';
  try {
    if (typeof getComputedStyle === 'function') {
      const style = getComputedStyle(node);
      if (style?.overflowY) return String(style.overflowY);
    }
  } catch { /* shim */ }
  if (node.style?.overflowY) return String(node.style.overflowY);
  if (node.style?.overflow) {
    const parts = String(node.style.overflow).trim().split(/\s+/);
    if (parts.length >= 2) return parts[1];
    if (parts.length === 1 && parts[0]) return parts[0];
  }
  const attr = node.getAttribute?.('style') ?? '';
  const explicit = attr.match(/overflow-y:\s*([a-z-]+)/i)?.[1];
  if (explicit) return explicit;
  const shorthand = attr.match(/(?:^|;)\s*overflow:\s*([a-z-]+)(?:\s+([a-z-]+))?/i);
  if (shorthand) return shorthand[2] ?? shorthand[1] ?? '';
  return '';
}

function isNodeVisible(node) {
  if (!node) return false;
  try {
    if (typeof getComputedStyle === 'function') {
      const style = getComputedStyle(node);
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.opacity === '0') return false;
    }
  } catch { /* shim */ }
  if (node.style?.display === 'none' || node.style?.visibility === 'hidden') return false;
  return true;
}

function domDepth(node, stopAt) {
  let depth = 0;
  let cur = node;
  while (cur && cur !== stopAt && depth < 60) {
    depth += 1;
    cur = cur.parentNode;
  }
  return depth;
}

/**
 * The scrollable list inside a followers/following/likers modal — the element
 * the human auto-scroller drives.
 *
 * Prioritizes containers that ACTUALLY hold user profile links (`a[href]`) and
 * have real scrollable room (`scrollHeight > clientHeight`), preferring the
 * deepest matching `overflow-y: auto|scroll|overlay` container so we always
 * scroll the real user list (never the Search bar or outer backdrop) and never
 * pick a sub-scroller located after `"Suggested for you"`.
 */
export function findScrollableList(root) {
  if (!root) return null;
  const boundary = findSuggestedBoundary(root);
  const orderMap = boundary ? buildOrderMap(root) : null;

  let bestUsersExplicit = null;
  let bestUsersExplicitDepth = -1;
  let bestUsersExplicitRoom = 0;

  let bestUsersAny = null;
  let bestUsersAnyRoom = 0;

  let firstOverflowWithUsers = null;

  let bestGenericExplicit = null;
  let bestGenericExplicitRoom = 0;
  let bestGenericFallback = null;
  let bestGenericFallbackRoom = 0;

  for (const node of qsa(root, 'div')) {
    if (!isNodeVisible(node)) continue;
    if (boundary && isAfterInRoot(node, boundary, orderMap)) continue;

    const overflowY = overflowYOf(node);
    const explicitScrollable = /^(auto|scroll|overlay)$/i.test(overflowY);
    if (overflowY && !explicitScrollable && overflowY !== 'visible') continue;

    const room = (Number(node.scrollHeight ?? 0)) - (Number(node.clientHeight ?? 0));
    const hasUsers = qsa(node, 'a[href]').some((a) => {
      if (boundary && isAfterInRoot(a, boundary, orderMap)) return false;
      return Boolean(profileLinkUsername(a.getAttribute?.('href') ?? a.href ?? ''));
    });

    if (hasUsers) {
      if (room > 4 && explicitScrollable) {
        const depth = domDepth(node, root);
        if (depth > bestUsersExplicitDepth || (depth === bestUsersExplicitDepth && room > bestUsersExplicitRoom)) {
          bestUsersExplicit = node;
          bestUsersExplicitDepth = depth;
          bestUsersExplicitRoom = room;
        }
      } else if (room > 4 && room > bestUsersAnyRoom) {
        bestUsersAny = node;
        bestUsersAnyRoom = room;
      } else if (explicitScrollable && !firstOverflowWithUsers) {
        firstOverflowWithUsers = node;
      }
    } else if (room > 0) {
      if (explicitScrollable && room > bestGenericExplicitRoom) {
        bestGenericExplicit = node;
        bestGenericExplicitRoom = room;
      } else if (!overflowY && room > bestGenericFallbackRoom) {
        bestGenericFallback = node;
        bestGenericFallbackRoom = room;
      }
    }
  }

  return bestUsersExplicit
    ?? bestUsersAny
    ?? firstOverflowWithUsers
    ?? bestGenericExplicit
    ?? bestGenericFallback;
}

/* ------------------------------------------- 2026 browser-DOM collection finders */

/** True when an element is the "Followed by @friend" mutuals link (NOT the Followers list trigger). */
function isMutualOnlyLink(el, href = '', text = '') {
  const lowerHref = String(href).toLowerCase();
  if (lowerHref.includes('mutualonly') || lowerHref.includes('/mutual')) return true;
  if (/^(followed\s+by|متابع\s+من\s+قبل|يتابعه)\b/i.test(text)) return true;
  return false;
}

/**
 * Find the clickable Followers or Following trigger on an Instagram profile page.
 *
 * In 2026 Instagram desktop HTML:
 *   - Real triggers in `<header>` are `<a role="link" href="#">236K followers</a>`
 *     and `<a role="link" href="#">11 following</a>` — clicking them opens the
 *     native Followers/Following modal WITHOUT changing the page URL.
 *   - Meanwhile `<a href="/<user>/followers/mutualOnly">Followed by ...</a>`
 *     navigates away to a mutuals-only page and MUST NEVER be clicked.
 *
 * Supports both English and Arabic UI and both `#`-based 2026 triggers and
 * classic exact `/<user>/followers/` links (strictly excluding `mutualOnly`).
 */
export function findProfileListTrigger(root, kind = 'followers') {
  if (!root) return null;
  const target = kind === 'following' ? 'following' : 'followers';
  const headers = qsa(root, 'header');
  const mains = qsa(root, 'main');
  const searchRoots = headers.length ? [...headers, ...mains] : (mains.length ? mains : [root]);

  const countPattern = target === 'followers'
    ? /\b(followers?)\b|متابعين|متابعون|متابِعون|متابعاً|متابع/i
    : /\b(following)\b|أتابعه|أتابع|يتابع|تتابعه/i;

  const exactPathRegex = target === 'followers'
    ? /^\/[A-Za-z0-9._]{1,30}\/followers\/?$/i
    : /^\/[A-Za-z0-9._]{1,30}\/following\/?$/i;

  const pathnameOf = (href) => {
    const raw = String(href ?? '').trim();
    if (!raw || raw === '#') return '';
    try {
      if (/^https?:/i.test(raw)) return new URL(raw).pathname;
    } catch { /* relative */ }
    return raw.split('?')[0].split('#')[0];
  };

  // 1. Primary (2026 desktop): count-labeled trigger in header/main (`<a href="#">236K followers</a>`
  //    or `<a href="/user/followers/">236K followers</a>`), strictly skipping `mutualOnly`
  //    and skipping the primary "Following" relationship action button.
  for (const scope of searchRoots) {
    for (const el of qsa(scope, 'a, button, [role="link"], [role="button"]')) {
      if (!isNodeVisible(el)) continue;
      const href = String(el.getAttribute?.('href') ?? el.href ?? '');
      const text = collapse(el.textContent);
      if (!text || text.length > 50) continue;
      if (isMutualOnlyLink(el, href, text)) continue;
      if (target === 'following' && labelKind(text) === Label.FOLLOWING) continue;
      if (target === 'followers' && (labelKind(text) === Label.FOLLOW || labelKind(text) === Label.FOLLOW_BACK)) continue;
      if (!countPattern.test(text)) continue;

      const path = pathnameOf(href);
      if (!path || exactPathRegex.test(path)) return el;
    }
  }

  // 2. Fallback: exact `<a href="/username/followers/">` or `<a href="/username/following/">`
  //    (strictly excluding `/followers/mutualOnly` or any sub-route).
  for (const scope of searchRoots) {
    for (const link of qsa(scope, 'a[href]')) {
      if (!isNodeVisible(link)) continue;
      const href = String(link.getAttribute?.('href') ?? link.href ?? '');
      const text = collapse(link.textContent);
      if (isMutualOnlyLink(link, href, text)) continue;
      const path = pathnameOf(href);
      if (exactPathRegex.test(path)) return link;
    }
  }

  return null;
}

/**
 * Find the active visible Instagram dialog. When stacked (e.g. a Likes dialog
 * opened on top of a Post modal), `preferTopmost: true` returns the topmost one.
 * Optionally filters by dialog `aria-label` or internal heading (`h1`/`h2`/`h3`),
 * e.g. 'Likes', 'Followers', 'Following'.
 */
export function findVisibleDialog(root, { preferTopmost = true, ariaLabel = null } = {}) {
  if (!root) return null;
  const dialogs = findDialogs(root).filter(isNodeVisible);
  if (!dialogs.length) return null;
  if (ariaLabel) {
    const wanted = ariaLabel instanceof RegExp ? ariaLabel : new RegExp(`^${String(ariaLabel)}$`, 'i');
    const matched = dialogs.filter((d) => {
      if (wanted.test(collapse(d.getAttribute?.('aria-label') ?? ''))) return true;
      return qsa(d, 'h1, h2, h3, [role="heading"]').some((h) => wanted.test(collapse(h.textContent)));
    });
    if (matched.length) return preferTopmost ? matched[matched.length - 1] : matched[0];
  }
  return preferTopmost ? dialogs[dialogs.length - 1] : dialogs[0];
}

/**
 * Detect Instagram's "Suggested for you" boundary inside a Followers/Following
 * dialog so suggested accounts below it are NEVER collected as real followers.
 */
export function findSuggestedBoundary(dialog) {
  if (!dialog) return null;
  const pattern = /^(suggested\s+for\s+you|similar\s+accounts|see\s+all\s+suggestions|اقتراحات\s+لك|حسابات\s+مشابهة|مقترح\s+لك|عرض\s+كل\s+الاقتراحات)$/i;
  for (const node of qsa(dialog, 'span, h2, h3, h4, div, a')) {
    const text = collapse(node.textContent);
    if (!text || text.length > 42) continue;
    if (pattern.test(text)) return node;
  }
  return null;
}

/**
 * Detect Instagram's loading spinner (`<div role="progressbar">` or
 * `<svg aria-label="Loading...">`) inside a dialog or comments pane.
 */
export function findDialogLoadingSpinner(root) {
  if (!root) return null;
  for (const bar of qsa(root, '[role="progressbar"]')) {
    if (isNodeVisible(bar)) return bar;
  }
  for (const svg of qsa(root, 'svg[aria-label]')) {
    const label = collapse(svg.getAttribute?.('aria-label') ?? '').toLowerCase();
    if (/^(loading|جاري\s+التحميل)/.test(label) && isNodeVisible(svg)) return svg;
  }
  return null;
}

/**
 * Find an in-dialog "See all followers" / "See all" / "Load more" trigger
 * when Instagram collapses a list, strictly IGNORING "See All Suggestions"
 * (`/explore/people/`) and anything after "Suggested for you".
 */
export function findDialogLoadMoreButton(dialog) {
  if (!dialog) return null;
  const boundary = findSuggestedBoundary(dialog);
  const orderMap = boundary ? buildOrderMap(dialog) : null;
  const want = /^(see\s+all(\s+(followers?|following|likes))?|show\s+more|load\s+more|view\s+all|عرض\s+الكل|عرض\s+المزيد|تحميل\s+المزيد)$/i;
  for (const el of qsa(dialog, 'button, a, [role="button"], [role="link"]')) {
    if (!isNodeVisible(el)) continue;
    if (boundary && isAfterInRoot(el, boundary, orderMap)) continue;
    const href = String(el.getAttribute?.('href') ?? el.href ?? '').toLowerCase();
    if (href.includes('/explore/people') || href.includes('mutualonly')) continue;
    const text = collapse(el.textContent);
    if (!text || text.length > 48) continue;
    if (/suggest|اقتراح/i.test(text)) continue;
    if (want.test(text)) return el;
  }
  return null;
}

/**
 * True when Instagram renders its 2025/2026 follower cap notice inside a dialog
 * (e.g. `"Only fightclubpoint can see all followers"`). Collectors treat this
 * as a clean partial cap rather than an error.
 */
export function hasFollowerCapNotice(dialog) {
  if (!dialog) return false;
  const text = collapse(dialog.textContent ?? '');
  return /only\s+[A-Za-z0-9._]+\s+can\s+see\s+all\s+(followers?|following)/i.test(text)
    || /فقط\s+يمكنه\s+رؤية\s+جميع\s+(المتابعين|من\s+يتابعهم)/.test(text)
    || /يمكن\s+ل[ـ\s]*\S+\s+فقط\s+رؤية\s+جميع\s+(المتابعين|من\s+يتابعهم)/.test(text);
}

/**
 * Return true if `candidate` appears strictly AFTER `boundary` in document
 * pre-order within `root`. Uses a single deterministic pre-order check instead
 * of relying solely on `compareDocumentPosition` (which varies across shims).
 */
function buildOrderMap(root) {
  const map = new Map();
  if (!root) return map;
  let index = 0;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    map.set(node, index++);
    const children = node.children;
    if (children && children.length) {
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
    }
  }
  return map;
}

function isAfterInRoot(candidate, boundary, orderMap) {
  if (!candidate || !boundary || candidate === boundary) return false;
  if (orderMap && orderMap.has(candidate) && orderMap.has(boundary)) {
    return orderMap.get(candidate) > orderMap.get(boundary);
  }
  if (typeof boundary.compareDocumentPosition === 'function') {
    return Boolean(boundary.compareDocumentPosition(candidate) & 4);
  }
  return false;
}

function stripVerifiedLabel(text) {
  return collapse(String(text ?? '').replace(/\b(verified|تم\s+التحقق|موثّق)\b/gi, ''));
}

/**
 * Extract clean user rows from an open Followers / Following / Likers dialog.
 *
 * Verified against real 2026 Instagram HTML snapshots:
 *   - Parses canonical usernames from `<a href="...">` (supporting both full
 *     `https://www.instagram.com/username/` and relative `/username/`).
 *   - Stops strictly before any `"Suggested for you"` / `"See All Suggestions"`
 *     section boundary (including Instagram's two-scroller Following dialog).
 *   - Strips `"Verified"` badge text and action button labels (`Follow`,
 *     `Following`, `Requested`, `Remove`) from display names.
 */
export function extractDialogUsers(dialog, { excludeUsername = null, respectSuggestedBoundary = true } = {}) {
  if (!dialog) return { users: [], hitSuggested: false };
  const boundary = respectSuggestedBoundary ? findSuggestedBoundary(dialog) : null;
  const orderMap = boundary ? buildOrderMap(dialog) : null;
  const excludeLower = excludeUsername ? String(excludeUsername).replace(/^@/, '').toLowerCase() : null;
  // Always scan the entire dialog (never restricted to findScrollableList) so
  // visible followers are NEVER missed even if Instagram changes wrapper nesting.
  const scope = dialog;

  const byKey = new Map();
  const links = qsa(scope, 'a[href]');
  let hitSuggested = Boolean(boundary);

  for (const link of links) {
    if (boundary && isAfterInRoot(link, boundary, orderMap)) {
      hitSuggested = true;
      continue;
    }
    const href = link.getAttribute?.('href') ?? link.href ?? '';
    if (String(href).toLowerCase().includes('/explore/people')) {
      hitSuggested = true;
      continue;
    }
    const username = profileLinkUsername(href);
    if (!username) continue;
    const key = username.toLowerCase();
    if (excludeLower && key === excludeLower) continue;

    let fullName = '';
    let isVerified = false;
    let row = link.closest?.('[role="listitem"], li') ?? null;
    if (!row) {
      let cur = link.parentNode;
      for (let depth = 0; depth < 6 && cur && cur !== scope && cur !== dialog; depth += 1) {
        const distinctUsers = new Set();
        for (const a of qsa(cur, 'a[href]')) {
          const u = profileLinkUsername(a.getAttribute?.('href') ?? a.href ?? '');
          if (u) distinctUsers.add(u.toLowerCase());
          if (distinctUsers.size > 1) break;
        }
        if (distinctUsers.size > 1) break;
        row = cur;
        if (qsa(cur, 'button, [role="button"]').length > 0) break;
        cur = cur.parentNode;
      }
    }

    if (row) {
      if (row.querySelector?.('svg[aria-label="Verified"], svg[aria-label="تم التحقق"]')) {
        isVerified = true;
      }
      if (!isVerified && qsa(row, 'title').some((t) => /^(verified|تم\s+التحقق)$/i.test(collapse(t.textContent)))) {
        isVerified = true;
      }
      const spans = qsa(row, 'span');
      for (const span of spans) {
        if (qsa(span, 'a, button, [role="button"]').length > 0) continue;
        const text = stripVerifiedLabel(span.textContent);
        if (!text || text.toLowerCase() === key || text.toLowerCase() === `@${key}`) continue;
        if (labelKind(text)) continue;
        if (/^(remove|verified|·|•|follow|following|requested|follow\s+back|إزالة|متابعة|متابع)$/i.test(text)) continue;
        if (text.length <= 80 && !fullName) {
          fullName = text;
        }
      }
    }

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        username,
        fullName,
        href: `/${username}/`,
        isVerified,
      });
    } else {
      if (!existing.fullName && fullName) existing.fullName = fullName;
      if (!existing.isVerified && isVerified) existing.isVerified = true;
    }
  }

  return { users: [...byKey.values()], hitSuggested };
}

/**
 * Return the last visible user profile `<a>` element inside a dialog before
 * any `"Suggested for you"` boundary — used as a reliable `scrollIntoView`
 * fallback whenever Instagram wraps scrolling in an unexpected container.
 */
export function findLastVisibleUserLink(dialog, { excludeUsername = null, respectSuggestedBoundary = true } = {}) {
  if (!dialog) return null;
  const boundary = respectSuggestedBoundary ? findSuggestedBoundary(dialog) : null;
  const orderMap = boundary ? buildOrderMap(dialog) : null;
  const excludeLower = excludeUsername ? String(excludeUsername).replace(/^@/, '').toLowerCase() : null;
  let last = null;
  for (const link of qsa(dialog, 'a[href]')) {
    if (boundary && isAfterInRoot(link, boundary, orderMap)) break;
    if (!isNodeVisible(link)) continue;
    const href = link.getAttribute?.('href') ?? link.href ?? '';
    const username = profileLinkUsername(href);
    if (!username) continue;
    if (excludeLower && username.toLowerCase() === excludeLower) continue;
    last = link;
  }
  return last;
}

/**
 * Find unique post/reel tile links (`/p/<shortcode>/`, `/<user>/p/<shortcode>/`,
 * `/reel/<shortcode>/`, `/<user>/reel/<shortcode>/`) on a profile or hashtag
 * page, in visual top-to-bottom DOM order.
 */
export function findPostGridLinks(root, limit = 12) {
  if (!root) return [];
  const scopes = qsa(root, 'main, article');
  const searchRoots = scopes.length ? scopes : [root];
  const seen = new Set();
  const out = [];

  for (const scope of searchRoots) {
    for (const link of qsa(scope, 'a[href]')) {
      const href = String(link.getAttribute?.('href') ?? link.href ?? '');
      const match = href.match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]{4,})\b/);
      if (!match) continue;
      const shortcode = match[2];
      if (seen.has(shortcode)) continue;
      seen.add(shortcode);
      out.push({
        element: link,
        shortcode,
        href: `/${match[1] === 'reels' ? 'reel' : match[1]}/${shortcode}/`,
        isReel: match[1] === 'reel' || match[1] === 'reels',
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Return true if `el` is (or contains) a Like / Unlike heart button we must NEVER click. */
function isLikeHeartControl(el) {
  if (!el) return false;
  const aria = collapse(el.getAttribute?.('aria-label') ?? '').toLowerCase();
  if (/^(like|unlike|أعجبني|إلغاء الإعجاب)$/.test(aria)) return true;
  const svg = el.querySelector?.('svg[aria-label]');
  if (svg) {
    const svgAria = collapse(svg.getAttribute?.('aria-label') ?? '').toLowerCase();
    if (/^(like|unlike|أعجبني|إلغاء الإعجاب)$/.test(svgAria)) return true;
  }
  return false;
}

/**
 * Return true if `el` lives inside an individual comment row (so its
 * `<button>28 likes</button>` is a COMMENT likes trigger, NOT the post's).
 */
function isInsideCommentRow(el) {
  if (!el) return false;
  const li = el.closest?.('li');
  if (li) {
    if (qsa(li, 'a[href]').some((a) => /\/c\/\d+/.test(String(a.getAttribute?.('href') ?? a.href ?? '')))) return true;
    if (qsa(li, 'button, [role="button"]').some((b) => /^(reply|رد|view\s+replies)/i.test(collapse(b.textContent)))) return true;
    if (li.querySelector?.('h3') && li.querySelector?.('time')) return true;
  }
  return false;
}

/**
 * Find the clickable Likes trigger inside a post modal or post detail page
 * (e.g. `<a href="/p/ABC/liked_by/">8,391 likes</a>`, `"4,397 others"`,
 * `"Liked by X and others"`, or Arabic `"142 تسجيل إعجاب"` / `"وآخرون"`).
 *
 * Strictly refuses:
 *   - the heart Like/Unlike icon (never likes a post by mistake)
 *   - comment-row `<button>N likes</button>` triggers (never opens comment likers)
 */
export function findPostLikersTrigger(root) {
  if (!root) return null;

  // 1. Direct `/liked_by` anchor (classic & 2026 desktop layout).
  //    Prefer one with visible text (e.g. "8,391 likes" / "4,397 others") over
  //    an empty-text liker avatar anchor.
  let avatarFallback = null;
  for (const link of qsa(root, 'a[href]')) {
    const href = String(link.getAttribute?.('href') ?? link.href ?? '');
    if (!href.includes('liked_by')) continue;
    if (!isNodeVisible(link) || isLikeHeartControl(link) || isInsideCommentRow(link)) continue;
    if (collapse(link.textContent)) return link;
    if (!avatarFallback) avatarFallback = link;
  }
  if (avatarFallback) return avatarFallback;

  // 2. Clickable button/link inside the post (outside comments) showing "N likes" or "others"
  const likesCountPattern = /^\s*\d[\d,.\sKkMm]*\s*(likes?|others|تسجيلات?\s*إعجاب|إعجاب)\s*$/i;
  const othersPattern = /\b(and\s+others|others|liked\s+by)\b|وآخرون|وغيرهم|أشخاص\s+آخرين|أعجب\s+به/i;

  const candidates = qsa(root, 'a, button, [role="button"], [role="link"]');
  for (const el of candidates) {
    if (!isNodeVisible(el) || isLikeHeartControl(el) || isInsideCommentRow(el)) continue;
    const text = collapse(el.textContent);
    if (!text || text.length > 90) continue;
    if (likesCountPattern.test(text)) return el;
  }
  for (const el of candidates) {
    if (!isNodeVisible(el) || isLikeHeartControl(el) || isInsideCommentRow(el)) continue;
    const text = collapse(el.textContent);
    if (!text || text.length > 90) continue;
    if (othersPattern.test(text)) {
      const inner = qsa(el, 'a, button, [role="button"], span').find((child) => {
        const ct = collapse(child.textContent);
        return /^(others|وآخرون|وغيرهم|\d[\d,.\sKkMm]*\s*(likes?|others))$/i.test(ct) && !isLikeHeartControl(child);
      });
      return inner ?? el;
    }
  }

  // 3. Fallback: clickable <span> with "N likes" or "others" inside a post section
  for (const span of qsa(root, 'section span, article span')) {
    if (!isNodeVisible(span) || isInsideCommentRow(span)) continue;
    const text = collapse(span.textContent);
    if (!text || text.length > 60) continue;
    if (likesCountPattern.test(text) || /^(others|وآخرون|وغيرهم)$/i.test(text)) {
      const clickable = span.closest?.('a, button, [role="button"], [role="link"]') ?? span;
      if (!isLikeHeartControl(clickable) && !isInsideCommentRow(clickable)) return clickable;
    }
  }
  return null;
}

/** Find the Next post arrow button inside an open post modal. */
export function findNextPostButton(root) {
  if (!root) return null;
  for (const svg of qsa(root, 'svg[aria-label]')) {
    const label = collapse(svg.getAttribute?.('aria-label') ?? '').toLowerCase();
    if (label === 'next' || label === 'التالي') {
      const btn = svg.closest?.('button, [role="button"], a');
      if (btn && isNodeVisible(btn)) return btn;
    }
  }
  for (const btn of qsa(root, 'button[aria-label], [role="button"][aria-label]')) {
    const label = collapse(btn.getAttribute?.('aria-label') ?? '').toLowerCase();
    if ((label === 'next' || label === 'التالي') && isNodeVisible(btn)) return btn;
  }
  return null;
}

/**
 * Find the Close button of a dialog (or document-level backdrop Close button for
 * 2026 Post modals whose Close icon sits outside `role="dialog"`).
 */
export function findCloseDialogButton(root, fallbackDoc = null) {
  const searchIn = (scope, excludeDialogs = false) => {
    if (!scope) return null;
    for (const btn of qsa(scope, 'button[aria-label], [role="button"][aria-label]')) {
      if (excludeDialogs && btn.closest?.('[role="dialog"]')) continue;
      const label = collapse(btn.getAttribute?.('aria-label') ?? '').toLowerCase();
      if ((label === 'close' || label === 'إغلاق') && isNodeVisible(btn)) return btn;
    }
    for (const svg of qsa(scope, 'svg[aria-label]')) {
      if (excludeDialogs && svg.closest?.('[role="dialog"]')) continue;
      const label = collapse(svg.getAttribute?.('aria-label') ?? '').toLowerCase();
      if (label === 'close' || label === 'إغلاق') {
        const btn = svg.closest?.('button, [role="button"]');
        if (btn && isNodeVisible(btn)) return btn;
      }
    }
    return null;
  };
  return searchIn(root, false) ?? (fallbackDoc && fallbackDoc !== root ? searchIn(fallbackDoc, true) : null);
}

/** Find the scrollable comments container inside an open post page or post dialog. */
export function findCommentScrollContainer(root) {
  if (!root) return null;
  let bestWithTime = null;
  let bestWithTimeRoom = 0;

  for (const node of qsa(root, 'div, ul')) {
    if (!isNodeVisible(node)) continue;
    const room = Number(node.scrollHeight ?? 0) - Number(node.clientHeight ?? 0);
    if (room <= 20) continue;
    const overflowY = overflowYOf(node);
    if (overflowY && !/^(auto|scroll|overlay|visible)$/i.test(overflowY)) continue;
    const hasTime = Boolean(node.querySelector?.('time'));
    if (hasTime && room > bestWithTimeRoom) {
      bestWithTime = node;
      bestWithTimeRoom = room;
    }
  }
  return bestWithTime ?? findScrollableList(root);
}

/**
 * Find Instagram's "Load more comments" / "+" button inside a post pane.
 * Strictly ignores "Hide replies" so expanded threads are never collapsed.
 */
export function findLoadMoreCommentsButton(root) {
  if (!root) return null;
  for (const svg of qsa(root, 'svg[aria-label]')) {
    const label = collapse(svg.getAttribute?.('aria-label') ?? '').toLowerCase();
    if (/load more comments|view more comments|تحميل المزيد من التعليقات/.test(label)) {
      const btn = svg.closest?.('button, [role="button"]');
      if (btn && isNodeVisible(btn)) return btn;
    }
  }
  for (const btn of qsa(root, 'button, [role="button"]')) {
    if (!isNodeVisible(btn)) continue;
    const text = collapse(btn.textContent).toLowerCase();
    const aria = collapse(btn.getAttribute?.('aria-label') ?? '').toLowerCase();
    if (/hide\s+replies|إخفاء\s+الردود/.test(text) || /hide\s+replies/.test(aria)) continue;
    if (/load\s+more\s+comments|view\s+more\s+comments|view\s+all\s+\d*\s*comments|تحميل\s+المزيد\s+من\s+التعليقات|عرض\s+جميع\s+التعليقات/.test(text)
      || /load\s+more\s+comments|view\s+more\s+comments/.test(aria)) {
      return btn;
    }
  }
  return null;
}

/**
 * Universal semantic `<time>` + `<h3>` DOM walker for 2026 Instagram comments.
 *
 * Works across standalone `/p/.../` pages, Post modals (`ul > li > h3` +
 * `<a href=".../c/<id>/"><time>`), and Reels comment drawers regardless of
 * obfuscated CSS class names.
 */
export function extractCommentsFromDom(root, { excludeAuthor = null } = {}) {
  if (!root) return [];
  const excludeLower = excludeAuthor ? String(excludeAuthor).replace(/^@/, '').toLowerCase() : null;
  const times = qsa(root, 'time');
  const seen = new Set();
  const out = [];

  for (const timeEl of times) {
    const timeAgo = collapse(timeEl.textContent);
    let container = timeEl.parentNode;
    let foundRow = null;
    let foundUsername = null;

    for (let depth = 0; depth < 8 && container && container !== root; depth += 1) {
      let user = null;
      const h3Link = container.querySelector?.('h3 a[href]');
      if (h3Link) {
        user = profileLinkUsername(h3Link.getAttribute?.('href') ?? h3Link.href ?? '');
      }
      if (!user) {
        for (const link of qsa(container, 'a[href]')) {
          const candidate = profileLinkUsername(link.getAttribute?.('href') ?? link.href ?? '');
          if (candidate) {
            user = candidate;
            break;
          }
        }
      }
      if (user) {
        const fullText = collapse(container.textContent);
        if (fullText.length > (timeAgo.length + user.length + 1)) {
          foundRow = container;
          foundUsername = user;
          if (String(container.tagName ?? '').toUpperCase() === 'LI' || container.querySelector?.('h3') || container.querySelector?.('img')) {
            break;
          }
        }
      }
      container = container.parentNode;
    }

    if (!foundRow || !foundUsername) continue;
    if (excludeLower && foundUsername.toLowerCase() === excludeLower) continue;

    const dirNodes = qsa(foundRow, 'span[dir="auto"], div[dir="auto"]');
    const parts = [];
    for (const node of dirNodes) {
      if (node.closest?.('h3, button, [role="button"]')) continue;
      if (qsa(node, 'h3, time, button').length > 0) continue;
      const text = stripVerifiedLabel(node.textContent);
      if (!text) continue;
      if (text.toLowerCase() === foundUsername.toLowerCase()) continue;
      if (text === timeAgo) continue;
      if (/^(reply|رد|see translation|عرض الترجمة|view\s+replies\s*\(\d+\)|\d+\s*likes?|\d+\s*إعجاب|edited|تم التعديل)$/i.test(text)) continue;
      parts.push(text);
    }

    let commentText = parts.join(' ').trim();
    if (!commentText) {
      // Fallback: collect leaf text spans outside h3 / button / time / a
      const leafParts = [];
      for (const span of qsa(foundRow, 'span')) {
        if (span.closest?.('h3, button, [role="button"], a, time')) continue;
        if (qsa(span, 'h3, button, [role="button"], a, time, span').length > 0) continue;
        const text = stripVerifiedLabel(span.textContent);
        if (!text || text.toLowerCase() === foundUsername.toLowerCase() || text === timeAgo) continue;
        if (/^(reply|رد|see translation|عرض الترجمة|view\s+replies\s*\(\d+\)|\d+\s*likes?|\d+\s*إعجاب|edited|تم التعديل)$/i.test(text)) continue;
        leafParts.push(text);
      }
      commentText = leafParts.join(' ').trim();
    }
    if (!commentText) {
      commentText = stripVerifiedLabel(foundRow.textContent)
        .replace(new RegExp(`^@?${foundUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '')
        .replace(timeAgo, '')
        .replace(/(?:Reply|See translation|View replies\s*\(\d+\)|\d+\s*likes?)+$/gi, '')
        .replace(/\b(Reply|See translation|View replies\s*\(\d+\)|\d+\s+likes?)\b/gi, '')
        .trim();
    }
    if (!commentText) continue;

    const dedupeKey = `${foundUsername.toLowerCase()}|${commentText.slice(0, 80)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({
      username: foundUsername,
      text: commentText,
      timeAgo,
      createdAt: timeEl.getAttribute?.('datetime') ?? null,
    });
  }

  return out;
}

/** True when the rendered profile page shows Instagram's private-account wall. */
export function isPrivateAccountPage(root) {
  if (!root) return false;
  const text = collapse(root.textContent ?? '');
  return /this account is private|هذا الحساب خاص/i.test(text);
}

/** Username + display name rows inside a user-list modal or a grid page. */
export function userLinksFrom(root) {
  const out = [];
  const seen = new Set();
  for (const link of qsa(root, 'a[href]')) {
    const href = link.getAttribute?.('href') ?? link.href ?? '';
    const username = profileLinkUsername(href);
    if (!username) continue;
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const spans = qsa(link, 'span');
    const fullName = stripVerifiedLabel(
      spans.map((s) => collapse(s.textContent)).filter(Boolean).join(' ') || collapse(link.textContent),
    );
    out.push({ username, fullName, href: `/${username}/` });
  }
  return out;
}

/** Authors of tiles on hashtag/explore/saved grids (SRC-8). */
export function gridTileAuthors(root) {
  const out = [];
  for (const article of qsa(root, 'article, [role="menuitem"], li')) {
    const link = qsa(article, 'a[href]').find((a) => {
      const href = a.getAttribute?.('href') ?? a.href ?? '';
      return Boolean(profileLinkUsername(href));
    });
    if (!link) continue;
    const href = link.getAttribute?.('href') ?? link.href ?? '';
    const username = profileLinkUsername(href);
    if (username && !out.some((row) => row.username.toLowerCase() === username.toLowerCase())) {
      out.push({ username, href: `/${username}/` });
    }
  }
  return out;
}

/**
 * Reading direction of an element, for geometry that mirrors in RTL.
 * Computed style first (Chrome), attribute and dir=auto heuristics after, so
 * the same code works in the DOM shim used by tests.
 */
export function isRtlElement(element) {
  if (!element) return false;
  const computed = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
  const fromStyle = computed?.direction;
  if (fromStyle) return fromStyle === 'rtl';
  let node = element;
  while (node && node.getAttribute) {
    const dir = node.getAttribute('dir');
    if (dir === 'rtl') return true;
    if (dir === 'ltr') return false;
    node = node.parentNode;
  }
  // Nothing in the chain declared a direction: fall back to the document.
  const docDir = element.ownerDocument?.dir || element.ownerDocument?.documentElement?.getAttribute?.('dir');
  return String(docDir).toLowerCase() === 'rtl';
}
