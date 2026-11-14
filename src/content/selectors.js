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
  'favicon.ico', 'robots.txt', 'saved', 'tag',
]);

export function isReservedSegment(segment) {
  return RESERVED_SEGMENTS.includes(String(segment ?? '').toLowerCase());
}

/** Username from a pathname like "/sara_shop/?hl=en", or null when reserved. */
export function usernameFromPath(pathname) {
  const first = String(pathname ?? '').split('/').filter(Boolean)[0] ?? '';
  const name = decodeURIComponent(first).replace(/\.+$/, '');
  if (!name || isReservedSegment(name)) return null;
  return name;
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

/**
 * The scrollable list inside a followers/following/likers modal — the element
 * the universal auto-scroller has to drive. Chosen by overflow and scrollable
 * height, never by a class name Instagram may rename.
 */
export function findScrollableList(root) {
  let best = null;
  let bestRoom = 0;
  for (const node of root.querySelectorAll('div')) {
    const room = (node.scrollHeight ?? 0) - (node.clientHeight ?? 0);
    if (room <= 0) continue;
    const overflowY = node.style?.overflowY || (node.getAttribute('style') ?? '').match(/overflow-y:\s*([a-z-]+)/)?.[1] || '';
    if (overflowY && !/auto|scroll|overlay/.test(overflowY)) continue;
    if (room > bestRoom) {
      best = node;
      bestRoom = room;
    }
  }
  return best;
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
