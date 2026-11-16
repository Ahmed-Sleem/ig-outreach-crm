/**
 * Tab 2 — Your people: ranked CRM organised into bucket tabs.
 *
 * Every workspace starts with a ready "Default" bucket so collected leads always
 * have a home on day one. Each bucket (All people, Default, and every custom
 * bucket the user creates) appears as a tab across the top; clicking "+ New
 * bucket" creates a new tab immediately.
 *
 * The table is virtualised so thousands of rows scroll at 60 fps, and every
 * scraped name and biography renders through scannedText() — never innerHTML.
 * Clicking a row opens the lead details drawer with one-click bucket assignment,
 * score breakdown, provenance edges, and recent action history.
 */

import {
  btn, card, chipList, clear, drawer, el, field, fmtNum, modal, note,
  relTime, scannedText, stateBadge, table, toast, warmthBadge,
} from '../lib/ui.js';
import { virtualTable } from '../lib/virtual-list.js';
import { isDefaultBucket, parseHandlesInput } from '../lib/api.js';
import { listEdgesForLead, setLeadGroup, upsertLead } from '../../storage/db.js';

const TIERS = ['hot', 'warm', 'lukewarm', 'cold'];
const SORTS = [
  { value: 'score', label: 'Priority score' },
  { value: 'username', label: 'Username (A–Z)' },
  { value: 'followers', label: 'Followers' },
  { value: 'recent', label: 'Recently actioned' },
];

const COLUMNS = [
  { key: 'username', label: 'Username', width: '1.3fr', cell: (row) => `@${row.username}` },
  { key: 'fullName', label: 'Name', width: '1.3fr', cell: (row) => scannedText(row.fullName ?? '') },
  { key: 'warmthTier', label: 'Warmth', width: '96px', cell: (row) => warmthBadge(row.warmthTier, row.priorityScore) },
  { key: 'relState', label: 'Status', width: '180px', cell: (row) => stateBadge(row.relState) },
  { key: 'followers', label: 'Followers', width: '104px', numeric: true, cell: (row) => fmtNum(row.followers ?? null, { compact: true }) },
];

/**
 * @param {{api: object, toast?: Function, onSync?: Function, onChanged?: Function, setBadge?: Function, onNavigate?: Function}} ctx
 */
export function createPeopleView(ctx = {}) {
  const api = ctx.api;
  if (!api) throw new Error('createPeopleView needs an api client');
  const say = ctx.toast ?? toast;

  const root = el('div', { class: 'col' });
  const bucketTabsBar = el('nav', { class: 'subtabs', role: 'tablist', 'aria-label': 'People buckets' });
  const bucketHeader = el('div', { class: 'row row--wrap mb-2' });
  const filterBar = el('div', { class: 'people__toolbar mb-2' });
  const tableMount = el('div', { class: 'vtable' });
  const libraryCard = card('All people', [bucketHeader, filterBar, tableMount], { hint: '' });

  let allLeads = [];
  let groups = [];
  let vtable = null;
  let activeBucket = 'all'; // 'all' or group.groupId
  let filters = { search: '', tiers: new Set(), sort: 'score' };
  const unsubscribe = [];

  /* ------------------------------------------------------------ bucket tabs */

  function activeGroup() {
    if (activeBucket === 'all') return null;
    return groups.find((g) => g.groupId === activeBucket) ?? null;
  }

  function countInBucket(groupId) {
    if (groupId === 'all') return allLeads.length;
    return allLeads.filter((lead) => (lead.groupIds ?? []).includes(groupId)).length;
  }

  function selectBucket(bucketId) {
    activeBucket = bucketId;
    renderBucketTabs();
    renderBucketHeader();
    applyFilters();
    updateCounts();
  }

  function renderBucketTabs() {
    clear(bucketTabsBar);

    const makeTab = (id, label, count) => {
      const on = activeBucket === id;
      return el('button', {
        class: `subtab ${on ? 'subtab--on' : ''}`.trim(),
        role: 'tab',
        type: 'button',
        'aria-selected': on ? 'true' : 'false',
        'data-bucket-tab': id,
        onclick: () => selectBucket(id),
      }, [
        el('span', { text: label }),
        el('span', { class: 'subtab__count', text: String(count) }),
      ]);
    };

    bucketTabsBar.append(makeTab('all', 'All people', allLeads.length));
    for (const group of groups) {
      bucketTabsBar.append(makeTab(group.groupId, group.name, countInBucket(group.groupId)));
    }
    bucketTabsBar.append(el('span', { class: 'subtabs__spacer' }));
    bucketTabsBar.append(el('button', {
      class: 'subtab subtab--add',
      type: 'button',
      text: '+ New bucket',
      onclick: () => openNewBucketModal(),
    }));
  }

  function renderBucketHeader() {
    const group = activeGroup();
    const titleNode = libraryCard.querySelector('.card__title');
    if (titleNode) titleNode.textContent = group ? group.name : 'All people';

    const scopeCount = countInBucket(activeBucket);
    clear(bucketHeader);

    const subtitle = !group
      ? 'Everyone you have collected or added across all buckets. Click any person to inspect or assign buckets.'
      : isDefaultBucket(group, api.workspaceId)
        ? 'Ready default bucket — newly saved people land here unless you pick another bucket.'
        : (group.note || 'Custom bucket — people stay in All people even if you remove this bucket.');

    const actionButtons = [
      btn('+ Add people', { variant: 'sm primary', onClick: () => openAddPeopleModal() }),
      btn(group ? `Delete all (${scopeCount})` : `Delete all (${scopeCount})`, {
        variant: 'sm danger',
        disabled: scopeCount === 0,
        onClick: () => openDeleteAllModal(group, scopeCount),
      }),
    ];

    if (group && !isDefaultBucket(group, api.workspaceId)) {
      actionButtons.push(
        btn('Rename', { variant: 'sm ghost', onClick: () => openRenameBucketModal(group) }),
        btn('Remove bucket', { variant: 'sm ghost', onClick: () => openDeleteBucketModal(group) }),
      );
    }

    bucketHeader.append(
      el('span', { class: 'small dim', text: subtitle }),
      el('span', { class: 'grow' }),
      el('div', { class: 'people__actions' }, actionButtons),
    );
  }

  function openAddPeopleModal() {
    let rawHandles = '';
    let fullName = '';
    let noteText = '';
    const defaultGroup = activeGroup()?.groupId
      ?? groups.find((g) => isDefaultBucket(g, api.workspaceId))?.groupId
      ?? groups[0]?.groupId
      ?? null;
    let targetGroupId = defaultGroup;

    const previewLine = el('div', { class: 'small dim', text: 'Paste one or more Instagram @usernames or profile links.' });
    const textarea = el('textarea', {
      class: 'input input--area',
      rows: '5',
      placeholder: '@linen.studio\ncairo.coffee\nhttps://www.instagram.com/handmade.egypt/',
    });
    const updatePreview = () => {
      const { valid, invalid } = parseHandlesInput(rawHandles);
      if (!rawHandles.trim()) {
        previewLine.textContent = 'Paste one or more Instagram @usernames or profile links.';
      } else if (!valid.length) {
        previewLine.textContent = `No valid handles found (${invalid.length} ignored).`;
      } else {
        previewLine.textContent = `${valid.length} ${valid.length === 1 ? 'person' : 'people'} ready to add${invalid.length ? ` (${invalid.length} invalid skipped)` : ''}.`;
      }
    };
    textarea.addEventListener('input', () => { rawHandles = textarea.value; updatePreview(); });

    const bucketSelect = el('select', { class: 'select' });
    for (const g of groups) {
      bucketSelect.append(el('option', { value: g.groupId, text: g.name }));
    }
    if (targetGroupId) bucketSelect.value = targetGroupId;
    bucketSelect.addEventListener('change', () => { targetGroupId = bucketSelect.value || null; });

    modal({
      title: 'Add new people',
      body: el('div', { class: 'col' }, [
        el('label', { class: 'field' }, [
          el('span', { class: 'field__label', text: 'Instagram usernames or profile links (one per line or comma-separated)' }),
          textarea,
        ]),
        previewLine,
        groups.length ? el('label', { class: 'field' }, [
          el('span', { class: 'field__label', text: 'Save into bucket' }),
          bucketSelect,
        ]) : null,
        field('Full name (optional, when adding 1 person)', { value: '', placeholder: 'Sara Mansour', onInput: (v) => { fullName = v; } }),
        field('Note (optional, when adding 1 person)', { value: '', placeholder: 'Met at Cairo design week', onInput: (v) => { noteText = v; } }),
      ]),
      actions: [
        { label: 'Cancel', variant: 'ghost' },
        {
          label: 'Add people',
          variant: 'primary',
          onClick: async () => {
            const res = await api.addPeople({
              input: rawHandles,
              fullName,
              note: noteText,
              groupId: targetGroupId,
            });
            if (!res?.ok) {
              say(res?.reason ?? 'Enter at least one valid Instagram username.', 'error');
              return false;
            }
            const bucketName = groups.find((g) => g.groupId === res.groupId)?.name ?? 'Default';
            const parts = [];
            if (res.added) parts.push(`added ${res.added}`);
            if (res.updated) parts.push(`updated ${res.updated}`);
            say(`${parts.join(' and ') || `saved ${res.total}`} in ${bucketName}.`, 'success');
            await refresh();
            ctx.onChanged?.();
          },
        },
      ],
    });
  }

  function openDeleteAllModal(group, count) {
    if (!count) return;
    const isScoped = Boolean(group);
    const title = isScoped
      ? `Clear ${count} ${count === 1 ? 'person' : 'people'} from "${group.name}"?`
      : `Delete all ${count} ${count === 1 ? 'person' : 'people'}?`;
    const warning = isScoped
      ? `You can either remove all ${count} people from "${group.name}" (keeping them in All people), or permanently delete them from your CRM.`
      : `This permanently deletes all ${count} people and their provenance history from this workspace. Your buckets, templates, and safety settings stay untouched. This cannot be undone.`;

    const actions = [{ label: 'Cancel', variant: 'ghost' }];
    if (isScoped) {
      actions.push({
        label: `Remove from "${group.name}" only`,
        variant: 'default',
        onClick: async () => {
          const res = await api.deleteAllPeople({ groupId: group.groupId, mode: 'untag' });
          say(`Removed ${res.untagged} ${res.untagged === 1 ? 'person' : 'people'} from "${group.name}".`, 'success');
          await refresh();
          ctx.onChanged?.();
        },
      });
    }
    actions.push({
      label: isScoped ? `Delete all ${count} permanently` : `Delete all ${count} people`,
      variant: 'danger-solid',
      onClick: async () => {
        const res = await api.deleteAllPeople({ groupId: group?.groupId ?? null, mode: 'delete' });
        say(`Deleted ${res.deleted} ${res.deleted === 1 ? 'person' : 'people'}.`, 'success');
        await refresh();
        ctx.onChanged?.();
      },
    });

    modal({ title, body: note(warning, 'danger'), actions });
  }

  function openNewBucketModal() {
    let name = '';
    let noteText = '';
    modal({
      title: 'New bucket',
      body: el('div', { class: 'col' }, [
        field('Bucket name', { value: '', placeholder: 'Cairo boutiques', onInput: (v) => { name = v; } }),
        field('Note (optional)', { value: '', placeholder: 'Short description for your reference', onInput: (v) => { noteText = v; } }),
      ]),
      actions: [
        { label: 'Cancel', variant: 'ghost' },
        {
          label: 'Create bucket', variant: 'primary',
          onClick: async () => {
            const trimmed = name.trim();
            if (!trimmed) { say('A bucket needs a name.', 'error'); return false; }
            const created = await api.createGroup({ name: trimmed, note: noteText.trim() });
            say(`Bucket "${created.name}" created.`, 'success');
            activeBucket = created.groupId;
            await refresh();
            ctx.onChanged?.();
          },
        },
      ],
    });
  }

  function openRenameBucketModal(group) {
    let name = group.name;
    modal({
      title: `Rename "${group.name}"`,
      body: field('New bucket name', { value: group.name, onInput: (v) => { name = v; } }),
      actions: [
        { label: 'Cancel', variant: 'ghost' },
        {
          label: 'Save name', variant: 'primary',
          onClick: async () => {
            const trimmed = name.trim();
            if (!trimmed) { say('A bucket needs a name.', 'error'); return false; }
            await api.renameGroup(group.groupId, trimmed);
            say(`Renamed to "${trimmed}".`, 'success');
            await refresh();
            ctx.onChanged?.();
          },
        },
      ],
    });
  }

  function openDeleteBucketModal(group) {
    modal({
      title: `Remove bucket "${group.name}"?`,
      body: note('People in this bucket will NOT be deleted — they stay in All people and any other buckets they belong to.', 'info'),
      actions: [
        { label: 'Cancel', variant: 'ghost' },
        {
          label: 'Remove bucket', variant: 'danger',
          onClick: async () => {
            const res = await api.deleteGroup(group.groupId);
            if (!res?.deleted) {
              say(res?.reason ?? 'Could not remove that bucket.', 'error');
              return;
            }
            activeBucket = 'all';
            say(`Removed bucket "${group.name}".`, 'success');
            await refresh();
            ctx.onChanged?.();
          },
        },
      ],
    });
  }

  /* --------------------------------------------------------------- filtering */

  function sortRows(rows, sort) {
    const copy = [...rows];
    if (sort === 'username') copy.sort((a, b) => a.username.localeCompare(b.username));
    else if (sort === 'followers') copy.sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0));
    else if (sort === 'recent') copy.sort((a, b) => (b.followedAt ?? b.messagedAt ?? 0) - (a.followedAt ?? a.messagedAt ?? 0));
    else copy.sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0));
    return copy;
  }

  function applyFilters() {
    const search = filters.search.toLowerCase();
    let rows = allLeads.filter((lead) => {
      if (activeBucket !== 'all' && !(lead.groupIds ?? []).includes(activeBucket)) return false;
      if (search && !`${lead.username} ${lead.fullName ?? ''}`.toLowerCase().includes(search)) return false;
      if (filters.tiers.size && !filters.tiers.has(lead.warmthTier ?? 'cold')) return false;
      return true;
    });
    rows = sortRows(rows, filters.sort);
    vtable?.setRows(rows);
    return rows;
  }

  function renderFilterBar() {
    clear(filterBar);
    const search = el('input', {
      class: 'input', type: 'search', value: filters.search,
      placeholder: 'Search username or name…', style: { maxWidth: '260px' },
    });
    search.addEventListener('input', () => { filters.search = search.value; applyFilters(); updateCounts(); });

    const sortSelect = el('select', { class: 'select', style: { maxWidth: '180px' } });
    for (const option of SORTS) sortSelect.append(el('option', { value: option.value, text: option.label }));
    sortSelect.value = filters.sort;
    sortSelect.addEventListener('change', () => { filters.sort = sortSelect.value; applyFilters(); });

    filterBar.append(
      search,
      chipList(TIERS, [...filters.tiers], { onChange: (values) => { filters.tiers = new Set(values); applyFilters(); updateCounts(); } }),
      sortSelect,
      el('span', { class: 'grow' }),
      el('span', { class: 'small dim', id: 'people-count' }),
    );
  }

  function updateCounts() {
    const shown = vtable?.rowCount ?? 0;
    const scopeLeads = activeBucket === 'all'
      ? allLeads
      : allLeads.filter((lead) => (lead.groupIds ?? []).includes(activeBucket));
    const untouched = scopeLeads.filter((lead) => lead.relState === 'NONE' && lead.dmState === 'NONE').length;
    const node = root.querySelector('#people-count');
    if (node) node.textContent = `${shown} of ${scopeLeads.length} shown · ${untouched} untouched`;

    const allUntouched = allLeads.filter((lead) => lead.relState === 'NONE' && lead.dmState === 'NONE').length;
    ctx.setBadge?.('people', { total: allLeads.length, untouched: allUntouched });
  }

  /* ----------------------------------------------------------------- dossier */

  async function openDossier(lead) {
    const fresh = (await api.lead(lead.leadKey)) ?? lead;
    let edges = [];
    try { edges = await listEdgesForLead(fresh.leadKey); } catch { edges = []; }
    let all = [];
    try { all = await api.actions({ limit: 500 }); } catch { all = []; }
    const actions = all.filter((row) => row.leadKey === fresh.leadKey).slice(0, 12);

    const memberIds = new Set(fresh.groupIds ?? []);
    const bucketChips = el('div', { class: 'drawer-buckets' });
    const paintBucketChips = () => {
      clear(bucketChips);
      for (const group of groups) {
        const on = memberIds.has(group.groupId);
        bucketChips.append(el('button', {
          class: `chip ${on ? 'chip--on' : ''}`.trim(),
          type: 'button',
          'aria-pressed': on ? 'true' : 'false',
          text: on ? `✓ ${group.name}` : `+ ${group.name}`,
          onclick: async () => {
            const nextOn = !memberIds.has(group.groupId);
            if (nextOn) memberIds.add(group.groupId);
            else memberIds.delete(group.groupId);
            paintBucketChips();
            await setLeadGroup(fresh.leadKey, group.groupId, { on: nextOn });
            say(nextOn ? `Added @${fresh.username} to ${group.name}.` : `Removed @${fresh.username} from ${group.name}.`, 'success');
            await refresh();
            ctx.onChanged?.();
          },
        }));
      }
    };
    paintBucketChips();

    const body = el('div', { class: 'col' }, [
      el('div', { class: 'row row--wrap' }, [warmthBadge(fresh.warmthTier, fresh.priorityScore), stateBadge(fresh.relState), stateBadge(fresh.dmState)]),
      fresh.fullName ? el('div', {}, [scannedText(fresh.fullName, 'p')]) : null,
      fresh.biography ? el('div', { class: 'pre-wrap small dim' }, [scannedText(fresh.biography, 'span')]) : null,
      card('Buckets', bucketChips, { hint: 'click to add or remove' }),
      table(['Metric', 'Value'], [
        ['Priority score', String(Math.round(fresh.priorityScore ?? 0))],
        ['Followers', fmtNum(fresh.followers ?? null)],
        ['Following', fmtNum(fresh.following ?? null)],
        ['Private', fresh.isPrivate ? 'yes' : 'no'],
        ['Business', fresh.isBusiness ? 'yes' : 'no'],
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
        onClick: async () => {
          await upsertLead({ ...fresh, isWhitelisted: !fresh.isWhitelisted });
          say(fresh.isWhitelisted ? 'Whitelist removed.' : 'Protected: this person will never be actioned.', 'success');
          await refresh();
          ctx.onChanged?.();
        },
      }),
      btn('Do not contact', {
        variant: 'danger',
        onClick: async () => {
          await upsertLead({ ...fresh, doNotContactReason: 'marked by the owner' });
          say('Marked do-not-contact.', 'success');
          await refresh();
          ctx.onChanged?.();
        },
      }),
      btn('Delete', {
        variant: 'danger-solid',
        onClick: async () => {
          await api.deleteLead(fresh.leadKey);
          say(`Deleted @${fresh.username}.`, 'success');
          drawerApi?.close?.();
          await refresh();
          ctx.onChanged?.();
        },
      }),
    ];
    const drawerApi = drawer({ title: `@${fresh.username}`, body, actions: actions2, width: 'var(--drawer-w)' });
  }

  /* -------------------------------------------------------------- lifecycle */

  function tableViewportHeight() {
    const vh = typeof globalThis.innerHeight === 'number' && globalThis.innerHeight > 0 ? globalThis.innerHeight : 800;
    return Math.max(240, Math.min(Math.round(vh * 0.7), 640));
  }

  async function refresh() {
    try {
      const [loadedLeads, loadedGroups] = await Promise.all([api.leads({ limit: 50000 }), api.groups()]);
      allLeads = loadedLeads ?? [];
      groups = loadedGroups ?? [];
    } catch (error) {
      say(`Could not load your people: ${error?.message ?? error}`, 'error');
      allLeads = [];
      groups = [];
    }
    if (activeBucket !== 'all' && !groups.some((g) => g.groupId === activeBucket)) {
      activeBucket = 'all';
    }
    renderBucketTabs();
    renderBucketHeader();
    const rows = applyFilters();
    if (!vtable) {
      vtable = virtualTable(tableMount, {
        columns: COLUMNS,
        rows,
        rowHeight: 38,
        viewportHeight: tableViewportHeight(),
        overscan: 10,
        rowClass: () => 'vtable__row--clickable',
        onRowClick: (row) => openDossier(row),
        emptyMessage: allLeads.length
          ? 'No people match these filters.'
          : 'No people in this bucket yet. Go to Collect to gather people and save them here.',
      });
    } else {
      vtable.setRows(rows);
    }
    updateCounts();
  }

  function mount(container) {
    clear(root);
    root.append(bucketTabsBar, libraryCard);
    container.append(root);
    renderFilterBar();
    renderBucketTabs();
    renderBucketHeader();
    if (ctx.onRunEvent) {
      unsubscribe.push(ctx.onRunEvent((event) => {
        if (event.type === 'saved' || event.type === 'collected') void refresh();
      }));
    }
    if (ctx.onSync) {
      unsubscribe.push(ctx.onSync((message) => {
        if (!message?.type || message.type === 'LEADS_UPSERTED' || message.type === 'LEAD_STATE_CHANGED') void refresh();
      }));
    }
    void refresh();
  }

  function destroy() {
    for (const off of unsubscribe.splice(0)) { try { off?.(); } catch { /* noop */ } }
    vtable?.destroy();
    vtable = null;
    clear(root);
  }

  return {
    id: 'people',
    mount,
    refresh,
    destroy,
    root,
    selectBucket,
    get activeBucket() { return activeBucket; },
    get leads() { return allLeads; },
    get groups() { return groups; },
  };
}
