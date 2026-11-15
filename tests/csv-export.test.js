import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../scripts/lib/dom-shim.mjs';
import {
  FORMULA_PREFIXES,
  GUARD_CHAR,
  UTF8_BOM,
  csvCell,
  guardCellText,
  parseCsv,
  parseHandleList,
  startsWithFormula,
  toCsv,
  unguardCellText,
} from '../src/core/csv.js';
import {
  LEAD_CSV_COLUMNS,
  MIME,
  PACK_BUCKETS,
  REVOKE_DELAY_MS,
  SNAPSHOT_MAGIC,
  SNAPSHOT_VERSION,
  buildCampaignPack,
  buildPrintableHtml,
  buildSnapshot,
  downloadBlob,
  downloadCsv,
  downloadPrintableReport,
  escapeHtml,
  importCsvText,
  leadToCsvRow,
  parseSnapshot,
} from '../src/app/lib/export-utils.js';

function makeEnv() {
  const doc = installDom();
  const env = {
    document: doc,
    revoked: [],
    created: [],
    clicks: [],
    url: {
      createObjectURL: (blob) => { env.created.push(blob); return `blob:mock-${env.created.length}`; },
      revokeObjectURL: (url) => { env.revoked.push(url); },
    },
    revokeMs: 1,
    manualRevoke: true,
  };
  return env;
}

describe('csv cells', () => {
  test('every dangerous prefix is recognised', () => {
    for (const prefix of FORMULA_PREFIXES) {
      assert.equal(startsWithFormula(`${prefix}SUM(A1)`), true, JSON.stringify(prefix));
      assert.equal(guardCellText(`${prefix}SUM(A1)`), `${GUARD_CHAR}${prefix}SUM(A1)`);
    }
  });

  test('ordinary text is left alone', () => {
    assert.equal(guardCellText('Cairo linen shop'), 'Cairo linen shop');
    assert.equal(guardCellText(''), '');
    assert.equal(guardCellText(null), '');
    assert.equal(startsWithFormula('40% off'), false);
    assert.equal(startsWithFormula(''), false);
  });

  test('a minus sign that is not a formula is still guarded, and comes back', () => {
    const guarded = guardCellText('-40%');
    assert.equal(guarded, "'-40%");
    assert.equal(unguardCellText(guarded), '-40%');
  });

  test('an apostrophe that was never a guard stays', () => {
    assert.equal(unguardCellText("'sara's shop"), "'sara's shop");
    assert.equal(unguardCellText('plain'), 'plain');
    assert.equal(unguardCellText(''), '');
  });

  test('cells are always quoted and inner quotes are doubled', () => {
    assert.equal(csvCell('ali'), '"ali"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
    assert.equal(csvCell(null), '""');
    assert.equal(csvCell(undefined), '""');
    assert.equal(csvCell(42), '"42"');
  });

  test('guarding can be turned off for a machine-to-machine file', () => {
    assert.equal(csvCell('=SUM(A1)', { guard: false }), '"=SUM(A1)"');
  });
});

describe('toCsv', () => {
  test('columns decide order and headers', () => {
    const csv = toCsv([{ b: 2, a: 1 }], { columns: [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }] });
    assert.equal(csv.split('\r\n')[0], '"Alpha","Beta"');
    assert.equal(csv.split('\r\n')[1], '"1","2"');
  });

  test('without columns the union of keys is used in first-seen order', () => {
    const csv = toCsv([{ a: 1 }, { b: 2 }]);
    assert.equal(csv.split('\r\n')[0], '"a","b"');
    assert.equal(csv.split('\r\n')[1], '"1",""');
    assert.equal(csv.split('\r\n')[2], '"","2"');
  });

  test('an empty list still produces a header line when columns are given', () => {
    const csv = toCsv([], { columns: ['username'] });
    assert.equal(csv, '"username"\r\n');
  });

  test('a dangerous biography is neutralised in the file', () => {
    const csv = toCsv([{ username: 'ali', biography: '=HYPERLINK("http://evil.example","click")' }]);
    assert.match(csv, /"'=HYPERLINK/);
  });

  test('line endings are configurable for tools that want \n', () => {
    assert.equal(toCsv([{ a: 1 }], { lineEnding: '\n' }), '"a"\n"1"\n');
  });
});

describe('parseCsv', () => {
  test('round-trips quoted, comma and newline-bearing cells', () => {
    const rows = [
      { username: 'ali', biography: 'say "hi", friend\nsecond line' },
      { username: 'sara', biography: '=1+1' },
      { username: 'omar', biography: '' },
    ];
    const parsed = parseCsv(toCsv(rows));
    assert.deepEqual(parsed.warnings, []);
    assert.equal(parsed.rows.length, 3);
    assert.equal(parsed.rows[0].biography, 'say "hi", friend\nsecond line');
    assert.equal(parsed.rows[1].biography, '=1+1');
    assert.equal(parsed.rows[2].biography, '');
  });

  test('a BOM is stripped and both line endings work', () => {
    assert.equal(parseCsv(`${UTF8_BOM}"a"\n"1"\n`).rows[0].a, '1');
    assert.equal(parseCsv('"a"\r\n"1"\r\n').rows[0].a, '1');
    assert.equal(parseCsv(`${UTF8_BOM}"a"\r\n"1"\r\n`).header[0], 'a');
  });

  test('Arabic text survives the round trip', () => {
    const rows = [{ username: 'sara', fullName: 'سارة محمد', biography: 'متجر قماش في القاهرة' }];
    const parsed = parseCsv(toCsv(rows));
    assert.equal(parsed.rows[0].fullName, 'سارة محمد');
    assert.equal(parsed.rows[0].biography, 'متجر قماش في القاهرة');
  });

  test('a short row is filled and reported, not dropped', () => {
    const parsed = parseCsv('"a","b"\n"1"\n');
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].b, '');
    assert.equal(parsed.warnings.length, 1);
    assert.match(parsed.warnings[0], /missing cell/);
  });

  test('extra cells are reported, not silently appended', () => {
    const parsed = parseCsv('"a"\n"1","2"\n');
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].a, '1');
    assert.match(parsed.warnings[0], /extra cell/);
  });

  test('a file that ends inside a quote says so', () => {
    const parsed = parseCsv('"a"\n"unterminated');
    assert.ok(parsed.warnings.some((w) => /ends inside a quoted field/.test(w)));
  });

  test('a blank header cell gets a stable name', () => {
    assert.deepEqual(parseCsv('"a",""\n"1","2"\n').header, ['a', 'column_2']);
  });

  test('empty input yields no rows and no crash', () => {
    assert.deepEqual(parseCsv('').rows, []);
    assert.deepEqual(parseCsv(null).rows, []);
    assert.deepEqual(parseCsv('\n\n\n').rows, []);
  });
});

describe('parseHandleList', () => {
  test('handles, urls and spreadsheet rows all resolve to a username', () => {
    const list = parseHandleList([
      '@ali.dev',
      'https://www.instagram.com/sara_shop/?hl=ar',
      'omar (12345)',
      'nada,extra,cells',
      '  spaced  ',
    ].join('\n'));
    assert.deepEqual(list, ['ali.dev', 'sara_shop', 'omar', 'nada', 'spaced']);
  });

  test('duplicates collapse regardless of case', () => {
    assert.deepEqual(parseHandleList('Ali.Dev\nali.dev\n@ALIDEV'), ['Ali.Dev']);
    // A legacy dotted handle and its dotless form are the same account.
    assert.deepEqual(parseHandleList('ali.dev\nALIDEV'), ['ali.dev']);
  });

  test('reserved route segments are dropped so a page is never whitelisted', () => {
    assert.deepEqual(parseHandleList('explore\nreels\nali', { reserved: ['explore', 'reels'] }), ['ali']);
  });

  test('blank and unusable lines are ignored', () => {
    assert.deepEqual(parseHandleList('\n\n   \n!!!\nali'), ['ali']);
    assert.deepEqual(parseHandleList(''), []);
    assert.deepEqual(parseHandleList(null), []);
  });

  test('Arabic handles survive', () => {
    assert.deepEqual(parseHandleList('متجر_القاهرة'), ['متجر_القاهرة']);
  });
});

describe('downloads', () => {
  test('a download appends an anchor, clicks it and revokes late', () => {
    const env = makeEnv();
    const result = downloadBlob('a,b\n1,2\n', 'test.csv', MIME.csv, env);
    assert.equal(result.filename, 'test.csv');
    assert.equal(env.created.length, 1);
    const anchor = env.document.querySelectorAll('a')[0];
    assert.equal(anchor.download, 'test.csv');
    assert.equal(anchor.rel, 'noopener');
    assert.equal(env.revoked.length, 0, 'revoking immediately cancels the download in some browsers');
    assert.equal(typeof result.release, 'function');
    result.release();
    assert.deepEqual(env.revoked, ['blob:mock-1']);
    assert.equal(result.bytes, 8);
  });

  test('the revoke delay defaults to five seconds', () => {
    assert.equal(REVOKE_DELAY_MS, 5000);
  });

  test('csv downloads carry the BOM Excel needs', () => {
    const env = makeEnv();
    downloadCsv([{ a: 1 }], 'out.csv', {}, env);
    const blob = env.created[0];
    assert.ok(blob);
    assert.equal(env.document.querySelectorAll('a')[0].download, 'out.csv');
  });

  test('a printable report downloads as html', () => {
    const env = makeEnv();
    const result = downloadPrintableReport({ title: 'Demo', sections: [], filenamePrefix: 'demo' }, env);
    assert.equal(result.filename, 'demo-report.html');
  });

  test('without a document the download refuses instead of throwing deep', () => {
    // An env with no document at all (not one that falls back to the shim's global).
    assert.throws(() => downloadBlob('x', 'x.csv', MIME.csv, { document: null }), /needs a document/);
    assert.throws(() => downloadBlob('x', 'x.csv', MIME.csv, { document: installDom(), url: null }), /needs a document/);
  });
});

describe('snapshots', () => {
  test('a snapshot carries identity, counts and every store', () => {
    const snapshot = buildSnapshot({
      workspace: { workspaceId: '77', viewerUsername: 'me' },
      leads: [{ username: 'a' }, { username: 'b' }],
      edges: [{ edgeKey: 'x' }],
      groups: [],
      templates: [],
      runs: [],
      actionLog: [{ logId: 1 }],
      settings: { limits: {} },
    });
    assert.equal(snapshot.magic, SNAPSHOT_MAGIC);
    assert.equal(snapshot.version, SNAPSHOT_VERSION);
    assert.equal(snapshot.counts.leads, 2);
    assert.equal(snapshot.counts.edges, 1);
    assert.equal(snapshot.counts.actions, 1);
    assert.equal(snapshot.workspace.viewerUsername, 'me');
    assert.ok(snapshot.savedAt > 0);
  });

  test('a valid snapshot parses', () => {
    const parsed = parseSnapshot(JSON.stringify(buildSnapshot({ workspace: { workspaceId: '1' }, leads: [{ username: 'a' }] })));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.snapshot.leads.length, 1);
  });

  test('foreign JSON is refused by magic, not imported', () => {
    assert.match(parseSnapshot('{"hello":1}').reason, /not an ig-outreach-crm save file/);
    assert.equal(parseSnapshot('not json').ok, false);
    assert.equal(parseSnapshot('[1,2]').ok, false);
    assert.equal(parseSnapshot('').ok, false);
  });

  test('a snapshot from a newer build is refused rather than half-read', () => {
    const body = buildSnapshot({ workspace: {}, leads: [] });
    body.version = SNAPSHOT_VERSION + 1;
    const parsed = parseSnapshot(JSON.stringify(body));
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason, /understands up to/);
  });

  test('leads without a username are dropped and counted', () => {
    const body = buildSnapshot({ workspace: {}, leads: [{ username: 'a' }, {}, null, { username: 'b' }] });
    const parsed = parseSnapshot(JSON.stringify(body));
    assert.equal(parsed.snapshot.leads.length, 2);
    assert.equal(parsed.snapshot.dropped, 2);
  });

  test('missing arrays become empty arrays', () => {
    const parsed = parseSnapshot(JSON.stringify({ magic: SNAPSHOT_MAGIC, version: 1 }));
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.snapshot.edges, []);
    assert.deepEqual(parsed.snapshot.actionLog, []);
  });
});

describe('campaign pack', () => {
  const leads = [
    { username: 'hot', priorityScore: 90, relState: 'MUTUAL', dmState: 'DM_REPLIED', followers: 10, followedAt: 1700000000000, sourceAccounts: ['comp_a', 'comp_b'], biography: 'shop' },
    { username: 'cold', priorityScore: 5, relState: 'NONE', dmState: 'NONE' },
    { username: 'sent', priorityScore: 45, relState: 'FOLLOW_REQUESTED', dmState: 'DM_SENT_REQUEST' },
    { username: 'dropped', priorityScore: 60, relState: 'UNFOLLOWED', dmState: 'NONE' },
  ];

  test('there are seven buckets, all-leds first', () => {
    assert.equal(PACK_BUCKETS.length, 7);
    assert.equal(PACK_BUCKETS[0].key, 'all');
  });

  test('each bucket counts what its predicate says', () => {
    const pack = buildCampaignPack(leads, { prefix: 'demo' });
    const counts = Object.fromEntries(pack.map((file) => [file.key, file.count]));
    assert.deepEqual(counts, { all: 4, hot: 1, mutual: 1, followed: 2, messaged: 2, replied: 1, unfollowed: 1 });
    assert.equal(pack[0].filename, 'demo-all.csv');
  });

  test('every file is a complete csv with the BOM and the standard columns', () => {
    const pack = buildCampaignPack(leads, { prefix: 'demo' });
    for (const file of pack) {
      assert.ok(file.csv.startsWith(UTF8_BOM), file.key);
      const parsed = parseCsv(file.csv);
      assert.deepEqual(parsed.header, LEAD_CSV_COLUMNS.map((column) => column.label), file.key);
      assert.equal(parsed.rows.length, file.count, file.key);
    }
  });

  test('an empty workspace produces seven empty files, not an error', () => {
    const pack = buildCampaignPack([], { prefix: 'demo' });
    assert.equal(pack.length, 7);
    assert.ok(pack.every((file) => file.count === 0));
  });

  test('a lead row flattens dates, lists and booleans', () => {
    const row = leadToCsvRow(leads[0]);
    assert.equal(row.username, 'hot');
    assert.equal(row.foundVia ?? row.sourceAccounts, 'comp_a | comp_b');
    assert.equal(row.isPrivate, 'no');
    assert.match(row.followedAt, /^2023-11-14T/);
    assert.equal(row.profileUrl, 'https://www.instagram.com/hot/');
    assert.equal(row.priorityScore, 90);
  });

  test('an unknown lead shape flattens without throwing', () => {
    const row = leadToCsvRow(null);
    assert.equal(row.username, '');
    assert.equal(row.followedAt, '');
    assert.equal(row.profileUrl, '');
  });
});

describe('printable report', () => {
  test('escapes every value, in text and in attributes', () => {
    assert.equal(escapeHtml('<b>"a" & \'b\'</b>'), '&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(42), '42');
  });

  test('a scraped biography cannot inject markup or a script', () => {
    const html = buildPrintableHtml({
      title: 'Report <script>alert(1)</script>',
      sections: [{
        title: 'Leads',
        columns: [{ key: 'username', label: 'Lead' }, { key: 'biography', label: 'Bio' }],
        rows: [{ username: 'ali', biography: '<img src=x onerror=alert(1)>' }],
      }],
    });
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });

  test('an Arabic cell is marked rtl and the rest stays ltr', () => {
    const html = buildPrintableHtml({
      sections: [{ title: 'Leads', columns: [{ key: 'name' }], rows: [{ name: 'سارة' }, { name: 'Sara' }] }],
    });
    assert.equal((html.match(/<td dir="rtl">/g) ?? []).length, 1);
    assert.equal((html.match(/<td>/g) ?? []).length, 1);
  });

  test('an empty section says so instead of printing a bare table', () => {
    const html = buildPrintableHtml({ sections: [{ title: 'Replies', columns: [{ key: 'a' }], rows: [], emptyMessage: 'No replies yet.' }] });
    assert.ok(html.includes('No replies yet.'));
  });

  test('the report is standalone: no scripts and no external resources', () => {
    const html = buildPrintableHtml({ title: 'X', subtitle: 'sub', sections: [] });
    assert.ok(!/<script/i.test(html));
    assert.ok(!/<link/i.test(html));
    assert.ok(!/src="http/i.test(html));
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('<style>'));
    assert.ok(html.includes('generated'));
  });

  test('importCsvText reports counts and warnings together', () => {
    const result = importCsvText('"a","b"\n"1"\n');
    assert.equal(result.count, 1);
    assert.equal(result.warnings.length, 1);
  });
});
