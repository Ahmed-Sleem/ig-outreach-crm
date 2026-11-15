/**
 * Verify a built extension folder the way Chrome would load it.
 *
 * This exists because "the tests pass" says nothing about whether the packaged
 * artefact is loadable. Chrome fails an unpacked load on a single missing file,
 * and the error it shows is often unhelpful, so every reference is resolved here
 * before the zip is handed over.
 *
 * Usage: node scripts/check-package.mjs <folder>
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, normalize, dirname, relative } from 'node:path';

const root = process.argv[2] ?? 'build/extension';
const fail = [];
const ok = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function need(relPath, why) {
  // web_accessible_resources may use glob patterns ("app/*"). Resolve the
  // directory part and require that it exists and is not empty, rather than
  // looking for a file literally named "*".
  if (relPath.includes('*')) {
    const dir = relPath.slice(0, relPath.indexOf('*')).replace(/\/$/, '');
    const p = join(root, dir);
    if (existsSync(p) && readdirSync(p).length > 0) ok.push(`${why} -> ${relPath} (${readdirSync(p).length} entries)`);
    else fail.push(`${why} -> MISSING or empty ${relPath}`);
    return;
  }
  const p = join(root, relPath);
  if (existsSync(p)) ok.push(`${why} -> ${relPath}`);
  else fail.push(`${why} -> MISSING ${relPath}`);
}

const manifestPath = join(root, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`FATAL: no manifest.json at the root of ${root}.`);
  console.error('Chrome requires the manifest in the folder you select — not a subfolder.');
  process.exit(1);
}

const m = JSON.parse(readFileSync(manifestPath, 'utf-8'));

/* ---- every path the manifest names must exist ---- */
// No background worker by design: the dashboard page owns all logic, so there is
// nothing that can fail to register and take the whole extension down with it.
if (m.background) {
  console.error('FATAL: manifest declares a background worker. This extension deliberately has none.');
  process.exit(1);
}
if (m.options_page) need(m.options_page, 'options_page');
if (m.action?.default_popup) need(m.action.default_popup, 'action.default_popup');
for (const cs of m.content_scripts ?? []) for (const j of cs.js ?? []) need(j, 'content_scripts.js');
for (const war of m.web_accessible_resources ?? []) for (const r of war.resources ?? []) need(r, 'web_accessible_resources');
for (const [size, p] of Object.entries(m.icons ?? {})) need(p, `icons.${size}`);

/* ---- every relative import must resolve ---- */
const files = walk(root);
let imports = 0;
for (const f of files.filter((x) => x.endsWith('.js'))) {
  const src = readFileSync(f, 'utf-8');
  for (const mm of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    imports += 1;
    const target = normalize(join(dirname(f), mm[1]));
    if (!existsSync(target)) fail.push(`import in ${relative(root, f)} -> MISSING ${mm[1]}`);
  }
}

/* ---- every local asset an HTML page references must exist ---- */
let htmlRefs = 0;
for (const f of files.filter((x) => x.endsWith('.html'))) {
  const src = readFileSync(f, 'utf-8');
  for (const mm of src.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
    htmlRefs += 1;
    const target = normalize(join(dirname(f), mm[1]));
    if (!existsSync(target)) fail.push(`html ref in ${relative(root, f)} -> MISSING ${mm[1]}`);
  }
}

/* ---- MV3 rules that silently break an extension ---- */
// A manifest-declared content script is a CLASSIC script. A static import throws
// a SyntaxError before any line runs, and the extension simply does nothing.
for (const cs of m.content_scripts ?? []) {
  for (const j of cs.js ?? []) {
    const p = join(root, j);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, 'utf-8');
    if (/^\s*import\s+[^(]/m.test(src)) {
      fail.push(`${j} uses a STATIC import — a classic content script must use dynamic import()`);
    } else ok.push(`${j} has no static import (correct for a classic content script)`);
  }
}

// With no background worker, the toolbar icon MUST have a popup: chrome.action
// .onClicked can only be handled by a background script, so without a popup the
// icon would be inert.
if (m.action?.default_popup) {
  ok.push(`toolbar icon opens ${m.action.default_popup} (no worker needed)`);
} else {
  fail.push('action.default_popup is missing — with no background worker the toolbar icon would do nothing');
}

if (m.manifest_version !== 3) fail.push(`manifest_version is ${m.manifest_version}, expected 3`);
else ok.push('manifest_version 3');

const hosts = m.host_permissions ?? [];
const nonIg = hosts.filter((h) => !h.includes('instagram.com'));
if (nonIg.length) fail.push(`host_permissions reaches beyond Instagram: ${nonIg.join(', ')}`);
else ok.push(`host_permissions limited to Instagram (${hosts.join(', ')})`);

const csp = m.content_security_policy?.extension_pages ?? '';
if (!csp.includes("script-src 'self'")) fail.push(`CSP does not pin script-src to 'self': ${csp}`);
else ok.push("CSP pins script-src to 'self'");

console.log(`Checked ${files.length} files, ${imports} relative imports, ${htmlRefs} html refs.\n`);
for (const line of ok) console.log(`  ok   ${line}`);
if (fail.length) {
  console.log('');
  for (const line of fail) console.log(`  FAIL ${line}`);
  console.log(`\n${fail.length} problem(s). This folder would not load cleanly.`);
  process.exit(1);
}
console.log(`\nPackage OK — load "${root}" via chrome://extensions -> Load unpacked.`);
