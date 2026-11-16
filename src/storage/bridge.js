/**
 * The command bus between the dashboard and the Instagram tab.
 *
 * This extension has no service worker — on purpose, so nothing runs when the
 * owner is not watching. That removes `chrome.runtime.sendMessage` as a transport
 * between two extension contexts, because with no background page there is nobody
 * to route it. What is left that works everywhere is `chrome.storage.local`:
 * readable and writable from an extension page, from a popup and from a content
 * script, and it fires `onChanged` in all of them.
 *
 * So this module is a mailbox.
 *
 *   dashboard  --post command-->  storage  --watch-->  content script
 *   content    --post result--->   storage  --await-->  dashboard
 *   content    --post status--->   storage  --watch-->  dashboard
 *
 * Every message is a plain JSON object under a key namespaced by workspace, so
 * two Instagram accounts in one browser profile never read each other's commands.
 *
 * Design rules that follow from the transport:
 *  - a command carries an id, and the result is matched by that id, because
 *    storage gives no request/response pairing of its own;
 *  - waiting is polling on a one-second tick, so a Stop pressed in the dashboard
 *    reaches the content script within a second even in a throttled background
 *    tab;
 *  - a command that is never answered times out with a reason. Silence from a
 *    tab must never look like "still working" forever;
 *  - the storage adapter is injectable, so the whole protocol is unit-tested
 *    without a browser.
 */

/** Where the dashboard records which workspace its tabs should serve. */
export const ACTIVE_WORKSPACE_KEY = 'ig_crm_active_workspace_v1';

export const BRIDGE_PREFIX = 'ig_crm_bridge_v1';
export const BRIDGE_POLL_MS = 1000;
export const BRIDGE_COMMAND_TIMEOUT_MS = 30_000;

export const CommandType = Object.freeze({
  PING: 'PING',
  GET_CONTEXT: 'GET_CONTEXT',
  PROBE: 'PROBE',
  COLLECT_LEADS: 'COLLECT_LEADS',
  SYNC_RELATIONSHIPS: 'SYNC_RELATIONSHIPS',
  EXECUTE_FOLLOW: 'EXECUTE_FOLLOW',
  EXECUTE_UNFOLLOW: 'EXECUTE_UNFOLLOW',
  EXECUTE_DM: 'EXECUTE_DM',
  OPEN_THREAD: 'OPEN_THREAD',
  STOP: 'STOP',
});

/** Commands that must be answered even when a run is already in flight. */
export const ALWAYS_ACCEPTED = Object.freeze([CommandType.PING, CommandType.STOP, CommandType.GET_CONTEXT]);

export const keyFor = (workspaceId, kind) => `${BRIDGE_PREFIX}:${workspaceId ?? 'default'}:${kind}`;

/** True when Chrome tore down this content script after an extension reload/update. */
export function isContextInvalidatedError(error) {
  const msg = String(error?.message ?? error ?? '');
  return /extension context invalidated|context invalidated|receiving end does not exist/i.test(msg);
}

/**
 * A storage adapter over `chrome.storage.local`.
 *
 * Handles extension reloads cleanly: once Chrome invalidates the context,
 * reads/writes stop silently instead of throwing uncaught promise errors in
 * `chrome://extensions`. Also provides an optional `waitForChange` hook backed
 * by `storage.onChanged` so commands and replies wake up immediately instead of
 * waiting a full poll interval.
 */
export function chromeStorageAdapter(chromeApi) {
  const area = chromeApi?.storage?.local;
  if (!area) throw new Error('chrome.storage.local is unavailable in this context');
  const onChanged = chromeApi?.storage?.onChanged;
  let dead = false;

  const checkRuntimeAlive = () => {
    if (dead) return false;
    try {
      if (chromeApi?.runtime && ('id' in chromeApi.runtime) && !chromeApi.runtime.id) {
        dead = true;
        return false;
      }
    } catch {
      dead = true;
      return false;
    }
    return true;
  };

  return {
    isDead() { return !checkRuntimeAlive(); },
    async get(key) {
      if (!checkRuntimeAlive()) return null;
      try {
        const out = await area.get(key);
        return out?.[key] ?? null;
      } catch (error) {
        if (isContextInvalidatedError(error)) { dead = true; return null; }
        throw error;
      }
    },
    async set(key, value) {
      if (!checkRuntimeAlive()) return;
      try {
        await area.set({ [key]: value });
      } catch (error) {
        if (isContextInvalidatedError(error)) { dead = true; return; }
        throw error;
      }
    },
    async remove(key) {
      if (!checkRuntimeAlive()) return;
      try {
        await area.remove(key);
      } catch (error) {
        if (isContextInvalidatedError(error)) { dead = true; return; }
        throw error;
      }
    },
    waitForChange(key, maxMs, sleepFn) {
      if (!checkRuntimeAlive()) return Promise.resolve();
      if (typeof onChanged?.addListener !== 'function' || typeof onChanged?.removeListener !== 'function') {
        return sleepFn(maxMs);
      }
      return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          try { onChanged.removeListener(listener); } catch { /* context gone */ }
          resolve();
        };
        const listener = (changes, areaName) => {
          if (areaName && areaName !== 'local') return;
          if (changes && Object.prototype.hasOwnProperty.call(changes, key)) finish();
        };
        try {
          onChanged.addListener(listener);
        } catch (error) {
          if (isContextInvalidatedError(error)) dead = true;
          resolve();
          return;
        }
        timer = setTimeout(finish, Math.max(20, Number(maxMs) || 200));
        if (typeof timer?.unref === 'function') timer.unref();
      });
    },
  };
}

/** An in-memory adapter, for tests and for a preview with no chrome object. */
export function memoryStorageAdapter(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    // Copy on the way out as well as in: chrome.storage hands back structured
    // clones, so a fake that returned a live reference would let a test mutate
    // the store and pass for the wrong reason.
    async get(key) { return map.has(key) ? structuredCloneSafe(map.get(key)) : null; },
    async set(key, value) { map.set(key, structuredCloneSafe(value)); },
    async remove(key) { map.delete(key); },
    _map: map,
  };
}

function structuredCloneSafe(value) {
  try {
    return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

/** One random-enough id. Not a security boundary: collisions are the only risk. */
export function newCommandId(random = Math.random, now = Date.now) {
  const stamp = now().toString(36);
  const noise = Math.floor(random() * 0xffffff).toString(36).padStart(4, '0');
  return `cmd_${stamp}_${noise}`;
}

/**
 * @param {{storage: object, workspaceId?: string, pollMs?: number,
 *          commandTimeoutMs?: number, now?: () => number,
 *          sleep?: (ms: number) => Promise<void>, random?: () => number}} options
 */
export function createBridge(options = {}) {
  const storage = options.storage;
  if (!storage) throw new Error('createBridge needs a storage adapter');
  const workspaceId = String(options.workspaceId ?? 'default');
  const pollMs = Math.max(50, Number(options.pollMs) || BRIDGE_POLL_MS);
  const commandTimeoutMs = Math.max(500, Number(options.commandTimeoutMs) || BRIDGE_COMMAND_TIMEOUT_MS);
  const now = options.now ?? (() => Date.now());
  const sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;

  const commandKey = keyFor(workspaceId, 'command');
  const resultKey = keyFor(workspaceId, 'result');
  const statusKey = keyFor(workspaceId, 'status');

  /** Publish a command and wait for the matching result. */
  async function postCommand(type, payload = {}, { timeoutMs = commandTimeoutMs, signal = null, targetTabId = null } = {}) {
    if (!Object.values(CommandType).includes(type)) {
      return { ok: false, reason: `unknown command type: ${type}`, severity: null, result: null, commandId: null, elapsedMs: 0 };
    }
    const commandId = newCommandId(random, now);
    const command = {
      commandId,
      type,
      payload,
      postedAt: now(),
      workspaceId,
      ...(targetTabId !== null && targetTabId !== undefined ? { targetTabId: Number(targetTabId) } : {}),
    };
    await storage.set(commandKey, command);

    const deadline = now() + Math.max(500, timeoutMs);
    while (now() < deadline) {
      if (signal?.aborted) return { ok: false, reason: 'aborted while waiting for a reply', result: null, commandId };
      if (storage.isDead?.()) return { ok: false, reason: 'extension context was reloaded; refresh the page and try again', result: null, commandId, severity: 'tab' };
      const result = await storage.get(resultKey);
      if (result && result.commandId === commandId) {
        await storage.remove(resultKey);
        return {
          ok: Boolean(result.ok),
          reason: result.reason ?? null,
          severity: result.severity ?? null,
          result: result.value ?? null,
          commandId,
          elapsedMs: now() - command.postedAt,
        };
      }
      if (typeof storage.waitForChange === 'function') {
        await storage.waitForChange(resultKey, pollMs, sleepFn);
      } else {
        await sleepFn(pollMs);
      }
    }
    // Leave no stale command behind: a tab that wakes later must not execute it.
    await withdrawIfOurs(commandId);
    return {
      ok: false,
      reason: `no reply within ${Math.round(timeoutMs / 1000)}s — the Instagram tab may be closed, asleep, or not on instagram.com`,
      severity: 'tab',
      result: null,
      commandId,
      elapsedMs: now() - command.postedAt,
      timedOut: true,
    };
  }

  /** Cancel a pending command if it is still the one on the mailbox. */
  async function withdrawIfOurs(commandId) {
    const current = await storage.get(commandKey);
    if (current && current.commandId === commandId) await storage.remove(commandKey);
  }

  /**
   * The content-script side: poll for a command, run it, publish the result.
   *
   * `handlers` maps a CommandType to an async function. `isBusy` lets the
   * content script refuse a second collection run while one is in flight, except
   * for STOP and PING, which must always be answered.
   */
  async function runCommandLoop({ handlers, isBusy = () => false, signal = null, onCommand = null, idleMs = pollMs, getTabId = null } = {}) {
    let handled = 0;
    while (!signal?.aborted) {
      if (storage.isDead?.()) return { handled, invalidated: true };
      let command = null;
      try {
        command = await storage.get(commandKey);
      } catch (error) {
        if (isContextInvalidatedError(error)) return { handled, invalidated: true };
        throw error;
      }
      if (storage.isDead?.()) return { handled, invalidated: true };
      if (command && command.targetTabId !== undefined && command.targetTabId !== null) {
        const myTabId = typeof getTabId === 'function' ? getTabId() : null;
        if (myTabId === null || myTabId === undefined || Number(command.targetTabId) !== Number(myTabId)) {
          // Addressed to a different Instagram tab — leave it in the mailbox
          // untouched so the right tab claims it.
          if (typeof storage.waitForChange === 'function') {
            await storage.waitForChange(commandKey, idleMs, sleepFn);
          } else {
            await sleepFn(idleMs);
          }
          continue;
        }
      }
      if (!command) {
        if (typeof storage.waitForChange === 'function') {
          await storage.waitForChange(commandKey, idleMs, sleepFn);
        } else {
          await sleepFn(idleMs);
        }
        continue;
      }
      const commandId = command.commandId;
      // Consume it before doing anything: a crash mid-command must not leave it
      // on the mailbox to be executed twice when the tab wakes up.
      try {
        await storage.remove(commandKey);
      } catch (error) {
        if (isContextInvalidatedError(error)) return { handled, invalidated: true };
        throw error;
      }
      handled += 1;
      onCommand?.(command);

      const handler = handlers?.[command.type];
      if (!handler) {
        await postResult(commandId, { ok: false, reason: `this tab cannot handle ${command.type}`, value: null });
        continue;
      }
      if (isBusy() && !ALWAYS_ACCEPTED.includes(command.type)) {
        // `busy` travels inside the value: postResult persists a fixed row shape,
        // so a flag hung off the side would be dropped and the dashboard would
        // read "this tab refused" as "this tab is broken" instead of "try again
        // when the run in flight finishes".
        await postResult(commandId, { ok: false, reason: 'a run is already in progress in this tab', value: { busy: true } });
        continue;
      }
      try {
        const value = await handler(command.payload ?? {}, { command, postStatus, signal });
        // A handler answers either with a value or with a refusal of its own
        // (`{ ok: false, reason, severity }`). A refusal must not travel inside a
        // successful envelope, or the dashboard reports "the tab refused" as
        // "the tab did it" — and the refusal's own `value` is kept, because it
        // carries what the dashboard needs next (a url to navigate to, the counts
        // collected so far, the phase that failed).
        if (value && typeof value === 'object' && value.ok === false) {
          await postResult(commandId, {
            ok: false,
            reason: value.reason ?? 'the tab refused the command',
            value: value.value ?? value,
            severity: value.severity ?? null,
          });
        } else {
          await postResult(commandId, { ok: true, reason: null, value: value ?? null });
        }
      } catch (error) {
        await postResult(commandId, {
          ok: false,
          reason: error?.userFacing ? error.message : `${error?.name ?? 'Error'}: ${error?.message ?? 'unknown failure'}`,
          value: null,
          severity: error?.severity ?? null,
        });
      }
    }
    return { handled };
  }

  /** Answer a command. */
  async function postResult(commandId, { ok, reason = null, value = null, severity = null }) {
    await storage.set(resultKey, { commandId, ok: Boolean(ok), reason, value, severity, at: now() });
  }

  /** Publish progress. The dashboard polls this; nothing is queued. */
  async function postStatus(status) {
    await storage.set(statusKey, { ...status, workspaceId, at: now() });
  }

  async function readStatus() {
    return storage.get(statusKey);
  }

  /** Wait for the next status change, or return the current one after timeoutMs. */
  async function waitForStatus({ newerThan = 0, timeoutMs = 10_000, signal = null } = {}) {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (signal?.aborted) return null;
      const status = await readStatus();
      if (status && Number(status.at ?? 0) > newerThan) return status;
      await sleepFn(pollMs);
    }
    return readStatus();
  }

  /** Ask the tab to stop whatever it is doing. Never times out into silence. */
  async function postStop(reason = 'stopped from the dashboard') {
    return postCommand(CommandType.STOP, { reason }, { timeoutMs: Math.max(2000, pollMs * 3) });
  }

  async function clear() {
    await storage.remove(commandKey);
    await storage.remove(resultKey);
    await storage.remove(statusKey);
  }

  return {
    workspaceId,
    keys: { commandKey, resultKey, statusKey },
    postCommand,
    postStop,
    postResult,
    postStatus,
    readStatus,
    waitForStatus,
    runCommandLoop,
    withdrawIfOurs,
    clear,
  };
}
