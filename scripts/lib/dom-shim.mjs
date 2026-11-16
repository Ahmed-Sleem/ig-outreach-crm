/**
 * Minimal DOM + chrome API shim.
 *
 * Purpose: render the REAL view modules to static HTML outside Chrome, so the GUI
 * can be reviewed and edited without loading the extension, and so render-time
 * crashes are caught in CI rather than by a user clicking a tab.
 *
 * This is a preview/test tool, not a polyfill. It implements exactly the surface
 * the views actually touch — deliberately small, so it stays honest: if a view
 * starts using something this does not support, the render fails loudly instead of
 * quietly producing different HTML than Chrome would.
 */

const VOID_TAGS = new Set(['img', 'input', 'br', 'hr', 'meta', 'link']);

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

class ClassList {
  constructor(node) { this.node = node; }
  get _set() { return new Set((this.node.className || '').split(/\s+/).filter(Boolean)); }
  _write(set) { this.node.className = [...set].join(' '); }
  add(...c) { const s = this._set; c.forEach((x) => s.add(x)); this._write(s); }
  remove(...c) { const s = this._set; c.forEach((x) => s.delete(x)); this._write(s); }
  contains(c) { return this._set.has(c); }
  toggle(c, force) {
    const s = this._set;
    const has = s.has(c);
    const want = force === undefined ? !has : Boolean(force);
    if (want) s.add(c); else s.delete(c);
    this._write(s);
    return want;
  }
}

/**
 * Browser-faithful NodeList returned by `querySelectorAll`.
 *
 * Intentionally NOT an Array (no `.some`, `.map`, `.find`, `.filter`) so tests
 * catch real Chrome `NodeList` crashes (`TypeError: ...some is not a function`)
 * immediately in Node.
 */
class ShimNodeList {
  constructor(items = []) {
    for (let i = 0; i < items.length; i += 1) this[i] = items[i];
    this.length = items.length;
  }
  item(i) { return i >= 0 && i < this.length ? this[i] : null; }
  forEach(fn, thisArg) {
    for (let i = 0; i < this.length; i += 1) fn.call(thisArg, this[i], i, this);
  }
  *keys() { for (let i = 0; i < this.length; i += 1) yield i; }
  *values() { for (let i = 0; i < this.length; i += 1) yield this[i]; }
  *entries() { for (let i = 0; i < this.length; i += 1) yield [i, this[i]]; }
  [Symbol.iterator]() { return this.values(); }
}

class Element {
  constructor(tagName, doc) {
    this.tagName = tagName;
    this.nodeType = tagName === '#fragment' ? 11 : 1;
    this.ownerDocument = doc;
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.className = '';
    this.classList = new ClassList(this);
    this._text = null;
    this._rawHtml = null;
    this._listeners = {};
    this.parentNode = null;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
  }

  set textContent(v) { this._text = v === null || v === undefined ? '' : String(v); this.children = []; }
  get textContent() {
    if (this._text !== null) return this._text;
    return this.children.map((c) => c.textContent ?? '').join('');
  }

  /** Rendered text: <br> and block boxes become newlines, as a browser shows them. */
  get innerText() {
    if (this._text !== null) return this._text;
    if (this.tagName === 'br') return '\n';
    return this.children
      .map((child) => (child instanceof Element ? child.innerText : String(child.textContent ?? '')))
      .join(this.tagName === 'div' || this.tagName === 'p' ? '\n' : '');
  }

  set innerHTML(v) { this._rawHtml = String(v); this.children = []; this._text = null; }
  get innerHTML() { return this._rawHtml ?? this.children.map((c) => (c.outerHTML ?? escapeHtml(c.textContent ?? ''))).join(''); }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'id') this.ownerDocument?._register(String(v), this);
    if (k === 'class') this.className = String(v);
    if (k === 'disabled') this.disabled = true;
    if (k === 'checked') this.checked = true;
    if (k === 'value') this.value = String(v);
  }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  hasAttribute(k) { return k in this.attributes; }

  set id(v) { this.setAttribute('id', v); }
  get id() { return this.attributes.id ?? ''; }

  set dir(v) { this.setAttribute('dir', v); }
  get dir() { return this.attributes.dir ?? ''; }

  append(...nodes) {
    for (const n of nodes) {
      if (n === null || n === undefined || n === false) continue;
      const node = typeof n === 'object' ? n : this.ownerDocument.createTextNode(String(n));
      // A document fragment contributes its children, as in a real DOM.
      if (node instanceof Element && node.tagName === '#fragment') {
        this.append(...node.children);
        node.children = [];
        continue;
      }
      node.parentNode = this;
      this.children.push(node);
      this._text = null;
    }
  }
  appendChild(n) { this.append(n); return n; }
  prepend(...nodes) {
    const mapped = nodes.filter((n) => n !== null && n !== undefined && n !== false)
      .map((n) => (typeof n === 'object' ? n : this.ownerDocument.createTextNode(String(n))));
    mapped.forEach((n) => { n.parentNode = this; });
    this.children.unshift(...mapped);
    this._text = null;
  }
  replaceChildren(...nodes) { this.children = []; this._text = null; this._rawHtml = null; this.append(...nodes); }
  removeChild(n) {
    this.children = this.children.filter((c) => c !== n);
    // A detached node has no parent. Leaving the old reference behind made
    // "is this still in the page?" answer yes for a node the page had removed,
    // which is exactly the check a single-page-app re-mount depends on.
    if (n && typeof n === 'object') {
      n.parentNode = null;
      if (n.attributes?.id && n.ownerDocument?._ids?.get(n.attributes.id) === n) {
        n.ownerDocument._ids.delete(n.attributes.id);
      }
    }
    return n;
  }
  remove() { this.parentNode?.removeChild(this); }
  replaceWith(n) {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children[i] = n;
  }

  get firstChild() { return this.children[0] ?? null; }
  get firstElementChild() { return this.children.find((c) => c instanceof Element) ?? null; }

  addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] ?? []).filter((f) => f !== fn); }
  dispatchEvent(event) {
    const full = { target: this, ...event };
    for (const fn of [...(this._listeners[event.type] ?? [])]) fn(full);
    return true;
  }
  click() { return this.dispatchEvent({ type: 'click' }); }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  blur() {}
  scrollTo(optionsOrTop) {
    this.scrollTop = typeof optionsOrTop === 'object' ? (optionsOrTop?.top ?? this.scrollTop) : (optionsOrTop ?? this.scrollTop);
  }
  scrollBy(delta) { this.scrollTop += typeof delta === 'object' ? (delta?.top ?? 0) : delta; }
  scrollIntoView(_options) { this._scrolledIntoView = (this._scrolledIntoView ?? 0) + 1; }
  /** Replaces every child in one operation. Never `innerHTML = ''`. */
  replaceChildren(...nodes) {
    this.children = [];
    this._text = null;
    this._rawHtml = null;
    this.append(...nodes);
  }
  getBoundingClientRect() {
    const r = this._rect ?? { x: 0, y: 0, width: 0, height: 0 };
    return { left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height, ...r };
  }

  /** Depth-first search over comma groups of descendant-compound selectors. */
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel) {
    const out = [];
    const seen = new Set();
    for (const group of parseSelectorGroups(sel)) {
      const walk = (node, ancestors) => {
        for (const child of node.children) {
          if (!(child instanceof Element)) continue;
          if (matchesChain(child, group, ancestors)) {
            if (!seen.has(child)) { seen.add(child); out.push(child); }
          }
          walk(child, [child, ...ancestors]);
        }
      };
      walk(this, []);
    }
    return new ShimNodeList(out);
  }

  /** Standard DOM tree order comparison (bit 2 = PRECEDING, bit 4 = FOLLOWING, bit 8 = CONTAINS, bit 16 = CONTAINED_BY). */
  compareDocumentPosition(other) {
    if (!other || this === other) return 0;
    let cur = other.parentNode;
    while (cur) { if (cur === this) return 4 | 16; cur = cur.parentNode; }
    cur = this.parentNode;
    while (cur) { if (cur === other) return 2 | 8; cur = cur.parentNode; }
    let root = this;
    while (root.parentNode) root = root.parentNode;
    let seenThis = false;
    let seenOther = false;
    let result = 1; // DISCONNECTED
    const walk = (node) => {
      if (result !== 1) return;
      if (node === this) {
        if (seenOther) { result = 2; return; }
        seenThis = true;
      } else if (node === other) {
        if (seenThis) { result = 4; return; }
        seenOther = true;
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(root);
    return result;
  }

  /** Does this element match the selector? (comma groups, descendant chains.) */
  matches(sel) {
    for (const group of parseSelectorGroups(sel)) {
      if (matchesChain(this, group, ancestorsOf(this))) return true;
    }
    return false;
  }

  /**
   * Attach a shadow root.
   *
   * Content-script UI lives in one so a site-wide `button { }` rule cannot
   * destroy it. A closed root is not reachable from the host, exactly as in a
   * browser: only whoever created it keeps the reference, which is why the
   * launcher keeps its own and the shim does not hand one back.
   */
  attachShadow({ mode = 'open' } = {}) {
    if (this._shadowRoot) throw new Error('shadow root already attached');
    const root = new Element('#shadow-root', this.ownerDocument);
    root.mode = mode;
    root.host = this;
    this._shadowRoot = root;
    this.shadowRoot = mode === 'open' ? root : null;
    return root;
  }

  /** Nearest ancestor (or self) matching the selector. */
  closest(sel) {
    let node = this;
    while (node instanceof Element) {
      if (node.matches(sel)) return node;
      node = node.parentNode;
    }
    return null;
  }

  get outerHTML() {
    const attrs = Object.entries(this.attributes)
      .filter(([k]) => !k.startsWith('on'))
      .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join('');
    const cls = this.className ? ` class="${escapeHtml(this.className)}"` : '';
    const styleStr = Object.entries(this.style)
      .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${v}`).join(';');
    const st = styleStr ? ` style="${escapeHtml(styleStr)}"` : '';
    const ds = Object.entries(this.dataset).map(([k, v]) => ` data-${k}="${escapeHtml(String(v))}"`).join('');
    const dis = this.disabled && !('disabled' in this.attributes) ? ' disabled' : '';
    const chk = this.checked && !('checked' in this.attributes) ? ' checked' : '';
    const open = `<${this.tagName}${cls}${attrs}${st}${ds}${dis}${chk}>`;
    if (VOID_TAGS.has(this.tagName)) return open;
    const inner = this._rawHtml !== null
      ? this._rawHtml
      : this._text !== null
        ? escapeHtml(this._text)
        : this.children.map((c) => c.outerHTML ?? escapeHtml(c.textContent ?? '')).join('');
    return `${open}${inner}</${this.tagName}>`;
  }
}


/* ------------------------------------------------------------ selector engine */

function ancestorsOf(node) {
  const out = [];
  let parent = node.parentNode;
  while (parent instanceof Element) {
    out.push(parent);
    parent = parent.parentNode;
  }
  return out;
}

/** "a, b c[d="e"].f#g" -> arrays of compound selectors per comma group. */
function parseSelectorGroups(sel) {
  return String(sel).split(',').map((part) => part.trim().split(/\s+/).filter(Boolean).map(parseCompound));
}

function parseCompound(text) {
  const compound = { tag: null, id: null, classes: [], attrs: [] };
  const tagMatch = /^[a-zA-Z][\w-]*/.exec(text);
  let rest = text;
  if (tagMatch) {
    compound.tag = tagMatch[0].toLowerCase();
    rest = rest.slice(tagMatch[0].length);
  }
  const re = /([#.])([\w-]+)|\[\s*([\w-]+)\s*(?:=\s*"([^"]*)"\s*)?\]/g;
  let m;
  while ((m = re.exec(rest)) !== null) {
    if (m[1] === '#') compound.id = m[2];
    else if (m[1] === '.') compound.classes.push(m[2]);
    else if (m[3]) compound.attrs.push([m[3], m[4] === undefined ? null : m[4]]);
  }
  return compound;
}

function matchesCompound(node, compound) {
  if (!(node instanceof Element)) return false;
  if (compound.tag && node.tagName !== compound.tag) return false;
  if (compound.id && node.attributes.id !== compound.id) return false;
  for (const cls of compound.classes) if (!node.classList.contains(cls)) return false;
  for (const [name, value] of compound.attrs) {
    if (!(name in node.attributes)) return false;
    if (value !== null && node.attributes[name] !== value) return false;
  }
  return true;
}

/** node matches the LAST compound; earlier ones must match some ancestor chain. */
function matchesChain(node, group, ancestors) {
  if (!matchesCompound(node, group[group.length - 1])) return false;
  let index = group.length - 2;
  for (const ancestor of ancestors) {
    if (index < 0) break;
    if (matchesCompound(ancestor, group[index])) index -= 1;
  }
  return index < 0;
}

class ShimRange {
  constructor(doc) {
    this._doc = doc;
    this.startContainer = null;
    this.startOffset = 0;
    this.endContainer = null;
    this.endOffset = 0;
    this.collapsed = true;
  }
  setStart(node, offset = 0) { this.startContainer = node; this.startOffset = offset; this._sync(); }
  setEnd(node, offset = 0) { this.endContainer = node; this.endOffset = offset; this._sync(); }
  selectNodeContents(node) { this.setStart(node, 0); this.setEnd(node, node.children?.length ?? 0); }
  collapse(toStart = false) {
    if (toStart) { this.endContainer = this.startContainer; this.endOffset = this.startOffset; }
    else { this.startContainer = this.endContainer; this.startOffset = this.endOffset; }
    this.collapsed = true;
  }
  _sync() {
    this.collapsed = this.startContainer === this.endContainer && this.startOffset === this.endOffset;
  }
}

class ShimSelection {
  constructor(doc) { this._doc = doc; this.ranges = []; this._anchor = null; }
  get rangeCount() { return this.ranges.length; }
  get anchorNode() { return this._anchor; }
  get isCollapsed() { return this.ranges.length === 0 ? true : Boolean(this.ranges[0].collapsed); }
  addRange(range) { this.ranges.push(range); this._anchor = range.startContainer ?? range.endContainer; }
  removeAllRanges() { this.ranges = []; this._anchor = null; }
  collapse(node) { this.removeAllRanges(); const range = new ShimRange(this._doc); range.setStart(node, 0); range.collapse(); this.addRange(range); }
  getRangeAt(index = 0) { return this.ranges[index] ?? null; }
}

class TextNode {
  constructor(text) { this.nodeType = 3; this.textContent = String(text); this.parentNode = null; }
  get outerHTML() { return escapeHtml(this.textContent); }
}

class Doc {
  constructor() {
    this._ids = new Map();
    this.documentElement = new Element('html', this);
    this.body = new Element('body', this);
    this.head = new Element('head', this);
  }
  _register(id, node) { this._ids.set(id, node); }
  get selection() { return (this._selection ??= new ShimSelection(this)); }
  createRange() { return new ShimRange(this); }
  /**
   * A small but REAL implementation of the four commands the DM composer uses.
   * Recording the command names is not enough: the composer test has to see the
   * text land in the editor, exactly as Lexical would leave it.
   */
  execCommand(command, _ui = false, value = null) {
    (this._execCommands ??= []).push(command);
    const selection = this.selection;
    const anchor = selection.anchorNode;
    if (command === 'selectAll') {
      if (anchor) {
        const range = new ShimRange(this);
        range.selectNodeContents(anchor);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return Boolean(anchor);
    }
    if (!anchor) return false;
    if (command === 'delete') {
      anchor.children = [];
      anchor._text = '';
      return true;
    }
    if (command === 'insertText') {
      anchor.append(this.createTextNode(String(value ?? '')));
      return true;
    }
    if (command === 'insertLineBreak') {
      anchor.append(this.createElement('br'));
      return true;
    }
    return false;
  }
  createElement(tag) { return new Element(String(tag).toLowerCase(), this); }
  // SVG elements behave identically for serialisation purposes; the namespace is
  // irrelevant to a string renderer, but views legitimately call this for charts.
  createElementNS(_ns, tag) { return new Element(String(tag).toLowerCase(), this); }
  createTextNode(t) { return new TextNode(t); }
  createDocumentFragment() { return new Element('#fragment', this); }
  getElementById(id) { return this._ids.get(id) ?? null; }
  querySelector(sel) {
    if (sel.startsWith('#')) return this.getElementById(sel.slice(1));
    return this.body.querySelector(sel) ?? this.documentElement.querySelector(sel);
  }
  querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
  addEventListener() {}
  removeEventListener() {}
}

/**
 * Install the shim globally.
 * @param {object} chromeStub  responses keyed by message type
 */
export function installDom({ chromeResponses = {}, manifest = {}, visibilityState = 'visible' } = {}) {
  const doc = new Doc();
  doc.documentElement.dataset.theme = 'dark';
  doc.visibilityState = visibilityState;
  doc.dir = 'ltr';

  globalThis.document = doc;
  globalThis.getSelection = () => doc.selection;
  globalThis.Node = Element;
  globalThis.Element = Element;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    location: { href: 'chrome-extension://preview/app/index.html', search: '' },
    print() {}, close() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  globalThis.localStorage = {
    _d: new Map(),
    getItem(k) { return this._d.get(k) ?? null; },
    setItem(k, v) { this._d.set(k, String(v)); },
    removeItem(k) { this._d.delete(k); },
  };
  globalThis.location = globalThis.window.location;
  globalThis.navigator = { userAgent: 'Preview renderer (not a real browser)', storage: { estimate: async () => ({ usage: 2_400_000, quota: 2_000_000_000 }) } };
  globalThis.URL = globalThis.URL ?? class { static createObjectURL() { return 'blob:preview'; } static revokeObjectURL() {} };
  globalThis.Blob = globalThis.Blob ?? class {};

  globalThis.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: '1.0.0', manifest_version: 3, ...manifest }),
      getURL: (p) => `chrome-extension://preview/${p}`,
      sendMessage: (msg, cb) => {
        const responder = chromeResponses[msg?.type];
        const value = typeof responder === 'function' ? responder(msg) : responder;
        const result = value ?? { ok: false, error: `No preview stub for ${msg?.type}` };
        if (typeof cb === 'function') { cb(result); return undefined; }
        return Promise.resolve(result);
      },
      onMessage: { addListener() {}, removeListener() {} },
    },
    tabs: { query: async () => [], sendMessage: async () => ({ ok: true }), create: async () => ({ id: 1 }), update: async () => {} },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };

  return doc;
}

export { Element, Doc };
