import { test, describe } from 'node:test';
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

function loop(content, handlers, extra = {}) {
  const signal = { aborted: false };
  const promise = content.runCommandLoop({ handlers, signal, ...extra });
  return { signal, promise };
}

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
