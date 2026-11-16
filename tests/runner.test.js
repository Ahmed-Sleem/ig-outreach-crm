import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import { createLedger } from '../src/app/lib/api.js';
import {
  COUNTDOWN_EVERY_MS,
  MAX_CONSECUTIVE_FAILURES,
  RunPhase,
  TEMPLATE_MEMORY,
  budgetFor,
  budgetLineFor,
  chooseMessage,
  commandFor,
  countBucketFor,
  createRunController,
  messageContextFor,
  messagePreview,
  planOutreach,
  resultFromAnswer,
} from '../src/app/lib/runner.js';
import { ActionType, initialGovernorState, recordAction } from '../src/core/governor.js';
import { QueueMode } from '../src/core/queue.js';
import { RelState } from '../src/core/lifecycle.js';
import { CommandType } from '../src/storage/bridge.js';
import { EntropyPoolRNG } from '../src/core/random.js';
import { clampSafetySettings } from '../src/storage/settings.js';
import {
  clearAll,
  getLead,
  getWorkspace,
  leadRecord,
  listActions,
  listOutreachSessions,
  listScrapeRuns,
  putTemplate,
  putWorkspace,
  resetDb,
  templateRecord,
  upsertLead,
} from '../src/storage/db.js';

/** Inside the default active window (09:30-22:30 local), so the gate is open. */
const NOW = new Date(2026, 0, 7, 12, 0, 0).getTime();
const WS = '77';

function seededRng(seed = [11, 22, 33, 44]) {
  return new EntropyPoolRNG({ seed, clock: () => NOW, microClock: () => 1, randomWords: () => new Uint32Array(seed) });
}

/* --------------------------------------------------------------------- harness */

/**
 * A fake api client that is only half fake.
 *
 * The ledger is the real one over the fake IndexedDB, so a run's writes are the
 * writes production makes: real lead rows, real action log, real governor
 * counters, real session records. Only the channel — the part that would talk to
 * an Instagram tab — is scripted, because that is the part with no logic of its
 * own to test twice.
 */
function makeApi({ now, sleep, clock, answers = {}, tabs = null, settings = null, workspaceId = WS } = {}) {
  const state = { workspaceId };
  const ledger = createLedger({ state, now });
  const sent = [];
  const stops = [];
  const statuses = [];
  const sessions = [];
  // An array, not a counter: `{ ...channel }` in the return below evaluates a
  // getter once and freezes it, so a live count has to travel by reference.
  const disposals = [];

  const defaultAnswer = (type) => {
    if (type === CommandType.COLLECT_LEADS) {
      return { ok: true, value: { ok: true, leads: [], scored: [], edges: [], pages: 1, sourceAccount: 'comp_a' }, elapsedMs: 20 };
    }
    return { ok: true, value: { ok: true, outcome: 'done', state: 'following' }, elapsedMs: 30 };
  };

  const channel = {
    workspaceId,
    state,
    sent,
    stops,
    statuses,
    sessions,
    disposals,

    settings: async () => settings ?? clampSafetySettings({}).settings,

    async sendWithNavigation(type, payload = {}, options = {}) {
      sent.push({ type, payload, options });
      const script = answers[type];
      const answer = typeof script === 'function'
        ? script({ type, payload, options, sent, ledger, state })
        : (script ?? defaultAnswer(type));
      return { severity: null, elapsedMs: 10, commandId: `cmd_${sent.length}`, ...answer };
    },

    async stop(reason) { stops.push(reason); return { ok: true, reason: null, value: { stopped: true } }; },

    watch(onStatus) {
      return {
        dispose() { disposals.push(1); },
        push(row) { statuses.push(row); onStatus(row); },
      };
    },

    tabs: tabs ?? {
      async tabById(id) { return id === 7 ? { id: 7, url: 'https://www.instagram.com/sara_shop/' } : null; },
      async listTabs() { return [{ id: 7, url: 'https://www.instagram.com/sara_shop/', active: true }]; },
      async worker() { return { id: 7, url: 'https://www.instagram.com/' }; },
      async ensureWorker() { return { tab: { id: 7, url: 'https://www.instagram.com/' }, created: false }; },
      async navigate() { return { ok: true }; },
    },
  };

  return { ...ledger, ...channel };
}

function makeController(options = {}) {
  const clock = { t: options.start ?? NOW };
  const events = [];
  const now = () => clock.t;
  // Advance the virtual clock AND yield: a wait that only moved a number would
  // spin hot and starve the very loop it is inside.
  const sleep = async (ms) => { clock.t += ms; await new Promise(setImmediate); };
  const api = makeApi({ now, sleep, clock, ...options });
  const controller = createRunController({
    api,
    now,
    sleep,
    rng: options.rng ?? seededRng(),
    onEvent: (event) => events.push(event),
  });
  return { controller, api, events, clock, now, sleep, state: controller.state };
}

async function seedWorkspace(patch = {}) {
  await putWorkspace({
    workspaceId: WS,
    viewerUsername: 'my_shop',
    viewerFollowers: 900,
    viewerFollowing: 300,
    governorState: initialGovernorState(),
    ...patch,
  });
}

async function seedLead(username, patch = {}) {
  await upsertLead(leadRecord({ workspaceId: WS, username }, patch));
  return `${WS}:${username.toLowerCase()}`;
}

describe('the budget readout', () => {
  test('caps are shown after the warm-up factor, not before it', () => {
    const budget = budgetFor(initialGovernorState(), { settings: clampSafetySettings({}).settings, now: NOW, workspaceKey: WS });
    // Day 1 of the ramp is 40% of the configured 50 follows a day.
    assert.equal(budget.warmupDay, 1);
    assert.equal(budget.warmupFactor, 0.4);
    assert.equal(budget.follow.dailyCap, 20);
    assert.equal(budget.follow.remainingToday, 20);
    assert.equal(budget.follow.hourlyCap, 10, 'the hourly cap is not ramped: it is the short-term brake');
    assert.equal(budget.combinedRemainingToday, 30);
    assert.equal(budget.lockedUntil, null);
  });

  test('what has been spent today is what is missing from the budget', () => {
    let governor = initialGovernorState();
    for (let index = 0; index < 7; index += 1) governor = recordAction(governor, ActionType.FOLLOW, new Date(NOW));
    const budget = budgetFor(governor, { settings: clampSafetySettings({}).settings, now: NOW, workspaceKey: WS });
    assert.equal(budget.follow.used.daily, 7);
    assert.equal(budget.follow.remainingToday, 13);
    assert.equal(budget.follow.remainingThisHour, 3);
    assert.equal(budget.combinedRemainingToday, 23);
    assert.equal(budgetLineFor(ActionType.FOLLOW, budget).used.daily, 7);
    assert.equal(budgetLineFor(ActionType.DM_WARM, budget).dailyCap, 10);
    assert.equal(budgetLineFor('NOPE', budget), null);
  });

  test('a lock in the past is not a lock, and a live one is reported with its reason', () => {
    const settings = clampSafetySettings({}).settings;
    const expired = budgetFor({ ...initialGovernorState(), lockedUntil: NOW - 1000, lockReason: 'old news' }, { settings, now: NOW, workspaceKey: WS });
    assert.equal(expired.lockedUntil, null);
    assert.equal(expired.lockReason, null);

    const live = budgetFor({ ...initialGovernorState(), lockedUntil: NOW + 3600_000, lockReason: 'Instagram blocked a follow' }, { settings, now: NOW, workspaceKey: WS });
    assert.equal(live.lockedUntil, NOW + 3600_000);
    assert.match(live.lockReason, /blocked a follow/);
  });

  test('a closed window says when it opens', () => {
    const lateNight = new Date(2026, 0, 7, 3, 0, 0).getTime();
    const budget = budgetFor(initialGovernorState(), { settings: clampSafetySettings({}).settings, now: lateNight, workspaceKey: WS });
    assert.equal(budget.scheduleOpen, false);
    assert.ok(budget.windowOpensAt > lateNight);
    assert.equal(new Date(budget.windowOpensAt).getHours() >= 9, true);
  });
});

describe('message choice', () => {
  const pool = [
    { templateId: 't1', body: 'Hi {{first_name|there}}, {loved|liked} your {linen|cotton} work.', enabled: true },
    { templateId: 't2', body: 'Salam {{first_name|friend}} — the {studio|workshop} shots are {great|lovely}.', enabled: true },
    { templateId: 't3', body: 'Hey, {beautiful|stunning} {pieces|fabrics}. Do you {ship|deliver} to Cairo?', enabled: true },
    { templateId: 't4', body: 'disabled one', enabled: false },
  ];

  test('a person is greeted by name, a business is not', () => {
    assert.deepEqual(
      messageContextFor({ username: '@sara_shop', fullName: 'Sara Adel' }, { viewerUsername: '@my_shop' }),
      { username: 'sara_shop', full_name: 'Sara Adel', first_name: 'Sara', account: 'my_shop' },
    );
    const business = messageContextFor({ username: 'linen_export', fullName: 'Cairo Linen Export Co.' });
    assert.equal(business.first_name, '', 'a company name is not a first name');
    assert.equal(business.username, 'linen_export');
  });

  test('one of the enabled templates is chosen and rendered', () => {
    const chosen = chooseMessage({ templates: pool, lead: { username: 'sara_shop', fullName: 'Sara Adel' }, rng: seededRng() });
    assert.equal(chosen.ok, true);
    assert.ok(chosen.message.length > 10);
    assert.ok(!chosen.message.includes('{{'), 'no variable survived into the message');
    assert.ok(!chosen.message.includes('{'), 'no spintax branch survived into the message');
    assert.ok(chosen.bytes > 0 && chosen.bytes <= 1000);
    assert.ok(['t1', 't2', 't3'].includes(chosen.templateId));
  });

  test('a disabled or empty pool is refused rather than improvised', () => {
    assert.match(chooseMessage({ templates: [], rng: seededRng() }).reason, /no enabled message template/);
    assert.match(chooseMessage({ templates: [{ templateId: 'x', body: '   ', enabled: true }], rng: seededRng() }).reason, /no enabled message template/);
    assert.match(chooseMessage({ templates: [{ templateId: 'x', body: 'hi', enabled: false }], rng: seededRng() }).reason, /no enabled message template/);
    assert.match(chooseMessage({ templates: pool }).reason, /no random engine/);
  });

  test('a render over the byte limit is refused, not truncated', () => {
    const huge = { templateId: 'big', body: 'x'.repeat(1200), enabled: true };
    const out = chooseMessage({ templates: [huge], lead: { username: 'a' }, rng: seededRng() });
    assert.equal(out.ok, false);
    assert.match(out.reason, /over the 1000-byte limit/);
  });

  test('the same template does not go out twice in a row while others remain', () => {
    // A pool bigger than the anti-streak window, so an unused template always
    // exists and the "no repeat while alternatives remain" guarantee is real.
    const wide = [
      { templateId: 'w1', body: 'One {great|lovely} studio.', enabled: true },
      { templateId: 'w2', body: 'Two {fine|sharp} pieces.', enabled: true },
      { templateId: 'w3', body: 'Three {soft|smooth} fabrics.', enabled: true },
      { templateId: 'w4', body: 'Four {bold|bright} colours.', enabled: true },
      { templateId: 'w5', body: 'Five {calm|clean} shots.', enabled: true },
      { templateId: 'w6', body: 'disabled', enabled: false },
    ];
    const rng = seededRng([3, 9, 27, 81]);
    const recent = [];
    const seen = [];
    for (let index = 0; index < 24; index += 1) {
      const chosen = chooseMessage({ templates: wide, lead: { username: `u${index}`, fullName: `Person ${index}` }, rng, recent });
      assert.equal(chosen.ok, true);
      seen.push(chosen.templateId);
      recent.push(chosen.templateId);
      while (recent.length > TEMPLATE_MEMORY) recent.shift();
    }
    assert.equal(new Set(seen).size, 5, 'the whole enabled pool gets used');
    assert.ok(!seen.includes('w6'), 'a disabled template is never sent');
    for (let index = TEMPLATE_MEMORY; index < seen.length; index += 1) {
      const window = seen.slice(index - TEMPLATE_MEMORY, index);
      assert.equal(window.includes(seen[index]), false, `template ${seen[index]} repeated inside the anti-streak window at ${index}`);
    }
  });

  test('a preview is one line and bounded', () => {
    assert.equal(messagePreview('  hi\n  there  '), 'hi there');
    assert.equal(messagePreview('x'.repeat(200)).length, 90);
    assert.equal(messagePreview('x'.repeat(200)).endsWith('…'), true);
    assert.equal(messagePreview(null), '');
  });
});

describe('command and counter mapping', () => {
  test('each governor action has exactly one mailbox command', () => {
    assert.equal(commandFor(ActionType.FOLLOW), CommandType.EXECUTE_FOLLOW);
    assert.equal(commandFor(ActionType.UNFOLLOW), CommandType.EXECUTE_UNFOLLOW);
    assert.equal(commandFor(ActionType.DM_WARM), CommandType.EXECUTE_DM);
    assert.equal(commandFor(ActionType.DM_COLD), CommandType.EXECUTE_DM);
    assert.equal(commandFor('SOMETHING'), null);
  });

  test('outcomes land in the session counter that describes them', () => {
    assert.equal(countBucketFor('done'), 'done');
    assert.equal(countBucketFor('skipped'), 'skipped');
    assert.equal(countBucketFor('refused'), 'refused');
    assert.equal(countBucketFor('not_done'), 'failed');
    assert.equal(countBucketFor('stopped'), 'failed');
    assert.equal(countBucketFor(undefined), 'failed');
  });

  test('an answer the tab never gave is a failure, never a success', () => {
    const lost = resultFromAnswer({ ok: false, reason: 'no reply within 90s', severity: 'tab', value: null, elapsedMs: 90_000 });
    assert.deepEqual({ ok: lost.ok, outcome: lost.outcome, severity: lost.severity }, { ok: false, outcome: 'not_done', severity: 'tab' });
    assert.match(lost.reason, /no reply within 90s/);

    const refused = resultFromAnswer({ ok: false, reason: 'Instagram blocked the follow', severity: 'account', value: { ok: false, outcome: 'stopped', reason: 'Instagram blocked the follow' } });
    assert.equal(refused.outcome, 'stopped');
    assert.equal(refused.severity, 'account');

    const done = resultFromAnswer({ ok: true, value: { ok: true, outcome: 'done', state: 'following', requested: false } });
    assert.equal(done.ok, true);
    assert.equal(done.outcome, 'done');
    assert.equal(done.state, 'following', 'the tab\'s own detail survives for the log');
  });

  test('the constants are the ones the safety story depends on', () => {
    assert.equal(MAX_CONSECUTIVE_FAILURES, 3);
    assert.ok(COUNTDOWN_EVERY_MS >= 5_000);
    assert.ok(TEMPLATE_MEMORY >= 2);
    assert.equal(RunPhase.BLOCKED, 'blocked');
  });
});

/* ------------------------------------------------------------------ run loops */

function collectResult(usernames, extra = {}) {
  return {
    ok: true,
    leads: usernames.map((username) => ({ lead: { username, fullName: username.replace(/_/g, ' ') } })),
    scored: [],
    edges: [],
    pages: 1,
    sourceAccount: 'comp_a',
    ...extra,
  };
}

describe('the run loops (real ledger, scripted tab)', () => {
  let fake;

  before(() => { fake = installFakeIndexedDB(); });
  beforeEach(async () => { await clearAll(); });
  after(() => { fake.uninstall(); resetDb(); });

  test('a collection opens a run, reads the visible tab, and closes the run as collected', async () => {
    const { controller, api, events } = makeController({
      answers: { [CommandType.COLLECT_LEADS]: { ok: true, value: collectResult(['sara_shop', 'linen_co']), elapsedMs: 20 } },
    });
    const out = await controller.collect({ source: 'followers', username: 'comp_a' });

    assert.equal(out.ok, true);
    assert.equal(out.count, 2);
    assert.equal(controller.state.phase, RunPhase.DONE);

    const runs = await listScrapeRuns(WS);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'collected');
    assert.equal(runs[0].counts.leads, 2);
    assert.equal(runs[0].sourceAccount, 'comp_a');

    // A collection runs in the tab the owner is looking at, not the worker.
    assert.equal(api.sent.length, 1);
    assert.equal(api.sent[0].type, CommandType.COLLECT_LEADS);
    assert.equal(api.sent[0].options.tabId, 7);
    assert.equal(api.sent[0].payload.limit, 200);

    assert.ok(events.some((event) => event.type === 'run'));
    assert.ok(events.some((event) => event.type === 'collected' && event.count === 2));
    assert.equal(api.disposals.length, 1, 'the status watcher is released when the collection ends');
  });

  test('a collection with nowhere to run fails before opening a run row', async () => {
    const { controller, api } = makeController({
      tabs: {
        tabById: async () => null,
        listTabs: async () => [],
        worker: async () => null,
        ensureWorker: async () => null,
        navigate: async () => ({ ok: true }),
      },
    });
    const out = await controller.collect({ source: 'followers' });

    assert.equal(out.ok, false);
    assert.match(out.reason, /no Instagram tab is open/);
    assert.equal(controller.state.phase, RunPhase.FAILED);
    assert.equal(api.sent.length, 0);
    assert.equal((await listScrapeRuns(WS)).length, 0, 'no run row is opened when there is nowhere to run');
  });

  test('a refused collection closes its run as failed, with the severity recorded', async () => {
    const { controller } = makeController({
      answers: { [CommandType.COLLECT_LEADS]: { ok: false, reason: 'Instagram is rate limiting this list', severity: 'tab', value: null } },
    });
    const out = await controller.collect({ source: 'followers', username: 'comp_a' });

    assert.equal(out.ok, false);
    assert.equal(out.phase, RunPhase.FAILED);
    assert.equal(out.severity, 'tab');
    assert.match(out.reason, /rate limiting/);

    const runs = await listScrapeRuns(WS);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'failed', 'a failed collection is not left running in the history');
    assert.equal(runs[0].severity, 'tab');
  });

  test('commit writes a previewed collection into a named bucket', async () => {
    const { controller, api } = makeController();
    const saved = await controller.commit({ result: collectResult(['sara_shop', 'linen_co']), groupName: 'Warm leads' });

    assert.equal(saved.ok, true);
    assert.equal(saved.saved, 2);
    assert.equal(saved.total, 2);
    assert.ok(saved.groupId, 'a bucket is created for the name');

    const lead = await getLead(`${WS}:sara_shop`);
    assert.ok(lead, 'the person is now in the library');
    assert.deepEqual(lead.groupIds, [saved.groupId]);

    const groups = await api.groups();
    assert.deepEqual(groups.map((g) => g.name), ['Default', 'Warm leads']);
  });

  test('discard marks the run so the history does not show a collection that vanished', async () => {
    const { controller } = makeController({
      answers: { [CommandType.COLLECT_LEADS]: { ok: true, value: collectResult(['someone']) } },
    });
    const collected = await controller.collect({ source: 'followers' });
    const out = await controller.discard({ runId: collected.runId, reason: 'not the right people' });

    assert.equal(out.ok, true);
    const runs = await listScrapeRuns(WS);
    assert.equal(runs[0].status, 'discarded');
    assert.equal(runs[0].reason, 'not the right people');
  });

  test('a dry run plans the queue but touches no tab and opens no session', async () => {
    await seedWorkspace();
    await seedLead('sara_shop');
    await seedLead('linen_co');
    const { controller, api, events } = makeController();

    const out = await controller.outreach({ mode: QueueMode.FOLLOW, dryRun: true });

    assert.equal(out.ok, true);
    assert.equal(out.dryRun, true);
    assert.ok(out.plan.counts.ready >= 1, 'the two fresh leads are queued');
    assert.equal(controller.state.phase, RunPhase.IDLE, 'a dry run leaves the controller idle, ready to be started for real');
    assert.equal(api.sent.length, 0, 'a dry run sends no command');
    assert.equal((await listOutreachSessions(WS)).length, 0, 'a dry run opens no session');
    assert.ok(events.some((event) => event.type === 'plan' && event.queued >= 1));
  });

  test('a queue where everyone was already actioned is capped, not an error', async () => {
    await seedWorkspace();
    await seedLead('sara_shop', { relState: RelState.FOLLOWING, followedViaExtension: true, followedAt: NOW - 86_400_000 });
    const { controller, api } = makeController();

    const out = await controller.outreach({ mode: QueueMode.FOLLOW });

    assert.equal(out.ok, true);
    assert.equal(out.phase, RunPhase.CAPPED);
    assert.equal(out.counts.attempted, 0);
    assert.match(out.reason, /nobody is waiting/);
    assert.equal(api.sent.length, 0);
    assert.equal((await listOutreachSessions(WS)).length, 0, 'an empty queue opens no session');
  });

  test('a run outside the active window is blocked before it opens a session', async () => {
    await seedWorkspace();
    await seedLead('sara_shop');
    const threeAm = new Date(2026, 0, 7, 3, 0, 0).getTime();
    const { controller, api } = makeController({ start: threeAm });

    const out = await controller.outreach({ mode: QueueMode.FOLLOW });

    assert.equal(out.ok, false);
    assert.equal(out.phase, RunPhase.BLOCKED);
    assert.equal(out.severity, null, 'a closed window is not an account-level alarm');
    assert.equal(api.sent.length, 0);
    assert.equal((await listOutreachSessions(WS)).length, 0, 'a blocked run opens no session');
  });

  test('a follow run actions each lead, moves the counters, and closes the session done', async () => {
    await seedWorkspace();
    const keyA = await seedLead('sara_shop');
    const keyB = await seedLead('linen_co');
    const { controller, api, events } = makeController();

    const out = await controller.outreach({ mode: QueueMode.FOLLOW });

    assert.equal(out.ok, true);
    assert.equal(out.phase, RunPhase.DONE);
    assert.equal(out.counts.attempted, 2);
    assert.equal(out.counts.done, 2);
    assert.equal(out.counts.failed, 0);

    // Both commands went to the worker window, not the tab the owner is reading.
    assert.equal(api.sent.length, 2);
    assert.ok(api.sent.every((call) => call.type === CommandType.EXECUTE_FOLLOW && call.options.tabId === 7));

    const leadA = await getLead(keyA);
    assert.equal(leadA.relState, RelState.FOLLOWING, 'the verified follow is written to the lead');
    assert.equal(leadA.followedViaExtension, true);

    const actions = await listActions(WS);
    assert.equal(actions.length, 2);
    assert.ok(actions.every((row) => row.verifiedOk === true && row.actionType === ActionType.FOLLOW));

    const workspace = await getWorkspace(WS);
    assert.equal(workspace.governorState.daily.follows, 2, 'the daily counter moved by the two verified follows');

    const sessions = await listOutreachSessions(WS);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, 'done');
    assert.equal(sessions[0].counts.done, 2);
    assert.ok(sessions[0].endedAt, 'the session is closed, not left running');

    assert.ok(events.some((event) => event.type === 'session'));
    assert.ok(events.some((event) => event.type === 'summary' && event.ok === true));
  });

  test('Stop pressed during a delay ends the run as stopped and closes the session', async () => {
    await seedWorkspace();
    await seedLead('sara_shop');
    await seedLead('linen_co');

    const clock = { t: NOW };
    const events = [];
    const now = () => clock.t;
    const sleep = async (ms) => { clock.t += ms; await new Promise(setImmediate); };
    const api = makeApi({ now, sleep, clock });
    let controller;
    controller = createRunController({
      api,
      now,
      sleep,
      rng: seededRng(),
      onEvent: (event) => {
        events.push(event);
        // Press Stop the instant the first delay is announced.
        if (event.type === 'delay') controller.stop('the owner pressed stop');
      },
    });

    const out = await controller.outreach({ mode: QueueMode.FOLLOW });

    assert.equal(out.ok, true, 'a clean stop is a success: the owner asked for it');
    assert.equal(out.phase, RunPhase.STOPPED);
    assert.equal(out.counts.attempted, 0, 'nothing was actioned: the stop landed during the first wait');
    assert.ok(api.stops.length >= 1, 'the tab is told to stop pacing too');

    const sessions = await listOutreachSessions(WS);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, 'stopped');
    assert.ok(sessions[0].endedAt, 'the stopped session is still closed');
  });

  test('a message run with only an over-limit template refuses rather than truncating', async () => {
    await seedWorkspace();
    await seedLead('sara_shop', { warmthTier: 'cold' });
    await putTemplate(templateRecord({ workspaceId: WS, body: 'x'.repeat(1200), label: 'too long', enabled: true }));
    const { controller, api, events } = makeController();

    const out = await controller.outreach({ mode: QueueMode.DM, policy: { mutualOnly: false } });

    assert.equal(out.counts.refused, 1);
    assert.equal(out.counts.attempted, 0, 'an unusable message is never sent');
    assert.equal(api.sent.length, 0, 'no DM command goes out when the only template is over the limit');
    assert.ok(events.some((event) => event.type === 'refusal' && /over the 1000-byte limit/.test(event.reason)));

    const sessions = await listOutreachSessions(WS);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, 'done', 'a run that refused everyone still closes cleanly');
  });

  test('three actions in a row that do not land abort the run as a page failure', async () => {
    await seedWorkspace();
    await seedLead('a_one');
    await seedLead('b_two');
    await seedLead('c_three');
    await seedLead('d_four');
    const { controller, api } = makeController({
      answers: {
        [CommandType.EXECUTE_FOLLOW]: { ok: false, reason: 'the follow button was not where we expected', severity: 'tab', value: { ok: false, outcome: 'not_done', reason: 'the follow button was not where we expected' } },
      },
    });

    const out = await controller.outreach({ mode: QueueMode.FOLLOW, limit: 10 });

    assert.equal(out.ok, false);
    assert.equal(out.phase, RunPhase.FAILED);
    assert.equal(out.severity, 'page');
    assert.equal(out.counts.failed, MAX_CONSECUTIVE_FAILURES);
    assert.equal(out.counts.attempted, MAX_CONSECUTIVE_FAILURES, 'it stops at the third failure, not the fourth');
    assert.equal(api.sent.length, MAX_CONSECUTIVE_FAILURES);
    assert.match(out.reason, /did not land/);

    const sessions = await listOutreachSessions(WS);
    assert.equal(sessions[0].status, 'failed');
  });

  test('an account-level refusal stops the run, trips the breaker, and tells the tab to stop', async () => {
    await seedWorkspace();
    await seedLead('a_one');
    await seedLead('b_two');
    const { controller, api } = makeController({
      answers: {
        [CommandType.EXECUTE_FOLLOW]: { ok: false, reason: 'Instagram blocked this follow', severity: 'account', value: { ok: false, outcome: 'stopped', reason: 'Instagram blocked this follow' } },
      },
    });

    const out = await controller.outreach({ mode: QueueMode.FOLLOW, limit: 10 });

    assert.equal(out.ok, false);
    assert.equal(out.phase, RunPhase.BLOCKED);
    assert.equal(out.severity, 'account');
    assert.equal(out.counts.attempted, 1, 'it stops on the first account-level refusal');
    assert.ok(api.stops.length >= 1, 'the tab is told to stop');

    const workspace = await getWorkspace(WS);
    assert.ok(workspace.governorState.lockedUntil > NOW, 'the circuit breaker is locked and persisted');

    const sessions = await listOutreachSessions(WS);
    assert.equal(sessions[0].status, 'blocked');
  });

  test('a controller cannot start a second run while one is in flight', async () => {
    await seedWorkspace();
    await seedLead('sara_shop');
    const { controller } = makeController({
      answers: { [CommandType.COLLECT_LEADS]: { ok: true, value: collectResult(['x']) } },
    });
    // Hold a collection open by starting it and immediately asking for another.
    const first = controller.collect({ source: 'followers' });
    const second = await controller.collect({ source: 'following' });
    assert.equal(second.ok, false);
    assert.match(second.reason, /already in progress/);
    const third = await controller.outreach({ mode: QueueMode.FOLLOW, limit: 5 });
    assert.equal(third.ok, false);
    assert.match(third.reason, /already in progress/);
    await first;
  });

  test('collect focuses the Instagram tab while running and automatically returns to the dashboard tab when done', async () => {
    let focusedTab = null;
    let returnedToDashboard = 0;
    const { controller } = makeController({
      answers: { [CommandType.COLLECT_LEADS]: { ok: true, value: collectResult(['sara_shop']) } },
      tabs: {
        tabById: async () => ({ id: 7, url: 'https://www.instagram.com/comp_a/' }),
        listTabs: async () => [{ id: 7, url: 'https://www.instagram.com/comp_a/', active: true }],
        focus: async (id) => { focusedTab = id; return { ok: true }; },
        focusDashboard: async () => { returnedToDashboard += 1; return { ok: true, tabId: 99 }; },
        navigate: async () => ({ ok: true }),
      },
    });
    const out = await controller.collect({ source: 'followers', username: 'comp_a' });
    assert.equal(out.ok, true);
    assert.equal(focusedTab, 7, 'brings Instagram tab forward during scan');
    assert.equal(returnedToDashboard, 1, 'automatically switches focus back to the dashboard tab on completion');
  });

  test('createRunController refuses to build without an api client', () => {
    assert.throws(() => createRunController({}), /needs an api client/);
  });
});
