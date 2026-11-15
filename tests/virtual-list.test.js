import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../scripts/lib/dom-shim.mjs';
import { DEFAULT_VIRTUAL_OPTIONS, virtualTable, windowRange } from '../src/app/lib/virtual-list.js';

function rows(n) {
  return Array.from({ length: n }, (_, i) => ({ id: i, username: `user_${i}`, score: n - i }));
}

const COLUMNS = [
  { key: 'score', label: 'Score', width: '60px', numeric: true },
  { key: 'username', label: 'Username', width: '1fr' },
];

describe('windowRange (the scroll math on its own)', () => {
  test('an empty list renders nothing', () => {
    assert.deepEqual(windowRange({ total: 0 }), { first: 0, last: 0, rendered: 0 });
  });

  test('at the top it renders the visible window plus overscan, not the whole list', () => {
    const range = windowRange({ scrollTop: 0, rowHeight: 36, viewportHeight: 360, overscan: 5, total: 1000 });
    assert.equal(range.first, 0);
    assert.equal(range.last, 15, '10 visible + 5 overscan below');
    assert.equal(range.rendered, 15);
  });

  test('scrolled down, the window slides and clamps the overscan above at zero', () => {
    const range = windowRange({ scrollTop: 3600, rowHeight: 36, viewportHeight: 360, overscan: 5, total: 1000 });
    assert.equal(range.first, 95, 'row 100 minus 5 overscan');
    assert.equal(range.last, 115);
  });

  test('near the end the window clamps to the last row', () => {
    const range = windowRange({ scrollTop: 36_000, rowHeight: 36, viewportHeight: 360, overscan: 5, total: 1000 });
    assert.equal(range.last, 1000, 'never renders past the end');
    assert.ok(range.first >= 990);
  });

  test('a row height below the floor is lifted so the math never divides by ~zero', () => {
    const range = windowRange({ scrollTop: 0, rowHeight: 1, viewportHeight: 100, overscan: 0, total: 50 });
    assert.equal(range.first, 0);
    assert.ok(range.last <= 50);
  });
});

describe('virtualTable', () => {
  let doc;
  beforeEach(() => { doc = installDom(); });

  function mount(options = {}) {
    const node = doc.createElement('div');
    doc.body.append(node);
    return { node, table: virtualTable(node, { columns: COLUMNS, document: doc, ...options }) };
  }

  test('it builds a head, a scroll viewport and an empty message', () => {
    const { node, table } = mount({ rows: [], emptyMessage: 'Nobody here.' });
    assert.ok(node.querySelector('.vtable__head'));
    assert.ok(node.querySelector('.vtable__viewport'));
    assert.equal(table.rowCount, 0);
    assert.match(node.querySelector('.vtable__empty').textContent, /Nobody here/);
    table.destroy();
  });

  test('a large list renders only a window of rows, not one node per row', () => {
    const { node, table } = mount({ rows: rows(5000), rowHeight: 36, viewportHeight: 360, overscan: 5 });
    assert.equal(table.rowCount, 5000);
    assert.ok(table.renderedCount <= 20, `only a window is in the DOM (got ${table.renderedCount})`);
    assert.ok(table.renderedCount > 0);
    // The spacer carries the full height so the scrollbar is honest.
    const spacer = node.querySelector('.vtable__spacer');
    assert.equal(spacer.style.height, `${5000 * 36}px`);
    table.destroy();
  });

  test('the head shows one cell per column with the right alignment class', () => {
    const { node, table } = mount({ rows: rows(3) });
    const headCells = node.querySelectorAll('.vtable__cell--head');
    assert.equal(headCells.length, 2);
    assert.equal(headCells[0].textContent, 'Score');
    assert.ok(headCells[0].classList.contains('vtable__cell--num'), 'a numeric column is right-aligned');
    table.destroy();
  });

  test('setRows swaps the data and repaints', () => {
    const { table } = mount({ rows: rows(10) });
    assert.equal(table.rowCount, 10);
    table.setRows(rows(3));
    assert.equal(table.rowCount, 3);
    table.setRows(null);
    assert.equal(table.rowCount, 0, 'a non-array clears rather than throwing');
    table.destroy();
  });

  test('a custom cell renderer can return a node, and a row class is applied', () => {
    const badge = doc.createElement('span');
    badge.className = 'badge badge--tier-hot';
    badge.textContent = 'hot';
    const { node, table } = mount({
      rows: rows(4),
      columns: [{ key: 'username', label: 'Who', cell: () => badge }],
      rowClass: () => 'vtable__row--clickable',
    });
    const row = node.querySelector('.vtable__row');
    assert.ok(row.classList.contains('vtable__row--clickable'));
    assert.ok(row.querySelector('.badge--tier-hot'), 'the node returned by cell() is mounted, not stringified');
    table.destroy();
  });

  test('clicking a row calls onRowClick with the row and its index', () => {
    let clicked = null;
    const { node, table } = mount({ rows: rows(5), onRowClick: (row, index) => { clicked = { row, index }; } });
    const row = node.querySelector('.vtable__row');
    for (const fn of row._listeners.click ?? []) fn();
    assert.equal(clicked.index, 0);
    assert.equal(clicked.row.username, 'user_0');
    table.destroy();
  });

  test('scrollToIndex moves the viewport and renders that row', () => {
    const { node, table } = mount({ rows: rows(1000), rowHeight: 36, viewportHeight: 360, overscan: 2 });
    const index = table.scrollToIndex(500);
    assert.equal(index, 500);
    assert.equal(node.querySelector('.vtable__viewport').scrollTop, 500 * 36);
    // The rendered window now contains row 500.
    // The shim's selector engine has no :not(), so read every cell's text; the
    // username cells are the ones that say "user_N".
    const texts = [...node.querySelectorAll('.vtable__cell')].map((c) => c.textContent);
    assert.ok(texts.includes('user_500'), 'row 500 is on screen after the jump');
    table.destroy();
  });

  test('scrollToIndex clamps an out-of-range index', () => {
    const { table } = mount({ rows: rows(10) });
    assert.equal(table.scrollToIndex(9999), 9);
    assert.equal(table.scrollToIndex(-5), 0);
    table.destroy();
  });

  test('destroy empties the mount', () => {
    const { node, table } = mount({ rows: rows(5) });
    assert.ok(node.children.length > 0);
    table.destroy();
    assert.equal(node.children.length, 0);
  });

  test('the defaults are the documented ones', () => {
    assert.deepEqual(DEFAULT_VIRTUAL_OPTIONS, { rowHeight: 36, overscan: 8, viewportHeight: 480 });
  });
});
