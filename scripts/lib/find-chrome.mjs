/**
 * Locate a Chromium/Chrome binary for the browser-based checks.
 *
 * PATH alone is not enough. A locally installed browser (for example one fetched
 * with `npx @puppeteer/browsers install chromium`) lives at a versioned path that
 * is never on PATH, so checks that spawned the bare name 'chromium' died with
 * ENOENT on a machine that demonstrably had a working browser — which reads as a
 * product failure when it is only a missing binary.
 *
 * Order: an explicit override, then PATH, then the usual local install roots.
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function onPath(bin) {
  try {
    return execSync(`command -v ${bin}`, { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/** Newest first, so a freshly installed build wins over a stale one. */
function scanInstallRoot(root) {
  if (!existsSync(root)) return [];
  let entries;
  try { entries = readdirSync(root); } catch { return []; }
  return entries
    .sort()
    .reverse()
    .flatMap((dir) => [
      join(root, dir, 'chrome-linux', 'chrome'),
      join(root, dir, 'chrome-linux64', 'chrome'),
      join(root, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
      // @puppeteer/browsers nests a browser-named directory under --path, so an
      // install into ~/chromium lands at ~/chromium/chromium/linux-<rev>/...
      // Look one level deeper rather than silently reporting "no browser".
      ...(existsSync(join(root, dir)) ? scanNested(join(root, dir)) : []),
    ]);
}

/** One extra level, for the browser-named directory @puppeteer/browsers adds. */
function scanNested(root) {
  let entries;
  try { entries = readdirSync(root); } catch { return []; }
  return entries
    .sort()
    .reverse()
    .flatMap((dir) => [
      join(root, dir, 'chrome-linux', 'chrome'),
      join(root, dir, 'chrome-linux64', 'chrome'),
    ]);
}

export function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  for (const bin of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    const found = onPath(bin);
    if (found) return found;
  }

  const roots = [
    join(homedir(), 'chromium'),
    join(homedir(), '.cache', 'puppeteer', 'chrome'),
    join(homedir(), '.cache', 'puppeteer', 'chromium'),
    '/usr/lib/chromium',
  ];
  for (const root of roots) {
    for (const candidate of scanInstallRoot(root)) {
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}
