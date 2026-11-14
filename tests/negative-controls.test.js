/**
 * NEGATIVE CONTROLS.
 *
 * A test that has never been observed failing is an assumption wearing a test's
 * clothing. This file proves the suite has teeth: for each rule that matters it
 * copies the source tree to a temp dir, deliberately breaks the implementation,
 * runs the real test suite against the broken copy, and asserts that the suite
 * fails — naming the guard that must catch it.
 *
 * If a mutation survives, the guarding test is decorative and this file fails.
 * The mutations are applied to a throwaway copy; the real tree is untouched.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let workdir;

before(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-crm-mutants-'));
});

after(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

function freshCopy(name) {
  const dest = path.join(workdir, name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(path.join(ROOT, 'src'), path.join(dest, 'src'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'tests'), path.join(dest, 'tests'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'package.json'), path.join(dest, 'package.json'));
  // Without this the mutation run would recurse into itself forever.
  fs.rmSync(path.join(dest, 'tests', 'negative-controls.test.js'), { force: true });
  return dest;
}

/** Literal replacement; throws when the anchor moves, so a refactor turns a
 *  control into a loud failure instead of a silent no-op. */
function mutate(dest, relPath, from, to) {
  const file = path.join(dest, relPath);
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(
    src.includes(from),
    `Mutation anchor missing in ${relPath}: ${JSON.stringify(from.slice(0, 70))}. Update this control.`,
  );
  fs.writeFileSync(file, src.replace(from, to));
}

/**
 * Run one copied suite in a clean child process.
 *
 * NODE_TEST_CONTEXT must be stripped: this file is itself run by node --test,
 * and a child that inherits the variable prints a recursion warning and exits
 * 0 WITHOUT RUNNING ANYTHING — silence that a naive harness would read as
 * "mutation survived". We therefore also refuse a run with no TAP results.
 */
function runSuite(dest, testFile) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  let stdout = '';
  let failed = false;
  try {
    stdout = execFileSync(process.execPath, ['--test', `tests/${testFile}`], {
      cwd: dest,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    failed = true;
    stdout = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  assert.ok(/# (tests|pass)/.test(stdout), 'the child run produced no TAP output at all');
  return { failed, stdout };
}

/** Assert the suite FAILS on this mutation, and says which test failed. */
function expectCaught(name, relPath, mutations, testFile, expectTestName) {
  test(`mutation survives no test: ${name}`, () => {
    const dest = freshCopy(name.replace(/\W+/g, '-'));
    for (const [from, to] of mutations) mutate(dest, relPath, from, to);
    const { failed, stdout } = runSuite(dest, testFile);
    assert.ok(failed, `the suite PASSED with ${name} broken — the guard is decorative`);
    assert.match(stdout, /not ok/, 'the suite failed without naming a test');
    if (expectTestName) {
      assert.ok(
        stdout.includes(expectTestName),
        `the failure did not come from "${expectTestName}" — something else broke first`,
      );
    }
  });
}

expectCaught(
  'the one-message lock on unaccepted requests',
  'src/core/lifecycle.js',
  [
    ['if (dm === DmState.DM_SENT_REQUEST && rel !== RelState.MUTUAL && rel !== RelState.FOLLOWED_BY_ONLY && dm !== DmState.DM_REPLIED) {', 'if (false) {'],
  ],
  'lifecycle.test.js',
  'a second request message is refused until answered',
);

expectCaught(
  'the 48-hour unfollow grace floor',
  'src/core/lifecycle.js',
  [['export const MIN_UNFOLLOW_GRACE_MS = 48 * 60 * 60 * 1000;', 'export const MIN_UNFOLLOW_GRACE_MS = 0;']],
  'lifecycle.test.js',
  'the 48h floor cannot be configured away',
);

expectCaught(
  'the hard daily follow ceiling',
  'src/core/governor.js',
  [['  followsPerDay: 140,', '  followsPerDay: 9999,']],
  'governor.test.js',
  'no stored value can exceed a hard ceiling',
);

expectCaught(
  'the 48-hour circuit breaker',
  'src/core/governor.js',
  [['const hours = kind === \'challenge\' ? 24 : 48;', 'const hours = 0;']],
  'governor.test.js',
  'a tripped breaker locks writes for 48 hours, persisted',
);

expectCaught(
  'the log-normal delay bounds',
  'src/core/random.js',
  [
    // Both halves of the guarantee: the in-range retry and the final clamp.
    ['if (value >= min && value <= max) break;', 'if (true) break;'],
    ['return Math.round(Math.min(max, Math.max(min, value)));', 'return Math.round(value);'],
  ],
  'random.test.js',
  'log-normal delays stay inside the requested bounds',
);

expectCaught(
  'variable resolution before spintax parsing',
  'src/core/templates.js',
  [['return compileSpintax(resolveVariables(body, context)).render(rng).trim();', 'return resolveVariables(compileSpintax(body).render(rng), context).trim();']],
  'templates.test.js',
  '{{var|fallback}} resolves before spintax sees it',
);

expectCaught(
  'the 1000-byte message limit',
  'src/core/linter.js',
  [['export const MESSAGE_BYTE_LIMIT = 1000;', 'export const MESSAGE_BYTE_LIMIT = 100000;']],
  'linter.test.js',
  'enforces the 1000-byte UTF-8 message limit',
);

expectCaught(
  'settings clamping against the ceilings',
  'src/core/governor.js',
  [['    if (next !== value) {', '    if (false) {']],
  'storage.test.js',
  'stored values above a ceiling are corrected on the way in',
);

expectCaught(
  'provenance edge idempotency',
  'src/storage/db.js',
  [['return tx(Store.LEAD_EDGES, \'readwrite\', (s) => wrap(s.put(row)));', 'return tx(Store.LEAD_EDGES, \'readwrite\', (s) => wrap(s.add(row)));']],
  'storage.test.js',
  'the same provenance fact collected twice stays one row',
);

expectCaught(
  'the business-name refusal in salutations',
  'src/core/text.js',
  [['  if (looksLikeBusinessName(cleaned).business) return fallback;', '  if (false) return fallback;']],
  'text.test.js',
  'business names fall back in both scripts',
);
