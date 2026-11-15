/**
 * Save / Import / Export.
 *
 * Three jobs that all answer one worry: "what happens to my library?"
 *
 *  - Export hands the data OUT (CSV for a spreadsheet, a printable report for a
 *    client, a .igcrm.json save file for a full restore on another machine).
 *  - Save points keep a restore point IN this browser's IndexedDB, so a bad
 *    campaign can be rolled back without ever having exported a file.
 *  - Import brings data back IN, merging rather than replacing: a restore must
 *    not erase work done since the save.
 *
 * A restore is the one path where untrusted JSON enters the database, so it is
 * validated by parseSnapshot field by field before a single row is written.
 */

import { btn, card, el, clear, empty, field, modal, note, stat, table, toast, fmtNum, fmtDate, relTime } from '../lib/ui.js';
import {
  LEAD_CSV_COLUMNS,
  MIME,
  buildCampaignPack,
  buildPrintableHtml,
  buildSnapshot,
  downloadBlob,
  downloadCsv,
  downloadJson,
  importCsvText,
  leadToCsvRow,
  parseSnapshot,
} from '../lib/export-utils.js';
import { mergeLead } from '../lib/api.js';
import {
  deleteSnapshot,
  getSnapshot,
  listEdgesForLead,
  listSnapshots,
  putGroup,
  putSnapshot,
  putTemplate,
  upsertEdge,
  upsertLead,
  usageEstimate,
} from '../../storage/db.js';

/**
 * @param {{api: object, toast?: Function, env?: object, onChanged?: Function}} ctx
 *   `env` is forwarded to every download so a test can pass `{manualRevoke:true}`
 *   and not leave a 5-second revoke timer holding the process open.
 */
export function createBackupView(ctx = {}) {
  const api = ctx.api;
  if (!api) throw new Error('createBackupView needs an api client');
  const say = ctx.toast ?? toast;
  const env = ctx.env ?? {};

  const root = el('div', { class: 'col' });
  const storageRow = el('div', { class: 'grid grid--4' });
  const exportCard = card('Export', el('div'));
  const savePointsCard = card('Save points', el('div'), { hint: 'stored in this browser' });
  const importCard = card('Import & restore', el('div'));
  const importPreview = el('div');

  async function gather() {
    const [workspace, leads, groups, templates, runs, actionLog, settings] = await Promise.all([
      api.workspace(),
      api.leads({ limit: 20_000 }),
      api.groups(),
      api.templates(),
      api.runs({ limit: 500 }),
      api.actions({ limit: 5_000 }),
      api.settings(),
    ]);
    // Edges are provenance and live per lead; a save file without them would
    // restore the people but lose why each one was collected.
    const edges = [];
    for (const lead of leads) {
      const rows = await listEdgesForLead(lead.leadKey);
      for (const edge of rows) edges.push(edge);
    }
    return { workspace, leads, edges, groups, templates, runs, actionLog, settings };
  }

  function stamp() {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  }

  /* ------------------------------------------------------------------ export */

  async function exportCsv() {
    const leads = await api.leads({ limit: 20_000 });
    if (!leads.length) { say('There are no leads to export yet.', 'error'); return; }
    downloadCsv(leads.map(leadToCsvRow), `igcrm-leads-${stamp()}.csv`, { columns: LEAD_CSV_COLUMNS }, env);
    say(`Exported ${leads.length} leads to CSV.`, 'success');
  }

  async function exportPack() {
    const leads = await api.leads({ limit: 20_000 });
    const pack = buildCampaignPack(leads, { prefix: `igcrm-${stamp()}` });
    const nonEmpty = pack.filter((file) => file.count > 0);
    if (!nonEmpty.length) { say('No leads matched any funnel bucket.', 'error'); return; }
    for (const file of nonEmpty) {
      downloadBlob(file.csv, file.filename, MIME.csv, env);
    }
    say(`Downloaded ${nonEmpty.length} funnel CSV files.`, 'success');
  }

  async function exportSaveFile() {
    const data = await gather();
    const snapshot = buildSnapshot(data);
    downloadJson(snapshot, `igcrm-save-${stamp()}.igcrm.json`, env);
    say(`Save file written: ${snapshot.counts.leads} leads, ${snapshot.counts.templates} templates.`, 'success');
  }

  async function exportReport() {
    const [overview, leads, sessions] = await Promise.all([api.overview(), api.leads({ limit: 20_000 }), api.sessions({ limit: 50 })]);
    const tiers = { hot: 0, warm: 0, lukewarm: 0, cold: 0 };
    for (const lead of leads) tiers[lead.warmthTier ?? 'cold'] = (tiers[lead.warmthTier ?? 'cold'] ?? 0) + 1;
    const html = buildPrintableHtml({
      title: 'Instagram outreach report',
      subtitle: overview.viewerUsername ? `@${overview.viewerUsername}` : 'this workspace',
      sections: [
        {
          title: 'Summary',
          columns: [{ key: 'metric', label: 'Metric' }, { key: 'value', label: 'Value' }],
          rows: [
            { metric: 'Leads in library', value: String(leads.length) },
            { metric: 'Hot / warm / lukewarm / cold', value: `${tiers.hot} / ${tiers.warm} / ${tiers.lukewarm} / ${tiers.cold}` },
            { metric: 'Follows today', value: String(overview.counters?.follow?.used?.daily ?? 0) },
            { metric: 'Messages today', value: String((overview.counters?.warmDm?.used?.daily ?? 0) + (overview.counters?.coldDm?.used?.daily ?? 0)) },
            { metric: 'Buckets', value: String(overview.groups?.length ?? 0) },
            { metric: 'Enabled templates', value: String(overview.enabledTemplates ?? 0) },
          ],
        },
        {
          title: 'Recent sessions',
          columns: [{ key: 'mode', label: 'Mode' }, { key: 'status', label: 'Status' }, { key: 'done', label: 'Done' }, { key: 'when', label: 'Started' }],
          rows: sessions.map((s) => ({ mode: s.mode, status: s.status, done: String(s.counts?.done ?? 0), when: fmtDate(s.startedAt) })),
          emptyMessage: 'No outreach sessions recorded yet.',
        },
      ],
    });
    // buildPrintableHtml already produced the document; write that blob rather
    // than calling downloadPrintableReport, which would build it a second time.
    downloadBlob(html, `igcrm-report-${stamp()}.html`, MIME.html, env);
    say('Printable report downloaded.', 'success');
  }

  /* -------------------------------------------------------------- save points */

  async function createSavePoint(label) {
    const data = await gather();
    const payload = buildSnapshot(data);
    const snapshotId = `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await putSnapshot({
      snapshotId,
      workspaceId: api.workspaceId,
      label: String(label ?? '').trim() || `Save point ${new Date().toLocaleString('en')}`,
      counts: payload.counts,
      payload,
    });
    say('Save point created.', 'success');
    await renderSavePoints();
    ctx.onChanged?.();
  }

  async function restoreSnapshot(snapshotId) {
    const row = await getSnapshot(snapshotId);
    if (!row?.payload) { say('That save point could not be read.', 'error'); return; }
    const applied = await applySnapshot(row.payload);
    say(`Restored ${applied.leads} leads, ${applied.groups} buckets, ${applied.templates} templates (merged).`, 'success');
    ctx.onChanged?.();
  }

  async function downloadSnapshot(snapshotId) {
    const row = await getSnapshot(snapshotId);
    if (!row?.payload) { say('That save point could not be read.', 'error'); return; }
    downloadJson(row.payload, `igcrm-save-${(row.label ?? 'point').replace(/\W+/g, '-')}.igcrm.json`, env);
  }

  async function removeSnapshot(snapshotId) {
    await deleteSnapshot(snapshotId);
    say('Save point deleted.');
    await renderSavePoints();
  }

  // Deleting a save point is permanent, so the red-outline button asks once.
  function confirmRemoveSnapshot(row) {
    modal({
      title: 'Delete this save point?',
      body: note(`\"${row.label ?? 'Save point'}\" will be permanently removed from this browser. Your leads and buckets are not affected.`, 'warning'),
      actions: [
        { label: 'Cancel', variant: 'ghost' },
        { label: 'Delete save point', variant: 'danger-solid', onClick: () => { void removeSnapshot(row.snapshotId); } },
      ],
    });
  }

  async function renderSavePoints() {
    const body = el('div');
    let rows = [];
    try { rows = await listSnapshots(api.workspaceId, { limit: 50 }); } catch { rows = []; }
    let labelValue = '';
    const labelField = field('Label the save point', {
      value: '', placeholder: 'Before Ramadan campaign',
      onInput: (value) => { labelValue = value; },
    });
    body.append(
      el('div', { class: 'row row--wrap' }, [
        labelField,
        btn('Create save point', { variant: 'primary', busyLabel: 'Saving…', onClick: () => createSavePoint(labelValue) }),
      ]),
    );
    if (!rows.length) {
      body.append(note('No save points yet. A save point is a full restore point stored only in this browser.', ''));
    } else {
      body.append(table(
        ['Label', 'Leads', 'Templates', 'Created', ''],
        rows.map((row) => [
          row.label ?? '—',
          String(row.counts?.leads ?? 0),
          String(row.counts?.templates ?? 0),
          relTime(row.createdAt),
          el('div', { class: 'row' }, [
            el('button', { class: 'btn btn--sm', text: 'Restore', onclick: () => restoreSnapshot(row.snapshotId) }),
            el('button', { class: 'btn btn--sm btn--ghost', text: 'Download', onclick: () => downloadSnapshot(row.snapshotId) }),
            el('button', { class: 'btn btn--sm btn--danger', text: 'Delete', onclick: () => confirmRemoveSnapshot(row) }),
          ]),
        ]),
        { numeric: [1, 2] },
      ));
    }
    replaceCard(savePointsCard, body);
  }

  /* ------------------------------------------------------------------- import */

  /**
   * Apply a validated snapshot. Merging, not replacing: a lead that exists is
   * merged (PRESERVED_ON_RECOLLECT fields survive), a new one is inserted.
   */
  async function applySnapshot(snapshot) {
    const workspaceId = String(api.workspaceId);
    let leads = 0; let groups = 0; let templates = 0; let edges = 0;
    for (const group of snapshot.groups ?? []) {
      await putGroup({ ...group, workspaceId });
      groups += 1;
    }
    for (const template of snapshot.templates ?? []) {
      await putTemplate({ ...template, workspaceId });
      templates += 1;
    }
    for (const incoming of snapshot.leads ?? []) {
      if (!incoming?.username) continue;
      const leadKey = `${workspaceId}:${String(incoming.username).toLowerCase()}`;
      const existing = await api.lead(leadKey);
      await upsertLead(mergeLead(existing, { ...incoming, workspaceId, leadKey }));
      leads += 1;
    }
    for (const edge of snapshot.edges ?? []) {
      if (!edge?.leadKey) continue;
      await upsertEdge({ ...edge, workspaceId });
      edges += 1;
    }
    if (snapshot.settings) { try { await api.saveSettings(snapshot.settings); } catch { /* settings are best-effort on restore */ } }
    return { leads, groups, templates, edges };
  }

  /** Import a file the owner picked. Exposed so a test can drive it directly. */
  async function importText(text, filename = '') {
    clear(importPreview);
    const lower = String(filename).toLowerCase();
    if (lower.endsWith('.json') || String(text).trimStart().startsWith('{')) {
      const parsed = parseSnapshot(text);
      if (!parsed.ok) {
        importPreview.append(note(`That file could not be read: ${parsed.reason}`, 'danger'));
        return { ok: false, reason: parsed.reason };
      }
      const snap = parsed.snapshot;
      importPreview.append(
        note(`Save file recognised: ${snap.counts?.leads ?? 0} leads, ${snap.counts?.templates ?? 0} templates, saved ${fmtDate(snap.savedAt)}. Restoring merges into this workspace.`, 'info'),
        el('div', { class: 'row' }, [
          btn('Restore this file', { variant: 'primary', busyLabel: 'Restoring…', onClick: async () => { const applied = await applySnapshot(snap); say(`Restored ${applied.leads} leads (merged).`, 'success'); clear(importPreview); ctx.onChanged?.(); } }),
        ]),
      );
      return { ok: true, kind: 'snapshot', counts: snap.counts };
    }

    const parsed = importCsvText(text);
    const handles = parsed.rows
      .map((row) => String(row.username ?? row.handle ?? row[Object.keys(row)[0]] ?? '').trim().replace(/^@/, ''))
      .filter(Boolean);
    if (!handles.length) {
      importPreview.append(note('No handles were found in that CSV. Expected a column of usernames.', 'danger'));
      return { ok: false, reason: 'no handles' };
    }
    const unique = [...new Set(handles.map((h) => h.toLowerCase()))];
    importPreview.append(
      note(`Found ${unique.length} unique handle${unique.length === 1 ? '' : 's'}${parsed.warnings?.length ? ` (${parsed.warnings.length} line warnings)` : ''}.`, 'info'),
      el('div', { class: 'row row--wrap small dim', text: unique.slice(0, 12).map((h) => `@${h}`).join('  ') + (unique.length > 12 ? '  …' : '') }),
      el('div', { class: 'row mt-2' }, [
        btn(`Import ${unique.length} as new leads`, { variant: 'primary', busyLabel: 'Importing…', onClick: async () => { await importHandles(unique); } }),
      ]),
    );
    return { ok: true, kind: 'csv', count: unique.length, handles: unique };
  }

  async function importHandles(handles) {
    const workspaceId = String(api.workspaceId);
    let added = 0;
    for (const handle of handles) {
      const leadKey = `${workspaceId}:${handle.toLowerCase()}`;
      const existing = await api.lead(leadKey);
      if (existing) continue;
      await upsertLead({ leadKey, workspaceId, username: handle, fullName: '', relState: 'NONE', dmState: 'NONE', groupIds: [], sourceAccounts: [], edgeTypes: [], warmthTier: 'cold', priorityScore: 0, scoreParts: {}, isWhitelisted: false });
      added += 1;
    }
    say(`Imported ${added} new lead${added === 1 ? '' : 's'} (${handles.length - added} already in the library).`, 'success');
    clear(importPreview);
    ctx.onChanged?.();
  }

  function fileInput() {
    const input = el('input', { type: 'file', class: 'input', accept: '.json,.csv,text/csv,application/json' });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { void importText(String(reader.result ?? ''), file.name); };
      reader.onerror = () => say('That file could not be read.', 'error');
      reader.readAsText(file);
    });
    return input;
  }

  /* ------------------------------------------------------------------- render */

  function replaceCard(cardNode, body) {
    const head = cardNode.querySelector('.card__head');
    clear(cardNode);
    if (head) cardNode.append(head);
    cardNode.append(body);
  }

  async function renderStorage() {
    clear(storageRow);
    const [leads, overview, estimate] = await Promise.all([
      api.leads({ limit: 20_000 }).catch(() => []),
      api.overview().catch(() => null),
      usageEstimate().catch(() => null),
    ]);
    storageRow.append(
      stat('Leads', fmtNum(leads.length)),
      stat('Buckets', fmtNum(overview?.groups?.length ?? 0)),
      stat('Enabled templates', fmtNum(overview?.enabledTemplates ?? 0)),
      stat('Local storage used', estimate?.pct == null ? '—' : `${estimate.pct.toFixed(1)}%`, { sub: estimate ? `${fmtNum(Math.round(estimate.usage / 1024))} KB of ${fmtNum(Math.round(estimate.quota / 1048576))} MB` : 'estimate unavailable' }),
    );
  }

  function renderExport() {
    replaceCard(exportCard, el('div', { class: 'row row--wrap' }, [
      btn('Download CSV (all leads)', { onClick: exportCsv, busyLabel: 'Exporting…' }),
      btn('Download funnel pack', { onClick: exportPack, busyLabel: 'Exporting…', title: 'one CSV per funnel stage' }),
      btn('Download save file (.igcrm.json)', { onClick: exportSaveFile, busyLabel: 'Building…' }),
      btn('Download printable report', { onClick: exportReport, busyLabel: 'Building…' }),
    ]));
  }

  function renderImport() {
    replaceCard(importCard, el('div', { class: 'col' }, [
      note('A .igcrm.json save file restores and merges the whole library. A CSV of handles adds them as new leads. Secrets are never stored in either.', 'info'),
      fileInput(),
      importPreview,
    ]));
  }

  async function refresh() {
    renderExport();
    renderImport();
    await Promise.all([renderStorage(), renderSavePoints()]);
  }

  function mount(container) {
    clear(root);
    root.append(storageRow, exportCard, savePointsCard, importCard);
    container.append(root);
    void refresh();
  }

  function destroy() { clear(root); }

  return { mount, refresh, destroy, root, importText, applySnapshot, gather };
}
