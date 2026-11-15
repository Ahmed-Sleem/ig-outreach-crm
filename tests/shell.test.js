import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../scripts/lib/dom-shim.mjs';
import { installFakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import { createLedger } from '../src/app/lib/api.js';
import { clampSafetySettings } from '../src/storage/settings.js';
import { initialGovernorState } from '../src/core/governor.js';
import { clearAll, putWorkspace, resetDb } from '../src/storage/db.js';
// Imported for its side effect only after the DOM exists; the module's own
// auto-boot guard checks for #view-root at import time, which is absent here
// (installDom has not run yet), so importing never boots a second app.
import { createApp } from '../src/app/main.js';

const WS = '500';
const NOW = new Date(2026, 0, 7, 12, 0, 0).getTime();

// The exact roots index.html ships. A boot that needs one of these and does not
// find it would render a blank dashboard in Chrome, so the shell test mirrors
// the real page rather than a synthetic container.
const ROOT_IDS = ['shell-left', 'shell-center', 'shell-right', 'view-root', 'modal-root', 'drawer-root', 'toasts'];

let doc;
let fake;

function setupDom() {
  doc = installDom();
  for (const id of ROOT_IDS) {
    const node = doc.createElement('div');
    node.setAttribute('id', id);
    doc.body.append(node);
  }
  return doc;
}

/** A fake api shaped like the real client: the ledger for reads, stubs for tabs. */
function makeApi({ now }) {
  const state = { workspaceId: WS };
  const ledger = createLedger({ state, now });
  const sent = [];
  const stops = [];
  const api = {
    ...ledger,
    workspaceId: WS,
    sent,
    stops,
    savedSettings: null,
    settings: async () => clampSafetySettings({}).settings,
    saveSettings: async (patch) => { api.savedSettings = patch; return clampSafetySettings(patch).settings; },
    async overview() {
      const ws = await ledger.workspace();
      const lockedUntil = Number(ws?.governorState?.lockedUntil ?? 0);
      return {
        workspaceId: WS,
        viewerUsername: ws?.viewerUsername ?? 'my_shop',
        followers: 900, following: 300,
        counters: {},
        lockedUntil: lockedUntil > now() ? lockedUntil : null,
        lockReason: null,
        groups: await ledger.groups(),
        enabledTemplates: await ledger.enabledTemplateCount(),
      };
    },
    async sendWithNavigation(type, payload, options) {
      sent.push({ type, payload, options });
      return { ok: true, value: { ok: true, outcome: 'done', state: 'following' }, severity: null, elapsedMs: 10, commandId: 'c' };
    },
    async stop(reason) { stops.push(reason); return { ok: true }; },
    watch: () => ({ dispose() {}, push() {} }),
    tabs: {
      tabById: async () => ({ id: 7, url: 'https://www.instagram.com/sara_shop/' }),
      listTabs: async () => [{ id: 7, url: 'https://www.instagram.com/sara_shop/', active: true }],
      worker: async () => ({ id: 7 }),
      ensureWorker: async () => ({ tab: { id: 7 }, created: false }),
      navigate: async () => ({ ok: true }),
    },
  };
  return api;
}

// A bus stub so createApp never touches BroadcastChannel under test.
function makeBus() {
  const subs = [];
  return { subscribe: (fn) => { subs.push(fn); return () => {}; }, publish: (m) => subs.forEach((f) => f(m)), close() {}, _subs: subs };
}

async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) await new Promise(setImmediate);
  await new Promise((r) => setTimeout(r, 0));
}

function textOf(root) { return (root?.textContent ?? ''); }

describe('the dashboard shell (main.js createApp)', () => {
  before(() => { fake = installFakeIndexedDB(); });
  beforeEach(async () => { setupDom(); await clearAll(); await putWorkspace({ workspaceId: WS, viewerUsername: 'my_shop', viewerFollowers: 900, viewerFollowing: 300, governorState: initialGovernorState() }); });
  after(() => { fake.uninstall(); resetDb(); });

  function bootApp(over = {}) {
    const clock = { t: NOW };
    const now = () => clock.t;
    const api = makeApi({ now });
    const bus = makeBus();
    const app = createApp({ document: doc, api, bus, ...over });
    return { app, api, bus, now };
  }

  test('start() mounts a view and paints the whole top bar without throwing', async () => {
    const { app } = bootApp();
    await app.start();
    await settle();

    // The view actually mounted into the real root, not a detached node.
    const viewRoot = doc.getElementById('view-root');
    assert.ok(viewRoot.children.length > 0, 'a view is mounted into #view-root');

    // Brand + session pill landed on the left.
    const left = doc.getElementById('shell-left');
    assert.ok(left.querySelector('.brand'), 'the brand is rendered');
    assert.ok(left.querySelector('#session-pill'), 'the session pill is rendered');
    assert.match(textOf(left.querySelector('#session-pill')), /@my_shop/, 'the pill shows the connected workspace');

    // Two tabs, the collector one active by default.
    const center = doc.getElementById('shell-center');
    const tabs = [...center.querySelectorAll('.tab')];
    assert.equal(tabs.length, 2, 'two tabs are rendered');
    assert.match(tabs[0].textContent, /Collect/);
    assert.match(tabs[1].textContent, /Outreach/);
    assert.ok(tabs[0].classList.contains('tab--on'), 'the collector tab is active on boot');

    // Telemetry strip on the right, with a Stop button and the two drawers.
    const right = doc.getElementById('shell-right');
    assert.ok(right.querySelector('.telemetry'), 'the telemetry strip is rendered');
    const labels = [...right.querySelectorAll('.btn')].map((b) => b.textContent.trim());
    assert.ok(labels.includes('Stop'), 'a Stop button is present');
    assert.ok(labels.includes('Settings') && labels.includes('Backup'), 'Settings and Backup buttons are present');

    app.destroy();
  });

  test('navigate("outreach") re-mounts into the same live root and flips the active tab', async () => {
    const { app } = bootApp();
    await app.start();
    await settle();

    const center = doc.getElementById('shell-center');
    const viewRoot = doc.getElementById('view-root');
    const beforeHtml = viewRoot.innerHTML;

    app.navigate('outreach');
    await settle();

    assert.equal(app.activeTab, 'outreach', 'the active tab is now outreach');
    const tabs = [...center.querySelectorAll('.tab')];
    assert.ok(tabs[1].classList.contains('tab--on'), 'the outreach tab is marked active');
    assert.ok(!tabs[0].classList.contains('tab--on'), 'the collector tab is no longer active');
    assert.ok(viewRoot.children.length > 0, 'the outreach view is mounted');
    assert.notEqual(viewRoot.innerHTML, beforeHtml, 'the mounted content changed on navigation');

    app.destroy();
  });

  test('a ?tab=outreach deep link lands on Outreach before the first mount', async () => {
    // index.html is opened as app/index.html?tab=outreach by the popup.
    globalThis.location.search = '?tab=outreach';
    const { app } = bootApp();
    await app.start();
    await settle();

    assert.equal(app.activeTab, 'outreach', 'the deep link set the active tab');
    const tabs = [...doc.getElementById('shell-center').querySelectorAll('.tab')];
    assert.ok(tabs[1].classList.contains('tab--on'), 'Outreach is the tab the owner asked for');

    globalThis.location.search = '';
    app.destroy();
  });

  test('destroy() tears down the scheduler, watcher and both views without throwing', async () => {
    const { app } = bootApp();
    await app.start();
    await settle();
    // Must not throw and must not leave a live interval holding the process open.
    app.destroy();
    await settle(2);
    assert.ok(true, 'destroy completed');
  });
});
