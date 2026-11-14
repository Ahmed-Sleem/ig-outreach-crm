/**
 * Cross-tab sync bus.
 *
 * Tab 1, Tab 2, a second dashboard window and the content script all mutate the
 * same workspace. Each writer publishes a typed event here; each reader
 * refreshes only what the event names. That is what makes a follow executed in
 * the managed Instagram tab flip a badge in Tab 1 without a page reload.
 *
 * BroadcastChannel is process-local by design: nothing leaves the browser.
 * The channel factory is injectable so tests can wire two buses together
 * without a browser.
 */

export const CHANNEL_NAME = 'ig-crm-sync';

export const SyncEvent = Object.freeze({
  LEADS_UPSERTED: 'LEADS_UPSERTED',
  LEAD_STATE_CHANGED: 'LEAD_STATE_CHANGED',
  GOVERNOR_TICK: 'GOVERNOR_TICK',
  CIRCUIT_BREAKER_TRIPPED: 'CIRCUIT_BREAKER_TRIPPED',
  SETTINGS_CHANGED: 'SETTINGS_CHANGED',
});

function defaultFactory() {
  const Ctor = globalThis.BroadcastChannel;
  return Ctor ? new Ctor(CHANNEL_NAME) : null;
}

/**
 * @param {{channelFactory?: () => object}} options
 * @returns {{publish: Function, subscribe: Function, close: Function, live: boolean}}
 */
export function createSyncBus(options = {}) {
  const channel = (options.channelFactory ?? defaultFactory)();
  const handlers = new Set();

  if (!channel) {
    // No BroadcastChannel (very old browser): the bus degrades to a no-op
    // rather than throwing, and says so, so the UI can offer a manual refresh.
    return {
      live: false,
      publish: () => false,
      subscribe: () => () => {},
      close: () => {},
    };
  }

  channel.onmessage = (event) => {
    const message = event?.data;
    if (!message || typeof message.type !== 'string') return;
    for (const handler of handlers) {
      try {
        handler(message);
      } catch {
        // A broken subscriber must not silence the others.
      }
    }
  };

  return {
    live: true,
    publish(type, payload = {}) {
      const message = { type, at: Date.now(), ...payload };
      channel.postMessage(message);
      return true;
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      handlers.clear();
      channel.close();
    },
  };
}
