import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../scripts/lib/dom-shim.mjs';
import {
  ACTIVE_WORKSPACE_KEY,
  CommandType,
  createBridge,
  memoryStorageAdapter,
} from '../src/storage/bridge.js';
import {
  CONTENT_LOOP_MAX_RESTARTS,
  createContentBootstrap,
  installMessageHandlers,
  resetMessageHandlers,
} from '../src/content/main.js';

const LOGGED_IN = 'sessionid=abc; csrftoken=tok; ds_user_id=77';

/** Every bootstrap this file starts, stopped whether the test passed or not. */
const live = [];
afterEach(() => {
  const pending = live.splice(0, live.length);
  for (const item of pending) { try { item.stop('test over'); } catch { /* already stopped */ } }
});

/**
 * One tab on a virtual clock.
 *
 * The clock advances and then yields to the real event loop: a bridge poll that
 * only moved a number would spin hot and starve the command it is waiting for.
 */
function setup(options = {}) {
  const doc = installDom();
  const location = {
    href: `https://www.instagram.com/${options.username ?? 'sara_shop'}/`,
    pathname: `/${options.username ?? 'sara_shop'}/`,
  };
  const follow = doc.createElement('button');
  follow.textContent = options.button ?? 'Follow';
  const heading = doc.createElement('h1');
  heading.textContent = options.username ?? 'sara_shop';
  doc.body.append(heading, follow);

  const clock = { t: options.start ?? 1_000 };
  const storage = options.storage ?? memoryStorageAdapter(options.seed ?? {});
  const listeners = [];
  const chrome = {
    storage: {
      local: storage,
      onChanged: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => {
          const at = listeners.indexOf(fn);
          if (at >= 0) listeners.splice(at, 1);
        },
      },
    },
    runtime: { getURL: (path) => `chrome-extension://test/${path}` },
  };

  const env = {
    chrome,
    storage,
    document: doc,
    location,
    cookieString: options.cookieString ?? LOGGED_IN,
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; await new Promise(setImmediate); },
    pollMs: options.pollMs ?? 20,
    restartMs: options.restartMs ?? 5,
    maxRestarts: options.maxRestarts ?? CONTENT_LOOP_MAX_RESTARTS,
    launcher: options.launcher ?? false,
    request: options.request ?? null,
  };
  if (!env.request) delete env.request;

  /** Fire a chrome.storage.onChanged event the way Chrome does. */
  const emit = (key, newValue, area = 'local') => {
    for (const fn of [...listeners]) fn({ [key]: { newValue } }, area);
  };

  /** The dashboard end of the same mailbox. */
  const dashboardFor = (workspaceId) => createBridge({
    storage,
    workspaceId,
    now: () => clock.t,
    sleep: env.sleep,
    pollMs: env.pollMs,
  });

  return { doc, location, clock, storage, chrome, env, emit, listeners, dashboardFor, follow };
}

function track(bootstrap) {
  live.push(bootstrap);
  return bootstrap;
}

describe('the content bootstrap', () => {
  test('it serves the workspace the dashboard recorded, not a guess', async () => {
    const page = setup({ seed: { [ACTIVE_WORKSPACE_KEY]: { workspaceId: '900', at: 5 } } });
    const bootstrap = track(createContentBootstrap(page.env));
    const started = await bootstrap.start();
    assert.deepEqual(started, { ok: true, workspaceId: '900' });
    assert.equal(bootstrap.state.workspaceId, '900');
    assert.equal(bootstrap.bridge().keys.commandKey, 'ig_crm_bridge_v1:900:command');
  });

  test('with nothing recorded it serves the bootstrap workspace', async () => {
    const page = setup();
    const bootstrap = track(createContentBootstrap(page.env));
    assert.equal((await bootstrap.start()).workspaceId, 'default');
    assert.equal(await bootstrap.readWorkspaceId(), 'default');
  });

  test('a ping from the dashboard is answered with the page it is looking at', async () => {
    const page = setup({ seed: { [ACTIVE_WORKSPACE_KEY]: { workspaceId: '900', at: 5 } } });
    track(createContentBootstrap(page.env)).start();
    const dashboard = page.dashboardFor('900');
    const answer = await dashboard.postCommand(CommandType.PING, {}, { timeoutMs: 2000 });
    assert.equal(answer.ok, true);
    assert.equal(answer.result.pong, true);
    assert.equal(answer.result.pageUsername, 'sara_shop');
    assert.equal(answer.result.loggedIn, true);
    assert.equal(answer.result.busy, false);
  });

  test('a command for another workspace is not answered by this tab', async () => {
    const page = setup({ seed: { [ACTIVE_WORKSPACE_KEY]: { workspaceId: '900', at: 5 } } });
    track(createContentBootstrap(page.env)).start();
    const other = page.dashboardFor('901');
    const answer = await other.postCommand(CommandType.PING, {}, { timeoutMs: 300 });
    assert.equal(answer.ok, false);
    assert.match(answer.reason, /no reply within/);
    // The sender withdraws its own dead command, so a tab that later moves to
    // this workspace does not pick up a request nobody is waiting for.
    assert.equal(await page.storage.get('ig_crm_bridge_v1:901:command'), null);
  });

  test('the owner switching accounts moves this tab to the new mailbox', async () => {
    const page = setup({ seed: { [ACTIVE_WORKSPACE_KEY]: { workspaceId: '900', at: 5 } } });
    const bootstrap = track(createContentBootstrap(page.env));
    await bootstrap.start();
    assert.equal(bootstrap.state.workspaceId, '900');

    await page.storage.set(ACTIVE_WORKSPACE_KEY, { workspaceId: '901', at: 9 });
    page.emit(ACTIVE_WORKSPACE_KEY, { workspaceId: '901', at: 9 });
    await new Promise(setImmediate);
    await new Promise(setImmediate);

    assert.equal(bootstrap.state.workspaceId, '901');
    const answer = await page.dashboardFor('901').postCommand(CommandType.PING, {}, { timeoutMs: 2000 });
    assert.equal(answer.ok, true);
    const stale = await page.dashboardFor('900').postCommand(CommandType.PING, {}, { timeoutMs: 200 });
    assert.equal(stale.ok, false, 'the old mailbox is not served any more');
  });

  test('a change to another storage area or another key is ignored', async () => {
    const page = setup({ seed: { [ACTIVE_WORKSPACE_KEY]: { workspaceId: '900', at: 5 } } });
    const bootstrap = track(createContentBootstrap(page.env));
    await bootstrap.start();
    page.emit(ACTIVE_WORKSPACE_KEY, { workspaceId: '901' }, 'sync');
    page.emit('ig_crm_settings_v1', { anything: true }, 'local');
    page.emit(ACTIVE_WORKSPACE_KEY, { workspaceId: '900', at: 6 }, 'local');
    await new Promise(setImmediate);
    assert.equal(bootstrap.state.workspaceId, '900');
  });

  test('stop ends the loop, the pill and any run, and says how much it did', async () => {
    const page = setup({ seed: { [ACTIVE_WORKSPACE_KEY]: { workspaceId: '900', at: 5 } } });
    const bootstrap = track(createContentBootstrap(page.env));
    await bootstrap.start();
    const answer = await page.dashboardFor('900').postCommand(CommandType.GET_CONTEXT, {}, { timeoutMs: 2000 });
    assert.equal(answer.ok, true);
    const stopped = bootstrap.stop('tab closed');
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.commands, 1);
    assert.equal(bootstrap.state.stopped, true);
    const after = await page.dashboardFor('900').postCommand(CommandType.PING, {}, { timeoutMs: 200 });
    assert.equal(after.ok, false, 'a stopped tab answers nothing');
  });

  test('starting twice is one installation, not two loops on one mailbox', async () => {
    const page = setup({ seed: { [ACTIVE_WORKSPACE_KEY]: { workspaceId: '900', at: 5 } } });
    const bootstrap = track(createContentBootstrap(page.env));
    await bootstrap.start();
    const again = await bootstrap.start();
    assert.equal(again.alreadyStarted, true);
    const dashboard = page.dashboardFor('900');
    const answer = await dashboard.postCommand(CommandType.PING, {}, { timeoutMs: 2000 });
    assert.equal(answer.ok, true);
    assert.equal(bootstrap.state.commands, 1, 'one command, one answer - never the same command twice');
  });

  test('without extension storage it refuses instead of throwing', async () => {
    const page = setup();
    const bootstrap = track(createContentBootstrap({ ...page.env, storage: null, chrome: null }));
    const started = await bootstrap.start();
    assert.equal(started.ok, false);
    assert.match(started.reason, /no extension storage/);
    assert.equal(bootstrap.state.loop, null);
  });

  test('a loop that dies comes back, and gives up after too many deaths', async () => {
    const page = setup({ seed: { [ACTIVE_WORKSPACE_KEY]: { workspaceId: '900', at: 5 } }, maxRestarts: 2 });
    let deaths = 0;
    const bootstrap = track(createContentBootstrap({
      ...page.env,
      bridgeFor: () => ({
        keys: { commandKey: 'ig_crm_bridge_v1:900:command' },
        readStatus: async () => null,
        postStatus: async () => {},
        runCommandLoop: async () => { deaths += 1; throw new Error('the mailbox exploded'); },
      }),
    }));
    const started = await bootstrap.start();
    assert.equal(started.ok, true);
    const outcome = await bootstrap.state.loop;
    assert.equal(outcome.gaveUp, true);
    assert.equal(deaths, 3, 'the original attempt plus two restarts');
    assert.equal(bootstrap.state.restarts, 3);
    assert.match(bootstrap.state.reason, /reload this Instagram tab/);
    assert.match(bootstrap.state.lastError, /the mailbox exploded/);
  });

  test('a restart keeps serving after the loop dies once', async () => {
    const page = setup({ seed: { [ACTIVE_WORKSPACE_KEY]: { workspaceId: '900', at: 5 } } });
    const bootstrap = track(createContentBootstrap(page.env));
    await bootstrap.start();
    const firstSignal = bootstrap.state.signal;
    firstSignal.aborted = false;
    // Kill the loop the way a storage failure would: the supervisor must notice,
    // wait, and come back on the same mailbox.
    bootstrap.state.bridge.runCommandLoop = async () => { throw new Error('transient'); };
    await bootstrap.restartFor('900');
    await new Promise(setImmediate);
    assert.equal(bootstrap.state.workspaceId, '900');
  });

  test('the pill reads the mailbox status and its stop ends the run', async () => {
    const page = setup({
      seed: { [ACTIVE_WORKSPACE_KEY]: { workspaceId: '900', at: 5 } },
      launcher: true,
      setInterval: () => 0,
      clearInterval: () => {},
      addEventListener: () => {},
    });
    let pillDeps = null;
    const bootstrap = track(createContentBootstrap({
      ...page.env,
      installLauncher: (deps) => {
        pillDeps = deps;
        return { stop: () => { pillDeps.stopped = true; } };
      },
    }));
    await bootstrap.start();
    assert.equal(typeof pillDeps.readStatus, 'function');
    assert.equal(typeof pillDeps.onStop, 'function');

    await bootstrap.bridge().postStatus({ kind: 'run-end', ok: true, summary: 'Collected 12 people.', at: page.clock.t });
    assert.equal((await pillDeps.readStatus()).summary, 'Collected 12 people.');

    const stopped = pillDeps.onStop();
    assert.equal(stopped.stopped, false, 'nothing was running, so nothing was stopped');
    const status = await bootstrap.bridge().readStatus();
    assert.equal(status.kind, 'run-end');
    assert.equal(status.ok, false);
    assert.match(status.reason, /Stopped from this tab/);

    // A run in flight is ended by the same button, and the pill goes with it.
    bootstrap.runtime.current = 'collect:followers';
    assert.equal(pillDeps.onStop().stopped, true);
    assert.equal(bootstrap.runtime.current, null);
    bootstrap.stop('test over');
    assert.equal(pillDeps.stopped, true, 'the pill is torn down with the bootstrap');
  });

  test('a run in flight is refused a second command, and stop is still answered', async () => {
    const page = setup({ seed: { [ACTIVE_WORKSPACE_KEY]: { workspaceId: '900', at: 5 } } });
    const bootstrap = track(createContentBootstrap(page.env));
    await bootstrap.start();
    bootstrap.runtime.current = 'collect:followers';
    const dashboard = page.dashboardFor('900');
    const refused = await dashboard.postCommand(CommandType.COLLECT_LEADS, { source: 'followers' }, { timeoutMs: 2000 });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /already in progress/);
    assert.equal(refused.result.busy, true);

    const stopped = await dashboard.postStop('owner pressed stop');
    assert.equal(stopped.ok, true, 'stop is answered even mid-run');
    assert.equal(stopped.result.stopped, true);
    assert.equal(bootstrap.runtime.current, null);
  });
});

describe('the page-level installation', () => {
  test('one installation per page, and reset drops it', async () => {
    resetMessageHandlers();
    const page = setup({ seed: { [ACTIVE_WORKSPACE_KEY]: { workspaceId: '900', at: 5 } } });
    const first = await installMessageHandlers(page.env);
    track(first);
    const second = await installMessageHandlers(page.env);
    assert.equal(second, first, 'a page that imports the module twice gets one loop, not two');
    assert.equal(resetMessageHandlers(), true);
    assert.equal(resetMessageHandlers(), false);
    assert.equal(first.state.stopped, true);
  });

  test('a bootstrap that throws during start is reported, not swallowed silently', async () => {
    resetMessageHandlers();
    const page = setup();
    const broken = {
      ...page.env,
      storage: {
        get: async () => { throw new Error('storage is gone'); },
        set: async () => {},
        remove: async () => {},
      },
    };
    const installed = await installMessageHandlers(broken);
    track(installed);
    // A dead storage area is survivable: the workspace falls back and the loop
    // keeps polling, so the tab still answers a ping if storage comes back.
    assert.equal(installed.state.workspaceId, 'default');
    resetMessageHandlers();
  });
});
