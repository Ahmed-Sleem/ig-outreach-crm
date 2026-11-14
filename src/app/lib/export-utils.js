/**
 * Saving work out of the extension: CSV, JSON snapshot and a printable report.
 *
 * The CSV text itself is built by `core/csv.js`, which owns the formula-injection
 * guard. This file owns the browser half — the Blob, the object URL and the
 * download anchor — plus the campaign pack and the printable report.
 *
 * The printable report escapes every scraped string by hand. It is the one place
 * in the app that builds an HTML *string*, because the output has to open in a
 * browser with no extension code in it; the escaping is therefore total and
 * tested, and no other module may do this.
 *
 * Download flow adapted from InstagramUnfollowers (MIT, Copyright (c) 2022 David
 * Arroyo) — notably the delayed `revokeObjectURL`, without which Safari and some
 * Chrome versions cancel the download before it starts. See
 * THIRD_PARTY_NOTICES.md.
 */

import { UTF8_BOM, parseCsv, toCsv } from '../../core/csv.js';

export const MIME = Object.freeze({
  csv: 'text/csv;charset=utf-8',
  json: 'application/json;charset=utf-8',
  html: 'text/html;charset=utf-8',
});

/** Object URLs are revoked late: too early and the download never starts. */
export const REVOKE_DELAY_MS = 5000;

/**
 * Hand a Blob to the browser as a download.
 *
 * @param {string|Blob} content
 * @param {string} filename
 * @param {string} mime
 * @param {{document?: Document, revokeMs?: number, url?: object}} env
 */
export function downloadBlob(content, filename, mime = MIME.csv, env = {}) {
  const doc = env.document ?? (typeof document !== 'undefined' ? document : null);
  const urlApi = env.url ?? (typeof URL !== 'undefined' ? URL : null);
  if (!doc || !urlApi) throw new Error('downloadBlob needs a document and URL');

  const blob = content instanceof Blob
    ? content
    : new Blob([content], { type: mime });
  const objectUrl = urlApi.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = objectUrl;
  anchor.download = String(filename);
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  doc.body.append(anchor);
  anchor.click();

  const revokeMs = Number(env.revokeMs ?? REVOKE_DELAY_MS);
  const timer = typeof setTimeout === 'function'
    ? setTimeout(() => {
      urlApi.revokeObjectURL(objectUrl);
      anchor.remove?.();
    }, revokeMs)
    : null;
  return { filename: String(filename), bytes: blob.size ?? String(content).length, objectUrl, timer };
}

/** A CSV download, with the UTF-8 BOM Excel needs to detect Arabic correctly. */
export function downloadCsv(rows, filename, options = {}, env = {}) {
  const text = `${UTF8_BOM}${toCsv(rows, options)}`;
  return downloadBlob(text, filename, MIME.csv, env);
}

export function downloadJson(value, filename, env = {}) {
  return downloadBlob(JSON.stringify(value, null, 2), filename, MIME.json, env);
}

/** The file extension every full save uses, so a restore can recognise it. */
export const SNAPSHOT_EXTENSION = '.igcrm.json';

export const SNAPSHOT_MAGIC = 'ig-outreach-crm/snapshot';
export const SNAPSHOT_VERSION = 1;

/**
 * A full save point: everything needed to rebuild the workspace elsewhere.
 *
 * `merge` vs `replace` is decided at restore time, not here; the snapshot simply
 * carries enough identity (workspace id, viewer username, saved-at) for the
 * restore dialog to say what it is about to do.
 */
export function buildSnapshot({ workspace, leads = [], edges = [], groups = [], templates = [], runs = [], actionLog = [], snapshots = [], settings = null }) {
  return {
    magic: SNAPSHOT_MAGIC,
    version: SNAPSHOT_VERSION,
    savedAt: Date.now(),
    workspace: workspace ?? null,
    counts: {
      leads: leads.length,
      edges: edges.length,
      groups: groups.length,
      templates: templates.length,
      runs: runs.length,
      actions: actionLog.length,
    },
    leads,
    edges,
    groups,
    templates,
    runs,
    actionLog,
    snapshots,
    settings,
  };
}

/**
 * Validate something the owner picked from disk before it is written anywhere.
 *
 * A restore is the one path where untrusted JSON enters the database, so the
 * shape is checked field by field rather than spread into a row.
 */
export function parseSnapshot(text) {
  let body;
  try {
    body = JSON.parse(String(text ?? ''));
  } catch (error) {
    return { ok: false, snapshot: null, reason: `not valid JSON (${error.message})` };
  }
  if (!body || typeof body !== 'object') return { ok: false, snapshot: null, reason: 'the file is not an object' };
  if (body.magic !== SNAPSHOT_MAGIC) {
    return { ok: false, snapshot: null, reason: 'this is not an ig-outreach-crm save file' };
  }
  if (Number(body.version) > SNAPSHOT_VERSION) {
    return { ok: false, snapshot: null, reason: `this save file is version ${body.version}; this build understands up to ${SNAPSHOT_VERSION}` };
  }
  const leads = Array.isArray(body.leads) ? body.leads.filter((row) => row && typeof row === 'object' && row.username) : [];
  return {
    ok: true,
    reason: null,
    snapshot: {
      ...body,
      leads,
      edges: Array.isArray(body.edges) ? body.edges : [],
      groups: Array.isArray(body.groups) ? body.groups : [],
      templates: Array.isArray(body.templates) ? body.templates : [],
      runs: Array.isArray(body.runs) ? body.runs : [],
      actionLog: Array.isArray(body.actionLog) ? body.actionLog : [],
      dropped: (Array.isArray(body.leads) ? body.leads.length : 0) - leads.length,
    },
  };
}

/* ------------------------------------------------------------- campaign pack */

/**
 * The seven buckets a campaign is judged by.
 *
 * One file per bucket, plus the full list, so the owner can hand "replied" to a
 * colleague without handing over the whole database. The predicates read the
 * lifecycle states rather than guessing from timestamps.
 */
export const PACK_BUCKETS = Object.freeze([
  { key: 'all', label: 'All leads', test: () => true },
  { key: 'hot', label: 'Hot leads (score 70+)', test: (lead) => Number(lead?.priorityScore ?? 0) >= 70 },
  { key: 'mutual', label: 'Mutual follows', test: (lead) => lead?.relState === 'MUTUAL' },
  { key: 'followed', label: 'Followed by campaign', test: (lead) => ['FOLLOWING', 'FOLLOW_REQUESTED', 'MUTUAL'].includes(lead?.relState) },
  { key: 'messaged', label: 'Messaged', test: (lead) => ['DM_SENT_PRIMARY', 'DM_SENT_REQUEST', 'DM_REPLIED'].includes(lead?.dmState) },
  { key: 'replied', label: 'Replied', test: (lead) => lead?.dmState === 'DM_REPLIED' },
  { key: 'unfollowed', label: 'Unfollowed or withdrawn', test: (lead) => ['UNFOLLOWED', 'REQUEST_WITHDRAWN'].includes(lead?.relState) },
]);

/** The columns every exported lead file carries, in this order. */
export const LEAD_CSV_COLUMNS = Object.freeze([
  { key: 'username', label: 'username' },
  { key: 'fullName', label: 'full name' },
  { key: 'priorityScore', label: 'priority score' },
  { key: 'warmthTier', label: 'warmth' },
  { key: 'relState', label: 'relationship' },
  { key: 'dmState', label: 'dm state' },
  { key: 'followers', label: 'followers' },
  { key: 'following', label: 'following' },
  { key: 'isPrivate', label: 'private' },
  { key: 'isBusiness', label: 'business' },
  { key: 'intentLabel', label: 'intent' },
  { key: 'edgeCount', label: 'signals' },
  { key: 'sourceAccounts', label: 'found via' },
  { key: 'followedAt', label: 'followed at' },
  { key: 'messagedAt', label: 'messaged at' },
  { key: 'repliedAt', label: 'replied at' },
  { key: 'biography', label: 'biography' },
  { key: 'profileUrl', label: 'profile url' },
]);

/** Flatten a lead into the exported row shape. Dates become ISO strings. */
export function leadToCsvRow(lead) {
  const iso = (value) => (value ? new Date(Number(value)).toISOString() : '');
  const list = (value) => (Array.isArray(value) ? value.join(' | ') : String(value ?? ''));
  return {
    username: lead?.username ?? '',
    fullName: lead?.fullName ?? '',
    priorityScore: Number.isFinite(Number(lead?.priorityScore)) ? Number(lead.priorityScore) : '',
    warmthTier: lead?.warmthTier ?? '',
    relState: lead?.relState ?? '',
    dmState: lead?.dmState ?? '',
    followers: lead?.followers ?? '',
    following: lead?.following ?? '',
    isPrivate: lead?.isPrivate ? 'yes' : 'no',
    isBusiness: lead?.isBusiness ? 'yes' : 'no',
    intentLabel: lead?.intentLabel ?? '',
    edgeCount: lead?.edgeCount ?? '',
    sourceAccounts: list(lead?.sourceAccounts),
    followedAt: iso(lead?.followedAt),
    messagedAt: iso(lead?.messagedAt),
    repliedAt: iso(lead?.repliedAt),
    biography: lead?.biography ?? '',
    profileUrl: lead?.username ? `https://www.instagram.com/${lead.username}/` : '',
  };
}

/**
 * Build every bucket file. Returns `{ key, label, filename, csv, count }` per
 * bucket so the UI can render a list with real counts and disable empty ones.
 */
export function buildCampaignPack(leads, { prefix = 'igcrm', buckets = PACK_BUCKETS } = {}) {
  const list = Array.isArray(leads) ? leads : [];
  return buckets.map((bucket) => {
    const rows = list.filter((lead) => bucket.test(lead)).map(leadToCsvRow);
    return {
      key: bucket.key,
      label: bucket.label,
      filename: `${prefix}-${bucket.key}.csv`,
      count: rows.length,
      csv: `${UTF8_BOM}${toCsv(rows, { columns: LEAD_CSV_COLUMNS })}`,
    };
  });
}

/* ------------------------------------------------------------ printed report */

/** Escape for an HTML text node or a double-quoted attribute. Total, not partial. */
export function escapeHtml(value) {
  return String(value ?? '')
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&#39;');
}

/**
 * A standalone printable report. No scripts, no external resources: it has to
 * open from disk and print identically offline.
 *
 * Direction is set per cell from the text itself, so an Arabic display name
 * renders right-to-left inside an English report.
 */
export function buildPrintableHtml({ title = 'Instagram outreach report', subtitle = null, sections = [], generatedAt = Date.now() } = {}) {
  const dirOf = (text) => (isRtlText(text) ? ' dir="rtl"' : '');
  const cell = (value) => `<td${dirOf(value)}>${escapeHtml(value)}</td>`;

  const body = sections.map((section) => {
    const rows = (section.rows ?? [])
      .map((row) => `<tr>${(section.columns ?? []).map((column) => cell(row?.[column.key] ?? '')).join('')}</tr>`)
      .join('\n');
    const head = (section.columns ?? []).map((column) => `<th>${escapeHtml(column.label ?? column.key)}</th>`).join('');
    return `<section>
<h2>${escapeHtml(section.title)}</h2>
${section.note ? `<p class="note">${escapeHtml(section.note)}</p>` : ''}
<table>
<thead><tr>${head}</tr></thead>
<tbody>
${rows || `<tr><td colspan="${(section.columns ?? []).length || 1}">${escapeHtml(section.emptyMessage ?? 'Nothing in this section.')}</td></tr>`}
</tbody>
</table>
</section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", system-ui, "Noto Sans Arabic", sans-serif; margin: 32px; color: #14181f; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 28px 0 8px; border-bottom: 1px solid #d8dee9; padding-bottom: 4px; }
  .meta { color: #5b6675; font-size: 12px; margin-bottom: 24px; }
  .note { color: #5b6675; font-size: 12px; margin: 0 0 8px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d8dee9; padding: 5px 8px; text-align: left; vertical-align: top; }
  th { background: #f2f5f9; font-weight: 600; }
  td[dir="rtl"] { text-align: right; }
  @media print { body { margin: 12mm; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="meta">${escapeHtml(subtitle ?? '')} &middot; generated ${escapeHtml(new Date(generatedAt).toLocaleString('en'))}</div>
${body}
</body>
</html>
`;
}

export function downloadPrintableReport(options = {}, env = {}) {
  const html = buildPrintableHtml(options);
  const filename = `${options.filenamePrefix ?? 'igcrm'}-report.html`;
  return downloadBlob(html, filename, MIME.html, env);
}

/** Reuse the RTL test the UI already applies, so both agree. */
function isRtlText(text) {
  if (typeof text !== 'string' || !text) return false;
  const rtl = (text.match(/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g) ?? []).length;
  const ltr = (text.match(/[A-Za-z]/g) ?? []).length;
  return rtl > ltr;
}

/**
 * Import a CSV of handles or leads.
 *
 * Used by the whitelist manager and the legacy-account importer. Rows are
 * returned as plain objects plus the warnings `core/csv.js` produced, so the UI
 * can show "3 lines had extra cells" instead of silently dropping them.
 */
export function importCsvText(text) {
  const parsed = parseCsv(text);
  return { ...parsed, count: parsed.rows.length };
}
