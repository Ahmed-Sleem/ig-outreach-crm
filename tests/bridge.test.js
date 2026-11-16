import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALWAYS_ACCEPTED,
  BRIDGE_COMMAND_TIMEOUT_MS,
  BRIDGE_POLL_MS,
  BRIDGE_PREFIX,
  CommandType,
  chromeStorageAdapter,
  createBridge,
  keyFor,
  memoryStorageAdapter,
  newCommandId,
} from '../src/storage/bridge.js';

/** Two ends of one mailbox on a virtual clock: no test here waits in real time. */
function pair(options = {}) {
  const storage = memoryStorageAdapter();
  const clock = { t: 0 };
  const env = {
    storage,
    workspaceId: options.workspaceId ?? '77',
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    pollMs: options.pollMs ?? 100,
    commandTimeoutMs: options.commandTimeoutMs ?? BRIDGE_COMMAND_TIMEOUT_MS,
    random: () => clock.t / 1000,
  };
  return {
    clock,
    storage,
    dashboard: createBridge(env),
    content: createBridge({ ...env, workspaceId: options.contentWorkspaceId ?? env.workspaceId }),
  };
}

const liveLoops = [];

function loop(content, handlers, extra = {}) {
  const signal = { aborted: false };
  const promise = content.runCommandLoop({ handlers, signal, ...extra });
  const run = { signal, promise };
  liveLoops.push(run);
  return run;
}

/**
 * Every loop is stopped after its test, even one whose assertions threw.
 *
 * A command loop on a virtual clock is a hot microtask spin: left running it
 * keeps the process alive forever and, because a child process's stdout is
 * buffered until exit, the reporter prints nothing at all. The failure then looks
 * like a hang instead of a failed assertion.
 */
afterEach(() => {
  const pending = liveLoops.splice(0, liveLoops.length);
  for (const run of pending) {
    run.signal.aborted = true;
    // Not awaited: an async root-level hook leaves a promise the runner waits on,
    // and with every other test skipped that shows up as "cancelledByParent"
    // instead of a clean run. Flagging the signal is enough — the loop exits on
    // its own next turn, and the catch keeps a rejection from escaping.
    run.promise.catch(() => null);
  }
});

describe('keys and ids', () => {
  test('keys are namespaced by workspace so two accounts never collide', () => {
    assert.equal(keyFor('77', 'command'), `${BRIDGE_PREFIX}:77:command`);
    assert.notEqual(keyFor('77', 'command'), keyFor('88', 'command'));
    assert.equal(keyFor(undefined, 'status'), `${BRIDGE_PREFIX}:default:status`);
  });

  test('command ids are unique enough to pair a result', () => {
    const ids = new Set();
    for (let index = 0; index < 500; index += 1) ids.add(newCommandId(() => index / 500, () => index));
    assert.equal(ids.size, 500);
    assert.match(newCommandId(), /^cmd_/);
  });

  test('the poll tick is one second so a stop lands quickly', () => {
    assert.equal(BRIDGE_POLL_MS, 1000);
    assert.ok(BRIDGE_COMMAND_TIMEOUT_MS >= 10_000);
  });

  test('stop and ping are answered even mid-run', () => {
    assert.ok(ALWAYS_ACCEPTED.includes(CommandType.STOP));
    assert.ok(ALWAYS_ACCEPTED.includes(CommandType.PING));
    assert.ok(!ALWAYS_ACCEPTED.includes(CommandType.COLLECT_LEADS));
  });
});

describe('storage adapters', () => {
  test('the memory adapter round-trips and deep-copies', async () => {
    const storage = memoryStorageAdapter({ a: { list: [1] } });
    assert.deepEqual(await storage.get('a'), { list: [1] });
    const value = await storage.get('a');
    value.list.push(2);
    assert.deepEqual((await storage.get('a')).list, [1], 'a reader must not be able to mutate the store');
    await storage.set('b', 2);
    assert.equal(await storage.get('b'), 2);
    await storage.remove('b');
    assert.equal(await storage.get('b'), null);
    assert.equal(await storage.get('missing'), null);
  });

  test('the chrome adapter reads and writes single keys', async () => {
    const store = {};
    const adapter = chromeStorageAdapter({
      storage: {
        local: {
          get: async (key) => ({ [key]: store[key] }),
          set: async (patch) => Object.assign(store, patch),
          remove: async (key) => { delete store[key]; },
        },
      },
    });
    await adapter.set('k', { v: 1 });
    assert.deepEqual(store.k, { v: 1 });
    assert.deepEqual(await adapter.get('k'), { v: 1 });
    await adapter.remove('k');
    assert.equal(await adapter.get('k'), null);
  });

  test('without chrome.storage.local the adapter refuses', () => {
    assert.throws(() => chromeStorageAdapter({}), /unavailable/);
    assert.throws(() => chromeStorageAdapter(undefined), /unavailable/);
  });

  test('a bridge without storage refuses to exist', () => {
    assert.throws(() => createBridge({}), /needs a storage adapter/);
  });
});

describe('command round trip', () => {
  test('a handled command returns its value and the elapsed time', async () => {
    const { dashboard, content, clock } = pair();
    const run = loop(content, { [CommandType.PING]: async () => ({ pong: true, at: clock.t }) });
    const result = await dashboard.postCommand(CommandType.PING, {}, { timeoutMs: 2000 });
    assert.equal(result.ok, true);
    assert.equal(result.result.pong, true);
    assert.ok(result.result.at >= 0);
    assert.ok(result.elapsedMs > 0);
    assert.match(result.commandId, /^cmd_/);
    run.signal.aborted = true;
    await run.promise;
  });

  test('the payload reaches the handler', async () => {
    const { dashboard, content } = pair();
    let seen = null;
    const run = loop(content, { [CommandType.COLLECT_LEADS]: async (payload) => { seen = payload; return { leads: 1 }; } });
    await dashboard.postCommand(CommandType.COLLECT_LEADS, { source: 'likers', limit: 50 }, { timeoutMs: 2000 });
    assert.deepEqual(seen, { source: 'likers', limit: 50 });
    run.signal.aborted = true;
    await run.promise;
  });

  test('an unknown command type never reaches the mailbox', async () => {
    const { dashboard, storage } = pair();
    const result = await dashboard.postCommand('DELETE_EVERYTHING');
    assert.equal(result.ok, false);
    assert.match(result.reason, /unknown command type/);
    assert.equal(await storage.get(keyFor('77', 'command')), null);
  });

  test('a command with no handler is answered, not left hanging', async () => {
    const { dashboard, content } = pair();
    const run = loop(content, {});
    const result = await dashboard.postCommand(CommandType.COLLECT_LEADS, {}, { timeoutMs: 2000 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /cannot handle COLLECT_LEADS/);
    run.signal.aborted = true;
    await run.promise;
  });

  test('a throwing handler reports the error, and a userFacing one keeps its message', async () => {
    const { dashboard, content } = pair();
    class PacingStopped extends Error { constructor() { super('Scan stopped by user.'); this.name = 'PacingStopped'; this.userFacing = true; } }
    const run = loop(content, {
      [CommandType.COLLECT_LEADS]: async () => { throw new PacingStopped(); },
      [CommandType.SYNC_RELATIONSHIPS]: async () => { throw new TypeError('cannot read x'); },
    });
    const stopped = await dashboard.postCommand(CommandType.COLLECT_LEADS, {}, { timeoutMs: 2000 });
    assert.equal(stopped.ok, false);
    assert.equal(stopped.reason, 'Scan stopped by user.');
    const crashed = await dashboard.postCommand(CommandType.SYNC_RELATIONSHIPS, {}, { timeoutMs: 2000 });
    assert.match(crashed.reason, /TypeError: cannot read x/);
    run.signal.aborted = true;
    await run.promise;
  });

  test('a busy tab refuses a second run but still answers STOP', async () => {
    const { dashboard, content } = pair();
    let busy = true;
    const run = loop(content, {
      [CommandType.STOP]: async () => { busy = false; return { stopped: true }; },
      [CommandType.COLLECT_LEADS]: async () => ({ leads: 1 }),
    }, { isBusy: () => busy });
    const refused = await dashboard.postCommand(CommandType.COLLECT_LEADS, {}, { timeoutMs: 2000 });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /already in progress/);
    const stopped = await dashboard.postStop('owner pressed stop');
    assert.equal(stopped.ok, true);
    assert.equal(busy, false);
    run.signal.aborted = true;
    await run.promise;
  });

  test('a command is consumed before it runs, so a crash cannot replay it', async () => {
    const { dashboard, content, storage } = pair();
    const run = loop(content, { [CommandType.PING]: async () => ({ pong: true }) });
    await dashboard.postCommand(CommandType.PING, {}, { timeoutMs: 2000 });
    assert.equal(await storage.get(keyFor('77', 'command')), null);
    run.signal.aborted = true;
    const summary = await run.promise;
    assert.equal(summary.handled, 1);
  });

  test('the loop stops on abort and reports how much it handled', async () => {
    const { dashboard, content } = pair();
    const run = loop(content, { [CommandType.PING]: async () => ({}) });
    await dashboard.postCommand(CommandType.PING, {}, { timeoutMs: 1000 });
    await dashboard.postCommand(CommandType.PING, {}, { timeoutMs: 1000 });
    run.signal.aborted = true;
    const summary = await run.promise;
    assert.equal(summary.handled, 2);
  });
});

describe('timeouts and workspaces', () => {
  test('a command nobody answers times out with a useful reason', async () => {
    const { dashboard } = pair();
    const result = await dashboard.postCommand(CommandType.COLLECT_LEADS, {}, { timeoutMs: 500 });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.match(result.reason, /no reply within/);
    assert.match(result.reason, /tab may be closed/);
  });

  test('a timed-out command is withdrawn so a waking tab cannot run it late', async () => {
    const { dashboard, storage } = pair();
    await dashboard.postCommand(CommandType.COLLECT_LEADS, {}, { timeoutMs: 400 });
    assert.equal(await storage.get(keyFor('77', 'command')), null);
  });

  test('a dashboard in workspace 77 is not answered by a tab in workspace 88', async () => {
    const { dashboard, content } = pair({ contentWorkspaceId: '88' });
    const run = loop(content, { [CommandType.PING]: async () => ({ pong: true }) });
    const result = await dashboard.postCommand(CommandType.PING, {}, { timeoutMs: 500 });
    assert.equal(result.timedOut, true);
    run.signal.aborted = true;
    await run.promise;
  });

  test('waiting for a reply can be aborted from the dashboard side', async () => {
    // A handler that never returns: only the dashboard's own abort can end this.
    const storage = memoryStorageAdapter();
    const clock = { t: 0 };
    const signal = { aborted: false };
    const env = {
      storage,
      workspaceId: '77',
      now: () => clock.t,
      sleep: async (ms) => { clock.t += ms; if (clock.t >= 300) signal.aborted = true; },
      pollMs: 100,
      random: () => clock.t / 1000,
    };
    const dashboard = createBridge(env);
    const content = createBridge(env);
    const run = loop(content, { [CommandType.COLLECT_LEADS]: async () => new Promise(() => {}) });
    const result = await dashboard.postCommand(CommandType.COLLECT_LEADS, {}, { timeoutMs: 60_000, signal });
    assert.equal(result.ok, false);
    assert.match(result.reason, /aborted while waiting/);
    run.signal.aborted = true;
  });
});

describe('status channel', () => {
  test('progress published by the tab is readable by the dashboard', async () => {
    const { dashboard, content } = pair();
    const run = loop(content, {
      [CommandType.COLLECT_LEADS]: async (_payload, ctx) => {
        await ctx.postStatus({ phase: 'likers', done: 10, total: 40 });
        await ctx.postStatus({ phase: 'likers', done: 40, total: 40 });
        return { leads: 40 };
      },
    });
    const promise = dashboard.postCommand(CommandType.COLLECT_LEADS, {}, { timeoutMs: 5000 });
    const status = await dashboard.waitForStatus({ newerThan: 0, timeoutMs: 2000 });
    assert.equal(status.workspaceId, '77');
    assert.ok(status.at > 0);
    assert.ok(['likers'].includes(status.phase));
    await promise;
    run.signal.aborted = true;
    await run.promise;
  });

  test('waitForStatus only returns something newer than the watermark', async () => {
    const { dashboard, content, clock } = pair();
    await content.postStatus({ phase: 'idle' });
    const watermark = clock.t;
    clock.t += 1000;
    await content.postStatus({ phase: 'running' });
    const fresh = await dashboard.waitForStatus({ newerThan: watermark, timeoutMs: 1000 });
    assert.equal(fresh.phase, 'running');
    const stale = await dashboard.waitForStatus({ newerThan: clock.t + 10_000, timeoutMs: 300 });
    assert.equal(stale.phase, 'running', 'on timeout the current status is returned, not null');
  });

  test('clear empties the mailbox', async () => {
    const { dashboard, storage } = pair();
    await dashboard.postStatus({ phase: 'x' });
    await dashboard.clear();
    assert.equal(await storage.get(keyFor('77', 'command')), null);
    assert.equal(await storage.get(keyFor('77', 'result')), null);
    assert.equal(await storage.get(keyFor('77', 'status')), null);
  });
});

describe('handler answers', () => {
  test('a refusal from a handler is posted as a refusal, with its detail kept', async () => {
    const { dashboard, content } = pair();
    const run = loop(content, {
      [CommandType.EXECUTE_FOLLOW]: async () => ({
        ok: false,
        reason: 'this tab is showing a different profile',
        severity: null,
        value: { needsNavigation: true, url: 'https://www.instagram.com/omar/' },
      }),
    });
    const answer = await dashboard.postCommand(CommandType.EXECUTE_FOLLOW, { username: 'omar' }, { timeoutMs: 4000 });
    assert.equal(answer.ok, false, 'a refusal must not ride inside a success');
    assert.equal(answer.reason, 'this tab is showing a different profile');
    assert.equal(answer.result.needsNavigation, true, 'the value survives, so the dashboard knows where to move the tab');
    assert.equal(answer.result.url, 'https://www.instagram.com/omar/');
    run.signal.aborted = true;
    await run.promise;
  });

  test('a refusal with no inner detail still carries its reason', async () => {
    const { dashboard, content } = pair();
    const run = loop(content, { [CommandType.PING]: async () => ({ ok: false, reason: 'not logged in' }) });
    const answer = await dashboard.postCommand(CommandType.PING, {}, { timeoutMs: 4000 });
    assert.equal(answer.ok, false);
    assert.equal(answer.reason, 'not logged in');
    assert.equal(answer.result.ok, false, 'with no inner value the whole answer is kept');
    run.signal.aborted = true;
    await run.promise;
  });

  test('a severity travels with the refusal', async () => {
    const { dashboard, content } = pair();
    const run = loop(content, {
      [CommandType.EXECUTE_FOLLOW]: async () => ({ ok: false, reason: 'Instagram blocked the follow', severity: 'account', value: null }),
    });
    const answer = await dashboard.postCommand(CommandType.EXECUTE_FOLLOW, {}, { timeoutMs: 4000 });
    assert.equal(answer.ok, false);
    assert.equal(answer.severity, 'account', 'severity has to survive the mailbox or the dashboard cannot trip its breaker');
    run.signal.aborted = true;
    await run.promise;
  });

  test('a plain value is still posted as a success', async () => {
    const { dashboard, content } = pair();
    const run = loop(content, { [CommandType.PING]: async () => ({ pong: true, page: '/sara/' }) });
    const answer = await dashboard.postCommand(CommandType.PING, {}, { timeoutMs: 4000 });
    assert.equal(answer.ok, true);
    assert.deepEqual(answer.result, { pong: true, page: '/sara/' });
    run.signal.aborted = true;
    await run.promise;
  });

  test('a success that mentions ok inside its payload is not mistaken for a refusal', async () => {
    const { dashboard, content } = pair();
    const run = loop(content, {
      [CommandType.COLLECT_LEADS]: async () => ({ ok: true, leads: 3, meta: { ok: false, note: 'one row was skipped' } }),
    });
    const answer = await dashboard.postCommand(CommandType.COLLECT_LEADS, {}, { timeoutMs: 4000 });
    assert.equal(answer.ok, true);
    assert.equal(answer.result.leads, 3);
    assert.equal(answer.result.meta.ok, false, 'an inner ok:false is data, not a refusal');
    run.signal.aborted = true;
    await run.promise;
  });
});

describe('live Chrome resilience: context invalidation, onChanged wake-up & multi-tab routing', () => {
  test('chromeStorageAdapter handles Extension context invalidated silently and runCommandLoop exits cleanly', async () => {
    const fakeChrome = {
      runtime: { id: 'ext-abc' },
      storage: {
        local: {
          async get() { throw new Error('Extension context invalidated.'); },
          async set() { throw new Error('Extension context invalidated.'); },
          async remove() { throw new Error('Extension context invalidated.'); },
        },
      },
    };
    const adapter = chromeStorageAdapter(fakeChrome);
    assert.equal(adapter.isDead(), false);
    assert.equal(await adapter.get('k'), null, 'does not throw on invalidated context');
    assert.equal(adapter.isDead(), true, 'marks adapter dead after invalidation error');

    const bridge = createBridge({ storage: adapter, workspaceId: '77', sleep: async () => {} });
    const res = await bridge.runCommandLoop({ handlers: {}, signal: { aborted: false } });
    assert.equal(res.invalidated, true, 'loop exits with invalidated:true instead of looping/throwing');
  });

  test('chromeStorageAdapter detects runtime.id clearing on reload', async () => {
    const fakeChrome = {
      runtime: { id: undefined },
      storage: {
        local: {
          async get() { throw new Error('should not be called when runtime.id is undefined'); },
          async set() {},
          async remove() {},
        },
      },
    };
    const adapter = chromeStorageAdapter(fakeChrome);
    assert.equal(adapter.isDead(), true);
    assert.equal(await adapter.get('k'), null);
  });

  test('waitForChange wakes up immediately when chrome.storage.onChanged fires', async () => {
    const listeners = new Set();
    const fakeChrome = {
      runtime: { id: 'ext-live' },
      storage: {
        local: { async get() { return {}; }, async set() {}, async remove() {} },
        onChanged: {
          addListener(fn) { listeners.add(fn); },
          removeListener(fn) { listeners.delete(fn); },
        },
      },
    };
    const adapter = chromeStorageAdapter(fakeChrome);
    const start = Date.now();
    const waitPromise = adapter.waitForChange('igcrm:v1:77:command', 5_000);
    setTimeout(() => {
      for (const fn of [...listeners]) fn({ 'igcrm:v1:77:command': { newValue: { ok: true } } }, 'local');
    }, 10);
    await waitPromise;
    assert.ok(Date.now() - start < 500, 'woke up via onChanged without waiting 5s');
    assert.equal(listeners.size, 0, 'listener cleaned up after wake-up');
  });

  test('multi-tab routing: command with targetTabId is ignored by other tabs and claimed only by target tab', async () => {
    const storage = memoryStorageAdapter();
    let t = 0;
    const sleep = async (ms) => { t += ms; await new Promise((r) => setTimeout(r, 1)); };
    const dashboard = createBridge({ storage, workspaceId: '77', now: () => t, sleep, pollMs: 25 });
    const tabA = createBridge({ storage, workspaceId: '77', now: () => t, sleep, pollMs: 25 });
    const tabB = createBridge({ storage, workspaceId: '77', now: () => t, sleep, pollMs: 25 });

    const seenBy = [];
    const sigA = { aborted: false };
    const sigB = { aborted: false };
    const loopA = tabA.runCommandLoop({
      handlers: { [CommandType.PING]: async () => { seenBy.push('A'); return { from: 'A' }; } },
      getTabId: () => 101,
      signal: sigA,
    });
    const loopB = tabB.runCommandLoop({
      handlers: { [CommandType.PING]: async () => { seenBy.push('B'); return { from: 'B' }; } },
      getTabId: () => 102,
      signal: sigB,
    });

    const ans = await dashboard.postCommand(CommandType.PING, {}, { timeoutMs: 2000, targetTabId: 102 });
    assert.equal(ans.ok, true);
    assert.deepEqual(ans.result, { from: 'B' });
    assert.deepEqual(seenBy, ['B'], 'Tab A ignored command addressed to Tab B');

    sigA.aborted = true;
    sigB.aborted = true;
    await Promise.all([loopA, loopB]);
  });
});

