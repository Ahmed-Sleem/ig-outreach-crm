/**
 * Tab 1 — People Collector & Ranked CRM.
 *
 * Two surfaces in one tab. The launcher collects a source (the followers of a
 * competitor, the likers of a post, a hashtag grid) into a PREVIEW; nothing is
 * written to the library until the owner looks at it and presses Save into a
 * bucket. Below it, the permanent library renders as a ranked, virtualised table
 * — virtualised because a niche competitor's follower list is thousands of rows
 * and a DOM node per row would freeze the tab the first time he scrolls.
 *
 * Every scraped name and biography renders through scannedText(), never
 * innerHTML: a biography is attacker-controlled text and must display as
 * characters. Clicking a row opens the lead dossier drawer.
 */

import {
  btn, card, chipList, drawer, el, clear, field, note, scannedText,
  stateBadge, table, toast, warmthBadge, fmtNum, relTime,
} from '../lib/ui.js';
import { virtualTable } from '../lib/virtual-list.js';
import { CollectSource } from '../../content/main.js';
import { listEdgesForLead, upsertLead } from '../../storage/db.js';

const SOURCES = [
  { value: CollectSource.FOLLOWERS, label: 'Followers of an account' },
  { value: CollectSource.FOLLOWING, label: 'Following of an account' },
  { value: CollectSource.POST_LIKERS, label: 'Likers of a post' },
  { value: CollectSource.POST_COMMENTS, label: 'Commenters on a post' },
  { value: CollectSource.PROFILE_RECENT_LIKERS, label: 'Recent likers on a profile' },
  { value: CollectSource.HASHTAG_GRID, label: 'Hashtag grid authors' },
  { value: CollectSource.SAVED_GRID, label: 'Saved-posts grid' },
  { value: CollectSource.OPEN_LIST_DIALOG, label: 'An open follower/following dialog' },
  { value: CollectSource.CURRENT_PAGE, label: 'Whoever is on the current tab' },
];

const SOURCE_NEEDS_TARGET = new Set([
  CollectSource.FOLLOWERS, CollectSource.FOLLOWING, CollectSource.POST_LIKERS,
  CollectSource.POST_COMMENTS, CollectSource.PROFILE_RECENT_LIKERS, CollectSource.HASHTAG_GRID,
]);

const TIERS = ['hot', 'warm', 'lukewarm', 'cold'];
const SORTS = [
  { value: 'score', label: 'Priority score' },
  { value: 'username', label: 'Username (A–Z)' },
  { value: 'followers', label: 'Followers' },
  { value: 'recent', label: 'Recently actioned' },
];

const COLUMNS = [
  { key: 'priorityScore', label: 'Score', width: '68px', numeric: true, cell: (row) => String(Math.round(row.priorityScore ?? 0)) },
  { key: 'username', label: 'Username', width: '1.5fr', cell: (row) => `@${row.username}` },
  { key: 'fullName', label: 'Name', width: '1.5fr', cell: (row) => scannedText(row.fullName ?? '') },
  { key: 'warmthTier', label: 'Warmth', width: '92px', cell: (row) => warmthBadge(row.warmthTier, row.priorityScore) },
  { key: 'relState', label: 'Relationship', width: '132px', cell: (row) => stateBadge(row.relState) },
  { key: 'dmState', label: 'Message', width: '132px', cell: (row) => stateBadge(row.dmState) },
  { key: 'followers', label: 'Followers', width: '88px', numeric: true, cell: (row) => fmtNum(row.followers ?? null, { compact: true }) },
  { key: 'sourceAccounts', label: 'Sources', width: '1.2fr', cell: (row) => (row.sourceAccounts ?? []).join(', ') || '—' },
];

/**
 * @param {{api: object, controller: object, toast?: Function, onRunEvent?: Function, onSync?: Function, onChanged?: Function}} ctx
 */
export function createCollectorView(ctx = {}) {
  const api = ctx.api;
  const controller = ctx.controller;
  if (!api) throw new Error('createCollectorView needs an api client');
  if (!controller) throw new Error('createCollectorView needs a run controller');
  const say = ctx.toast ?? toast;

  const root = el('div', { class: 'col' });
  const launcherCard = card('Collect people', el('div'), { hint: 'nothing is saved until you press Save' });
  const previewCard = el('div');
  const filterBar = el('div', { class: 'row row--wrap mb-2' });
  const tableMount = el('div', { class: 'vtable' });
  const libraryCard = card('Library', [filterBar, tableMount], { hint: '' });

  let allLeads = [];
  let vtable = null;
  let filters = { search: '', tiers: new Set(), bucket: 'all', sort: 'score' };
  let groups = [];
  let lastPreview = null;
  const unsubscribe = [];

  /* ---------------------------------------------------------------- launcher */

  function renderLauncher() {
    let source = CollectSource.FOLLOWERS;
    let username = '';
    let limit = 200;

    const sourceSelect = el('select', { class: 'select' });
    for (const option of SOURCES) sourceSelect.append(el('option', { value: option.value, text: option.label }));
    sourceSelect.value = source;

    const targetField = field('Target account, post URL or hashtag', {
      value: '', placeholder: 'competitor_handle  ·  /p/CxY…  ·  #linen',
      onInput: (value) => { username = value.trim(); },
    });
    const limitField = field('How many to collect', { type: 'number', value: '200', onInput: (value) => { limit = Math.max(1, Math.min(5000, Number(value) || 200)); } });

    const status = el('div', { class: 'small dim mt-2' });
    const collectBtn = btn('Collect', {
      variant: 'primary', busyLabel: 'Collecting…',
      onClick: async () => {
        if (SOURCE_NEEDS_TARGET.has(source) && !username) {
          status.textContent = 'This source needs a target account, post or hashtag.';
          return;
        }
        status.textContent = 'Opening the source and reading it at a human pace…';
        const out = await controller.collect({ source, username: username || null, limit, statusIntervalMs: 1000 });
        if (out.ok) {
          status.textContent = `Collected ${out.count}. Review the preview, then save it into a bucket.`;
          lastPreview = { runId: out.runId, result: out.result };
          renderPreview();
        } else {
          status.textContent = out.reason ?? 'The collection did not finish.';
          lastPreview = null;
          renderPreview();
        }
      },
    });

    const sourceWrap = el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'Source' }), sourceSelect]);
    sourceSelect.addEventListener('change', () => {
      source = sourceSelect.value;
      const needsTarget = SOURCE_NEEDS_TARGET.has(source);
      targetField.classList.toggle('hidden', !needsTarget);
    });
    targetField.classList.toggle('hidden', !SOURCE_NEEDS_TARGET.has(source));

    replaceCard(launcherCard, el('div', { class: 'grid grid--2' }, [
      el('div', { class: 'col' }, [sourceWrap, targetField]),
      el('div', { class: 'col' }, [limitField, el('div', { class: 'row' }, [collectBtn]), status]),
    ]));
  }

  /* ----------------------------------------------------------------- preview */

  function renderPreview() {
    clear(previewCard);
    if (!lastPreview) return;
    const result = lastPreview.result ?? {};
    const leads = Array.isArray(result.leads) ? result.leads : [];
    if (!leads.length) {
      previewCard.append(note(result.reason ?? 'That source returned nobody to preview.', 'warning'));
      return;
    }
    let bucketName = '';
    const rows = leads.slice(0, 50).map((entry) => {
      const lead = entry?.lead ?? entry;
      return [`@${lead.username}`, scannedText(lead.fullName ?? ''), String(Math.round(lead.priorityScore ?? 0)), warmthBadge(lead.warmthTier ?? 'cold')];
    });
    previewCard.append(card(`Preview — ${leads.length} collected`, [
      note('These people are not in your library yet. Save them into a bucket to keep them, or discard the collection.', 'info'),
      table(['Username', 'Name', 'Score', 'Warmth'], rows, { numeric: [2] }),
      el('div', { class: 'row row--wrap mt-4' }, [
        field('Save into a new or existing bucket', { value: '', placeholder: 'Linen suppliers', onInput: (value) => { bucketName = value; } }),
        btn('Save to library', {
          variant: 'primary', busyLabel: 'Saving…',
          onClick: async () => {
            const saved = await controller.commit({ result, groupName: bucketName.trim() || null, runId: lastPreview.runId });
            if (saved.ok) {
              say(`Saved ${saved.saved} new, updated ${saved.updated}.`, 'success');
              lastPreview = null;
              renderPreview();
              await refresh();
              ctx.onChanged?.();
            } else {
              say(saved.reason ?? 'Could not save the collection.', 'error');
            }
          },
        }),
        btn('Discard', { variant: 'danger', busyLabel: '…', onClick: async () => { await controller.discard({ runId: lastPreview.runId }); lastPreview = null; renderPreview(); say('Collection discarded.'); } }),
      ]),
    ], { hint: `run ${lastPreview.runId ?? ''}` }));
  }

  /* ----------------------------------------------------------------- library */

  function applyFilters() {
    const search = filters.search.toLowerCase();
    let rows = allLeads.filter((lead) => {
      if (search && !`${lead.username} ${lead.fullName ?? ''}`.toLowerCase().includes(search)) return false;
      if (filters.tiers.size && !filters.tiers.has(lead.warmthTier ?? 'cold')) return false;
      if (filters.bucket !== 'all' && !(lead.groupIds ?? []).includes(filters.bucket)) return false;
      return true;
    });
    rows = sortRows(rows, filters.sort);
    vtable?.setRows(rows);
    return rows;
  }

  function sortRows(rows, sort) {
    const copy = [...rows];
    if (sort === 'username') copy.sort((a, b) => a.username.localeCompare(b.username));
    else if (sort === 'followers') copy.sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0));
    else if (sort === 'recent') copy.sort((a, b) => (b.followedAt ?? b.messagedAt ?? 0) - (a.followedAt ?? a.messagedAt ?? 0));
    else copy.sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0));
    return copy;
  }

  function renderFilterBar() {
    clear(filterBar);
    const search = el('input', { class: 'input', type: 'search', placeholder: 'Search username or name…', style: { maxWidth: '260px' } });
    search.addEventListener('input', () => { filters.search = search.value; applyFilters(); updateCounts(); });

    const bucketSelect = el('select', { class: 'select', style: { maxWidth: '200px' } });
    bucketSelect.append(el('option', { value: 'all', text: 'All buckets' }));
    for (const group of groups) bucketSelect.append(el('option', { value: group.groupId, text: group.name }));
    bucketSelect.value = filters.bucket;
    bucketSelect.addEventListener('change', () => { filters.bucket = bucketSelect.value; applyFilters(); updateCounts(); });

    const sortSelect = el('select', { class: 'select', style: { maxWidth: '180px' } });
    for (const option of SORTS) sortSelect.append(el('option', { value: option.value, text: option.label }));
    sortSelect.value = filters.sort;
    sortSelect.addEventListener('change', () => { filters.sort = sortSelect.value; applyFilters(); });

    filterBar.append(
      search,
      chipList(TIERS, [...filters.tiers], { onChange: (values) => { filters.tiers = new Set(values); applyFilters(); updateCounts(); } }),
      bucketSelect,
      sortSelect,
      el('span', { class: 'grow' }),
      el('span', { class: 'small dim', id: 'collector-count' }),
    );
  }

  function updateCounts() {
    const shown = vtable?.rowCount ?? 0;
    const untouched = allLeads.filter((lead) => lead.relState === 'NONE' && lead.dmState === 'NONE').length;
    const node = root.querySelector('#collector-count');
    if (node) node.textContent = `${shown} of ${allLeads.length} shown · ${untouched} untouched`;
    ctx.setBadge?.('collector', { total: allLeads.length, untouched });
  }

  /* ------------------------------------------------------------------ dossier */

  async function openDossier(lead) {
    const fresh = (await api.lead(lead.leadKey)) ?? lead;
    let edges = [];
    try { edges = await listEdgesForLead(fresh.leadKey); } catch { edges = []; }
    let all = [];
    try { all = await api.actions({ limit: 500 }); } catch { all = []; }
    const actions = all.filter((row) => row.leadKey === fresh.leadKey).slice(0, 12);

    const body = el('div', { class: 'col' }, [
      el('div', { class: 'row row--wrap' }, [warmthBadge(fresh.warmthTier, fresh.priorityScore), stateBadge(fresh.relState), stateBadge(fresh.dmState)]),
      fresh.fullName ? el('div', {}, [scannedText(fresh.fullName, 'p')]) : null,
      fresh.biography ? el('div', { class: 'pre-wrap small dim' }, [scannedText(fresh.biography, 'span')]) : null,
      table(['Metric', 'Value'], [
        ['Priority score', String(Math.round(fresh.priorityScore ?? 0))],
        ['Followers', fmtNum(fresh.followers ?? null)],
        ['Following', fmtNum(fresh.following ?? null)],
        ['Private', fresh.isPrivate ? 'yes' : 'no'],
        ['Business', fresh.isBusiness ? 'yes' : 'no'],
        ['Buckets', (fresh.groupIds ?? []).map((id) => groups.find((g) => g.groupId === id)?.name ?? id).join(', ') || '—'],
        ['Collected from', (fresh.sourceAccounts ?? []).join(', ') || '—'],
        ['Followed', fresh.followedAt ? relTime(fresh.followedAt) : '—'],
        ['Messaged', fresh.messagedAt ? relTime(fresh.messagedAt) : '—'],
      ]),
      fresh.scoreParts && Object.keys(fresh.scoreParts).length
        ? card('Score breakdown', table(['Signal', 'Points'], Object.entries(fresh.scoreParts).map(([k, v]) => [k, String(Math.round(v))]), { numeric: [1] }))
        : null,
      edges.length ? card('Provenance', table(['Source', 'Edge', 'When'], edges.slice(0, 10).map((e) => [e.sourceAccount ?? '—', e.edgeType ?? '—', e.observedAt ? relTime(e.observedAt) : '—']))) : null,
      actions.length ? card('Recent actions', table(['Action', 'Outcome', 'When'], actions.map((a) => [a.actionType, a.verifiedOk ? 'verified' : (a.outcome ?? '—'), relTime(a.timestamp)]))) : null,
    ]);

    const actions2 = [
      btn(fresh.isWhitelisted ? 'Remove whitelist' : 'Whitelist (protect)', {
        variant: 'ghost',
        onClick: async () => { await upsertLead({ ...fresh, isWhitelisted: !fresh.isWhitelisted }); say(fresh.isWhitelisted ? 'Whitelist removed.' : 'Protected: this person will never be actioned.', 'success'); await refresh(); },
      }),
      btn('Do not contact', {
        variant: 'danger',
        onClick: async () => { await upsertLead({ ...fresh, doNotContactReason: 'marked by the owner' }); say('Marked do-not-contact.', 'success'); await refresh(); },
      }),
    ];
    drawer({ title: `@${fresh.username}`, body, actions: actions2, width: 'var(--drawer-w)' });
  }

  /* ------------------------------------------------------------------- render */

  function replaceCard(cardNode, body) {
    const head = cardNode.querySelector('.card__head');
    clear(cardNode);
    if (head) cardNode.append(head);
    cardNode.append(body);
  }

  async function refresh() {
    try {
      [allLeads, groups] = await Promise.all([api.leads({ limit: 20_000 }), api.groups()]);
    } catch (error) {
      say(`Could not load the library: ${error?.message ?? error}`, 'error');
      allLeads = []; groups = [];
    }
    renderFilterBar();
    const rows = applyFilters();
    // The virtual table renders its own empty message, so it is mounted once and
    // never torn down: detaching it on an empty library would drop the scroll
    // position every time a filter box empties and refills.
    if (!vtable) {
      vtable = virtualTable(tableMount, {
        columns: COLUMNS, rows, rowHeight: 38, viewportHeight: 520, overscan: 10,
        rowClass: () => 'vtable__row--clickable',
        onRowClick: (row) => openDossier(row),
        emptyMessage: allLeads.length ? 'No leads match these filters.' : 'No leads yet — collect a source above, then save it into a bucket.',
      });
    } else {
      vtable.setRows(rows);
    }
    updateCounts();
  }

  function mount(container) {
    clear(root);
    root.append(launcherCard, previewCard, libraryCard);
    container.append(root);
    renderLauncher();
    renderPreview();
    if (ctx.onRunEvent) unsubscribe.push(ctx.onRunEvent((event) => {
      // A collection finishing elsewhere, or a commit, should refresh the table.
      if (event.type === 'saved' || event.type === 'collected') void refresh();
    }));
    if (ctx.onSync) unsubscribe.push(ctx.onSync((message) => {
      if (message?.type === 'LEADS_UPSERTED' || message?.type === 'LEAD_STATE_CHANGED') void refresh();
    }));
    void refresh();
  }

  function destroy() {
    for (const off of unsubscribe.splice(0)) { try { off?.(); } catch { /* already gone */ } }
    vtable?.destroy();
    vtable = null;
    clear(root);
  }

  return { mount, refresh, destroy, root, get leads() { return allLeads; } };
}
