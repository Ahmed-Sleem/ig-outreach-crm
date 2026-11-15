/**
 * Dedicated Web Worker: an unthrottled 1 Hz tick for the autopilot telemetry.
 *
 * Why a worker rather than a setInterval in the page.
 *
 * Chrome throttles timers in a backgrounded tab to roughly once a minute. The
 * dashboard is exactly the tab an owner backgrounds: he opens it, starts a run,
 * then switches to the managed Instagram window to watch the autopilot work. At
 * that moment the page's own setInterval("update the countdown", 1000) would
 * silently slow to a crawl, and the telemetry strip — the one thing he left
 * visible to trust — would freeze on a stale "Next follow in 01:42".
 *
 * A dedicated worker is not throttled the way a hidden page is, so it keeps
 * beating once a second. It owns no state and touches no chrome.* API: it is a
 * metronome. The page listens for `tick` and recomputes every countdown from the
 * wall clock, so a tick that arrives late still renders the right number.
 *
 * Classic worker, no imports — it is spawned with `new Worker(url)` from the
 * dashboard page and must not depend on the module graph resolving.
 */

let timer = null;
let rateMs = 1000;

function beat() {
  // `at` is stamped here, in the worker, so the page can tell a late tick from a
  // late render: if two ticks arrive together after a stall, their `at` values
  // still differ by the real elapsed time.
  self.postMessage({ type: 'tick', at: Date.now() });
}

function start(ms) {
  stop();
  // Floor the rate: a page that asks for a 1 ms tick would burn a core for no
  // benefit, since every consumer of this beat only needs one update a second.
  rateMs = Math.max(250, Number(ms) || 1000);
  timer = setInterval(beat, rateMs);
}

function stop() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

self.onmessage = (event) => {
  const data = event?.data ?? {};
  if (data.type === 'start') start(data.intervalMs);
  else if (data.type === 'stop') stop();
  else if (data.type === 'ping') self.postMessage({ type: 'pong', at: Date.now(), rateMs });
};

// Begin beating immediately: the page should not have to remember to start the
// metronome before the first second of a run is already gone.
start(1000);
