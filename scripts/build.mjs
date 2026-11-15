/**
 * Build the loadable extension folder.
 *
 * The problem this solves: the repo keeps sources under `src/`, which is good
 * hygiene, but Chrome's "Load unpacked" requires the selected folder to contain
 * `manifest.json` AT ITS ROOT. Shipping a repo and telling someone "pick the src
 * subfolder" is a trap — pick the wrong level and Chrome only says
 * "Manifest file is missing or unreadable", which sounds like a corrupt download
 * rather than a wrong click.
 *
 * So the distributable is a flat folder whose root IS the extension. No choosing.
 *
 * Usage: node scripts/build.mjs [outdir]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'build/extension'));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.cpSync(SRC, OUT, { recursive: true });

// Fail loudly rather than shipping a folder Chrome will reject.
const manifestPath = path.join(OUT, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error('FATAL: manifest.json is not at the root of the build output.');
  process.exit(1);
}

// THERE IS NO SERVICE WORKER. The dashboard page does the work itself.
//
// This extension used to ship a background worker, and when Chrome refused to
// register it ("Service worker registration failed. Status code: 2" — often just
// a corrupted browser profile) every single feature died at once with no
// recourse for the user. Nothing the worker did actually required a worker:
// IndexedDB, chrome.storage and chrome.tabs are all available to an extension
// page, and a page is not killed mid-task the way an idle MV3 worker is.

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const required = [
  manifest.options_page,
  manifest.action?.default_popup,
  ...(manifest.content_scripts ?? []).flatMap((c) => c.js ?? []),
  ...(manifest.web_accessible_resources ?? []).flatMap((w) => w.resources ?? []),
  ...Object.values(manifest.icons ?? {}),
].filter(Boolean);

// web_accessible_resources may be a glob ("app/*"); resolve it to its directory.
const missing = required.filter((f) => {
  const target = f.includes('*') ? f.slice(0, f.indexOf('*')).replace(/\/$/, '') : f;
  return !fs.existsSync(path.join(OUT, target));
});
if (missing.length) {
  console.error(`FATAL: build output is missing files the manifest references:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

const count = (function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? walk(path.join(dir, e.name)) : 1), 0);
})(OUT);

console.log(`Built ${path.relative(ROOT, OUT)}/`);
console.log(`  manifest.json at root: yes`);
console.log(`  ${count} files, all manifest references resolve`);
console.log(`\nLoad this exact folder in chrome://extensions -> Load unpacked.`);
