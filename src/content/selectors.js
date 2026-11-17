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
  SEND_MESSAGE: 'sendMessage',
  OPTIONS: 'options',
  CLOSE: 'close',
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
  [Label.SEND_MESSAGE]: ['Send message', 'Send Message', 'إرسال رسالة'],
  [Label.OPTIONS]: ['Options', 'More options', 'خيارات', 'المزيد من الخيارات'],
  [Label.CLOSE]: ['Close', 'إغلاق'],
  [Label.SEND]: [
    'Send', 'Send a message', 'Press enter to send', 'Press Enter to send',
    'إرسال', 'إرسال الرسالة', 'ارسال',
    'Envoyer', 'Enviar', 'Senden', 'Gönder', 'Invia', 'Отправить', 'Kirim', '发送', '送信', '보내기',
  ],
  [Label.UNFOLLOW]: ['Unfollow', 'إلغاء المتابعة'],
  [Label.CANCEL]: ['Cancel', 'إلغاء'],
  [Label.TRY_AGAIN_LATER]: ['Try Again Later', 'حاول لاحقًا', 'حاولي لاحقًا'],
  [Label.CONFIRM]: ['Confirm', 'تأكيد'],
});

const LABEL_LOOKUP = (() => {
  const map = new Map();
  for (const [kind, texts] of Object.entries(LABEL_TEXT)) {
    for (const text of texts) {
      const norm = collapse(text);
      map.set(norm, kind);
      map.set(norm.toLowerCase(), kind);
    }
  }
  return map;
})();

export function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Which label kind this visible text is, or null. Exact match, never substring. */
export function labelKind(text) {
  const norm = collapse(text);
  if (!norm) return null;
  return LABEL_LOOKUP.get(norm) ?? LABEL_LOOKUP.get(norm.toLowerCase()) ?? null;
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

/** Username from a pathname like "/sara_shop/?hl=en", or null when reserved or a post URL. */
export function usernameFromPath(pathname) {
  const cleanPath = String(pathname ?? '').split('?')[0].split('#')[0];
  const segments = cleanPath.split('/').filter(Boolean);
  const first = segments[0] ?? '';
  const second = String(segments[1] ?? '').toLowerCase();
  // 2026 Instagram renders profile-prefixed post URLs like /<user>/p/<shortcode>/
  // and /<user>/reel/<shortcode>/. Those are post views, NOT profile pages.
  if (segments.length >= 3 && (second === 'p' || second === 'reel' || second === 'reels' || second === 'tv')) {
    return null;
  }
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

const IGNORED_BUTTON_TAGS = new Set(['SVG', 'TITLE', 'STYLE', 'SCRIPT']);

/**
 * Visible text of a button/control excluding embedded `<svg><title>` icons.
 *
 * In 2026 Instagram, the profile "Following" button includes a nested
 * `<svg><title>Down chevron icon</title></svg>`, so raw `button.textContent`
 * becomes `"FollowingDown chevron icon"`. Skipping SVG/title subtrees recovers
 * the exact human-visible label (`"Following"`) across English & Arabic.
 */
/** Non-SVG visible text inside a button (returns '' for icon-only buttons). */
function nonSvgButtonText(node) {
  if (!node) return '';
  const kids = node.childNodes ?? node.children;
  if (!kids || kids.length === 0) return collapse(node.textContent ?? '');
  const parts = [];
  const walk = (cur) => {
    if (!cur) return;
    if (typeof cur === 'string') {
      parts.push(cur);
      return;
    }
    if (cur.nodeType === 3) {
      parts.push(String(cur.nodeValue ?? cur.textContent ?? ''));
      return;
    }
    const tag = String(cur.tagName ?? '').toUpperCase();
    if (IGNORED_BUTTON_TAGS.has(tag)) return;
    const childList = cur.childNodes ?? cur.children;
    if (childList && childList.length > 0) {
      for (const child of childList) walk(child);
    } else if (cur._text !== undefined && cur._text !== null) {
      parts.push(String(cur._text));
    } else if (cur.textContent) {
      parts.push(String(cur.textContent));
    }
  };
  walk(node);
  return collapse(parts.join(' '));
}

export function visibleButtonText(node) {
  if (!node) return '';
  const joined = nonSvgButtonText(node);
  return joined || collapse(node.textContent);
}

/** Extract embedded `<svg><title>` and `svg[aria-label]` strings from a node. */
function svgLabelsOf(node) {
  const labels = [];
  if (!node) return labels;
  for (const svg of qsa(node, 'svg')) {
    const al = collapse(svg.getAttribute?.('aria-label') ?? '');
    if (al) labels.push(al);
    for (const title of qsa(svg, 'title')) {
      const t = collapse(title.textContent ?? '');
      if (t) labels.push(t);
    }
  }
  return labels;
}

/** Buttons whose exact label is one of the requested kinds. */
export function findButtonsByLabel(root, kinds) {
  const wanted = new Set(kinds);
  const out = [];
  for (const button of qsa(root, 'button, [role="button"]')) {
    const pureVisible = nonSvgButtonText(button);
    let kind = labelKind(pureVisible) ?? labelKind(button.textContent);
    if (!kind) {
      kind = labelKind(button.getAttribute?.('aria-label'));
    }
    if (!kind && !pureVisible) {
      for (const lbl of svgLabelsOf(button)) {
        kind = labelKind(lbl);
        if (kind) break;
      }
    }
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
 * Find the profile `<header>` Message button (never matching the sidebar or
 * bottom-right "Messages" dock launcher).
 */
export function findProfileMessageButton(root) {
  if (!root) return null;
  const headers = qsa(root, 'header').filter((h) => !h.closest?.('[role="dialog"]'));
  for (const hdr of headers) {
    const hit = findButtonByLabel(hdr, [Label.MESSAGE, Label.SEND_MESSAGE]);
    if (hit && isNodeVisible(hit.button)) return hit;
    for (const link of qsa(hdr, 'a[href*="/direct/"]')) {
      const kind = labelKind(visibleButtonText(link)) ?? labelKind(link.getAttribute?.('aria-label'));
      if ((kind === Label.MESSAGE || kind === Label.SEND_MESSAGE) && isNodeVisible(link)) {
        return { button: link, kind };
      }
    }
  }
  // Responsive/narrow layout fallback: check directly inside <main> outside
  // feed <article> cards, dialogs, and nav.
  const mains = qsa(root, 'main, [role="main"]').filter((m) => !m.closest?.('[role="dialog"]'));
  for (const main of mains) {
    for (const hit of findButtonsByLabel(main, [Label.MESSAGE, Label.SEND_MESSAGE])) {
      if (hit.button.closest?.('article, nav, [role="dialog"]')) continue;
      if (isNodeVisible(hit.button)) return hit;
    }
  }
  // Minimal DOM fallback (only when no profile <header> or <main> exists at all).
  if (headers.length === 0 && mains.length === 0) {
    for (const hit of findButtonsByLabel(root, [Label.MESSAGE, Label.SEND_MESSAGE])) {
      if (hit.button.closest?.('nav, [role="dialog"]')) continue;
      if (isNodeVisible(hit.button)) return hit;
    }
  }
  return null;
}

/**
 * Find the profile `<header>` three-dots "Options" button (`svg title="Options"`
 * or `aria-label="Options"`). Some Instagram profiles hide "Send message" inside
 * this menu instead of rendering a header Message button.
 */
export function findProfileOptionsButton(root) {
  if (!root) return null;
  const headers = qsa(root, 'header').filter((h) => !h.closest?.('[role="dialog"]'));
  for (const hdr of headers) {
    const hit = findButtonByLabel(hdr, [Label.OPTIONS]);
    if (hit && isNodeVisible(hit.button)) return hit;
  }
  const mains = qsa(root, 'main, [role="main"]').filter((m) => !m.closest?.('[role="dialog"]'));
  for (const main of mains) {
    for (const hit of findButtonsByLabel(main, [Label.OPTIONS])) {
      if (hit.button.closest?.('article, nav, [role="dialog"]')) continue;
      if (isNodeVisible(hit.button)) return hit;
    }
  }
  return null;
}

const OPTIONS_MENU_MARKERS = [
  /^block$/i,
  /^restrict$/i,
  /^report$/i,
  /^about this account$/i,
  /^share to/i,
  /^send message$/i,
  /^حظر$/,
  /^تقييد$/,
  /^إبلاغ$/,
  /^حول هذا الحساب$/,
  /^إرسال رسالة$/,
];

/**
 * Inspect open `[role="dialog"]` overlays for the profile Options menu.
 * Returns `{ dialog, isOptionsMenu, sendMessageButton, cancelButton }` when an
 * Options menu dialog is open, or null otherwise.
 */
export function findOptionsDialogSendMessage(root) {
  const dialogs = findDialogs(root);
  for (let i = dialogs.length - 1; i >= 0; i -= 1) {
    const dialog = dialogs[i];
    const buttons = qsa(dialog, 'button, [role="button"]');
    if (buttons.length === 0) continue;
    let sendMessageButton = null;
    let cancelButton = null;
    let markerHits = 0;
    for (const b of buttons) {
      const txt = visibleButtonText(b) || collapse(b.getAttribute?.('aria-label') ?? '');
      const kind = labelKind(txt) ?? labelKind(b.textContent);
      if (kind === Label.SEND_MESSAGE || kind === Label.MESSAGE) sendMessageButton = b;
      if (kind === Label.CANCEL || kind === Label.CLOSE) cancelButton = b;
      if (OPTIONS_MENU_MARKERS.some((re) => re.test(txt))) markerHits += 1;
    }
    if (sendMessageButton || markerHits >= 2) {
      return { dialog, isOptionsMenu: true, sendMessageButton, cancelButton };
    }
  }
  return null;
}

const UNRELATED_EDITOR_RE = /\b(comment|reply to|search|caption|bio|note|notes|find)\b|تعليق|رد على|بحث|إضافة تعليق|اكتب تعليق|коммент|поиск/i;
const MESSAGE_CUE_RE = /\b(messages?|write a message|send a message|type a message|chat)\b|رسالة|مراسلة|اكتب رسالة|сообщени|envoyer|enviar|nachricht|mesaj/i;
const COMPOSER_TRAY_RE = /^(choose an emoji|voice clip|add photo or video|choose a gif|like|send|press enter to send|إرسال|مقطع صوتي|إضافة صورة)/i;
const SEND_BUTTON_RE = /^(send(\s+(a\s+)?message)?|press\s+enter\s+to\s+send|إرسال(\s+(الرسالة|رسالة))?|ارسال|envoyer|enviar|senden|gönder|invia|отправить|kirim|发送|送信|보내기)$/i;
const NON_SEND_TRAY_RE = /\b(emoji|voice|microphone|audio|photo|video|gallery|image|gif|sticker|like|heart|thumbs|camera|attach|file|plus|add|more|close|expand|go back|back|call|info|conversation|details|options)\b|صوت|مقطع صوتي|صورة|فيديو|ملصق|إعجاب|رموز|إغلاق|توسيع|رجوع|خيارات/i;

function editorLabelText(editor) {
  if (!editor) return '';
  return collapse([
    editor.getAttribute?.('aria-label'),
    editor.getAttribute?.('aria-placeholder'),
    editor.getAttribute?.('placeholder'),
    editor.getAttribute?.('data-placeholder'),
  ].filter(Boolean).join(' '));
}

function siblingPlaceholderText(editor) {
  const parent = editor?.parentNode;
  if (!parent) return '';
  const kids = parent.children ?? parent.childNodes ?? [];
  const parts = [];
  for (const kid of kids) {
    if (!kid || kid === editor) continue;
    const tag = String(kid.tagName ?? '').toUpperCase();
    if (!tag || tag === 'BUTTON' || tag === 'SVG' || tag === 'SCRIPT' || tag === 'STYLE') continue;
    if (kid.getAttribute?.('role') === 'button') continue;
    const txt = collapse(kid.textContent ?? '');
    if (txt && txt.length <= 60) parts.push(txt);
  }
  return parts.join(' ');
}

/** True when `editor` carries an explicit Message/DM placeholder or aria-label. */
export function hasMessageEditorCue(editor) {
  if (!editor) return false;
  const own = editorLabelText(editor);
  if (own && MESSAGE_CUE_RE.test(own)) return true;
  const sib = siblingPlaceholderText(editor);
  if (sib && MESSAGE_CUE_RE.test(sib) && !UNRELATED_EDITOR_RE.test(sib)) return true;
  return false;
}

function isCommentEditor(editor) {
  if (!editor) return true;
  const combined = editorLabelText(editor);
  if (combined && UNRELATED_EDITOR_RE.test(combined)) return true;
  const role = String(editor.getAttribute?.('role') ?? '').toLowerCase();
  if (role === 'searchbox') return true;
  const type = String(editor.getAttribute?.('type') ?? '').toLowerCase();
  if (type === 'search') return true;
  // A contenteditable or textarea nested inside a feed/post <article>, site
  // <nav>, profile <header>, or search container is never a Direct composer
  // (DM docks render [role="article"] as sibling message bubbles above the
  // composer, never wrapping the composer itself).
  if (editor.closest?.('article, nav, [role="search"], form[role="search"]')) return true;
  // Never pick an editor inside a profile <header> (e.g. bio edit).
  if (editor.closest?.('header')) return true;
  return false;
}

function hasDockChrome(node) {
  if (!node) return false;
  let hasClose = false;
  let hasExpandOrBack = false;
  for (const btn of qsa(node, 'button, [role="button"]')) {
    const al = collapse(btn.getAttribute?.('aria-label') ?? '').toLowerCase();
    const labels = [al, ...svgLabelsOf(btn).map((s) => s.toLowerCase())];
    for (const l of labels) {
      if (l === 'close' || l === 'إغلاق') hasClose = true;
      if (l === 'expand' || l === 'go back' || l === 'open in direct' || l === 'توسيع' || l === 'رجوع') hasExpandOrBack = true;
    }
    if (hasClose && hasExpandOrBack) return true;
  }
  return false;
}

function hasComposerTrayIcons(node) {
  if (!node) return false;
  let hits = 0;
  for (const btn of qsa(node, 'button, [role="button"]')) {
    const labels = [
      collapse(btn.getAttribute?.('aria-label') ?? ''),
      visibleButtonText(btn),
      ...svgLabelsOf(btn),
    ];
    for (const l of labels) {
      if (l && COMPOSER_TRAY_RE.test(l)) {
        hits += 1;
        break;
      }
    }
    if (hits >= 2) return true;
  }
  return false;
}

function isFixedPositionNode(node) {
  if (!node) return false;
  try {
    if (typeof getComputedStyle === 'function') {
      if (getComputedStyle(node)?.position === 'fixed') return true;
    }
  } catch { /* shim */ }
  if (node.style?.position === 'fixed') return true;
  const attr = String(node.getAttribute?.('style') ?? '');
  return /(?:^|;)\s*position\s*:\s*fixed/i.test(attr);
}

/**
 * Walk up from a Lexical/textbox composer to locate the floating bottom-right
 * Direct chat dock container on a profile/feed page (where there is NO
 * [role="dialog"] and the URL stays on /<username>/).
 */
function findDmDockContainerForEditor(editor, root) {
  let cur = editor?.parentNode ?? null;
  let trayFallback = null;
  let fixedFallback = null;
  let chatStyleFallback = null;
  for (let depth = 0; depth < 30 && cur; depth += 1) {
    const tag = String(cur.tagName ?? '').toUpperCase();
    if (tag === 'BODY' || tag === 'HTML' || tag === 'MAIN') break;
    if (cur.getAttribute?.('role') === 'main') break;
    if (hasDockChrome(cur)) return cur;
    if (!trayFallback && hasComposerTrayIcons(cur)) trayFallback = cur;
    if (!fixedFallback && isFixedPositionNode(cur) && !cur.querySelector?.('main, header')) {
      fixedFallback = cur;
    }
    const styleAttr = String(cur.getAttribute?.('style') ?? '');
    if (!chatStyleFallback && /--x-width\s*:|--chat-composer/i.test(styleAttr) && !cur.querySelector?.('main, header')) {
      chatStyleFallback = cur;
    }
    cur = cur.parentNode;
  }
  if (fixedFallback) return fixedFallback;
  if (chatStyleFallback) {
    // Walk up 1–2 levels past the composer style wrapper if we're still inside a dock pane.
    let up = chatStyleFallback;
    for (let i = 0; i < 6 && up?.parentNode; i += 1) {
      const p = up.parentNode;
      const pTag = String(p.tagName ?? '').toUpperCase();
      if (pTag === 'BODY' || pTag === 'HTML' || pTag === 'MAIN') break;
      if (p.querySelector?.('main, header')) break;
      if (hasDockChrome(p)) return p;
      up = p;
    }
    return up;
  }
  // If we found the composer tray outside <main>, walk up so the container
  // includes the dock's message list and header above the composer.
  if (trayFallback && !editor.closest?.('main, [role="main"]')) {
    let up = trayFallback;
    for (let i = 0; i < 10 && up?.parentNode; i += 1) {
      const p = up.parentNode;
      const pTag = String(p.tagName ?? '').toUpperCase();
      if (pTag === 'BODY' || pTag === 'HTML' || pTag === 'MAIN') break;
      if (p.querySelector?.('main, header')) break;
      if (hasDockChrome(p)) return p;
      up = p;
    }
    return up;
  }
  return null;
}

/**
 * Walk up from a composer on `/direct/` (or any non-dock page) to find a broad
 * conversation container that encloses BOTH the message list above the box and
 * the Send button beside it — never collapsing down to a tiny `editor.parentNode`.
 */
function findThreadPanelForEditor(editor, root) {
  const mainScope = editor.closest?.('main, [role="main"], section');
  if (mainScope) return mainScope;
  let cur = editor?.parentNode ?? null;
  let best = null;
  for (let depth = 0; depth < 24 && cur; depth += 1) {
    const tag = String(cur.tagName ?? '').toUpperCase();
    if (tag === 'BODY' || tag === 'HTML') break;
    if (cur.querySelector?.('nav[role="navigation"]')) break;
    if (cur.querySelector?.('[role="grid"], [role="article"], [role="log"]')) {
      return cur;
    }
    if (hasComposerTrayIcons(cur) || qsa(cur, 'button, [role="button"]').length >= 1) {
      best = cur;
    }
    cur = cur.parentNode;
  }
  return best ?? root?.body ?? root ?? editor.parentNode;
}

/**
 * Find an open floating Direct chat dock on the page, EVEN IF it renders no
 * composer (for example, when Instagram displays "You can't message this
 * account unless they follow you" or "Invite sent" inside the dock).
 */
export function findOpenDmDock(root) {
  if (!root) return null;
  for (const btn of qsa(root, 'button, [role="button"]')) {
    if (btn.closest?.('main, [role="main"], nav, [role="dialog"]')) continue;
    const labels = [
      collapse(btn.getAttribute?.('aria-label') ?? '').toLowerCase(),
      ...svgLabelsOf(btn).map((s) => s.toLowerCase()),
    ];
    if (!labels.some((l) => l === 'close' || l === 'إغلاق')) continue;
    let cur = btn.parentNode;
    for (let depth = 0; depth < 10 && cur; depth += 1) {
      const tag = String(cur.tagName ?? '').toUpperCase();
      if (tag === 'BODY' || tag === 'HTML') break;
      if (hasDockChrome(cur)) {
        // Walk up slightly while staying outside body if needed so the message
        // area + composer/restriction notice are inside the dock container.
        let container = cur;
        for (let up = 0; up < 6 && container?.parentNode; up += 1) {
          const p = container.parentNode;
          const pTag = String(p.tagName ?? '').toUpperCase();
          if (pTag === 'BODY' || pTag === 'HTML') break;
          // Stop before engulfing <main> or <header>
          if (p.querySelector?.('main, header')) break;
          container = p;
        }
        return container;
      }
      cur = cur.parentNode;
    }
  }
  return null;
}

/** Locate the Close button inside an open floating Direct chat dock. */
export function findDmDockCloseButton(container) {
  if (!container) return null;
  const hit = findButtonByLabel(container, [Label.CLOSE]);
  return hit?.button ?? null;
}

/**
 * Collect candidate editable nodes across `root` (including open shadow roots
 * if any exist). Deduplicates while preserving document order.
 */
function collectEditableCandidates(root) {
  const seen = new Set();
  const out = [];
  const addFrom = (scope) => {
    for (const el of qsa(scope, '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], textarea')) {
      if (String(el.getAttribute?.('contenteditable') ?? '').toLowerCase() === 'false') continue;
      if (!seen.has(el)) {
        seen.add(el);
        out.push(el);
      }
    }
  };
  addFrom(root);
  // Open shadow root scan (defensive, zero cost when none exist).
  for (const el of qsa(root, '*')) {
    if (el?.shadowRoot) addFrom(el.shadowRoot);
  }
  return out;
}

/**
 * Find the active DM surface (`dialog`, `direct_page`, or floating `dock`) and
 * its composer node on ANY Instagram page. Never picks post comment boxes,
 * search boxes, or bio fields.
 */
export function findDmSurface(root, pathname = '') {
  if (!root) return null;
  const onDirect = String(pathname || root?.location?.pathname || '').startsWith('/direct');
  const candidates = collectEditableCandidates(root);

  const matches = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const editor = candidates[index];
    if (!isNodeVisible(editor)) continue;
    if (isCommentEditor(editor)) continue;
    const tag = String(editor.tagName ?? '').toUpperCase();
    const isLexical = editor.getAttribute?.('data-lexical-editor') === 'true';
    const isTextboxRole = String(editor.getAttribute?.('role') ?? '').toLowerCase() === 'textbox';
    const hasMessageCue = hasMessageEditorCue(editor);

    // For <textarea>, require an explicit Message placeholder/aria-label (or
    // being directly on /direct/) so we never confuse a bio/comment textarea
    // with a DM box.
    if (tag === 'TEXTAREA' && !hasMessageCue && !onDirect) continue;

    const dialog = editor.closest?.('[role="dialog"]');
    if (dialog) {
      matches.push({ kind: 'dialog', container: dialog, editor, priority: 100 + (hasMessageCue ? 20 : 0) + (isLexical ? 10 : 0), index });
      continue;
    }

    const dock = findDmDockContainerForEditor(editor, root);
    if (dock && (hasMessageCue || isLexical || isTextboxRole)) {
      matches.push({ kind: 'dock', container: dock, editor, priority: 90 + (hasMessageCue ? 20 : 0) + (isLexical ? 10 : 0), index });
      continue;
    }

    if (onDirect) {
      const container = findThreadPanelForEditor(editor, root);
      matches.push({ kind: 'direct_page', container, editor, priority: 95 + (hasMessageCue ? 20 : 0) + (isLexical ? 10 : 0), index });
      continue;
    }

    // Universal any-page fallback: even if Instagram changed dock chrome or
    // rendered an unexpected wrapper on any page, accept any visible non-comment
    // editor with a message cue OR a visible Lexical/textbox composer!
    if (hasMessageCue || isLexical || isTextboxRole) {
      const container = dock ?? findThreadPanelForEditor(editor, root);
      matches.push({
        kind: 'dock',
        container,
        editor,
        priority: (hasMessageCue ? 70 : 40) + (isLexical ? 15 : 0) + (isTextboxRole ? 5 : 0),
        index,
      });
    }
  }

  if (matches.length === 0) return null;
  // Prefer highest confidence; tie-break toward the last (bottom-most/newest)
  // visible composer in document order.
  matches.sort((a, b) => (b.priority - a.priority) || (b.index - a.index));
  const best = matches[0];
  return { kind: best.kind, container: best.container, editor: best.editor };
}

/**
 * The Lexical DM composer, or null.
 *
 * Scoped on purpose: instagram.com carries other contenteditable boxes (post
 * comments, reply fields), and typing a campaign message into one of those is
 * a public post, not a DM. Supports the 2026 floating bottom-right Direct chat
 * dock, Direct dialogs, and the full `/direct/t/...` page.
 */
export function composerScope(root, pathname = '') {
  return findDmSurface(root, pathname)?.editor ?? null;
}

const DM_UNAVAILABLE_PATTERNS = [
  /you\s+can['’]?t\s+message\s+this\s+account/i,
  /not\s+everyone\s+can\s+message\s+this\s+account/i,
  /this\s+account\s+can['’]?t\s+receive\s+your\s+message/i,
  /doesn['’]?t\s+allow\s+new\s+message\s+requests/i,
  /you\s+can['’]?t\s+send\s+messages?\s+to\s+this\s+account/i,
  /only\s+people\s+.*\s+follows\s+can\s+message/i,
  /can['’]?t\s+message\s+this\s+account\s+unless/i,
  /لا\s+يمكنك\s+مراسلة\s+هذا\s+الحساب/,
  /لا\s+يمكن\s+للجميع\s+مراسلة\s+هذا\s+الحساب/,
  /لا\s+يسمح\s+هذا\s+الحساب\s+بتلقي\s+طلبات\s+المراسلة/,
  /لا\s+يمكنك\s+إرسال\s+رسائل\s+إلى\s+هذا\s+الحساب/,
];

const DM_INVITE_SENT_PATTERNS = [
  /\binvite\s+sent\b/i,
  /you\s+can\s+send\s+more\s+messages\s+after\s+your\s+invite\s+is\s+accepted/i,
  /you(?:'ve|\s+have)?\s+already\s+sent\s+(?:an?|a\s+message)\s+invite/i,
  /once\s+they\s+accept\s+your\s+(?:invite|request)/i,
  /تم\s+إرسال\s+الدعوة/,
  /يمكنك\s+إرسال\s+المزيد\s+من\s+الرسائل\s+بعد\s+قبول\s+دعوتك/,
];

const DM_SEND_FAILED_PATTERNS = [
  /\b(?:message\s+)?failed\s+to\s+send\b/i,
  /\bcouldn['’]?t\s+send\s+(?:this\s+)?message\b/i,
  /تعذر\s+إرسال\s+الرسالة/,
];

/** Collect non-composer chrome text from a DM container for restriction matching. */
function dmChromeText(scope, { includeArticles = false } = {}) {
  if (!scope) return '';
  const parts = [];
  const walk = (node) => {
    if (!node) return;
    if (typeof node === 'string') { parts.push(node); return; }
    if (node.nodeType === 3) { parts.push(String(node.nodeValue ?? node.textContent ?? '')); return; }
    const tag = String(node.tagName ?? '').toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG') return;
    if (node.getAttribute?.('contenteditable') === 'true' || tag === 'TEXTAREA') return;
    if (!includeArticles && node.getAttribute?.('role') === 'article') return;
    const kids = node.childNodes ?? node.children;
    if (kids && kids.length > 0) {
      for (const child of kids) walk(child);
    } else if (node._text !== undefined && node._text !== null) {
      parts.push(String(node._text));
    } else if (node.textContent) {
      parts.push(String(node.textContent));
    }
  };
  walk(scope);
  return collapse(parts.join(' '));
}

/**
 * Inspect an active DM container (dock, Direct thread panel, or dialog) for
 * Instagram messaging restriction notices, invite-sent locks, or send errors.
 * Ignores text inside the composer (and inside received/sent message bubbles
 * for account-restriction notices) so a user's own draft cannot self-trigger.
 */
export function detectDmRestriction(scope) {
  if (!scope) return null;
  const chromeText = dmChromeText(scope, { includeArticles: false });
  if (chromeText) {
    for (const re of DM_UNAVAILABLE_PATTERNS) {
      if (re.test(chromeText)) {
        return {
          kind: 'unavailable',
          reason: 'Instagram says you cannot message this account (message requests restricted or followers-only).',
        };
      }
    }
    for (const re of DM_INVITE_SENT_PATTERNS) {
      if (re.test(chromeText)) {
        return {
          kind: 'invite_sent',
          reason: 'A message invite was already sent to this account and has not been accepted yet.',
        };
      }
    }
  }
  const statusText = dmChromeText(scope, { includeArticles: true });
  if (statusText) {
    for (const re of DM_SEND_FAILED_PATTERNS) {
      if (re.test(statusText)) {
        return {
          kind: 'send_failed',
          reason: 'Instagram reported that the message failed to send.',
        };
      }
    }
  }
  return null;
}

function isButtonInteractive(button) {
  if (!button) return false;
  if (!isNodeVisible(button)) return false;
  if (button.disabled === true) return false;
  if (String(button.getAttribute?.('aria-disabled') ?? '').toLowerCase() === 'true') return false;
  if (button.style?.pointerEvents === 'none') return false;
  const inlineStyle = String(button.getAttribute?.('style') ?? '');
  if (inlineStyle && /(?:^|;)\s*pointer-events\s*:\s*none\b/i.test(inlineStyle)) return false;
  try {
    if (typeof getComputedStyle === 'function' && getComputedStyle(button)?.pointerEvents === 'none') {
      return false;
    }
  } catch { /* shim */ }
  return true;
}

function isSendLikeButton(button, allowSendMessage = false) {
  if (!isButtonInteractive(button)) return null;
  const pureVisible = nonSvgButtonText(button);
  const fullText = collapse(button.textContent ?? '');
  const aria = collapse(button.getAttribute?.('aria-label') ?? '');
  const titleAttr = collapse(button.getAttribute?.('title') ?? '');
  const svgs = svgLabelsOf(button);
  const wanted = allowSendMessage ? [Label.SEND, Label.SEND_MESSAGE] : [Label.SEND];

  for (const text of [pureVisible, fullText, aria, titleAttr, ...svgs]) {
    if (!text) continue;
    const kind = labelKind(text);
    if (kind && wanted.includes(kind)) return { button, kind };
    if (SEND_BUTTON_RE.test(text)) {
      if (!allowSendMessage && /^send\s+(a\s+)?message$/i.test(text)) continue;
      return { button, kind: Label.SEND };
    }
  }
  return null;
}

function isKnownNonSendTrayButton(button) {
  const combined = collapse([
    nonSvgButtonText(button),
    button.getAttribute?.('aria-label'),
    button.getAttribute?.('title'),
    ...svgLabelsOf(button),
  ].filter(Boolean).join(' '));
  return Boolean(combined && NON_SEND_TRAY_RE.test(combined));
}

/**
 * Find the Send button on ANY page where a DM composer is open:
 *  1. Walking up 1–8 ancestors around the composer textbox itself (the composer
 *     bar beside the textbox),
 *  2. Inside the active DM container (floating dock, dialog, or Direct pane),
 *  3. Falling back across the full document (excluding profile `<header>`,
 *     `<nav>`, and feed `<article>` cards so post Share buttons are never hit),
 *  4. When `allowPositional` is enabled (only AFTER verified text is in the
 *     composer), detecting an explicit `type="submit"` or a lone non-media
 *     trailing button right beside `editor` inside the composer bar (handles
 *     unlabelled SVG icon A/B tests and unlisted locales).
 */
export function findSendButton(root, dmContainer = null, editor = null, options = {}) {
  const allowPositional = Boolean(options?.allowPositional);
  const searchScope = (scope, { allowSendMessage = false, excludeChrome = false } = {}) => {
    if (!scope) return null;
    for (const button of qsa(scope, 'button, [role="button"]')) {
      if (excludeChrome && button.closest?.('header, nav, article')) continue;
      if (editor && (button === editor || editor.contains?.(button))) continue;
      const hit = isSendLikeButton(button, allowSendMessage);
      if (hit) return hit;
    }
    return null;
  };

  // 1. Composer bar ancestors right beside the textbox (fastest & most accurate).
  if (editor) {
    let cur = editor.parentNode;
    for (let depth = 0; depth < 8 && cur; depth += 1) {
      const tag = String(cur.tagName ?? '').toUpperCase();
      if (tag === 'BODY' || tag === 'HTML') break;
      const hit = searchScope(cur, { allowSendMessage: true, excludeChrome: true });
      if (hit) return hit;
      cur = cur.parentNode;
    }
  }

  // 2. Active DM container (dock / dialog / direct thread panel).
  if (dmContainer) {
    const hit = searchScope(dmContainer, { allowSendMessage: true, excludeChrome: false });
    if (hit) return hit;
  }

  // 3. Page-wide fallback (excluding profile header, nav, and feed articles).
  if (root) {
    const hit = searchScope(root, { allowSendMessage: false, excludeChrome: true });
    if (hit) return hit;
  }

  // 4. Positional composer-bar fallback (ONLY when caller confirms text is
  //    already typed into `editor` and explicit label lookup found nothing).
  if (allowPositional && editor) {
    const edRect = typeof editor.getBoundingClientRect === 'function' ? editor.getBoundingClientRect() : null;
    const hasLayout = Boolean(edRect && edRect.width > 0 && edRect.height > 0);
    let cur = editor.parentNode;
    for (let depth = 0; depth < 6 && cur; depth += 1) {
      const tag = String(cur.tagName ?? '').toUpperCase();
      if (tag === 'BODY' || tag === 'HTML' || tag === 'MAIN') break;
      const buttons = qsa(cur, 'button, [role="button"]').filter((b) => {
        if (b === editor || editor.contains?.(b)) return false;
        if (b.closest?.('header, nav, article')) return false;
        return isButtonInteractive(b);
      });
      if (buttons.length === 0) {
        cur = cur.parentNode;
        continue;
      }
      // Explicit submit button right beside the composer.
      const submitBtn = buttons.find((b) => String(b.getAttribute?.('type') ?? '').toLowerCase() === 'submit');
      if (submitBtn) return { button: submitBtn, kind: Label.SEND, positional: true };

      // Check if media tray buttons (Voice Clip / Photo / GIF) have already
      // swapped out for a single trailing send control.
      const hasMediaTray = buttons.some((b) => /\b(voice|microphone|photo|video|gif|sticker)\b|مقطع صوتي|إضافة صورة/i.test(collapse([
        b.getAttribute?.('aria-label'),
        ...svgLabelsOf(b),
      ].filter(Boolean).join(' '))));
      if (hasMediaTray) {
        cur = cur.parentNode;
        continue;
      }

      const candidates = buttons.filter((b) => {
        if (isKnownNonSendTrayButton(b)) return false;
        if (hasLayout && typeof b.getBoundingClientRect === 'function') {
          const r = b.getBoundingClientRect();
          if (r && r.width > 0 && r.height > 0) {
            const edCy = edRect.top + edRect.height / 2;
            const bCy = r.top + r.height / 2;
            if (Math.abs(bCy - edCy) > Math.max(48, edRect.height * 1.5)) return false;
          }
        }
        return true;
      });
      if (candidates.length === 1) {
        return { button: candidates[0], kind: Label.SEND, positional: true };
      }
      cur = cur.parentNode;
    }
  }
  return null;
}

const NON_MESSAGE_ROW_PATTERNS = [
  /\bview profile\b/i,
  /عرض الملف الشخصي/,
  /\bend-to-end encrypted\b/i,
  /مشفرة تمامًا بين الطرفين/,
  /\byou can send more messages after\b/i,
  /\byou followed each other on instagram\b/i,
  /\byou(?:'ve| have)? (?:been )?follow(?:ed|ing) this account\b/i,
  /\binvite sent\b/i,
];

function isNonMessageDirectRow(row) {
  if (!row) return true;
  if (row.querySelector?.('[contenteditable="true"]')) return true;
  const text = collapse(row.textContent);
  if (!text) return true;
  if (NON_MESSAGE_ROW_PATTERNS.some((re) => re.test(text))) return true;
  // A brand-new empty 2026 DM thread renders a profile intro card inside the
  // first [role="row"] with a "View profile" link/button pointing to /<user>/.
  for (const link of qsa(row, 'a[href]')) {
    const label = collapse(link.textContent).toLowerCase();
    if (label === 'view profile' || label === 'عرض الملف الشخصي') return true;
  }
  // Pure timestamp separator rows (e.g. "Today 11:42 PM", "Nov 16, 2026")
  if (/^(?:today|yesterday|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}:\d{2})\b[\d\s,:\u200eAPMapm-]*$/i.test(text)) {
    return true;
  }
  return false;
}

/** Rendered message bubbles of the open thread, strictly scoped to the active DM surface. */
export function threadBubbles(root, scopeOverride = null) {
  let scope = scopeOverride;
  if (!scope) {
    const surface = findDmSurface(root);
    if (surface?.container) {
      scope = surface.container;
    } else {
      const dialogs = findDialogs(root);
      scope = dialogs.length > 0 ? dialogs[dialogs.length - 1] : root;
    }
  }
  if (!scope) return [];
  const articles = qsa(scope, '[role="article"]');
  if (articles.length > 0) return articles;

  // 2026 Instagram Direct (Comet/Messenger engine) renders message rows inside
  // a `role="grid"` (often labeled "Messages in conversation with …"). Avoid
  // grabbing the left-hand Chats/Inbox list by preferring a grid whose label
  // mentions Messages/Conversation, and strictly skip profile intro cards
  // ("View profile"), timestamps, and system notices so empty new threads are
  // never mistaken for already-messaged conversations.
  const grids = qsa(scope, '[role="grid"]');
  const messageGrid = grids.find((g) => /(messages?|conversation|الرسائل|المحادثة)/i.test(String(g.getAttribute?.('aria-label') ?? '')))
    ?? (grids.length > 0 ? grids[grids.length - 1] : null);
  const rowSource = messageGrid ?? scope;
  return qsa(rowSource, '[role="row"]').filter((row) => !isNonMessageDirectRow(row));
}

/**
 * Inspect a DM container (floating dock or `/direct/t/` panel) to determine
 * which Instagram username(s) its header / "View profile" links identify.
 *
 * Ignores links inside message bubbles (`[role="article"]`), navigation chrome,
 * and inbox thread-list sidebars (`Chats` / `Thread list`), and optionally
 * skips `viewerUsername` so the logged-in user's own avatar link never looks
 * like a mismatched recipient.
 */
export function dmContainerUserMatch(container, username, options = {}) {
  const target = String(username ?? '').trim().replace(/^@+/, '').toLowerCase();
  const viewer = String(options?.viewerUsername ?? '').trim().replace(/^@+/, '').toLowerCase();
  if (!container || !target) return { matched: false, foundUsers: [] };

  const inSidebarOrBubble = (node) => {
    if (!node?.closest) return false;
    if (node.closest('[role="article"], nav, [role="navigation"], [role="tablist"]')) return true;
    // Only skip explicit inbox sidebar containers ("Chats", "Thread list"),
    // NEVER active conversation panels like "Chat with <user>".
    let cur = node.parentNode;
    for (let depth = 0; depth < 12 && cur && cur !== container; depth += 1) {
      const al = collapse(cur.getAttribute?.('aria-label') ?? '').toLowerCase();
      if (al === 'chats' || al === 'thread list' || al === 'messages' || al === 'الدردشات' || al === 'قائمة المحادثات') {
        return true;
      }
      cur = cur.parentNode;
    }
    return false;
  };

  const foundSet = new Set();
  for (const link of qsa(container, 'a[href]')) {
    if (inSidebarOrBubble(link)) continue;
    const rawHref = link.getAttribute?.('href') ?? link.href ?? '';
    let path = rawHref;
    if (/^https?:\/\//i.test(rawHref)) {
      try { path = new URL(rawHref).pathname; } catch { /* leave as-is */ }
    }
    const u = usernameFromPath(path);
    if (u) {
      const lower = u.toLowerCase();
      if (viewer && lower === viewer) continue;
      foundSet.add(lower);
    }
  }
  if (foundSet.has(target)) return { matched: true, foundUsers: [...foundSet] };

  for (const heading of qsa(container, 'h1, h2, h3, [role="heading"]')) {
    if (inSidebarOrBubble(heading)) continue;
    const t = collapse(heading.textContent).replace(/^@+/, '').toLowerCase();
    if (t === target) return { matched: true, foundUsers: [...foundSet, target] };
  }

  for (const img of qsa(container, 'img[alt]')) {
    if (inSidebarOrBubble(img)) continue;
    const alt = collapse(img.getAttribute?.('alt') ?? '');
    const m = /^@?([a-z0-9._]+)['’]s profile picture$/i.exec(alt);
    if (m) {
      const lower = m[1].toLowerCase();
      if (viewer && lower === viewer) continue;
      foundSet.add(lower);
      if (lower === target) return { matched: true, foundUsers: [...foundSet] };
    }
  }

  return { matched: false, foundUsers: [...foundSet] };
}

/** True when the rendered Instagram page is a 404 / unavailable profile. */
export function isProfileUnavailable(root) {
  if (!root) return false;
  const text = collapse(root.body?.textContent ?? root.textContent ?? '');
  if (!text) return false;
  return /sorry, this page isn'?t available|profile isn'?t available|the link you followed may be broken|عذرًا، هذه الصفحة غير متوفرة/i.test(text);
}

/**
 * True when an already-open `/direct/t/...` thread OR floating chat dock visibly
 * belongs to `username`. Prevents a multi-person DM run from ever sending
 * Person B's message into Person A's still-open conversation.
 */
export function directThreadMatchesUser(root, username, options = {}) {
  const target = String(username ?? '').trim().replace(/^@+/, '').toLowerCase();
  if (!root || !target) return false;
  const surface = findDmSurface(root);
  if (surface?.container) {
    if (dmContainerUserMatch(surface.container, target, options).matched) return true;
  }
  const openDock = findOpenDmDock(root);
  if (openDock && dmContainerUserMatch(openDock, target, options).matched) return true;
  const dialogs = findDialogs(root);
  const scope = dialogs.length > 0 ? dialogs[dialogs.length - 1] : (root.querySelector?.('main, [role="main"]') ?? root);
  return dmContainerUserMatch(scope, target, options).matched;
}

/** The unfollow/confirm dialog Instagram opens after an Unfollow click. */
export function findConfirmDialog(root) {
  for (const dialog of findDialogs(root)) {
    const buttons = findButtonsByLabel(dialog, [Label.UNFOLLOW, Label.CONFIRM]);
    if (buttons.length > 0) return { dialog, confirm: buttons[0].button, kind: buttons[0].kind };
  }
  return null;
}

/** A visible "Try Again Later" / "Action Blocked"-style action-block dialog. */
export function findActionBlockDialog(root) {
  const blockPatterns = [
    /action\s+blocked/i,
    /we\s+(?:limit\s+how\s+often|restrict\s+certain\s+activity)/i,
    /temporarily\s+(?:blocked|locked|restricted)/i,
    /تم\s+حظر\s+الإجراء|نقيد\s+بعض\s+الأنشطة/,
  ];
  for (const dialog of findDialogs(root)) {
    if (labelKind(dialog.textContent) === Label.TRY_AGAIN_LATER) return dialog;
    if (qsa(dialog, 'button, [role="button"]').some((b) => labelKind(visibleButtonText(b)) === Label.TRY_AGAIN_LATER)) return dialog;
    const text = collapse(dialog.textContent);
    if (LABEL_TEXT[Label.TRY_AGAIN_LATER].some((t) => text === t || text.startsWith(`${t} `))) return dialog;
    if (blockPatterns.some((re) => re.test(text))) return dialog;
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
  let cur = node;
  for (let depth = 0; cur && depth < 32; depth += 1) {
    const tag = String(cur.tagName ?? '').toUpperCase();
    if (tag === 'HTML' || tag === '#DOCUMENT') break;
    if (cur.hidden === true || cur.hasAttribute?.('hidden') === true) return false;
    if (cur.style?.display === 'none' || cur.style?.visibility === 'hidden') return false;
    const inlineStyle = String(cur.getAttribute?.('style') ?? '');
    if (inlineStyle && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(inlineStyle)) {
      return false;
    }
    try {
      if (typeof getComputedStyle === 'function') {
        const style = getComputedStyle(cur);
        if (style?.display === 'none' || style?.visibility === 'hidden') return false;
        if (depth === 0 && style?.opacity === '0') return false;
      }
    } catch { /* shim */ }
    cur = cur.parentNode;
  }
  // In a real browser (where document.body has non-zero layout geometry),
  // reject elements with zero bounding rect or zero client rects so collapsed /
  // offscreen hidden composers never shadow the live visible one.
  try {
    const bodyRect = node.ownerDocument?.body?.getBoundingClientRect?.();
    if (bodyRect && bodyRect.width > 0) {
      if (typeof node.getClientRects === 'function' && node.getClientRects().length === 0) {
        return false;
      }
      if (typeof node.getBoundingClientRect === 'function') {
        const rect = node.getBoundingClientRect();
        if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
      }
    }
  } catch { /* shim */ }
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
    if (!matched.length) return null;
    return preferTopmost ? matched[matched.length - 1] : matched[0];
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
