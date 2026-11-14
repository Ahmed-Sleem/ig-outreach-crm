/**
 * Content-script loader (CLASSIC script — no static imports allowed here).
 *
 * MV3 content scripts declared in the manifest are not modules. A static import
 * at the top of this file throws a SyntaxError before a single line runs, and
 * the failure is nearly invisible: the extension simply does nothing on the
 * page. The supported pattern is this small loader, which dynamic-imports the
 * real module from web_accessible_resources.
 *
 * Keep this file dependency-free and boring.
 */
(async () => {
  if (window.__IG_CRM_CONTENT_LOADED__) return;
  window.__IG_CRM_CONTENT_LOADED__ = true;
  try {
    const src = chrome.runtime.getURL('content/main.js');
    const mod = await import(src);
    mod.installMessageHandlers();
  } catch (err) {
    // Surface the failure instead of dying silently: a dead content script is
    // the single most confusing failure mode in an extension like this.
    console.error('[IG Outreach CRM] content module failed to load:', err);
    try {
      chrome.runtime.sendMessage({
        type: 'CONTENT_LOAD_FAILED',
        payload: { error: String(err?.message ?? err), url: location.href },
      });
    } catch { /* no receiver listening; nothing else to do from here */ }
  }
})();
