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

/** Buttons whose exact label is one of the requested kinds. */
export function findButtonsByLabel(root, kinds) {
  const wanted = new Set(kinds);
  const out = [];
  for (const button of root.querySelectorAll('button, [role="button"]')) {
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

/** Any open modal dialog. */
export function findDialogs(root) {
  return root.querySelectorAll('[role="dialog"]');
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
  const editors = root.querySelectorAll('[contenteditable="true"]');
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
  return scope.querySelectorAll('[role="article"], [data-igcrm-bubble]');
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
    if (dialog.querySelectorAll('button').some((b) => labelKind(b.textContent) === Label.TRY_AGAIN_LATER)) return dialog;
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
  return node.style?.overflowY
    || (node.getAttribute?.('style') ?? '').match(/overflow-y:\s*([a-z-]+)/i)?.[1]
    || '';
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

/**
 * The scrollable list inside a followers/following/likers modal — the element
 * the human auto-scroller drives. Chosen by computed overflow and scrollable
 * room, never by a class name Instagram may rename.
 */
export function findScrollableList(root) {
  if (!root) return null;
  let bestExplicit = null;
  let bestExplicitRoom = 0;
  let bestFallback = null;
  let bestFallbackRoom = 0;

  for (const node of root.querySelectorAll('div')) {
    if (!isNodeVisible(node)) continue;
    const room = (Number(node.scrollHeight ?? 0)) - (Number(node.clientHeight ?? 0));
    if (room <= 0) continue;
    const overflowY = overflowYOf(node);
    const explicitScrollable = /^(auto|scroll|overlay)$/i.test(overflowY);
    if (overflowY && !explicitScrollable && overflowY !== 'visible') continue;
    if (explicitScrollable && room > bestExplicitRoom) {
      bestExplicit = node;
      bestExplicitRoom = room;
    } else if (!overflowY && room > bestFallbackRoom) {
      bestFallback = node;
      bestFallbackRoom = room;
    }
  }
  return bestExplicit ?? bestFallback;
}

/* ------------------------------------------- 2026 browser-DOM collection finders */

/**
 * Find the clickable Followers or Following link on an Instagram profile page.
 * Supports English and Arabic UI and both `<a href="/user/followers/">` and
 * header count spans wrapped in `[role="link"]` / `<button>`.
 */
export function findProfileListTrigger(root, kind = 'followers') {
  if (!root) return null;
  const target = kind === 'following' ? 'following' : 'followers';
  const scopes = [...root.querySelectorAll('header, main')];
  const searchRoots = scopes.length ? scopes : [root];

  // 1. Direct href link (`/username/followers/` or `/username/following/`)
  for (const scope of searchRoots) {
    for (const link of scope.querySelectorAll('a')) {
      const href = String(link.getAttribute?.('href') ?? link.href ?? '');
      if (href.includes(`/${target}`) && isNodeVisible(link)) return link;
    }
  }

  // 2. Fallback: visible count button/link matching localized text
  const pattern = target === 'followers'
    ? /\b(followers?)\b|متابعين|متابعون|متابع/i
    : /\b(following)\b|أتابعه|يتابع|تتابعه/i;

  for (const scope of searchRoots) {
    for (const el of scope.querySelectorAll('a, button, [role="link"], [role="button"]')) {
      if (!isNodeVisible(el)) continue;
      const text = collapse(el.textContent);
      if (!text || text.length > 60) continue;
      // Avoid matching the primary "Following" relationship button instead of count
      if (target === 'following' && labelKind(text) === Label.FOLLOWING) continue;
      if (pattern.test(text)) return el;
    }
  }
  return null;
}

/**
 * Find the active visible Instagram dialog. When stacked (e.g. a Likes dialog
 * opened on top of a Post modal), `preferTopmost: true` returns the topmost one.
 */
export function findVisibleDialog(root, { preferTopmost = true } = {}) {
  if (!root) return null;
  const dialogs = [...findDialogs(root)].filter(isNodeVisible);
  if (!dialogs.length) return null;
  return preferTopmost ? dialogs[dialogs.length - 1] : dialogs[0];
}

/**
 * Detect Instagram's "Suggested for you" boundary inside a Followers/Following
 * dialog so suggested accounts below it are NEVER collected as real followers.
 */
export function findSuggestedBoundary(dialog) {
  if (!dialog) return null;
  const pattern = /^(suggested\s+for\s+you|similar\s+accounts|اقتراحات\s+لك|حسابات\s+مشابهة|مقترح\s+لك)$/i;
  for (const node of dialog.querySelectorAll('span, h2, h3, h4, div')) {
    // Only leaf/small heading elements, not giant containers
    const text = collapse(node.textContent);
    if (!text || text.length > 42) continue;
    if (pattern.test(text)) return node;
  }
  return null;
}

function isAfterNode(candidate, boundary) {
  if (!candidate || !boundary || candidate === boundary) return false;
  if (typeof boundary.compareDocumentPosition === 'function') {
    // Node.DOCUMENT_POSITION_FOLLOWING === 4
    return Boolean(boundary.compareDocumentPosition(candidate) & 4);
  }
  return false;
}

/**
 * Extract clean user rows from an open Followers / Following / Likers dialog.
 *
 * Adapted from battle-tested 2026 DOM scrapers:
 *   - Trusts `<a href="/username/">` (single-segment non-route paths) as the
 *     ground truth username source.
 *   - Stops before any `"Suggested for you"` section boundary.
 *   - Excludes the profile owner and UI action button text (`Follow`, `Remove`).
 */
export function extractDialogUsers(dialog, { excludeUsername = null, respectSuggestedBoundary = true } = {}) {
  if (!dialog) return { users: [], hitSuggested: false };
  const boundary = respectSuggestedBoundary ? findSuggestedBoundary(dialog) : null;
  const excludeLower = excludeUsername ? String(excludeUsername).replace(/^@/, '').toLowerCase() : null;
  const scope = findScrollableList(dialog) ?? dialog;

  const byKey = new Map();
  const links = [...scope.querySelectorAll('a[href]')];
  let hitSuggested = Boolean(boundary);

  for (const link of links) {
    if (boundary && isAfterNode(link, boundary)) {
      hitSuggested = true;
      continue;
    }
    const href = link.getAttribute?.('href') ?? link.href ?? '';
    const username = profileLinkUsername(href);
    if (!username) continue;
    const key = username.toLowerCase();
    if (excludeLower && key === excludeLower) continue;

    // Derive display name from the row surrounding this link (often a sibling span)
    let fullName = '';
    let isVerified = false;
    const row = link.closest?.('[role="listitem"], li') ?? link.parentNode?.parentNode ?? link.parentNode;
    if (row) {
      if (row.querySelector?.('svg[aria-label="Verified"], svg[aria-label="تم التحقق"]')) {
        isVerified = true;
      }
      const spans = [...(row.querySelectorAll?.('span') ?? [])];
      for (const span of spans) {
        const text = collapse(span.textContent);
        if (!text || text.toLowerCase() === key || text.toLowerCase() === `@${key}`) continue;
        if (labelKind(text)) continue; // skip "Follow", "Following", "Requested"
        if (/^(remove|verified|·|•|follow|following|requested|إزالة)$/i.test(text)) continue;
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
 * Find unique post/reel tile links (`/p/<shortcode>/`, `/reel/<shortcode>/`)
 * on a profile or hashtag page, in visual top-to-bottom DOM order.
 */
export function findPostGridLinks(root, limit = 12) {
  if (!root) return [];
  const scopes = [...root.querySelectorAll('main, article')];
  const searchRoots = scopes.length ? scopes : [root];
  const seen = new Set();
  const out = [];

  for (const scope of searchRoots) {
    for (const link of scope.querySelectorAll('a[href]')) {
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
 * Find the clickable Likes trigger inside a post modal or post detail page
 * (e.g. `<a href="/p/ABC/liked_by/">`, `"142 likes"`, `"Liked by X and others"`,
 * or Arabic `"142 تسجيل إعجاب"` / `"وآخرون"`).
 *
 * Strictly refuses the heart Like/Unlike icon so the extension NEVER likes a
 * post by mistake.
 */
export function findPostLikersTrigger(root) {
  if (!root) return null;

  // 1. Direct `/liked_by` anchor (classic & 2026 desktop layout)
  for (const link of root.querySelectorAll('a')) {
    const href = String(link.getAttribute?.('href') ?? link.href ?? '');
    if (href.includes('liked_by') && isNodeVisible(link) && !isLikeHeartControl(link)) return link;
  }

  // 2. Clickable button/link/span inside the post showing "N likes" or "others"
  const likesCountPattern = /^\s*\d[\d,.\sKkMm]*\s*(likes?|تسجيلات?\s*إعجاب|إعجاب)\s*$/i;
  const othersPattern = /\b(and\s+others|others|liked\s+by)\b|وآخرون|وغيرهم|أشخاص\s+آخرين|أعجب\s+به/i;

  const candidates = [...root.querySelectorAll('a, button, [role="button"], [role="link"]')];
  for (const el of candidates) {
    if (!isNodeVisible(el) || isLikeHeartControl(el)) continue;
    const text = collapse(el.textContent);
    if (!text || text.length > 90) continue;
    if (likesCountPattern.test(text)) return el;
  }
  for (const el of candidates) {
    if (!isNodeVisible(el) || isLikeHeartControl(el)) continue;
    const text = collapse(el.textContent);
    if (!text || text.length > 90) continue;
    if (othersPattern.test(text)) {
      // If this is a wrapper around "Liked by @user and others", prefer the
      // inner "others" link/button if one exists so we don't navigate to @user.
      const inner = [...(el.querySelectorAll?.('a, button, [role="button"], span') ?? [])].find((child) => {
        const ct = collapse(child.textContent);
        return /^(others|وآخرون|وغيرهم|\d[\d,.\sKkMm]*\s*likes?)$/i.test(ct) && !isLikeHeartControl(child);
      });
      return inner ?? el;
    }
  }

  // 3. Fallback: clickable <span> with "N likes" or "others" inside a section
  for (const span of root.querySelectorAll('section span, article span')) {
    if (!isNodeVisible(span)) continue;
    const text = collapse(span.textContent);
    if (!text || text.length > 60) continue;
    if (likesCountPattern.test(text) || /^(others|وآخرون|وغيرهم)$/i.test(text)) {
      const clickable = span.closest?.('a, button, [role="button"], [role="link"]') ?? span;
      if (!isLikeHeartControl(clickable)) return clickable;
    }
  }
  return null;
}

/** Find the Next post arrow button inside an open post modal. */
export function findNextPostButton(root) {
  if (!root) return null;
  for (const svg of root.querySelectorAll('svg[aria-label]')) {
    const label = collapse(svg.getAttribute?.('aria-label') ?? '').toLowerCase();
    if (label === 'next' || label === 'التالي') {
      const btn = svg.closest?.('button, [role="button"], a');
      if (btn && isNodeVisible(btn)) return btn;
    }
  }
  for (const btn of root.querySelectorAll('button[aria-label], [role="button"][aria-label]')) {
    const label = collapse(btn.getAttribute?.('aria-label') ?? '').toLowerCase();
    if ((label === 'next' || label === 'التالي') && isNodeVisible(btn)) return btn;
  }
  return null;
}

/** Find the Close button of a dialog (or null if Escape fallback should be used). */
export function findCloseDialogButton(root) {
  if (!root) return null;
  for (const svg of root.querySelectorAll('svg[aria-label]')) {
    const label = collapse(svg.getAttribute?.('aria-label') ?? '').toLowerCase();
    if (label === 'close' || label === 'إغلاق') {
      const btn = svg.closest?.('button, [role="button"]');
      if (btn && isNodeVisible(btn)) return btn;
    }
  }
  for (const btn of root.querySelectorAll('button[aria-label], [role="button"][aria-label]')) {
    const label = collapse(btn.getAttribute?.('aria-label') ?? '').toLowerCase();
    if ((label === 'close' || label === 'إغلاق') && isNodeVisible(btn)) return btn;
  }
  return null;
}

/** Find the scrollable comments container inside an open post page or post dialog. */
export function findCommentScrollContainer(root) {
  if (!root) return null;
  let bestWithTime = null;
  let bestWithTimeRoom = 0;

  for (const node of root.querySelectorAll('div, ul')) {
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
  for (const svg of root.querySelectorAll('svg[aria-label]')) {
    const label = collapse(svg.getAttribute?.('aria-label') ?? '').toLowerCase();
    if (/load more comments|view more comments|تحميل المزيد من التعليقات/.test(label)) {
      const btn = svg.closest?.('button, [role="button"]');
      if (btn && isNodeVisible(btn)) return btn;
    }
  }
  for (const btn of root.querySelectorAll('button, [role="button"]')) {
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
 * Universal semantic `<time>` DOM walker for Instagram comments (adapted from
 * Nov 2026 `dartganan/instagram-comment-scraper`).
 *
 * Works regardless of obfuscated CSS class names or React `ul`/`div` nesting:
 * anchors on `<time>` elements, walks up <= 8 ancestors to the enclosing row
 * holding a single-segment profile link `<a href="/username/">`, and extracts
 * the clean comment text from `span[dir="auto"], div[dir="auto"]`.
 */
export function extractCommentsFromDom(root, { excludeAuthor = null } = {}) {
  if (!root) return [];
  const excludeLower = excludeAuthor ? String(excludeAuthor).replace(/^@/, '').toLowerCase() : null;
  const times = [...root.querySelectorAll('time')];
  const seen = new Set();
  const out = [];

  for (const timeEl of times) {
    const timeAgo = collapse(timeEl.textContent);
    let container = timeEl.parentNode;
    let foundRow = null;
    let foundUsername = null;

    for (let depth = 0; depth < 8 && container && container !== root; depth += 1) {
      const links = [...(container.querySelectorAll?.('a[href]') ?? [])];
      let user = null;
      for (const link of links) {
        const candidate = profileLinkUsername(link.getAttribute?.('href') ?? link.href ?? '');
        if (candidate) {
          user = candidate;
          break;
        }
      }
      if (user) {
        const fullText = collapse(container.textContent);
        if (fullText.length > (timeAgo.length + user.length + 1)) {
          foundRow = container;
          foundUsername = user;
          // Prefer an <li> or a row with a profile avatar img if we reached it
          if (String(container.tagName ?? '').toUpperCase() === 'LI' || container.querySelector?.('img')) {
            break;
          }
        }
      }
      container = container.parentNode;
    }

    if (!foundRow || !foundUsername) continue;
    if (excludeLower && foundUsername.toLowerCase() === excludeLower) continue;

    // Extract clean comment text from dir="auto" spans/divs inside this row
    const dirNodes = [...(foundRow.querySelectorAll?.('span[dir="auto"], div[dir="auto"]') ?? [])];
    const parts = [];
    for (const node of dirNodes) {
      const text = collapse(node.textContent);
      if (!text) continue;
      if (text.toLowerCase() === foundUsername.toLowerCase()) continue;
      if (text === timeAgo) continue;
      if (/^(reply|رد|see translation|عرض الترجمة|\d+\s*likes?|\d+\s*إعجاب|edited|تم التعديل)$/i.test(text)) continue;
      parts.push(text);
    }

    let commentText = parts.join(' ').trim();
    if (!commentText) {
      // Fallback: strip username + timeAgo + trailing Reply/Likes labels from row text
      commentText = collapse(foundRow.textContent)
        .replace(new RegExp(`^@?${foundUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '')
        .replace(timeAgo, '')
        .replace(/\b(Reply|See translation|\d+\s+likes?)\b/gi, '')
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
  for (const link of root.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? '';
    if (!href.startsWith('/')) continue;
    const username = usernameFromPath(href.split('?')[0]);
    if (!username) continue;
    if (seen.has(username)) continue;
    seen.add(username);
    const spans = link.querySelectorAll('span');
    const fullName = spans.map((s) => collapse(s.textContent)).filter(Boolean).join(' ') || collapse(link.textContent);
    out.push({ username, fullName, href });
  }
  return out;
}

/** Authors of tiles on hashtag/explore/saved grids (SRC-8). */
export function gridTileAuthors(root) {
  const out = [];
  for (const article of root.querySelectorAll('article, [role="menuitem"], li')) {
    const link = article.querySelectorAll('a').find((a) => {
      const href = a.getAttribute('href') ?? '';
      return href.startsWith('/') && usernameFromPath(href.split('?')[0]);
    });
    if (!link) continue;
    const username = usernameFromPath((link.getAttribute('href') ?? '').split('?')[0]);
    if (username && !out.some((row) => row.username === username)) {
      out.push({ username, href: link.getAttribute('href') });
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
