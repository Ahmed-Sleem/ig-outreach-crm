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
  const ready = Symbol.for('content_module_ready');
  if (globalThis[ready]) return;
  globalThis[ready] = true;
  try {
    const src = chrome.runtime.getURL('content/main.js');
    const mod = await import(src);
    mod.installMessageHandlers();
  } catch (err) {
    console.error('[IG Outreach CRM] content module failed to load:', err);
    try {
      chrome.runtime.sendMessage({
        type: 'CONTENT_LOAD_FAILED',
        payload: { error: String(err?.message ?? err), url: location.href },
      });
    } catch { /* no receiver listening; nothing else to do from here */ }
  }
})();
