/**
 * Toolbar popup logic.
 *
 * Classic script, no imports: a popup page loaded with <script src> is not a
 * module, and this file must never depend on a service worker being alive —
 * there is none. Everything here uses chrome.tabs directly, so the icon works
 * from the browser itself and cannot report a worker that does not exist as
 * "not responding".
 */

const APP_URL = 'app/index.html';

function setStatus(text, warn) {
  const node = document.getElementById('status');
  if (!node) return;
  node.textContent = text;
  node.className = warn ? 'popup__status popup__status--warn' : 'popup__status';
}

/** Open the dashboard in a tab, reusing one that is already open. */
async function openDashboard(params) {
  const base = chrome.runtime.getURL(APP_URL);
  const query = new URLSearchParams(params || {}).toString();
  const url = query ? `${base}?${query}` : base;

  try {
    const existing = await chrome.tabs.query({ url: `${base}*` });
    if (existing.length > 0) {
      await chrome.tabs.update(existing[0].id, { active: true, url });
      if (existing[0].windowId != null) {
        await chrome.windows.update(existing[0].windowId, { focused: true });
      }
      window.close();
      return;
    }
  } catch {
    // Reusing a tab is a nicety; opening one is the job.
  }

  await chrome.tabs.create({ url });
  window.close();
}

document.getElementById('open-dashboard').addEventListener('click', () => {
  openDashboard().catch((err) => setStatus(`Could not open the dashboard: ${err.message}`, true));
});

document.getElementById('open-people')?.addEventListener('click', () => {
  openDashboard({ tab: 'people' }).catch((err) => setStatus(`Could not open the dashboard: ${err.message}`, true));
});

document.getElementById('open-outreach').addEventListener('click', () => {
  openDashboard({ tab: 'outreach' }).catch((err) => setStatus(`Could not open the dashboard: ${err.message}`, true));
});

/**
 * Report what is available, asking nothing of any background script. The answer
 * comes from chrome.tabs, so it is either true or a real browser error worth
 * naming — never a guess about a worker.
 */
(async function showStatus() {
  try {
    const tabs = await chrome.tabs.query({ url: ['*://*.instagram.com/*'] });
    const profiles = tabs.filter((tab) => {
      const match = /instagram\.com\/([^/?#]+)/.exec(tab.url ?? '');
      return match && !['p', 'reel', 'reels', 'explore', 'accounts', 'direct', 'stories'].includes(match[1].toLowerCase());
    });
    if (profiles.length === 0) {
      setStatus('No Instagram profile tab open yet. Open one, then collect from it.');
      return;
    }
    setStatus(`${profiles.length} Instagram profile tab${profiles.length === 1 ? '' : 's'} open.`);
  } catch (err) {
    setStatus(`Could not read your tabs: ${err.message}`, true);
  }
}());
