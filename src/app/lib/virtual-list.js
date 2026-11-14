/**
 * A windowed table for the lead list.
 *
 * A CRM with 40,000 leads cannot render 40,000 rows: the browser spends seconds
 * laying them out and the owner's fan spins up while they wait. This renders only
 * the rows in view plus a small overscan, and it repaints on `scroll` and
 * `resize` events — never on an animation frame loop, because a list that
 * redraws 60 times a second while nothing moves is a battery drain that buys
 * nothing.
 *
 * Rows are built with `el()` and mounted with `replaceChildren()`. No innerHTML
 * anywhere in this file: a lead's display name is scraped text.
 *
 * Adapted in structure from HyperList (MIT, Copyright (c) 2016 Tim Branyen);
 * see THIRD_PARTY_NOTICES.md. The continuous rAF loop and the innerHTML reset in
 * that library are deliberately not carried over.
 */

import { el } from './ui.js';

export const DEFAULT_VIRTUAL_OPTIONS = Object.freeze({
  rowHeight: 36,
  overscan: 8,
  viewportHeight: 480,
});

/**
 * @param {HTMLElement} mount
 * @param {{columns: Array<{key: string, label: string, width?: string, numeric?: boolean,
 *            cell?: (row: object, index: number) => (Node|string|number|null)}>,
 *          rows?: Array<object>, rowHeight?: number, overscan?: number,
 *          viewportHeight?: number, onRowClick?: (row: object, index: number) => void,
 *          rowClass?: (row: object) => string, emptyMessage?: string,
 *          document?: Document, observeResize?: boolean}} options
 */
export function virtualTable(mount, options = {}) {
  const doc = options.document ?? (typeof document !== 'undefined' ? document : null);
  if (!mount || !doc) throw new Error('virtualTable needs a mount element and a document');
  const columns = options.columns ?? [];
  const opts = { ...DEFAULT_VIRTUAL_OPTIONS, ...options };
  const rowHeight = Math.max(16, Number(opts.rowHeight) || DEFAULT_VIRTUAL_OPTIONS.rowHeight);
  const overscan = Math.max(0, Number(opts.overscan) || 0);
  const viewportHeight = Math.max(rowHeight, Number(opts.viewportHeight) || DEFAULT_VIRTUAL_OPTIONS.viewportHeight);

  let rows = Array.isArray(opts.rows) ? opts.rows : [];
  let renderedRange = null;

  const gridTemplate = columns.map((column) => column.width ?? '1fr').join(' ');

  const head = el('div', { class: 'vtable__head', role: 'row', style: { gridTemplateColumns: gridTemplate } },
    columns.map((column) => el('div', {
      class: `vtable__cell vtable__cell--head ${column.numeric ? 'vtable__cell--num' : ''}`.trim(),
      role: 'columnheader',
      text: column.label ?? column.key,
    })));

  const spacer = el('div', { class: 'vtable__spacer' });
  const body = el('div', { class: 'vtable__rows' });
  const viewport = el('div', {
    class: 'vtable__viewport',
    tabindex: '0',
    role: 'grid',
    'aria-rowcount': '0',
    style: { height: `${viewportHeight}px`, overflowY: 'auto' },
  }, [spacer, body]);

  const emptyNode = el('div', { class: 'vtable__empty small dim', text: opts.emptyMessage ?? 'Nothing to show yet.' });

  // The viewport is mounted once and never unmounted: detaching it would drop
  // the scroll position and the row container on every empty <-> non-empty
  // transition, which is exactly what a filter box does repeatedly.
  mount.replaceChildren(head, viewport, emptyNode);

  function render(force = false) {
    const total = rows.length;
    spacer.style.height = `${total * rowHeight}px`;
    viewport.setAttribute('aria-rowcount', String(total));
    if (total === 0) {
      viewport.hidden = true;
      emptyNode.hidden = false;
      if (renderedRange !== 'empty' || force) {
        body.replaceChildren();
        renderedRange = 'empty';
      }
      return;
    }
    viewport.hidden = false;
    emptyNode.hidden = true;
    renderedRange = null;

    const scrollTop = Math.max(0, Number(viewport.scrollTop) || 0);
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const visible = Math.ceil(viewportHeight / rowHeight);
    const last = Math.min(total, Math.floor(scrollTop / rowHeight) + visible + overscan);
    if (!force && renderedRange && renderedRange.first === first && renderedRange.last === last) return;
    renderedRange = { first, last };

    body.style.transform = `translateY(${first * rowHeight}px)`;
    const fragment = doc.createDocumentFragment();
    for (let index = first; index < last; index += 1) {
      fragment.append(renderRow(rows[index], index));
    }
    body.replaceChildren(fragment);
  }

  function renderRow(row, index) {
    const node = el('div', {
      class: `vtable__row ${opts.rowClass?.(row) ?? ''}`.trim(),
      role: 'row',
      'data-index': String(index),
      style: { height: `${rowHeight}px`, gridTemplateColumns: gridTemplate },
      onclick: opts.onRowClick ? () => opts.onRowClick(row, index) : null,
    }, columns.map((column) => renderCell(column, row, index)));
    return node;
  }

  function renderCell(column, row, index) {
    const value = typeof column.cell === 'function' ? column.cell(row, index) : row?.[column.key];
    return el('div', {
      class: `vtable__cell ${column.numeric ? 'vtable__cell--num' : ''}`.trim(),
      role: 'gridcell',
    }, [isNode(value) ? value : String(value ?? '—')]);
  }

  /** A DOM node, in a browser or in the shim: anything with a nodeType. */
  function isNode(value) {
    return Boolean(value) && typeof value === 'object' && typeof value.nodeType === 'number';
  }

  const onScroll = () => render(false);
  viewport.addEventListener('scroll', onScroll);

  let observer = null;
  if (opts.observeResize !== false && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => render(true));
    observer.observe(viewport);
  }

  render(true);

  return {
    /** Replace the data (after a filter or a sort) and repaint. */
    setRows(next) {
      rows = Array.isArray(next) ? next : [];
      renderedRange = null;
      render(true);
    },
    get rows() { return rows; },
    get rowCount() { return rows.length; },
    /** How many row elements are actually in the DOM right now. */
    get renderedCount() { return body.children.length; },
    get range() { return renderedRange && renderedRange !== 'empty' ? { ...renderedRange } : null; },
    get element() { return mount; },
    /** Scroll a row into view by index (used by "jump to this lead"). */
    scrollToIndex(index) {
      const target = Math.max(0, Math.min(rows.length - 1, Number(index) || 0));
      viewport.scrollTop = target * rowHeight;
      render(true);
      return target;
    },
    render,
    destroy() {
      viewport.removeEventListener('scroll', onScroll);
      observer?.disconnect?.();
      mount.replaceChildren();
    },
  };
}

/**
 * The scroll-driven window math on its own, so the numbers can be tested without
 * a DOM: which rows are in view for a given scroll offset.
 */
export function windowRange({ scrollTop = 0, rowHeight = 36, viewportHeight = 480, overscan = 8, total = 0 } = {}) {
  const height = Math.max(16, Number(rowHeight) || 36);
  if (total <= 0) return { first: 0, last: 0, rendered: 0 };
  const offset = Math.max(0, Number(scrollTop) || 0);
  const first = Math.max(0, Math.floor(offset / height) - Math.max(0, overscan));
  const visible = Math.ceil(Math.max(height, Number(viewportHeight) || 480) / height);
  const last = Math.min(total, Math.floor(offset / height) + visible + Math.max(0, overscan));
  return { first, last, rendered: Math.max(0, last - first) };
}
