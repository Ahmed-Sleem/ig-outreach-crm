import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import {
  DB_NAME,
  Store,
  clearAll,
  countEnabledTemplates,
  deleteGroup,
  edgeKeyFor,
  endOutreachSession,
  finishScrapeRun,
  getGroup,
  getLead,
  getSnapshot,
  getWorkspace,
  groupRecord,
  leadRecord,
  listActions,
  listEdgesForLead,
  listGroups,
  listLeads,
  listOutreachSessions,
  listScrapeRuns,
  listSnapshots,
  listTemplates,
  logAction,
  openDb,
  putGroup,
  putOutreachSession,
  putScrapeRun,
  putSnapshot,
  putTemplate,
  putWorkspace,
  reconcileSessions,
  recoverIfNeeded,
  resetDb,
  runRecord,
  sessionRecord,
  setLeadGroup,
  templateRecord,
  updateOutreachSession,
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
  test('opens the workspace database with all nine stores', async () => {
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

describe('buckets', () => {
  const ws = '900';

  test('a bucket needs a workspace and a name', () => {
    assert.throws(() => groupRecord({ name: 'linen' }), /needs a workspace/);
    assert.throws(() => groupRecord({ workspaceId: ws, name: '   ' }), /needs a name/);
    const group = groupRecord({ workspaceId: ws, name: 'Linen suppliers' });
    assert.match(group.groupId, /^grp_/);
    assert.equal(group.workspaceId, ws);
    assert.equal(group.name, 'Linen suppliers');
  });

  test('buckets round-trip per workspace, sorted by name', async () => {
    await putWorkspace({ workspaceId: ws, viewerUsername: 'me' });
    await putGroup(groupRecord({ workspaceId: ws, name: 'Zebra' }));
    await putGroup(groupRecord({ workspaceId: ws, name: 'Alpha' }));
    await putGroup(groupRecord({ workspaceId: '901', name: 'Other account' }));
    const groups = await listGroups(ws);
    assert.deepEqual(groups.map((group) => group.name), ['Alpha', 'Zebra']);
    assert.equal((await getGroup(groups[0].groupId)).name, 'Alpha');
  });

  test('tagging a lead keeps its history and can be undone', async () => {
    const lead = leadRecord({ workspaceId: ws, username: 'sara_shop' }, { followedAt: 123, priorityScore: 40 });
    await upsertLead(lead);
    const group = groupRecord({ workspaceId: ws, name: 'Warm' });
    await putGroup(group);

    const tagged = await setLeadGroup(lead.leadKey, group.groupId, { on: true });
    assert.deepEqual(tagged.groupIds, [group.groupId]);
    const reread = await getLead(lead.leadKey);
    assert.equal(reread.followedAt, 123, 'tagging must not touch funnel history');
    assert.equal(reread.priorityScore, 40);

    await setLeadGroup(lead.leadKey, group.groupId, { on: true });
    assert.equal((await getLead(lead.leadKey)).groupIds.length, 1, 'tagging twice is one tag');
    const untagged = await setLeadGroup(lead.leadKey, group.groupId, { on: false });
    assert.deepEqual(untagged.groupIds, []);
    assert.equal(await setLeadGroup('900:nobody', group.groupId), null);
  });

  test('deleting a bucket un-tags leads and never deletes a person', async () => {
    const lead = leadRecord({ workspaceId: ws, username: 'omar_craft' });
    await upsertLead(lead);
    const group = groupRecord({ workspaceId: ws, name: 'Temp' });
    await putGroup(group);
    await setLeadGroup(lead.leadKey, group.groupId, { on: true });

    const result = await deleteGroup(group.groupId);
    assert.deepEqual(result, { deleted: true, untagged: 1 });
    // IndexedDB resolves a missing key to undefined, not null; the code checks
    // for falsy so it behaves the same in a browser and against the fake.
    assert.equal(await getGroup(group.groupId), undefined);
    assert.deepEqual((await getLead(lead.leadKey)).groupIds, []);
    assert.ok(await getLead(lead.leadKey), 'the lead itself survives');
    assert.deepEqual(await deleteGroup('grp_missing'), { deleted: false, untagged: 0 });
  });
});

describe('message templates', () => {
  const ws = '900';

  test('a template needs a body, and pools are counted separately', async () => {
    assert.throws(() => templateRecord({ workspaceId: ws, body: '  ' }), /needs a message body/);
    await putTemplate(templateRecord({ workspaceId: ws, body: 'Hi {{first_name}}, do you ship to Cairo?', label: 'shipping' }));
    await putTemplate(templateRecord({ workspaceId: ws, body: 'Salam {{first_name}}، عندك كتان؟', language: 'ar', poolId: 'arabic' }));
    await putTemplate(templateRecord({ workspaceId: ws, body: 'disabled one', enabled: false }));

    assert.equal((await listTemplates(ws)).length, 3);
    assert.equal((await listTemplates(ws, { poolId: 'arabic' })).length, 1);
    assert.equal(await countEnabledTemplates(ws), 2);
    assert.equal(await countEnabledTemplates(ws, { poolId: 'arabic' }), 1);
  });

  test('spintax and variables survive the round trip unrendered', async () => {
    const body = 'Hi {{first_name|there}}, I liked your {linen|cotton} pieces.';
    await putTemplate(templateRecord({ workspaceId: ws, body, templateId: 'tpl_keep' }));
    const rows = await listTemplates(ws);
    assert.equal(rows.find((row) => row.templateId === 'tpl_keep').body, body);
  });
});

describe('collection and outreach sessions', () => {
  const ws = '900';

  test('a collection run records what came back and why it stopped', async () => {
    const run = runRecord({ workspaceId: ws, source: 'post_likers', sourceAccount: 'comp_a', tabId: 12, runId: 'run_1' });
    assert.equal(run.status, 'running');
    await putScrapeRun(run);
    assert.equal((await listScrapeRuns(ws))[0].runId, 'run_1');

    const finished = await finishScrapeRun('run_1', { status: 'done', counts: { leads: 38, edges: 38, pages: 2 } });
    assert.equal(finished.status, 'done');
    assert.equal(finished.counts.leads, 38);
    assert.ok(finished.finishedAt >= finished.startedAt);
    assert.equal(await finishScrapeRun('run_missing'), null);
  });

  test('a failed collection keeps its reason and severity', async () => {
    await putScrapeRun(runRecord({ workspaceId: ws, source: 'followers', runId: 'run_2' }));
    const row = await finishScrapeRun('run_2', { status: 'refused', reason: 'action block', severity: 'account' });
    assert.equal(row.status, 'refused');
    assert.equal(row.severity, 'account');
    const runs = await listScrapeRuns(ws, { kind: 'collect' });
    assert.equal(runs.length, 2);
    assert.equal(runs[0].runId, 'run_2', 'newest first');
  });

  test('an outreach session counts what it did', async () => {
    await putOutreachSession(sessionRecord({ workspaceId: ws, mode: 'FOLLOW', tabId: 12, sessionId: 'ses_1', policy: { mutualOnly: true } }));
    const bumped = await updateOutreachSession('ses_1', { counts: { attempted: 3, done: 2, refused: 1 }, planned: 24, lastActionAt: 5 });
    assert.deepEqual(bumped.counts, { attempted: 3, done: 2, refused: 1, skipped: 0, failed: 0 });
    assert.equal(bumped.status, 'running');
    assert.equal(bumped.policy.mutualOnly, true);

    const second = await updateOutreachSession('ses_1', { counts: { done: 4 } });
    assert.equal(second.counts.done, 4, 'counts merge, they do not reset');
    assert.equal(second.counts.refused, 1);

    const ended = await endOutreachSession('ses_1', { status: 'stopped', reason: 'owner pressed stop' });
    assert.equal(ended.status, 'stopped');
    assert.ok(ended.endedAt >= ended.startedAt);
    assert.equal(await updateOutreachSession('ses_missing', {}), null);
  });

  test('a session left running by a crash is marked, not hidden', async () => {
    await putOutreachSession(sessionRecord({ workspaceId: ws, mode: 'DM', sessionId: 'ses_live' }));
    await putOutreachSession(sessionRecord({ workspaceId: ws, mode: 'DM', sessionId: 'ses_done' }));
    await endOutreachSession('ses_done', { status: 'done' });
    const stale = await reconcileSessions(ws);
    assert.equal(stale, 1);
    const rows = await listOutreachSessions(ws);
    assert.equal(rows.find((row) => row.sessionId === 'ses_live').status, 'interrupted');
    assert.equal(rows.find((row) => row.sessionId === 'ses_done').status, 'done');
    assert.equal((await listOutreachSessions(ws, { mode: 'DM' })).length, 2);
    assert.equal((await listOutreachSessions(ws, { mode: 'FOLLOW' })).length, 1);
  });
});

describe('snapshots', () => {
  test('the list carries labels and sizes, the row carries the payload', async () => {
    await putSnapshot({ snapshotId: 'snap_1', workspaceId: '900', label: 'before the Ramadan campaign', payload: { leads: [{ a: 1 }] } });
    const list = await listSnapshots('900');
    assert.equal(list.length, 1);
    assert.equal(list[0].label, 'before the Ramadan campaign');
    assert.ok(list[0].bytes > 10);
    assert.equal(list[0].payload, undefined, 'a megabyte payload does not belong in a list');
    assert.deepEqual((await getSnapshot('snap_1')).payload, { leads: [{ a: 1 }] });
  });
});
