import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../scripts/lib/dom-shim.mjs';
import {
  $, badge, bar, btn, card, chipList, clear, drawer, el, empty, field, fmtNum,
  isRtlText, modal, na, note, scannedText, slider, stat, stateBadge, table, tabs,
  toast, toggle, warmthBadge,
} from '../src/app/lib/ui.js';

function fire(node, type, event = {}) {
  for (const fn of node._listeners?.[type] ?? []) fn({ target: node, ...event });
}

describe('el()', () => {
  let doc;
  beforeEach(() => { doc = installDom(); });

  test('it sets class, text, dataset, attributes and style objects', () => {
    const node = el('div', { class: 'a b', text: 'hi', dataset: { id: '7' }, role: 'row', style: { width: '40px' } });
    assert.equal(node.className, 'a b');
    assert.equal(node.textContent, 'hi');
    assert.equal(node.dataset.id, '7');
    assert.equal(node.getAttribute('role'), 'row');
    assert.equal(node.style.width, '40px');
  });

  test('it skips null, undefined and false attributes and children', () => {
    const node = el('div', { class: null, title: undefined, disabled: false }, ['a', null, false, 'b']);
    assert.equal(node.getAttribute('class'), null);
    assert.equal(node.textContent, 'ab');
  });

  test('a true attribute renders bare, and children accept nodes and strings', () => {
    const child = el('span', { text: 'inner' });
    const node = el('label', { checked: true }, ['text ', child]);
    assert.equal(node.getAttribute('checked'), '');
    assert.equal(node.children.length, 2);
    assert.equal(node.children[1], child);
  });

  test('it wires on* handlers', () => {
    let hit = 0;
    const node = el('button', { onclick: () => { hit += 1; } });
    fire(node, 'click');
    assert.equal(hit, 1);
  });

  test('clear() empties a node and returns it', () => {
    const node = el('div', {}, [el('span'), el('span')]);
    assert.equal(node.children.length, 2);
    const same = clear(node);
    assert.equal(same, node);
    assert.equal(node.children.length, 0);
  });
});

describe('direction-aware text', () => {
  beforeEach(() => installDom());

  test('isRtlText is true only when RTL characters outnumber Latin', () => {
    assert.equal(isRtlText('أهلاً يا سارة'), true);
    assert.equal(isRtlText('Hello Sara'), false);
    assert.equal(isRtlText(''), false);
    assert.equal(isRtlText(null), false);
  });

  test('scannedText tags Arabic content dir=rtl and leaves English alone', () => {
    const arabic = scannedText('أهلاً');
    assert.equal(arabic.getAttribute('dir'), 'rtl');
    assert.equal(arabic.classList.contains('scanned-text'), true);
    const english = scannedText('Hello');
    assert.equal(english.getAttribute('dir'), null);
  });
});

describe('formatting', () => {
  test('fmtNum distinguishes "could not see this" from zero', () => {
    assert.equal(fmtNum(null), '—');
    assert.equal(fmtNum(undefined), '—');
    assert.equal(fmtNum(0), '0');
    assert.equal(fmtNum(1234), '1,234');
    assert.equal(fmtNum(1500, { compact: true }), '1.5K');
    assert.equal(fmtNum(null, { na: 'n/a' }), 'n/a');
  });

  test('na() carries the reason as a title', () => {
    const node = na('hidden account');
    assert.equal(node.textContent, '—');
    assert.equal(node.getAttribute('title'), 'hidden account');
  });
});

describe('badges', () => {
  beforeEach(() => installDom());

  test('a lifecycle badge maps the state to its own class', () => {
    assert.equal(stateBadge('FOLLOWING').className, 'badge badge--state badge--following');
    assert.equal(stateBadge('DM_SENT_PRIMARY').className, 'badge badge--state badge--dm_sent_primary');
    assert.equal(stateBadge('MUTUAL').textContent, 'MUTUAL');
    assert.equal(stateBadge(null).textContent, '—');
  });

  test('a custom label overrides the state text', () => {
    assert.equal(stateBadge('FOLLOW_REQUESTED', 'Pending ⏳').textContent, 'Pending ⏳');
  });

  test('a warmth badge maps the tier and carries the score as a title', () => {
    const node = warmthBadge('hot', 87.4);
    assert.equal(node.className, 'badge badge--tier badge--tier-hot');
    assert.equal(node.textContent, 'hot');
    assert.equal(node.getAttribute('title'), 'Priority score 87');
    assert.equal(warmthBadge(null).className, 'badge badge--tier badge--tier-cold');
  });

  test('badge() applies a variant class', () => {
    assert.equal(badge('Blocked', 'danger').className, 'badge badge--danger');
    assert.equal(badge('Plain').className, 'badge');
  });
});

describe('layout components', () => {
  beforeEach(() => installDom());

  test('card keeps a title and hint in its head', () => {
    const node = card('Title', el('p', { text: 'body' }), { hint: 'aside' });
    assert.equal(node.querySelector('.card__title').textContent, 'Title');
    assert.equal(node.querySelector('.card__hint').textContent, 'aside');
  });

  test('a card with no title renders no head', () => {
    const node = card(null, el('p'));
    assert.equal(node.querySelector('.card__head'), null);
  });

  test('note applies a variant', () => {
    assert.equal(note('careful', 'warning').className, 'note note--warning');
    assert.equal(note('plain').className, 'note');
  });

  test('stat shows label, value and sub', () => {
    const node = stat('Leads', '42', { sub: '3 new' });
    assert.equal(node.querySelector('.stat__label').textContent, 'Leads');
    assert.equal(node.querySelector('.stat__value').textContent, '42');
    assert.equal(node.querySelector('.stat__sub').textContent, '3 new');
  });

  test('bar clamps the fraction to 0..1', () => {
    assert.equal(bar(2).querySelector('.bar__fill').style.width, '100%');
    assert.equal(bar(-1).querySelector('.bar__fill').style.width, '0%');
    assert.equal(bar(0.5).querySelector('.bar__fill').style.width, '50%');
  });

  test('empty renders a title, message and optional action', () => {
    const action = btn('Do it', {});
    const node = empty('Nothing', 'Try again', action);
    assert.equal(node.querySelector('.empty__title').textContent, 'Nothing');
    assert.ok(node.querySelector('.btn'));
  });

  test('table right-aligns numeric columns and mounts node cells', () => {
    const node = table(['Name', 'Score'], [['Sara', 9], [badge('x'), 3]], { numeric: [1] });
    const headers = node.querySelectorAll('th');
    assert.equal(headers[1].className, 'table__num');
    const cells = node.querySelectorAll('td');
    assert.ok(cells[2].querySelector('.badge'), 'a node cell is mounted, not stringified');
  });
});

describe('interactive components', () => {
  beforeEach(() => installDom());

  test('btn goes busy, disables itself, then restores', async () => {
    let resolveRun;
    const run = new Promise((r) => { resolveRun = r; });
    const node = btn('Save', { busyLabel: 'Saving…', onClick: () => run });
    fire(node, 'click');
    assert.equal(node.disabled, true);
    assert.equal(node.textContent, 'Saving…');
    assert.equal(node.dataset.busy, '1');
    resolveRun();
    await run;
    await new Promise(setImmediate);
    assert.equal(node.disabled, false);
    assert.equal(node.textContent, 'Save');
  });

  test('btn swallows a second click while busy', async () => {
    let calls = 0;
    const node = btn('Go', { onClick: async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); } });
    fire(node, 'click');
    fire(node, 'click');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 1, 'the busy guard blocks the double click');
  });

  test('toggle reports its new checked state', () => {
    let value = null;
    const node = toggle('Enabled', true, { onChange: (v) => { value = v; } });
    const input = node.querySelector('.toggle__input');
    assert.equal(input.checked, true);
    input.checked = false;
    fire(input, 'change');
    assert.equal(value, false);
  });

  test('slider renders its value and reports changes', () => {
    let seen = null;
    const node = slider('Follows', 20, { min: 0, max: 140, format: (v) => `${v}/day`, onChange: (v) => { seen = v; } });
    assert.equal(node.querySelector('.slider__value').textContent, '20/day');
    const input = node.querySelector('.slider__input');
    input.value = '55';
    fire(input, 'input');
    assert.equal(seen, 55);
    assert.equal(node.querySelector('.slider__value').textContent, '55/day');
  });

  test('slider clamps an out-of-range initial value', () => {
    const node = slider('X', 999, { min: 0, max: 10 });
    assert.equal(node.querySelector('.slider__input').value, '10');
  });

  test('field binds a value and reports input', () => {
    let text = null;
    const node = field('Name', { value: 'Sara', onInput: (v) => { text = v; } });
    const input = node.querySelector('input');
    assert.equal(input.value, 'Sara');
    input.value = 'Ada';
    fire(input, 'input');
    assert.equal(text, 'Ada');
  });

  test('chipList toggles membership in multiple mode', () => {
    let values = null;
    const node = chipList(['hot', 'warm', 'cold'], ['hot'], { onChange: (v) => { values = v; } });
    const chips = node.querySelectorAll('.chip');
    assert.equal(chips.length, 3);
    assert.ok(chips[0].classList.contains('chip--on'));
    fire(chips[1], 'click');
    assert.deepEqual(values.sort(), ['hot', 'warm']);
    fire(chips[0], 'click');
    assert.deepEqual(values, ['warm']);
  });

  test('chipList in single mode keeps only the last pick', () => {
    let values = null;
    const node = chipList([{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], [], { multiple: false, onChange: (v) => { values = v; } });
    const chips = node.querySelectorAll('.chip');
    fire(chips[0], 'click');
    fire(chips[1], 'click');
    assert.deepEqual(values, ['b']);
  });

  test('tabs marks the active tab and reports selection', () => {
    let selected = null;
    const node = tabs([{ id: 'one', label: 'One' }, { id: 'two', label: 'Two', count: 5 }], 'one', { onSelect: (id) => { selected = id; } });
    const buttons = node.querySelectorAll('.tab');
    assert.ok(buttons[0].classList.contains('tab--on'));
    assert.equal(buttons[1].querySelector('.tab__count').textContent, '5');
    fire(buttons[1], 'click');
    assert.equal(selected, 'two');
    assert.ok(node.querySelectorAll('.tab')[1].classList.contains('tab--on'));
  });
});

describe('overlays', () => {
  let doc;
  beforeEach(() => {
    doc = installDom();
    doc.body.append(el('div', { id: 'modal-root' }), el('div', { id: 'drawer-root' }), el('div', { id: 'toasts' }));
  });

  test('toast appends to #toasts and carries a variant', () => {
    toast('Saved', 'success');
    const node = $('#toasts').querySelector('.toast');
    assert.equal(node.textContent, 'Saved');
    assert.ok(node.classList.contains('toast--success'));
  });

  test('modal renders into #modal-root and an action closes it', () => {
    let closed = false;
    modal({ title: 'Confirm', body: el('p', { text: 'body' }), actions: [{ label: 'OK', onClick: () => { closed = true; } }], onClose: () => {} });
    const root = $('#modal-root');
    assert.equal(root.querySelector('.modal__title').textContent, 'Confirm');
    const ok = root.querySelector('.modal__actions .btn');
    fire(ok, 'click');
    assert.equal(closed, true);
    assert.equal(root.children.length, 0, 'the modal closed');
  });

  test('drawer renders into #drawer-root and the close button clears it', () => {
    drawer({ title: '@sara', body: el('p', { text: 'dossier' }) });
    const root = $('#drawer-root');
    assert.equal(root.querySelector('.drawer__title').textContent, '@sara');
    assert.ok(root.querySelector('.drawer__backdrop'));
    const closeBtn = root.querySelector('.icon-btn');
    fire(closeBtn, 'click');
    assert.equal(root.children.length, 0);
  });

  test('clicking the drawer backdrop closes it', () => {
    drawer({ title: 'x', body: el('p') });
    const root = $('#drawer-root');
    fire(root.querySelector('.drawer__backdrop'), 'click');
    assert.equal(root.children.length, 0);
  });
});
