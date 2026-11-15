/**
 * Tiny DOM helpers. No framework, because MV3 forbids remotely hosted code and a
 * bundler would add a build step to a project that otherwise has none.
 *
 * SAFETY RULE, enforced by verify.sh: scraped Instagram text is NEVER assigned to
 * innerHTML anywhere in this app. A biography, caption or comment is
 * attacker-controlled — markup in one must render as characters, not as DOM.
 * `el()` sets text via textContent, and there is no innerHTML helper at all: the
 * only module that emits an HTML string is the printable report in
 * `lib/export-utils.js`, which escapes every value by hand.
 *
 * Adapted from the UI helper of ig-analysis (MIT, Copyright (c) 2026 Ahmed
 * Sleem); see THIRD_PARTY_NOTICES.md. The CRM components below the formatting
 * helpers are this project's own.
 */

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * Render scanned text safely, with per-node direction so Arabic/Hebrew captions
 * display correctly inside an English UI.
 */
export function scannedText(text, tag = 'span') {
  const node = el(tag, { class: 'scanned-text', text: text ?? '' });
  if (isRtlText(text)) node.setAttribute('dir', 'rtl');
  return node;
}

export function isRtlText(text) {
  if (typeof text !== 'string' || !text) return false;
  const rtl = (text.match(/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g) ?? []).length;
  const ltr = (text.match(/[A-Za-z]/g) ?? []).length;
  return rtl > ltr;
}

/* ---------- Formatting ----------
 * `null` means "we could not see this", which is a different fact from zero and is
 * displayed differently everywhere in this UI. */

export function fmtNum(v, opts = {}) {
  if (v === null || v === undefined || Number.isNaN(v)) return opts.na ?? '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return opts.na ?? '—';
  if (opts.compact && Math.abs(n) >= 1000) {
    return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  }
  return new Intl.NumberFormat('en', { maximumFractionDigits: opts.decimals ?? 0 }).format(n);
}

export function fmtPct(v, decimals = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${Number(v).toFixed(decimals)}%`;
}

export function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtDateShort(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function relTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

/* ---------- Components ---------- */

export function stat(label, value, { sub = null, hint = null, na = false } = {}) {
  return el('div', { class: 'stat' }, [
    el('div', { class: 'stat__label' }, [label, hint ? el('span', { class: 'faint', title: hint, text: 'ⓘ' }) : null]),
    el('div', { class: na ? 'stat__value stat__value--na' : 'stat__value', text: value }),
    sub ? el('div', { class: 'stat__sub', text: sub }) : null,
  ]);
}

export function card(title, children, { hint = null } = {}) {
  const body = Array.isArray(children) ? children : [children];
  return el('section', { class: 'card' }, [
    title ? el('div', { class: 'card__head' }, [
      el('h3', { class: 'card__title', text: title }),
      hint ? el('div', { class: 'card__hint', text: hint }) : null,
    ]) : null,
    ...body,
  ]);
}

export function note(text, variant = '') {
  return el('div', { class: `note ${variant ? `note--${variant}` : ''}`.trim() }, [text]);
}

export function badge(text, variant = '') {
  return el('span', { class: `badge ${variant ? `badge--${variant}` : ''}`.trim(), text });
}

export function empty(title, message, action = null) {
  return el('div', { class: 'empty' }, [
    el('div', { class: 'empty__icon', text: '◌' }),
    el('div', { class: 'empty__title', text: title }),
    el('div', { class: 'small dim', text: message }),
    action ? el('div', { class: 'mt-4' }, [action]) : null,
  ]);
}

/**
 * A table, always wrapped in its own scroll container.
 *
 * The wrapper is not optional. A wide table inside a fixed-height app shell either
 * clips (data the user cannot reach) or pushes the whole page sideways (breaking
 * every other view). Scrolling the table itself is the only option that keeps the
 * layout intact at 320px, so it lives here rather than being remembered per view.
 */
export function table(headers, rows, { numeric = [] } = {}) {
  const node = el('table', { class: 'table' }, [
    el('thead', {}, [el('tr', {}, headers.map((h, i) =>
      el('th', { class: numeric.includes(i) ? 'table__num' : '', text: h })))]),
    el('tbody', {}, rows.map((cells) =>
      el('tr', {}, cells.map((c, i) =>
        el('td', { class: numeric.includes(i) ? 'table__num' : '' }, [c instanceof Node ? c : String(c ?? '—')]))))),
  ]);
  return el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Scrollable table' }, [node]);
}

export function toast(message, variant = '') {
  const root = $('#toasts');
  if (!root) return;
  const node = el('div', { class: `toast ${variant ? `toast--${variant}` : ''}`.trim(), text: message });
  root.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 300);
  }, variant === 'error' ? 8000 : 4000);
}

export function modal({ title, body, actions = [], onClose = null }) {
  const root = $('#modal-root');
  const close = () => {
    clear(root);
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  const backdrop = el('div', {
    class: 'modal__backdrop',
    onclick: (e) => { if (e.target === backdrop) close(); },
  }, [
    el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
      el('h2', { class: 'modal__title', text: title }),
      body,
      el('div', { class: 'modal__actions' }, actions.map((a) =>
        el('button', {
          class: `btn ${a.variant ? `btn--${a.variant}` : ''}`.trim(),
          text: a.label,
          onclick: () => { const r = a.onClick?.(close); if (r !== false && !a.keepOpen) close(); },
        }))),
    ]),
  ]);
  clear(root).append(backdrop);
  return close;
}

export function bar(fraction, color = null) {
  const pct = Math.max(0, Math.min(1, fraction ?? 0)) * 100;
  return el('div', { class: 'bar' }, [
    el('div', { class: 'bar__fill', style: { width: `${pct}%`, ...(color ? { background: color } : {}) } }),
  ]);
}

/** "Not available" with the REASON — an unexplained dash teaches the user nothing. */
export function na(reason) {
  return el('span', { class: 'na', text: '—', title: reason ?? 'Not available' });
}

/* ---------- CRM components ---------- */

/**
 * A button. `busy` disables it and swaps the label, because a control that stays
 * live while its action runs gets clicked twice — and twice here means two
 * follows, or two messages to one person.
 */
export function btn(label, { variant = '', onClick = null, disabled = false, title = null, busyLabel = 'Working…' } = {}) {
  const node = el('button', {
    class: `btn ${variant ? `btn--${variant}` : ''}`.trim(),
    text: label,
    disabled: disabled || null,
    title,
    onclick: async (event) => {
      if (!onClick) return;
      if (node.dataset.busy === '1') return;
      node.dataset.busy = '1';
      const original = node.textContent;
      node.disabled = true;
      node.textContent = busyLabel;
      try {
        await onClick(event);
      } finally {
        node.dataset.busy = '0';
        node.disabled = disabled;
        node.textContent = original;
      }
    },
  });
  return node;
}

/** A labelled toggle. `onChange` receives the new boolean. */
export function toggle(label, value, { onChange = null, hint = null } = {}) {
  const input = el('input', { type: 'checkbox', class: 'toggle__input' });
  input.checked = Boolean(value);
  input.addEventListener('change', () => onChange?.(input.checked));
  return el('label', { class: 'toggle', title: hint }, [
    input,
    el('span', { class: 'toggle__track' }, [el('span', { class: 'toggle__thumb' })]),
    el('span', { class: 'toggle__label', text: label }),
  ]);
}

/**
 * A number slider with its current value rendered beside it.
 *
 * `max` is the hard ceiling: the governor clamps anyway, but a slider that let
 * the owner dial in 500 follows a day would be a UI that invites the block the
 * code exists to prevent.
 */
export function slider(label, value, { min = 0, max = 100, step = 1, onChange = null, hint = null, format = null } = {}) {
  const readout = el('span', { class: 'slider__value', text: format ? format(value) : String(value) });
  const input = el('input', { type: 'range', class: 'slider__input', min: String(min), max: String(max), step: String(step) });
  input.value = String(Math.min(max, Math.max(min, Number(value) || min)));
  readout.textContent = format ? format(Number(input.value)) : input.value;
  input.addEventListener('input', () => {
    const next = Number(input.value);
    readout.textContent = format ? format(next) : String(next);
    onChange?.(next);
  });
  return el('div', { class: 'slider', title: hint }, [
    el('div', { class: 'slider__head' }, [el('span', { class: 'slider__label', text: label }), readout]),
    input,
  ]);
}

/** A text/textarea field with a label and an optional validation message. */
export function field(label, { value = '', type = 'text', rows = null, placeholder = null, onInput = null, hint = null, name = null } = {}) {
  const input = rows
    ? el('textarea', { class: 'input input--area', rows: String(rows), placeholder })
    : el('input', { class: 'input', type, placeholder, name });
  input.value = String(value ?? '');
  if (onInput) input.addEventListener('input', () => onInput(input.value, input));
  return el('label', { class: 'field' }, [
    el('span', { class: 'field__label' }, [label, hint ? el('span', { class: 'faint', title: hint, text: ' ⓘ' }) : null]),
    input,
  ]);
}

/** Filter chips. `values` is the current selection; clicking toggles membership. */
export function chipList(options, values, { onChange = null, multiple = true } = {}) {
  const selected = new Set(values ?? []);
  const chips = options.map((option) => {
    const value = typeof option === 'string' ? option : option.value;
    const label = typeof option === 'string' ? option : option.label;
    const chip = el('button', {
      class: `chip ${selected.has(value) ? 'chip--on' : ''}`,
      text: label,
      type: 'button',
      onclick: () => {
        if (selected.has(value)) selected.delete(value);
        else if (multiple) selected.add(value);
        else {
          selected.clear();
          selected.add(value);
        }
        chips.forEach((node, index) => {
          const chipValue = typeof options[index] === 'string' ? options[index] : options[index].value;
          node.className = `chip ${selected.has(chipValue) ? 'chip--on' : ''}`;
        });
        onChange?.([...selected]);
      },
    });
    return chip;
  });
  return el('div', { class: 'chips', role: 'group' }, chips);
}

/** A tab bar. `onSelect` receives the tab id. */
export function tabs(items, activeId, { onSelect = null } = {}) {
  const bar = el('div', { class: 'tabs', role: 'tablist' });
  const render = (current) => {
    clear(bar);
    for (const item of items) {
      bar.append(el('button', {
        class: `tab ${item.id === current ? 'tab--on' : ''}`,
        role: 'tab',
        'aria-selected': item.id === current ? 'true' : 'false',
        text: item.label,
        type: 'button',
        onclick: () => { render(item.id); onSelect?.(item.id); },
      }, [item.count === undefined ? null : el('span', { class: 'tab__count', text: String(item.count) })]));
    }
  };
  render(activeId);
  return bar;
}

/**
 * A right-hand drawer for one lead's dossier.
 *
 * Rendered into #drawer-root and closed by Escape, backdrop click or the close
 * button. Content is built by the caller with `el()`, so scraped biography text
 * never goes near innerHTML.
 */
export function drawer({ title, body, actions = [], onClose = null, width = null } = {}) {
  const root = $('#drawer-root') ?? document.body;
  const close = () => {
    clear(root);
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (event) => { if (event.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  const panel = el('aside', {
    class: 'drawer',
    role: 'dialog',
    'aria-modal': 'false',
    style: width ? { width } : null,
  }, [
    el('div', { class: 'drawer__head' }, [
      el('h2', { class: 'drawer__title', text: title }),
      el('button', { class: 'icon-btn', text: '✕', 'aria-label': 'Close', onclick: close, type: 'button' }),
    ]),
    el('div', { class: 'drawer__body' }, [body]),
    actions.length ? el('div', { class: 'drawer__actions' }, actions) : null,
  ]);
  const backdrop = el('div', { class: 'drawer__backdrop', onclick: close });
  clear(root).append(backdrop, panel);
  return close;
}

/**
 * A lifecycle badge: one class per state, one token per colour.
 * `state` is a value of RelState or DmState, lowercased into the class name.
 */
export function stateBadge(state, label = null) {
  const key = String(state ?? 'none').toLowerCase();
  return el('span', { class: `badge badge--state badge--${key}`, text: label ?? String(state ?? '—').replaceAll('_', ' ') });
}

/** A warmth badge driven by core/scoring.js tiers. */
export function warmthBadge(tier, score = null) {
  const key = String(tier ?? 'cold').toLowerCase();
  return el('span', {
    class: `badge badge--tier badge--tier-${key}`,
    title: score === null ? null : `Priority score ${Math.round(score)}`,
    text: key,
  });
}
