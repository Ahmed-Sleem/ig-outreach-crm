import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import {
  ACTIVE_WORKSPACE_KEY,
  BOOTSTRAP_WORKSPACE_ID,
  WORKER_WINDOW,
  WORKER_WINDOW_KEY,
  applyEvents,
  createApiClient,
  createCommandChannel,
  createLedger,
  createTabController,
  describeTab,
  eventsForOutcome,
  explainFailure,
  isInstagramUrl,
  mergeLead,
  pickTab,
  timeoutFor,
  usernameFromUrl,
} from '../src/app/lib/api.js';
import { ActionType } from '../src/core/governor.js';
import { RelState } from '../src/core/lifecycle.js';
import { CommandType } from '../src/storage/bridge.js';
import { getLead, getWorkspace, listActions, resetDb, upsertLead, leadRecord } from '../src/storage/db.js';

/* --------------------------------------------------------------------- fakes */

function fakeChrome({ tabs = [], autoLoad = false, failUpdate = false } = {}) {
  const calls = [];
  const tabMap = new Map(tabs.map((tab) => [tab.id, { status: 'complete', active: false, windowId: 1, ...tab }]));
  const store = new Map();
  // Mutable so one test can hold a tab mid-load and then let it finish.
  const flags = { autoLoad, failUpdate };
  let nextWindowId = 900;
  let nextTabId = tabs.reduce((max, tab) => Math.max(max, tab.id), 0) + 1;

  const chromeApi = {
    tabs: {
      query: async () => { calls.push(['query']); return [...tabMap.values()]; },
      get: async (id) => {
        const tab = tabMap.get(Number(id));
        if (!tab) throw new Error('No tab with id');
        return tab;
      },
      update: async (id, patch) => {
        calls.push(['update', Number(id), patch]);
        const tab = tabMap.get(Number(id));
        if (!tab) throw new Error('No tab with id');
        if (flags.failUpdate) throw new Error('The tab was discarded');
        // A real page finishes loading; `autoLoad: false` lets a test hold one
        // mid-load to exercise the ceiling instead of the happy path.
        Object.assign(tab, patch, { status: flags.autoLoad ? 'complete' : 'loading' });
        return tab;
      },
    },
    windows: {
      create: async (options) => {
        calls.push(['windows.create', options]);
        const windowId = nextWindowId++;
        const id = nextTabId++;
        const tab = { id, windowId, url: options.url, status: 'loading', active: true, title: 'Instagram' };
        tabMap.set(id, tab);
        return { id, tabs: [tab] };
      },
      remove: async (id) => { calls.push(['windows.remove', Number(id)]); },
    },
    scripting: {
      executeScript: async (options) => {
        calls.push(['inject', options.target.tabId, options.files]);
        if (!tabMap.has(Number(options.target.tabId))) throw new Error('No tab with id');
        return [];
      },
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: store.get(key) ?? null }),
        set: async (row) => { for (const [key, value] of Object.entries(row)) store.set(key, value); },
        remove: async (key) => { store.delete(key); },
      },
    },
  };
  return {
    chromeApi,
    calls,
    tabMap,
    store,
    flags,
    finishLoad: (id) => { tabMap.get(Number(id)).status = 'complete'; },
  };
}

function memoryStorage(seed = {}) {
  const rows = new Map(Object.entries(seed));
  return {
    rows,
    get: async (key) => (rows.has(key) ? JSON.parse(JSON.stringify(rows.get(key))) : null),
    set: async (key, value) => { rows.set(key, JSON.parse(JSON.stringify(value))); },
    remove: async (key) => { rows.delete(key); },
  };
}

const lead = (patch = {}) => ({
  leadKey: `7:${(patch.username ?? 'sara').toLowerCase()}`,
  workspaceId: '7',
  username: patch.username ?? 'sara',
  relState: RelState.NONE,
  dmState: 'NONE',
  priorityScore: 0,
  attempts: 0,
  groupIds: [],
  followedViaExtension: false,
  ...patch,
});

describe('urls, tabs and timeouts', () => {
  test('a username is read from a profile url and nowhere else', () => {
    assert.equal(usernameFromUrl('https://www.instagram.com/sara_shop/?hl=en'), 'sara_shop');
    assert.equal(usernameFromUrl('https://instagram.com/sara_shop'), 'sara_shop');
    for (const url of ['https://www.instagram.com/explore/', 'https://www.instagram.com/p/Cx9/', 'https://www.instagram.com/direct/inbox/', 'https://example.com/sara', null, '']) {
      assert.equal(usernameFromUrl(url), null, String(url));
    }
    assert.equal(isInstagramUrl('https://i.instagram.com/api/v1/x'), true);
    assert.equal(isInstagramUrl('https://evil.example.com/instagram.com/sara'), false);
  });

  test('a tab is described once, and only instagram tabs are candidates', () => {
    const described = describeTab({ id: 3, url: 'https://www.instagram.com/sara/', title: 'Sara', active: true, windowId: 9, discarded: false });
    assert.deepEqual(described, { id: 3, windowId: 9, url: 'https://www.instagram.com/sara/', title: 'Sara', active: true, status: null, username: 'sara', instagram: true, discarded: false });
    assert.equal(describeTab(null).instagram, false);
  });

  test('the tab picker prefers the tab that was asked for over the active one', () => {
    const tabs = [
      { id: 1, url: 'https://www.instagram.com/other/', active: true },
      { id: 2, url: 'https://www.instagram.com/sara/', active: false },
      { id: 3, url: 'https://example.com/', active: false },
    ];
    assert.equal(pickTab(tabs, { tabId: 2 }).reason, 'requested');
    assert.equal(pickTab(tabs, { workerTabId: 2 }).reason, 'worker');
    assert.equal(pickTab(tabs, { username: 'sara' }).tab.id, 2, 'the active tab is the wrong person here');
    assert.equal(pickTab(tabs, {}).reason, 'active');
    assert.equal(pickTab([{ id: 3, url: 'https://example.com/' }], {}).reason, 'none');
    assert.equal(pickTab([], { tabId: 9 }).tab, null);
  });

  test('a collection gets a long ceiling and a ping a short one', () => {
    assert.equal(timeoutFor(CommandType.COLLECT_LEADS), 30 * 60_000);
    assert.equal(timeoutFor(CommandType.PING), 8_000);
    assert.equal(timeoutFor('SOMETHING_NEW'), 30_000);
  });

  test('every failure mode is explained in words the owner can act on', () => {
    assert.equal(explainFailure('PING', { ok: true }), null);
    assert.match(explainFailure('COLLECT_LEADS', { ok: false, reason: 'the command timed out', elapsedMs: 1_800_000 }), /stopped answering a COLLECT_LEADS command after 1800s/);
    assert.match(explainFailure('PING', { ok: false, reason: 'no handler is listening' }), /not running this extension's content script/);
    assert.match(explainFailure('PING', { ok: false, reason: 'withdrawn after the deadline' }), /withdrawn/);
    assert.equal(explainFailure('PING', { ok: false, reason: 'Instagram refused' }), 'Instagram refused');
    assert.equal(explainFailure('PING', {}), 'no answer');
  });
});

describe('outcomes become states', () => {
  test('a verified follow moves the state and claims the action', () => {
    const publicFollow = eventsForOutcome({ actionType: ActionType.FOLLOW, result: { ok: true, outcome: 'done', state: 'following' }, lead: lead() });
    assert.equal(publicFollow.ok, true);
    assert.deepEqual(publicFollow.relEvents, ['QUEUE_FOLLOW', 'FOLLOW_CLICKED_PUBLIC']);
    assert.equal(publicFollow.patch.relState, RelState.FOLLOWING);
    assert.equal(publicFollow.patch.followedViaExtension, true);
    assert.ok(publicFollow.patch.followedAt > 0);
    assert.equal(publicFollow.stopRun, false);

    const privateFollow = eventsForOutcome({ actionType: ActionType.FOLLOW, result: { ok: true, outcome: 'done', requested: true, state: 'requested' }, lead: lead() });
    assert.equal(privateFollow.patch.relState, RelState.FOLLOW_REQUESTED);
    assert.ok(privateFollow.patch.requestedAt > 0);
    assert.equal(privateFollow.patch.followedAt, undefined, 'a pending request is not a follow yet');
  });

  test('an unverified click is a failure, never a success', () => {
    for (const result of [
      { ok: false, outcome: 'not_done', reason: 'the button never settled' },
      { ok: false, outcome: 'refused', reason: 'no Follow button found' },
      { ok: false, reason: 'the tab did not answer' },
    ]) {
      const outcome = eventsForOutcome({ actionType: ActionType.FOLLOW, result, lead: lead() });
      assert.equal(outcome.ok, false, JSON.stringify(result));
      assert.equal(outcome.patch.relState, RelState.NONE, 'the state must not move');
      assert.equal(outcome.patch.attempts, 1);
      assert.equal(outcome.patch.lastError, result.reason);
    }
  });

  test('what the page said but we did not do is an observation, not a credit', () => {
    const outcome = eventsForOutcome({
      actionType: ActionType.FOLLOW,
      result: { ok: false, outcome: 'skipped', reason: 'already following this account', state: 'following' },
      lead: lead(),
    });
    assert.equal(outcome.observed, 'following');
    assert.equal(outcome.patch.relState, RelState.FOLLOWING, 'the record adopts the truth');
    assert.equal(outcome.patch.followedViaExtension, false, 'so the cleaner never unfollows a friend followed by hand');
    assert.equal(outcome.patch.followedAt, undefined);

    const pending = eventsForOutcome({
      actionType: ActionType.FOLLOW,
      result: { ok: false, outcome: 'skipped', reason: 'a follow request is already pending' },
      lead: lead(),
    });
    assert.equal(pending.observed, 'requested');
    assert.equal(pending.patch.relState, RelState.FOLLOW_REQUESTED);
  });

  test('an action block stops the run without moving any state', () => {
    const outcome = eventsForOutcome({ actionType: ActionType.FOLLOW, result: { ok: false, outcome: 'stopped', reason: 'Instagram blocked the follow' }, lead: lead() });
    assert.equal(outcome.stopRun, true);
    assert.equal(outcome.patch.relState, RelState.NONE);
    assert.equal(outcome.patch.attempts, undefined);
    assert.match(outcome.patch.lastError, /blocked the follow/);
  });

  test('a warm message arms the funnel and lands on the sent state', () => {
    const warm = eventsForOutcome({ actionType: ActionType.DM_WARM, result: { ok: true, outcome: 'done' }, lead: lead({ relState: RelState.MUTUAL }) });
    assert.deepEqual(warm.dmEvents, ['FUNNEL_ARMED', 'DM_CONDITION_MET', 'DM_SENT_PRIMARY']);
    assert.equal(warm.patch.dmState, 'DM_SENT_PRIMARY');
    assert.ok(warm.patch.messagedAt > 0);
    assert.equal(warm.patch.attempts, 1);

    const cold = eventsForOutcome({ actionType: ActionType.DM_COLD, result: { ok: true, outcome: 'done' }, lead: lead({ dmState: 'DM_QUEUED' }) });
    assert.deepEqual(cold.dmEvents, ['DM_SENT_REQUEST'], 'an armed lead is not armed twice');
    assert.equal(cold.patch.dmState, 'DM_SENT_REQUEST');
  });

  test('a failed send is recorded as failed, and an existing thread as skipped', () => {
    const failed = eventsForOutcome({ actionType: ActionType.DM_WARM, result: { ok: false, outcome: 'not_done', reason: 'the composer still holds the message' }, lead: lead({ relState: RelState.MUTUAL }) });
    assert.equal(failed.patch.dmState, 'DM_FAILED');
    assert.equal(failed.patch.attempts, 1);
    assert.match(failed.patch.lastError, /composer still holds/);

    const existing = eventsForOutcome({ actionType: ActionType.DM_WARM, result: { ok: false, outcome: 'skipped', existingThread: true, reason: 'this thread already has messages' }, lead: lead({ dmState: 'DM_QUEUED' }) });
    assert.equal(existing.observed, 'existing-thread');
    assert.equal(existing.patch.dmState, 'DM_EXISTING_THREAD_SKIPPED');
    assert.equal(existing.patch.messagedAt, undefined, 'nothing was sent, so nothing is recorded as sent');
  });

  test('an unfollow only completes from a state that allows it', () => {
    const done = eventsForOutcome({ actionType: ActionType.UNFOLLOW, result: { ok: true, outcome: 'done', state: 'none' }, lead: lead({ relState: RelState.FOLLOWING, followedViaExtension: true }) });
    assert.equal(done.patch.relState, RelState.UNFOLLOWED);
    assert.ok(done.patch.unfollowedAt > 0);
    assert.deepEqual(done.warnings, []);

    const impossible = eventsForOutcome({ actionType: ActionType.UNFOLLOW, result: { ok: true, outcome: 'done' }, lead: lead({ relState: RelState.NONE }) });
    assert.equal(impossible.patch.relState, RelState.NONE);
    assert.ok(impossible.warnings.length > 0, 'a transition that cannot happen is reported, not silently applied');
  });

  test('events that do not fit are skipped with a warning', () => {
    const walked = applyEvents({ lead: lead({ relState: RelState.FOLLOWING }), relEvents: ['QUEUE_FOLLOW', 'FOLLOW_CLICKED_PUBLIC'] });
    assert.equal(walked.relState, RelState.FOLLOWING);
    assert.equal(walked.warnings.length, 2);
    assert.match(walked.warnings[0], /not valid from FOLLOWING/);
    assert.match(applyEvents({ lead: lead(), relEvents: ['NOT_AN_EVENT'] }).warnings[0], /unknown relationship event/);
  });

  test('a re-collection updates the evidence and keeps the funnel', () => {
    const stored = lead({ relState: RelState.FOLLOWING, followedAt: 111, groupIds: ['grp_a'], isWhitelisted: true, priorityScore: 12, attempts: 2, firstSeenAt: 5 });
    const fresh = lead({ priorityScore: 80, fullName: 'Sara Linen', relState: RelState.NONE, followedAt: null, groupIds: [], attempts: 0 });
    const merged = mergeLead(stored, fresh);
    assert.equal(merged.priorityScore, 80, 'the new score wins');
    assert.equal(merged.fullName, 'Sara Linen');
    assert.equal(merged.relState, RelState.FOLLOWING, 'the funnel is untouched');
    assert.equal(merged.followedAt, 111);
    assert.deepEqual(merged.groupIds, ['grp_a']);
    assert.equal(merged.isWhitelisted, true);
    assert.equal(merged.attempts, 2);
    assert.equal(merged.firstSeenAt, 5);
    assert.deepEqual(mergeLead(null, fresh), fresh);
  });
});

describe('the managed worker window', () => {
  test('it is created small, unfocused, and remembered', async () => {
    const fake = fakeChrome();
    let t = 1000;
    const tabs = createTabController({ chromeApi: fake.chromeApi, sleep: async () => {}, now: () => t });
    const first = await tabs.ensureWorker({ url: 'https://www.instagram.com/direct/new/sara/' });
    assert.equal(first.created, true);
    const options = fake.calls.find((call) => call[0] === 'windows.create')[1];
    assert.equal(options.width, WORKER_WINDOW.width);
    assert.equal(options.height, WORKER_WINDOW.height);
    assert.equal(options.type, 'popup');
    assert.equal(options.focused, false, 'stealing focus from the dashboard is how an extension gets closed');
    assert.ok(fake.store.get(WORKER_WINDOW_KEY).tabId, 'the worker is remembered for the next run');
    assert.equal(fake.store.get(WORKER_WINDOW_KEY).createdAt, 1000);

    fake.finishLoad(first.tab.id);
    const second = await tabs.ensureWorker({ url: 'https://www.instagram.com/direct/new/sara/' });
    assert.equal(second.created, false);
    assert.equal(second.tab.id, first.tab.id, 'one worker window, reused');
    assert.equal(fake.calls.filter((call) => call[0] === 'windows.create').length, 1);
  });

  test('a worker whose tab was closed is replaced, and reuse can be refused', async () => {
    const fake = fakeChrome();
    const tabs = createTabController({ chromeApi: fake.chromeApi, sleep: async () => {}, now: () => 0 });
    const first = await tabs.ensureWorker({});
    fake.tabMap.delete(first.tab.id);
    const replaced = await tabs.ensureWorker({});
    assert.equal(replaced.created, true);
    assert.notEqual(replaced.tab.id, first.tab.id);
    const forced = await tabs.ensureWorker({ reuse: false });
    assert.equal(forced.created, true);
  });

  test('navigation waits for the load and reports a tab that never finishes', async () => {
    const fake = fakeChrome({ tabs: [{ id: 5, url: 'https://www.instagram.com/sara/', status: 'complete' }] });
    let t = 0;
    const tabs = createTabController({ chromeApi: fake.chromeApi, sleep: async (ms) => { t += ms; await new Promise((resolve) => setImmediate(resolve)); }, now: () => t });
    const slow = await tabs.navigate(5, 'https://www.instagram.com/omar/', { timeoutMs: 1000 });
    assert.equal(slow.ok, false);
    assert.match(slow.reason, /still loading after 1s/);
    assert.equal(t >= 1000, true);

    // Now let the page finish loading, as a real one would.
    fake.flags.autoLoad = true;
    const fast = await tabs.navigate(5, 'https://www.instagram.com/omar/');
    assert.equal(fast.ok, true);
    assert.equal(fake.tabMap.get(5).url, 'https://www.instagram.com/omar/');
  });

  test('a closed tab is reported, not awaited forever', async () => {
    const fake = fakeChrome();
    const tabs = createTabController({ chromeApi: fake.chromeApi, sleep: async () => {}, now: () => 0 });
    assert.equal(await tabs.tabById(42), null);
    assert.deepEqual(await tabs.waitForLoad(42), { ok: false, reason: 'the tab was closed while it was loading' });
    const injected = await tabs.inject(42);
    assert.equal(injected.ok, false);
    assert.match(injected.reason, /No tab with id/);
    const moved = await tabs.navigate(42, 'https://www.instagram.com/sara/');
    assert.equal(moved.ok, false);
    assert.match(moved.reason, /could not be moved/);
  });

  test('a discarded tab is reported rather than throwing out of the dashboard', async () => {
    const fake = fakeChrome({ tabs: [{ id: 5, url: 'https://www.instagram.com/sara/' }], failUpdate: true });
    const tabs = createTabController({ chromeApi: fake.chromeApi, sleep: async () => {}, now: () => 0 });
    const moved = await tabs.navigate(5, 'https://www.instagram.com/omar/');
    assert.equal(moved.ok, false);
    assert.match(moved.reason, /the tab could not be moved \(The tab was discarded\)/);
  });

  test('the content script is injected into a tab that predates the extension', async () => {
    const fake = fakeChrome({ tabs: [{ id: 5, url: 'https://www.instagram.com/sara/' }] });
    const tabs = createTabController({ chromeApi: fake.chromeApi, sleep: async () => {}, now: () => 0 });
    assert.deepEqual(await tabs.inject(5), { ok: true });
    assert.deepEqual(fake.calls.find((call) => call[0] === 'inject'), ['inject', 5, ['content/content.js']]);
  });

  test('closing the worker forgets it', async () => {
    const fake = fakeChrome();
    const tabs = createTabController({ chromeApi: fake.chromeApi, sleep: async () => {}, now: () => 0 });
    await tabs.ensureWorker({});
    assert.deepEqual(await tabs.closeWorker(), { closed: true });
    assert.equal(fake.store.get(WORKER_WINDOW_KEY), null);
    assert.deepEqual(await tabs.closeWorker(), { closed: false });
    assert.equal(await tabs.worker(), null);
  });

  test('a controller without chrome.tabs says so instead of failing later', () => {
    assert.throws(() => createTabController({ chromeApi: {} }), /chrome\.tabs is unavailable/);
  });
});

describe('the command channel', () => {
  function channel({ results = {}, storage = null, autoLoad = true } = {}) {
    const fake = fakeChrome({ tabs: [{ id: 7, url: 'https://www.instagram.com/sara/', status: 'complete' }], autoLoad });
    const posted = [];
    const statuses = [];
    let t = 0;
    /**
     * A fake mailbox that speaks the real contract.
     *
     * `postCommand` resolves to `{ ok, reason, severity, result, commandId,
     * elapsedMs }` where `result` is the handler's VALUE — the row's own ok and
     * reason are lifted out of it. Fixtures here are written the way a handler
     * answers and translated exactly the way storage/bridge.js does, so the fake
     * cannot drift into a shape the real bridge never returns. A mailbox-level
     * failure (a timeout, a withdrawn command) is written as `{ envelope: ... }`.
     */
    const bridgeFor = (workspaceId) => ({
      postCommand: async (type, payload, options) => {
        posted.push({ workspaceId, type, payload, options });
        const fixture = results[type] ?? { ok: true, value: { pong: true } };
        const answer = typeof fixture === 'function' ? fixture({ type, payload, options, posted }) : fixture;
        if (answer?.envelope) return { commandId: 'cmd_1', elapsedMs: 0, severity: null, ...answer.envelope };
        const refused = answer?.ok === false;
        return {
          ok: !refused,
          reason: refused ? (answer.reason ?? 'the tab refused the command') : null,
          severity: refused ? (answer.severity ?? null) : null,
          result: refused ? (answer.value ?? answer) : (answer?.value ?? null),
          commandId: answer?.commandId ?? 'cmd_1',
          elapsedMs: answer?.elapsedMs ?? 4,
        };
      },
      postStop: async (reason) => {
        posted.push({ workspaceId, type: 'STOP', payload: { reason } });
        return { ok: true, reason: null, severity: null, result: { stopped: true }, commandId: 'cmd_stop', elapsedMs: 2 };
      },
      waitForStatus: async ({ newerThan }) => {
        const next = statuses.find((row) => Number(row.at) > newerThan);
        return next ?? null;
      },
      workspaceId,
    });
    const state = { workspaceId: BOOTSTRAP_WORKSPACE_ID };
    const tabs = createTabController({ chromeApi: fake.chromeApi, sleep: async (ms) => { t += ms; }, now: () => t });
    const adapter = storage ?? memoryStorage();
    // The watch loop polls until it is disposed, so sleep has to yield to the
    // real event loop as well as advance the virtual clock: a sleep that returns
    // immediately turns the loop into a hot spin that starves every other timer.
    const yieldSleep = async (ms) => { t += ms; await new Promise((resolve) => setImmediate(resolve)); };
    const commands = createCommandChannel({ storage: adapter, tabs, state, bridgeFor, now: () => t, sleep: yieldSleep });
    return { commands, posted, statuses, state, adapter, tabs, fake, clock: () => t };
  }

  test('a workspace switch is written where the content script reads it', async () => {
    const { commands, adapter, state } = channel();
    await commands.setWorkspace('77', { viewerUsername: 'me' });
    assert.equal(state.workspaceId, '77');
    assert.deepEqual(await adapter.get(ACTIVE_WORKSPACE_KEY), { workspaceId: '77', at: 0, viewerUsername: 'me' });
    assert.equal(await commands.rememberedWorkspace(), '77');
  });

  test('preparing a tab loads it, injects the script and waits for an answer', async () => {
    const { commands, posted, fake } = channel();
    const ready = await commands.prepare(7);
    assert.equal(ready.ok, true);
    assert.equal(ready.context.pong, true);
    assert.ok(fake.calls.some((call) => call[0] === 'inject' && call[1] === 7));
    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, CommandType.PING);
  });

  test('a tab that never answers the ping is reported after four tries', async () => {
    const { commands, posted, clock } = channel({ results: { PING: { envelope: { ok: false, reason: 'this tab cannot handle PING', result: null, elapsedMs: 3 } } } });
    const ready = await commands.prepare(7);
    assert.equal(ready.ok, false);
    assert.match(ready.reason, /nothing answered/);
    assert.equal(posted.length, 4, 'the loader is asynchronous, so the first ping may legitimately find nobody');
    assert.equal(clock() >= 1200, true);
  });

  test('send refuses before posting when the tab is gone', async () => {
    const { commands, posted } = channel();
    const result = await commands.send(CommandType.COLLECT_LEADS, { source: 'followers' }, { tabId: 42 });
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'tab');
    assert.match(result.reason, /closed/);
    assert.equal(posted.length, 0, 'nothing is posted to a tab that is not there');
  });

  test('a command answer is unwrapped into ok, value and severity', async () => {
    const { commands } = channel({
      results: { COLLECT_LEADS: { ok: true, value: { leads: [1, 2, 3] }, elapsedMs: 900, commandId: 'cmd_9' } },
    });
    const result = await commands.send(CommandType.COLLECT_LEADS, { source: 'followers' }, { tabId: 7 });
    assert.deepEqual(result, {
      ok: true,
      reason: null,
      raw: null,
      value: { leads: [1, 2, 3] },
      severity: null,
      elapsedMs: 900,
      commandId: 'cmd_9',
      timedOut: false,
    });
  });

  test('a refusal from the tab keeps its own reason and severity', async () => {
    const { commands } = channel({
      results: { EXECUTE_FOLLOW: { ok: false, reason: 'Instagram blocked the follow', severity: 'account', value: null, elapsedMs: 12 } },
    });
    const result = await commands.send(CommandType.EXECUTE_FOLLOW, { username: 'sara' }, { tabId: 7 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'Instagram blocked the follow');
    assert.equal(result.severity, 'account');
  });

  test('a mailbox timeout is distinguished from a refusal by the tab', async () => {
    const { commands } = channel({
      results: {
        // The bridge itself gives up, not the tab: the whole envelope comes back.
        PING: {
          envelope: {
            ok: false,
            reason: 'no reply within 8s — the Instagram tab may be closed, asleep, or not on instagram.com',
            severity: 'tab',
            result: null,
            commandId: 'cmd_to',
            elapsedMs: 8000,
            timedOut: true,
          },
        },
      },
    });
    const result = await commands.send(CommandType.PING, {}, { tabId: 7, allowUnprepared: true });
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'tab');
    assert.match(result.reason, /stopped answering a PING command after 8s/);
    assert.equal(result.commandId, 'cmd_to');
    assert.equal(result.value, null);
    assert.match(result.raw, /no reply within 8s/);
  });

  test('a command that needs the tab moved is moved and sent once more', async () => {
    const { commands, posted, fake } = channel({
      results: {
        EXECUTE_FOLLOW: ({ posted: seen }) => (seen.filter((entry) => entry.type === 'EXECUTE_FOLLOW').length === 1
          ? { ok: false, reason: 'this tab is showing a different profile', value: { needsNavigation: true, url: 'https://www.instagram.com/omar/' }, elapsedMs: 3 }
          : { ok: true, value: { state: 'following' }, elapsedMs: 9 }),
      },
    });
    const result = await commands.sendWithNavigation(CommandType.EXECUTE_FOLLOW, { username: 'omar' }, { tabId: 7 });
    assert.equal(result.ok, true);
    assert.equal(result.navigated, true);
    assert.match(result.firstReason, /different profile/);
    assert.equal(fake.tabMap.get(7).url, 'https://www.instagram.com/omar/');
    assert.equal(posted.filter((entry) => entry.type === 'EXECUTE_FOLLOW').length, 2, 'one retry, never a loop');
  });

  test('a move that fails is reported with both reasons', async () => {
    const { commands, tabs } = channel({
      results: { EXECUTE_DM: { ok: false, reason: 'wrong profile', value: { needsNavigation: true, url: 'https://www.instagram.com/omar/' } } },
    });
    // The tab is there, but Chrome refuses to move it (discarded or crashed).
    tabs.navigate = async () => ({ ok: false, reason: 'the tab could not be moved (The tab was discarded)' });
    const result = await commands.sendWithNavigation(CommandType.EXECUTE_DM, {}, { tabId: 7 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /wrong profile — and the tab could not be moved there/);
    assert.match(result.reason, /discarded/);
  });

  test('stop is answered even when nothing is running', async () => {
    const { commands } = channel();
    assert.deepEqual(await commands.stop('owner pressed stop'), { ok: true, reason: null, value: { stopped: true } });
  });

  test('status rows are delivered once each, in order', async () => {
    const { commands, statuses } = channel();
    const seen = [];
    statuses.push({ at: 1, type: 'pacing', waitMs: 3000 }, { at: 2, phase: 'followers', total: 12 });
    const watcher = commands.watch((row) => seen.push(row), { intervalMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    statuses.push({ at: 3, kind: 'run-end', ok: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    watcher.dispose();
    const count = seen.length;
    assert.deepEqual(seen.slice(0, 3).map((row) => row.at), [1, 2, 3]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(seen.length, count, 'a disposed watcher stops delivering');
  });

  test('a throwing listener does not kill the watch', async () => {
    const { commands, statuses } = channel();
    const seen = [];
    statuses.push({ at: 1 }, { at: 2 });
    const watcher = commands.watch((row) => { if (row.at === 1) throw new Error('listener bug'); seen.push(row.at); }, { intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    watcher.dispose();
    assert.deepEqual(seen, [2]);
  });

  test('a remembered workspace is verified against the tab before it is trusted', async () => {
    const storage = memoryStorage({ [ACTIVE_WORKSPACE_KEY]: { workspaceId: '77', at: 1 } });
    const { commands, posted } = channel({
      storage,
      results: {
        GET_CONTEXT: { ok: true, value: { viewer: { id: '77', username: 'me' } } },
      },
    });
    const resolved = await commands.resolveWorkspace({ tabId: 7 });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.workspaceId, '77');
    assert.equal(resolved.remembered, true);
    assert.equal(resolved.viewer.username, 'me');
    assert.ok(posted.some((entry) => entry.type === CommandType.GET_CONTEXT));
  });

  test('an account switch under the dashboard forces a re-probe', async () => {
    const storage = memoryStorage({ [ACTIVE_WORKSPACE_KEY]: { workspaceId: '77', at: 1 } });
    const { commands, posted, state } = channel({
      storage,
      results: {
        GET_CONTEXT: { ok: true, value: { viewer: { id: '88', username: 'other_account' } } },
        PROBE: { ok: true, value: { viewer: { id: '88', username: 'other_account', followers: 10, following: 5 }, session: { loggedIn: true } } },
      },
    });
    const resolved = await commands.resolveWorkspace({ tabId: 7 });
    assert.equal(resolved.workspaceId, '88', 'two accounts must never share one table');
    assert.equal(resolved.remembered, false);
    assert.equal(state.workspaceId, '88');
    assert.deepEqual(await storage.get(ACTIVE_WORKSPACE_KEY), { workspaceId: '88', at: 0, viewerUsername: 'other_account' });
    assert.ok(posted.some((entry) => entry.type === CommandType.PROBE));
  });

  test('a logged-out tab is told apart from a tab that will not answer', async () => {
    const { commands } = channel({ results: { PROBE: { ok: true, value: { viewer: null, session: { loggedIn: false } } } } });
    const resolved = await commands.resolveWorkspace({ force: true, tabId: 7 });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.reason, 'this tab is not logged in to Instagram');
    assert.equal(resolved.workspaceId, BOOTSTRAP_WORKSPACE_ID);
  });

  test('a probe with no viewer asks for a reload rather than guessing an id', async () => {
    const { commands } = channel({ results: { PROBE: { ok: true, value: { viewer: null, session: { loggedIn: true } } } } });
    const resolved = await commands.resolveWorkspace({ force: true, tabId: 7 });
    assert.equal(resolved.ok, false);
    assert.match(resolved.reason, /did not say which account/);
  });
});

describe('the ledger', () => {
  let fake;
  let ledger;
  let state;
  const NOW = new Date(2026, 0, 7, 12, 0, 0).getTime();

  before(() => {
    fake = installFakeIndexedDB();
    state = { workspaceId: '7' };
    ledger = createLedger({ state, now: () => NOW });
  });

  after(() => {
    fake.uninstall();
    resetDb();
  });

  test('a workspace is created once and then only updated', async () => {
    const created = await ledger.ensureWorkspace({ workspaceId: '7', viewerUsername: 'me', viewer: { followers: 120, following: 40 } });
    assert.equal(created.created, true);
    assert.equal(created.workspaceId, '7');
    assert.equal(created.viewerUsername, 'me');
    assert.ok(created.governorState, 'a new workspace starts with a governor, not with undefined');

    const again = await ledger.ensureWorkspace({ workspaceId: '7', viewerUsername: 'me', viewer: { followers: 130, following: 41 } });
    assert.equal(again.created, false);
    assert.equal(again.viewerFollowers, 130);
    assert.equal(state.workspaceId, '7');
  });

  test('a collection is saved into the library and into its bucket', async () => {
    const result = {
      pages: 2,
      leads: [
        {
          lead: { username: 'sara_shop', fullName: 'Sara', priorityScore: 82, warmthTier: 'hot', followers: 900, workspaceId: '7' },
          edges: [{ edgeType: 'LIKED_POST', sourceAccount: 'comp_a', refId: 'Cx9', sample: null }],
        },
        {
          lead: { username: 'omar_craft', fullName: 'Omar', priorityScore: 40, warmthTier: 'warm', workspaceId: '7' },
          edges: [{ edgeType: 'LIKED_POST', sourceAccount: 'comp_a', refId: 'Cx9' }],
        },
      ],
    };
    const saved = await ledger.saveCollected({ result, groupName: 'Linen suppliers' });
    assert.deepEqual(saved, { ok: true, saved: 2, updated: 0, edges: 2, groupId: saved.groupId, runId: null, total: 2 });
    assert.match(saved.groupId, /^grp_/);

    const groups = await ledger.groups();
    assert.deepEqual(groups.map((group) => group.name), ['Default', 'Linen suppliers']);
    const sara = await getLead('7:sara_shop');
    assert.equal(sara.priorityScore, 82);
    assert.equal(sara.warmthTier, 'hot');
    assert.deepEqual(sara.groupIds, [saved.groupId]);
    assert.equal(sara.relState, 'NONE');
    assert.equal(sara.followedViaExtension, false);
    assert.equal(sara.firstSeenAt > 0, true);
  });

  test('saving the same people again updates the evidence and keeps the funnel', async () => {
    const sara = await getLead('7:sara_shop');
    await upsertLead({ ...sara, relState: RelState.FOLLOWING, followedAt: 555, followedViaExtension: true, isWhitelisted: true });

    const linenGroup = (await ledger.groups()).find((g) => g.name === 'Linen suppliers');
    const saved = await ledger.saveCollected({
      result: { leads: [{ lead: { username: 'SARA_SHOP', priorityScore: 95, workspaceId: '7' }, edges: [{ edgeType: 'COMMENTED_POST', sourceAccount: 'comp_a', refId: 'Cx9' }] }] },
      groupId: linenGroup.groupId,
    });
    assert.deepEqual({ saved: saved.saved, updated: saved.updated, edges: saved.edges }, { saved: 0, updated: 1, edges: 1 });

    const merged = await getLead('7:sara_shop');
    assert.equal(merged.priorityScore, 95, 'the new score wins');
    assert.equal(merged.relState, RelState.FOLLOWING, 'the funnel is untouched');
    assert.equal(merged.followedAt, 555);
    assert.equal(merged.followedViaExtension, true);
    assert.equal(merged.isWhitelisted, true);
    assert.equal(merged.firstSeenAt, sara.firstSeenAt, 'first seen stays first seen');
    assert.equal(merged.groupIds.length, 1, 'the same bucket is not added twice');
  });

  test('a verified follow moves the lead, the log and the day budget together', async () => {
    await upsertLead(leadRecord({ workspaceId: '7', username: 'omar_craft' }, { priorityScore: 40 }));
    const applied = await ledger.applyOutcome({
      leadKey: '7:omar_craft',
      actionType: ActionType.FOLLOW,
      result: { ok: true, outcome: 'done', state: 'following' },
      sessionId: 'ses_1',
      at: NOW,
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.lead.relState, RelState.FOLLOWING);
    assert.equal(applied.lead.followedViaExtension, true);
    assert.equal(applied.flagged, false);

    const stored = await getLead('7:omar_craft');
    assert.equal(stored.relState, RelState.FOLLOWING);
    assert.equal(stored.followedAt, NOW);

    const log = await listActions('7', { actionType: ActionType.FOLLOW });
    assert.equal(log.length, 1);
    assert.equal(log[0].verifiedOk, true);
    assert.equal(log[0].usernameSnapshot, 'omar_craft');
    assert.equal(log[0].sessionId, 'ses_1');
    assert.equal(log[0].timestamp, NOW);

    const counters = await ledger.counters();
    assert.equal(counters.daily.follows, 1);
    assert.equal(counters.daily.combined, 1);
  });

  test('an unverified click is logged but spends no budget', async () => {
    await upsertLead(leadRecord({ workspaceId: '7', username: 'nada_studio' }));
    const applied = await ledger.applyOutcome({
      leadKey: '7:nada_studio',
      actionType: ActionType.FOLLOW,
      result: { ok: false, outcome: 'not_done', reason: 'the button never settled' },
      at: NOW,
    });
    assert.equal(applied.ok, false);
    assert.equal((await getLead('7:nada_studio')).relState, RelState.NONE);
    assert.equal((await getLead('7:nada_studio')).attempts, 1);
    const counters = await ledger.counters();
    assert.equal(counters.daily.follows, 1, 'the verified follow above is the only one counted');
    const log = await listActions('7', { actionType: ActionType.FOLLOW });
    assert.equal(log.length, 2);
    // Both entries share a timestamp in this test, so pick by person rather than
    // by position: ordering is the log's job, not the assertion's guess.
    const failed = log.find((entry) => entry.usernameSnapshot === 'nada_studio');
    assert.equal(failed.verifiedOk, false);
    assert.equal(failed.detail, 'the button never settled');
    assert.equal(failed.outcome, 'not_done');
    assert.equal(log.find((entry) => entry.usernameSnapshot === 'omar_craft').verifiedOk, true);
  });

  test('an action block locks the account, and the lock is persisted', async () => {
    await upsertLead(leadRecord({ workspaceId: '7', username: 'blocked_one' }));
    const applied = await ledger.applyOutcome({
      leadKey: '7:blocked_one',
      actionType: ActionType.FOLLOW,
      result: { ok: false, outcome: 'stopped', reason: 'Instagram blocked the follow ("Try Again Later")' },
      severity: 'account',
      at: NOW,
    });
    assert.equal(applied.flagged, true);
    assert.equal(applied.outcome.stopRun, true);
    const workspace = await getWorkspace('7');
    assert.ok(workspace.governorState.lockedUntil > NOW, 'the lock outlives the action');
    assert.match(workspace.governorState.lockReason, /blocked the follow/);
    const overview = await ledger.workspace();
    assert.equal(overview.governorState.lockedUntil, workspace.governorState.lockedUntil);
  });

  test('a message outcome is recorded against the same lead and log', async () => {
    await upsertLead(leadRecord({ workspaceId: '7', username: 'sara_shop' }, { relState: RelState.MUTUAL }));
    const applied = await ledger.applyOutcome({
      leadKey: '7:sara_shop',
      actionType: ActionType.DM_WARM,
      result: { ok: true, outcome: 'done' },
      at: NOW,
    });
    assert.equal(applied.lead.dmState, 'DM_SENT_PRIMARY');
    assert.equal(applied.lead.relState, RelState.MUTUAL);
    const counters = await ledger.counters();
    assert.equal(counters.daily.warmDms, 1);
    assert.equal((await getLead('7:sara_shop')).messagedAt, NOW);
  });

  test('an outcome for a lead that is not in this workspace is refused', async () => {
    const applied = await ledger.applyOutcome({ leadKey: '7:ghost', actionType: ActionType.FOLLOW, result: { ok: true, outcome: 'done' } });
    assert.equal(applied.ok, false);
    assert.match(applied.reason, /no lead 7:ghost/);
  });

  test('sessions record what a run planned, did and why it ended', async () => {
    const session = await ledger.startSession({ mode: 'FOLLOW', groupId: 'grp_a', tabId: 7, policy: { mutualOnly: true }, planned: 24 });
    assert.equal(session.status, 'running');
    assert.equal(session.planned, 24);
    const bumped = await ledger.bumpSession(session.sessionId, { counts: { attempted: 5, done: 4, refused: 1 }, lastActionAt: NOW });
    assert.equal(bumped.counts.done, 4);
    assert.equal(bumped.counts.failed, 0);
    const ended = await ledger.endSession(session.sessionId, { status: 'stopped', reason: 'owner pressed stop' });
    assert.equal(ended.status, 'stopped');
    assert.equal(ended.endedAt, NOW);
    assert.equal(ended.reason, 'owner pressed stop');
    const rows = await ledger.sessions({ mode: 'FOLLOW' });
    assert.equal(rows.length, 1);
  });

  test('a collection run is opened, then closed with its counts', async () => {
    const run = await ledger.startRun({ source: 'post_likers', sourceAccount: 'comp_a', tabId: 7, runId: 'run_x' });
    assert.equal(run.status, 'running');
    const finished = await ledger.finishRun('run_x', { status: 'done', counts: { leads: 12, edges: 12, pages: 1 } });
    assert.equal(finished.counts.leads, 12);
    assert.equal((await ledger.runs())[0].runId, 'run_x');
  });
});

describe('the composed client', () => {
  let fake;

  before(() => { fake = installFakeIndexedDB(); });
  after(() => { fake.uninstall(); resetDb(); });

  test('one client holds the workspace, the tabs and the overview', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 7, url: 'https://www.instagram.com/sara/' }] });
    chrome.store.set(ACTIVE_WORKSPACE_KEY, { workspaceId: '7', at: 1 });
    const client = createApiClient({ chromeApi: chrome.chromeApi, workspaceId: '7', now: () => Date.now() });
    assert.equal(client.workspaceId, '7');
    assert.equal(typeof client.send, 'function');
    assert.equal(typeof client.saveCollected, 'function');
    assert.equal(client.bridge().workspaceId, '7');

    await client.ensureWorkspace({ workspaceId: '7', viewerUsername: 'me', viewer: { followers: 900, following: 300 } });
    await client.createGroup({ name: 'Warm' });
    await client.saveCollected({ result: { leads: [{ lead: { username: 'sara', priorityScore: 10, workspaceId: '7' }, edges: [] }] } });

    const overview = await client.overview();
    assert.equal(overview.workspaceId, '7');
    assert.equal(overview.viewerUsername, 'me');
    assert.equal(overview.followers, 900);
    assert.deepEqual(overview.groups.map((g) => g.name), ['Default', 'Warm']);
    assert.equal(overview.enabledTemplates, 0);
    assert.equal(overview.counters.daily.follows, 0);
    assert.equal(overview.lockedUntil, null, 'a lock that was never tripped is not "locked until 1970"');

    // An account flag locks everything, and the top bar has to say so.
    await client.applyOutcome({
      leadKey: '7:sara',
      actionType: ActionType.FOLLOW,
      result: { ok: false, outcome: 'stopped', reason: 'Instagram blocked the follow' },
      severity: 'account',
    });
    const locked = await client.overview();
    assert.ok(locked.lockedUntil > Date.now());
    assert.match(locked.lockReason, /blocked the follow/);
    assert.equal(locked.counters.daily.follows, 0, 'a blocked action spends no budget');
  });

  test('switching workspace switches the mailbox with it', async () => {
    const chrome = fakeChrome();
    const client = createApiClient({ chromeApi: chrome.chromeApi, now: () => 0 });
    assert.equal(client.workspaceId, BOOTSTRAP_WORKSPACE_ID);
    const first = client.bridge();
    await client.setWorkspace('88');
    assert.equal(client.workspaceId, '88');
    assert.notEqual(client.bridge(), first, 'a new workspace is a new mailbox, not a reused key');
    assert.deepEqual(chrome.store.get(ACTIVE_WORKSPACE_KEY), { workspaceId: '88', at: 0 });
  });
});
