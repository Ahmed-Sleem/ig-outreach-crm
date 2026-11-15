import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../scripts/lib/dom-shim.mjs';
import {
  CURSOR_HOST_ID,
  createVirtualCursor,
  generateHumanPath,
  humanClickTarget,
  humanDelayMs,
  humanEase,
  humanMoveTo,
  humanScrollContainer,
  targetPointFor,
} from '../src/content/human.js';

function seededRandom(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('human cursor trajectory math', () => {
  test('humanEase is monotonic 0 -> 1 with smooth acceleration and deceleration', () => {
    assert.equal(humanEase(0), 0);
    assert.equal(humanEase(1), 1);
    assert.ok(humanEase(0.1) < 0.1, 'starts slower (ease-in)');
    assert.ok(humanEase(0.9) > 0.9, 'slows down near target (ease-out)');
    let prev = -1;
    for (let i = 0; i <= 20; i += 1) {
      const v = humanEase(i / 20);
      assert.ok(v >= prev, 'monotonic non-decreasing');
      prev = v;
    }
  });

  test('generateHumanPath curves off the straight chord and lands on destination', () => {
    const rng = seededRandom(7);
    const path = generateHumanPath({ clientX: 50, clientY: 80 }, { clientX: 520, clientY: 410 }, { random: rng });
    assert.ok(path.length >= 10, `expected >= 10 points, got ${path.length}`);
    const last = path[path.length - 1];
    assert.equal(last.clientX, 520);
    assert.equal(last.clientY, 410);
    // Verify it is not a straight robotic line (at least one point deviates > 8px from chord)
    const maxDeviation = path.reduce((best, p) => {
      const num = Math.abs((410 - 80) * p.clientX - (520 - 50) * p.clientY + 520 * 80 - 410 * 50);
      const den = Math.hypot(410 - 80, 520 - 50);
      return Math.max(best, num / den);
    }, 0);
    assert.ok(maxDeviation > 8, `expected curved Bezier path, max deviation was ${maxDeviation}`);
    assert.ok(path.every((p) => Number.isFinite(p.dtMs) && p.dtMs > 0));
  });

  test('humanDelayMs stays within [min, max] with natural spread', () => {
    const rng = seededRandom(99);
    const samples = Array.from({ length: 100 }, () => humanDelayMs(100, 600, rng));
    assert.ok(samples.every((ms) => ms >= 100 && ms <= 600));
    const unique = new Set(samples);
    assert.ok(unique.size > 40, 'delays vary naturally instead of repeating a fixed step');
  });

  test('targetPointFor stays strictly inside the element bounding box', () => {
    const el = { getBoundingClientRect: () => ({ left: 100, top: 200, width: 140, height: 44 }) };
    const rng = seededRandom(12);
    for (let i = 0; i < 40; i += 1) {
      const pt = targetPointFor(el, rng);
      assert.ok(pt.clientX > 100 && pt.clientX < 240);
      assert.ok(pt.clientY > 200 && pt.clientY < 244);
    }
  });
});

describe('virtual cursor & DOM human actions', () => {
  test('createVirtualCursor mounts pointer-events-none overlay and cleans up on destroy', () => {
    const doc = installDom();
    const cursor = createVirtualCursor(doc);
    cursor.show('Clicking Followers…');
    cursor.move(310, 220);
    const host = doc.getElementById(CURSOR_HOST_ID);
    assert.ok(host, 'overlay host is mounted');
    assert.equal(host.style.pointerEvents, 'none');
    assert.deepEqual(cursor.position, { clientX: 310, clientY: 220 });
    cursor.hide();
    assert.equal(host.style.display, 'none');
    cursor.destroy();
    assert.equal(host.parentNode, null);
    assert.equal(doc.body.children.length, 0);
  });

  test('humanClickTarget glides cursor, dispatches pointer/mouse events, and clicks', async () => {
    const doc = installDom();
    const btn = doc.createElement('button');
    btn.textContent = 'Followers';
    btn.getBoundingClientRect = () => ({ left: 200, top: 150, width: 100, height: 32 });
    const events = [];
    const origDispatch = btn.dispatchEvent.bind(btn);
    btn.dispatchEvent = (ev) => { events.push(ev.type); return origDispatch(ev); };
    let clicked = false;
    btn.click = () => { clicked = true; events.push('click'); };
    doc.body.append(btn);

    const ctx = {
      document: doc,
      wait: async () => {},
      random: seededRandom(5),
      virtualCursor: createVirtualCursor(doc),
    };
    const ok = await humanClickTarget(ctx, btn, { label: 'Clicking Followers' });
    assert.equal(ok, true);
    assert.equal(clicked, true);
    assert.ok(events.includes('pointermove'));
    assert.ok(events.includes('pointerover'));
    assert.ok(events.includes('pointerdown'));
    assert.ok(events.includes('mouseup'));
    assert.ok(events.includes('click'));
  });

  test('humanMoveTo aborts immediately when signal is aborted', async () => {
    const doc = installDom();
    const ac = new AbortController();
    ac.abort();
    const res = await humanMoveTo({ document: doc, wait: async () => {} }, { clientX: 400, clientY: 400 }, { signal: ac.signal });
    assert.equal(res.ok, false);
    assert.equal(res.aborted, true);
  });

  test('humanScrollContainer scrolls incrementally in multiple wheel bursts', async () => {
    const doc = installDom();
    const box = doc.createElement('div');
    box.scrollTop = 0;
    box.clientHeight = 400;
    box.scrollHeight = 2000;
    box.getBoundingClientRect = () => ({ left: 100, top: 100, width: 380, height: 400 });
    let scrollEvents = 0;
    box.addEventListener('scroll', () => { scrollEvents += 1; });
    doc.body.append(box);

    const ctx = {
      document: doc,
      wait: async () => {},
      random: seededRandom(17),
    };
    const step = await humanScrollContainer(ctx, box, { allowMicroBehaviors: false });
    assert.ok(step.movedPx > 150, `expected natural multi-step scroll, moved ${step.movedPx}px`);
    assert.ok(scrollEvents >= 2, `expected multiple wheel/scroll bursts, got ${scrollEvents}`);
    assert.equal(step.atBottom, false);
  });
});
