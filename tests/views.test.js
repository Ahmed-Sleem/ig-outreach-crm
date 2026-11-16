import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../scripts/lib/dom-shim.mjs';
import { installFakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import { createLedger } from '../src/app/lib/api.js';
import { createRunController } from '../src/app/lib/runner.js';
import { createSettingsView } from '../src/app/views/settings-view.js';
import { createBackupView } from '../src/app/views/backup-export.js';
import { createCollectorView } from '../src/app/views/tab1-collector.js';
import { createPeopleView } from '../src/app/views/tab-people.js';
import { createOutreachView } from '../src/app/views/tab2-outreach.js';
import { clampSafetySettings } from '../src/storage/settings.js';
import { initialGovernorState } from '../src/core/governor.js';
import { EntropyPoolRNG } from '../src/core/random.js';
import {
  clearAll, getLead, leadRecord, listSnapshots, listTemplates, putWorkspace,
  resetDb, templateRecord, upsertLead,
} from '../src/storage/db.js';

const WS = '500';
const NOW = new Date(2026, 0, 7, 12, 0, 0).getTime();

let doc;
let fake;

/** Install the DOM plus the three overlay roots ui.js renders into. */
function setupDom() {
  doc = installDom();
  for (const id of ['modal-root', 'drawer-root', 'toasts']) {
    const node = doc.createElement('div');
    node.setAttribute('id', id);
    doc.body.append(node);
  }
  return doc;
}

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

function makeCtx(over = {}) {
  const clock = { t: NOW };
  const now = () => clock.t;
  const sleep = async (ms) => { clock.t += ms; await new Promise(setImmediate); };
  const api = makeApi({ now });
  const events = [];
  const controller = createRunController({ api, now, sleep, rng: new EntropyPoolRNG({ seed: [1, 2, 3, 4], clock: now, microClock: () => 1, randomWords: () => new Uint32Array([1, 2, 3, 4]) }), onEvent: (e) => events.push(e) });
  const toasts = [];
  const container = doc.createElement('div');
  doc.body.append(container);
  return {
    api, controller, events, toasts, container, now, sleep,
    ctx: { api, controller, toast: (m, v) => toasts.push({ m, v }), onRunEvent: () => () => {}, onSync: () => () => {}, onChanged: () => {}, setBadge: () => {}, ...over },
  };
}

async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) await new Promise(setImmediate);
  await new Promise((r) => setTimeout(r, 0));
}

function buttons(root) { return [...root.querySelectorAll('.btn')]; }
function findButton(root, text) { return buttons(root).find((b) => b.textContent.trim() === text) ?? null; }

async function seedWorkspace(patch = {}) {
  await putWorkspace({ workspaceId: WS, viewerUsername: 'my_shop', viewerFollowers: 900, viewerFollowing: 300, governorState: initialGovernorState(), ...patch });
}
async function seedLead(username, patch = {}) {
  await upsertLead(leadRecord({ workspaceId: WS, username }, patch));
}

describe('the views', () => {
  before(() => { fake = installFakeIndexedDB(); });
  beforeEach(async () => { setupDom(); await clearAll(); });
  after(() => { fake.uninstall(); resetDb(); });

  /* ------------------------------------------------------------- settings */

  test('settings renders presets and sliders, and a preset snaps the limits', async () => {
    const { ctx, container } = makeCtx();
    const view = createSettingsView(ctx);
    view.mount(container);
    await view.refresh();

    assert.ok(container.querySelector('.chips'), 'the preset chips render');
    assert.ok(container.querySelectorAll('.slider').length >= 10, 'every limit renders a slider');

    const established = container.querySelectorAll('.chip')[2];
    assert.equal(established.textContent, 'Established');
    established._listeners.click[0]({ target: established });
    await settle();
    assert.equal(view.draft.limits.followsPerDay, 90, 'the Established preset snaps the daily follow cap');
    assert.equal(view.draft.trustPreset, 'established');
  });

  test('settings Save writes the clamped draft through the api', async () => {
    const { ctx, container, api } = makeCtx();
    const view = createSettingsView(ctx);
    view.mount(container);
    await view.refresh();

    // Move a slider to make the draft dirty, which enables Save.
    const sliderInput = container.querySelector('.slider__input');
    sliderInput.value = '33';
    sliderInput._listeners.input[0]({ target: sliderInput });
    await settle();

    const save = findButton(container, 'Save settings');
    assert.ok(save, 'a Save button exists');
    assert.equal(save.disabled, false, 'a dirty draft enables Save');
    save._listeners.click[0]({ target: save });
    await settle(10);
    assert.ok(api.savedSettings, 'Save reached the api');
    assert.equal(api.savedSettings.trustPreset, 'custom', 'editing a limit drops the preset to custom');
  });

  /* --------------------------------------------------------------- backup */

  test('backup imports a CSV of handles and reports the unique count', async () => {
    const { ctx, container } = makeCtx();
    const view = createBackupView(ctx);
    view.mount(container);
    await view.refresh();

    const out = await view.importText('username\n@sara_shop\nlinen_co\nsara_shop\n', 'leads.csv');
    assert.equal(out.ok, true);
    assert.equal(out.kind, 'csv');
    assert.equal(out.count, 2, 'the duplicate handle is collapsed');
    assert.deepEqual(out.handles.sort(), ['linen_co', 'sara_shop']);
  });

  test('backup rejects a file that is not a save and not a handle list', async () => {
    const { ctx, container } = makeCtx();
    const view = createBackupView(ctx);
    view.mount(container);
    await view.refresh();
    const out = await view.importText('just some prose, no handles here', 'notes.txt');
    // Prose with no JSON brace and no recognisable handle column.
    assert.equal(out.ok, false);
  });

  test('backup recognises a save file and applySnapshot merges its leads', async () => {
    await seedWorkspace();
    const { ctx, container, api } = makeCtx();
    const view = createBackupView(ctx);
    view.mount(container);
    await view.refresh();

    const snapshot = {
      magic: 'ig-outreach-crm/snapshot', version: 1, savedAt: NOW,
      counts: { leads: 1 }, groups: [], templates: [], edges: [],
      leads: [leadRecord({ workspaceId: WS, username: 'restored_one' })],
    };
    const recognised = await view.importText(JSON.stringify(snapshot), 'save.igcrm.json');
    assert.equal(recognised.ok, true);
    assert.equal(recognised.kind, 'snapshot');

    const applied = await view.applySnapshot(snapshot);
    assert.equal(applied.leads, 1);
    assert.ok(await getLead(`${WS}:restored_one`), 'the restored lead is in the library');
    void api;
  });

  test('backup gather collects the whole workspace for a save point', async () => {
    await seedWorkspace();
    await seedLead('sara_shop');
    const { ctx, container } = makeCtx();
    const view = createBackupView(ctx);
    view.mount(container);
    await view.refresh();
    const data = await view.gather();
    assert.equal(data.leads.length, 1);
    assert.equal(data.workspace.viewerUsername, 'my_shop');
    assert.ok(Array.isArray(data.edges));
  });

  /* ------------------------------------------------------------- collect */

  test('collect renders 2 separated sub-tabs (From an account, From a post) and switches source cleanly', async () => {
    await seedWorkspace();
    const { ctx, container } = makeCtx();
    const view = createCollectorView(ctx);
    view.mount(container);
    await view.refresh();
    await settle();

    const subtabs = [...container.querySelectorAll('.subtab')];
    assert.deepEqual(
      subtabs.map((b) => b.textContent.trim()),
      ['From an account', 'From a post'],
    );
    subtabs[1]._listeners.click[0]({ target: subtabs[1] });
    await settle();
    assert.equal(view.source, 'post_likers');
  });

  test('collector auto-starts from initialRequest and renders the 3-column preview with Default bucket ready', async () => {
    await seedWorkspace();
    let collectArgs = null;
    const { ctx, container } = makeCtx({
      initialRequest: { source: 'followers', username: 'sara_shop', auto: '1' },
    });
    ctx.controller.collect = async (args) => {
      collectArgs = args;
      return {
        ok: true,
        count: 1,
        runId: 'run-1',
        result: {
          leads: [{ username: 'linen_co', fullName: 'Linen Co', warmthTier: 'warm', priorityScore: 55 }],
        },
      };
    };
    const view = createCollectorView(ctx);
    view.mount(container);
    await settle(10);

    assert.equal(collectArgs?.source, 'followers');
    assert.equal(collectArgs?.username, 'sara_shop');
    const headers = [...container.querySelectorAll('table th')].map((th) => th.textContent);
    assert.deepEqual(headers, ['Username', 'Name', 'Warmth']);
    assert.match(container.textContent, /Default/);
    assert.match(container.textContent, /Your people/);
    assert.ok(findButton(container, 'Save'), 'Save button present in preview');
    assert.ok(findButton(container, 'Discard'), 'Discard button present in preview');
  });

  /* ---------------------------------------------------------- your people */

  test('your people renders ready Default bucket tab, custom bucket tabs, and seeded leads', async () => {
    await seedWorkspace();
    const { ctx, container, api } = makeCtx();
    const def = await api.ensureDefaultBucket();
    const custom = await api.createGroup({ name: 'Cairo boutiques' });
    await seedLead('sara_shop', { fullName: 'Sara Adel', warmthTier: 'hot', priorityScore: 80, groupIds: [def.groupId] });
    await seedLead('linen_co', { fullName: 'Linen Co', warmthTier: 'cold', priorityScore: 10, groupIds: [custom.groupId] });

    const view = createPeopleView(ctx);
    view.mount(container);
    await view.refresh();
    await settle();

    const tabs = [...container.querySelectorAll('.subtab')].map((b) => b.textContent.trim());
    assert.ok(tabs.some((t) => t.startsWith('All people')), 'All people tab rendered');
    assert.ok(tabs.some((t) => t.startsWith('Default')), 'ready Default bucket tab rendered');
    assert.ok(tabs.some((t) => t.startsWith('Cairo boutiques')), 'custom bucket tab rendered');
    assert.ok(tabs.includes('+ New bucket'), '+ New bucket button rendered');

    assert.equal(container.querySelectorAll('.vtable__row').length, 2);

    // Click the custom bucket tab — filters to only its leads
    const customTab = [...container.querySelectorAll('.subtab')].find((b) => b.textContent.includes('Cairo boutiques'));
    customTab._listeners.click[0]({ target: customTab });
    await settle();
    assert.equal(container.querySelectorAll('.vtable__row').length, 1);
    assert.match(container.querySelector('.vtable__viewport').textContent, /linen_co/);
  });

  test('your people search filter narrows the table', async () => {
    await seedWorkspace();
    await seedLead('sara_shop', { fullName: 'Sara Adel' });
    await seedLead('linen_co', { fullName: 'Linen Co' });
    const { ctx, container } = makeCtx();
    const view = createPeopleView(ctx);
    view.mount(container);
    await view.refresh();
    await settle();

    const search = container.querySelector('input[type="search"]');
    search.value = 'linen';
    search._listeners.input[0]({ target: search });
    await settle();
    assert.equal(container.querySelectorAll('.vtable__row').length, 1);
    assert.match(container.querySelector('.vtable__viewport').textContent, /linen_co/);
  });

  test('your people opens a lead dossier drawer on row click with bucket toggles', async () => {
    await seedWorkspace();
    await seedLead('sara_shop', { fullName: 'Sara Adel', biography: 'Cotton & linen' });
    const { ctx, container } = makeCtx();
    const view = createPeopleView(ctx);
    view.mount(container);
    await view.refresh();
    await settle();

    const row = container.querySelector('.vtable__row');
    row._listeners.click[0]({ target: row });
    await settle(10);
    const drawerRoot = doc.getElementById('drawer-root');
    assert.ok(drawerRoot.querySelector('.drawer'), 'the dossier drawer opened');
    assert.match(drawerRoot.querySelector('.drawer__title').textContent, /sara_shop/);
    assert.ok(drawerRoot.querySelector('.drawer-buckets'), 'bucket assignment toggles rendered inside drawer');
  });

  /* ------------------------------------------------------------- outreach */

  test('outreach separates Follow, Messages, and Unfollow into clean sub-tabs', async () => {
    await seedWorkspace();
    await seedLead('sara_shop');
    await seedLead('linen_co');
    const { ctx, container } = makeCtx();
    const view = createOutreachView(ctx);
    view.mount(container);
    await view.refresh();
    await settle();

    const subtabs = [...container.querySelectorAll('.subtab')].map((b) => b.textContent.trim());
    assert.deepEqual(subtabs, ['Follow', 'Messages', 'Unfollow']);
    assert.ok(view.plan, 'a dry run produced a plan');
    assert.ok(view.plan.counts.ready >= 1, 'the fresh leads are queued');
    assert.ok(container.querySelector('.bucket-bar'), 'the bucket selector renders');
    assert.equal(container.querySelector('.input--area'), null, 'Message studio stays hidden inside Follow sub-tab');
    assert.doesNotMatch(container.textContent, /Cleanup scope/, 'Cleanup scope stays hidden inside Follow sub-tab');
  });

  test('outreach Messages sub-tab renders Message studio and saves a new template', async () => {
    await seedWorkspace();
    const { ctx, container } = makeCtx();
    const view = createOutreachView(ctx);
    view.mount(container);
    await view.refresh();
    await settle();

    const msgTab = [...container.querySelectorAll('.subtab')].find((b) => b.textContent.trim() === 'Messages');
    assert.ok(msgTab, 'Messages sub-tab is rendered');
    msgTab._listeners.click[0]({ target: msgTab });
    await settle(8);

    const area = container.querySelector('.input--area');
    assert.ok(area, 'Message studio composer renders inside Messages sub-tab');
    area.value = 'Hi {{first_name|there}}, {loved|liked} your {linen|cotton}.';
    area._listeners.input[0]({ target: area });
    await settle();
    const save = findButton(container, 'Save template');
    save._listeners.click[0]({ target: save });
    await settle(10);

    const templates = await listTemplates(WS);
    assert.equal(templates.length, 1, 'the template was written to the pool');
    assert.match(templates[0].body, /loved\|liked/);
  });

  test('outreach switching to the Unfollow sub-tab renders Cleanup scope and hides Message studio', async () => {
    await seedWorkspace();
    await seedLead('sara_shop', { relState: 'FOLLOWING', followedViaExtension: true, followedAt: NOW - 10 * 86_400_000 });
    const { ctx, container } = makeCtx();
    const view = createOutreachView(ctx);
    view.mount(container);
    await view.refresh();
    await settle();

    const unfollowTab = [...container.querySelectorAll('.subtab')].find((b) => b.textContent.trim() === 'Unfollow');
    assert.ok(unfollowTab, 'Unfollow sub-tab is rendered');
    unfollowTab._listeners.click[0]({ target: unfollowTab });
    await settle(8);
    assert.match(container.textContent, /Cleanup scope/, 'Unfollow sub-tab exposes its scope control');
    assert.equal(container.querySelector('.input--area'), null, 'Message studio stays hidden inside Unfollow sub-tab');
  });
});
