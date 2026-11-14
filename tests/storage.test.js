import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import {
  DB_NAME,
  Store,
  clearAll,
  edgeKeyFor,
  getLead,
  getWorkspace,
  listActions,
  listEdgesForLead,
  listLeads,
  logAction,
  openDb,
  putWorkspace,
  recoverIfNeeded,
  resetDb,
  updateWorkspace,
  upsertEdge,
  upsertLead,
} from '../src/storage/db.js';
import { DEFAULTS, clampSafetySettings, loadSettings, redact, saveSettings } from '../src/storage/settings.js';
import { SyncEvent, createSyncBus } from '../src/storage/sync.js';

let fake;

before(() => {
  fake = installFakeIndexedDB();
});

after(() => {
  fake.uninstall();
  resetDb();
});

describe('schema', () => {
  test('opens the workspace database with all eight stores', async () => {
    const db = await openDb();
    assert.equal(db.name, DB_NAME);
    for (const store of Object.values(Store)) {
      assert.ok(db.objectStoreNames.contains(store), `missing store ${store}`);
    }
  });

  test('leads carry the indexes the dashboard queries by', async () => {
    const db = await openDb();
    const store = db.transaction(Store.LEADS, 'readonly').objectStore(Store.LEADS);
    for (const index of ['workspaceId', 'workspace_username', 'workspace_score', 'workspace_rel', 'workspace_dm']) {
      assert.ok(store.index(index), `missing index ${index}`);
    }
  });
});

describe('leads and provenance', () => {
  test('a lead round-trips with string ids', async () => {
    await upsertLead({
      leadKey: 'w1:17841400000000001',
      workspaceId: 'w1',
      igUserId: '17841400000000001',
      username: 'sara',
      relState: 'NONE',
      dmState: 'NONE',
    });
    const row = await getLead('w1:17841400000000001');
    assert.equal(row.username, 'sara');
    assert.equal(typeof row.igUserId, 'string');
    assert.ok(row.firstSeenAt > 0);
  });

  test('the same provenance fact collected twice stays one row', async () => {
    const edge = {
      leadKey: 'w1:17841400000000001',
      workspaceId: 'w1',
      edgeType: 'LIKED_POST',
      sourceAccount: 'compA',
      refId: 'p1',
    };
    await upsertEdge(edge);
    const first = (await listEdgesForLead('w1:17841400000000001')).length;
    await upsertEdge({ ...edge });
    const edges = await listEdgesForLead('w1:17841400000000001');
    assert.equal(first, 1);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].edgeKey, edgeKeyFor(edge));
  });

  test('listLeads scopes by workspace', async () => {
    await upsertLead({ leadKey: 'w2:1', workspaceId: 'w2', username: 'other' });
    const w1 = await listLeads('w1');
    assert.ok(w1.every((l) => l.workspaceId === 'w1'));
    assert.ok(w1.length >= 1);
  });
});

describe('write-ahead recovery', () => {
  test('an interrupted action is rolled back, not repeated', async () => {
    await putWorkspace({ workspaceId: 'w9', viewerUsername: 'me' });
    let ws = await getWorkspace('w9');
    ws.governorState.inFlightAction = { actionType: 'FOLLOW', leadKey: 'w9:5', usernameSnapshot: 'target' };
    await updateWorkspace('w9', { governorState: ws.governorState });

    const report = await recoverIfNeeded();
    assert.equal(report.length, 1);

    const after = await getWorkspace('w9');
    assert.equal(after.governorState.inFlightAction, null);

    const log = await listActions('w9');
    const rolled = log.find((e) => e.verifiedOk === false);
    assert.ok(rolled, 'the rolled-back action was not journalled');
    assert.match(rolled.detail, /rolled back on startup/);

    // A second run finds nothing left to reconcile.
    assert.deepEqual(await recoverIfNeeded(), []);
  });
});

describe('settings', () => {
  const adapter = () => {
    const store = {};
    return {
      get: async (key) => ({ [key]: store[key] }),
      set: async (obj) => Object.assign(store, obj),
    };
  };

  test('defaults load when nothing is stored', async () => {
    const settings = await loadSettings(adapter());
    assert.equal(settings.trustPreset, DEFAULTS.trustPreset);
    assert.equal(settings.limits.followsPerDay, 50);
  });

  test('stored values above a ceiling are corrected on the way in', async () => {
    const a = adapter();
    const saved = await saveSettings({ limits: { followsPerDay: 9999, minActionDelaySec: 2 } }, a);
    assert.equal(saved.limits.followsPerDay, 140);
    const again = await loadSettings(a);
    assert.equal(again.limits.followsPerDay, 140);
    assert.equal(again.limits.minActionDelaySec, 35);
  });

  test('clampSafetySettings reports the fields it moved', () => {
    const { settings, clamped } = clampSafetySettings({ limits: { coldInvitesPerDay: 900 }, ui: { tablePageSize: 9 } });
    assert.ok(clamped.includes('coldInvitesPerDay'));
    assert.ok(clamped.includes('ui.tablePageSize'));
    assert.equal(settings.limits.coldInvitesPerDay, 25);
    assert.equal(settings.ui.tablePageSize, 10);
  });

  test('redaction strips anything credential-shaped, at any depth', () => {
    const out = redact({ keep: 1, csrftoken: 'x', nested: { sessionid: 'y', list: [{ cookie: 'z', fine: 2 }] } });
    assert.deepEqual(out, { keep: 1, nested: { list: [{ fine: 2 }] } });
  });
});

describe('sync bus', () => {
  test('two buses on one channel deliver typed events', () => {
    // A loopback channel pair standing in for BroadcastChannel.
    const peers = [];
    const factory = () => {
      const handlers = { onmessage: null };
      const peer = {
        postMessage: (message) => {
          for (const other of peers) if (other !== peer) other.onmessage?.({ data: message });
        },
        close: () => {},
      };
      Object.defineProperty(peer, 'onmessage', {
        get: () => handlers.onmessage,
        set: (v) => { handlers.onmessage = v; },
      });
      peers.push(peer);
      return peer;
    };

    const a = createSyncBus({ channelFactory: factory });
    const b = createSyncBus({ channelFactory: factory });
    const seen = [];
    b.subscribe((m) => seen.push(m));

    assert.equal(a.live, true);
    a.publish(SyncEvent.LEAD_STATE_CHANGED, { workspaceId: 'w1', leadKey: 'w1:1', relState: 'FOLLOWING' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, SyncEvent.LEAD_STATE_CHANGED);
    assert.ok(seen[0].at > 0);
  });

  test('without a channel the bus degrades to a no-op that says so', () => {
    const bus = createSyncBus({ channelFactory: () => null });
    assert.equal(bus.live, false);
    assert.equal(bus.publish(SyncEvent.GOVERNOR_TICK, {}), false);
  });
});

describe('clearAll', () => {
  test('erases every store', async () => {
    await logAction({ workspaceId: 'w1', actionType: 'FOLLOW', leadKey: 'w1:1' });
    await clearAll();
    assert.deepEqual(await listLeads('w1'), []);
    assert.deepEqual(await listActions('w1'), []);
  });
});
