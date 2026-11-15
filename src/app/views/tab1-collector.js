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
  segmented, detailsLine, banner,
} from '../lib/ui.js';
import { virtualTable } from '../lib/virtual-list.js';
import { CollectSource } from '../../content/main.js';
import { RunPhase } from '../lib/runner.js';
import { SOURCE_FIELDS, SOURCE_GROUPS, parseTarget, describeTarget } from '../lib/target.js';
import { listEdgesForLead, upsertLead } from '../../storage/db.js';

// The nine collect sources, their four plain groups, and the field each one needs
// all live in lib/target.js (SOURCE_GROUPS / SOURCE_FIELDS), so the form, the live
// validation and the parser read one description and can never drift apart.

const TIERS = ['hot', 'warm', 'lukewarm', 'cold'];
const SORTS = [
  { value: 'score', label: 'Priority score' },
  { value: 'username', label: 'Username (A–Z)' },
  { value: 'followers', label: 'Followers' },
  { value: 'recent', label: 'Recently actioned' },
];

// Five columns only, so the table fits a laptop without crowding; the score,
// message state, sources and score breakdown all stay in the lead drawer.
const COLUMNS = [
  { key: 'username', label: 'Username', width: '1.3fr', cell: (row) => `@${row.username}` },
  { key: 'fullName', label: 'Name', width: '1.3fr', cell: (row) => scannedText(row.fullName ?? '') },
  { key: 'warmthTier', label: 'Warmth', width: '96px', cell: (row) => warmthBadge(row.warmthTier, row.priorityScore) },
  { key: 'relState', label: 'Status', width: '180px', cell: (row) => stateBadge(row.relState) },
  { key: 'followers', label: 'Followers', width: '104px', numeric: true, cell: (row) => fmtNum(row.followers ?? null, { compact: true }) },
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
  const libraryCard = card('Your people', [filterBar, tableMount], { hint: '' });

  let allLeads = [];
  let vtable = null;
  let filters = { search: '', tiers: new Set(), bucket: 'all', sort: 'score' };
  let groups = [];
  let lastPreview = null;
  const unsubscribe = [];

  /* ---------------------------------------------------------------- launcher */

  // Collect-form state. The picker, the adaptive field and the parser all read the
  // same descriptors from lib/target.js, so the form can never offer a source the
  // parser cannot validate, and the field always matches the chosen source.
  let source = CollectSource.FOLLOWERS;
  let rawInput = '';
  let limit = 200;
  let lastParse = null;
  let validateTimer = null;
  let targetFieldNode = null;
  let collectBtn = null;
  let initialApplied = false;
  let pendingFrom = null;

  const stepSource = el('div', { class: 'col' });
  const stepDetail = el('div', { class: 'col' });
  const statusLine = el('div', { class: 'status-line small dim', role: 'status', 'aria-live': 'polite' });
  const errorSlot = el('div', { class: 'col' });
  const bannerSlot = el('div');

  // One plain sentence per failure code plus what to do next. The raw internal
  // string is kept in a collapsed Details line, so nothing is lost for debugging.
  const HUMAN = {
    invalid_username: () => 'That does not look like an Instagram username. Use letters, numbers, . and _ only.',
    not_found: (name) => `Instagram could not find @${name}. Check the spelling, or the account may be private, removed or renamed.`,
    login_required: () => 'You are logged out of Instagram in this browser. Log in, reload the tab, then try again.',
    rate_limited: () => 'Instagram asked us to slow down. The run was paused. Wait a few minutes before trying again.',
    no_numeric_id: (name) => `Could not get @${name}'s ID from Instagram. Open their profile in the Instagram tab, wait for it to load, then press Collect.`,
    no_recent_posts: (name) => `@${name} has no readable recent posts (private account, or no posts).`,
    network: () => 'Could not reach Instagram. Check your connection.',
    no_tab: () => 'No Instagram tab is open. Open instagram.com in a tab and try again.',
  };

  function targetName() {
    return lastParse?.username ?? lastParse?.shortcode ?? lastParse?.tag ?? (rawInput.trim() || 'this account');
  }

  function humanFor(code, technical) {
    // Safety refusals keep pacing.js's own wording verbatim; never soften them.
    if (code === 'blocked') return { message: technical ?? 'Instagram blocked an action.', safety: true };
    const make = HUMAN[code];
    if (make) return { message: make(targetName()), safety: false };
    return { message: technical ?? 'The collection did not finish.', safety: false };
  }

  function metaFor(src) { return SOURCE_FIELDS[src] ?? SOURCE_FIELDS.current_page; }

  function groupOfSource(src) {
    const group = SOURCE_GROUPS.find((g) => g.options.some((o) => o.value === src));
    return (group ?? SOURCE_GROUPS[0]).id;
  }

  function renderSourcePicker() {
    clear(stepSource);
    const groupId = groupOfSource(source);
    stepSource.append(el('div', { class: 'step__label', text: 'Step 1 \u2013 What do you want to collect from?' }));
    const groupBar = el('div', { class: 'source-groups', role: 'group', 'aria-label': 'What to collect from' });
    for (const group of SOURCE_GROUPS) {
      const on = group.id === groupId;
      groupBar.append(el('button', {
        class: `source-group ${on ? 'source-group--on' : ''}`.trim(),
        type: 'button', 'aria-pressed': on ? 'true' : 'false', text: group.label,
        onclick: () => setSource(group.options[0].value),
      }));
    }
    stepSource.append(groupBar);
    const group = SOURCE_GROUPS.find((g) => g.id === groupId);
    if (group && group.options.length > 1) {
      const options = group.options.map((o) => ({ id: o.value, label: o.label }));
      stepSource.append(el('div', { class: 'mt-2' }, [segmented(options, source, { onSelect: (value) => setSource(value) })]));
    }
  }

  function setSource(next) {
    source = next;
    renderSourcePicker();
    renderDetail();
  }

  function renderDetail() {
    clear(stepDetail);
    const meta = metaFor(source);
    stepDetail.append(el('div', { class: 'step__label', text: 'Step 2 \u2013 Details' }));
    if (meta.needsField) {
      const f = field(meta.label, {
        value: rawInput, placeholder: meta.placeholder,
        onInput: (value) => { rawInput = value; scheduleValidate(); },
      });
      targetFieldNode = f;
      f.field.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); if (collectEnabled()) void doCollect(); }
      });
      stepDetail.append(f);
    } else {
      targetFieldNode = null;
      stepDetail.append(note(meta.helper, 'info'));
    }
    stepDetail.append(field('How many', {
      type: 'number', value: String(limit), hint: 'Between 1 and 5000.',
      onInput: (value) => { limit = Math.max(1, Math.min(5000, Number(value) || 200)); },
    }));
    validate(true);
    updateCollectEnabled();
  }

  function collectEnabled() {
    const meta = metaFor(source);
    if (!meta.needsField) return true;
    return Boolean(lastParse?.ok);
  }

  function updateCollectEnabled() {
    if (!collectBtn) return;
    const enabled = collectEnabled();
    if (enabled) collectBtn.removeAttribute('disabled');
    else collectBtn.setAttribute('disabled', '');
    collectBtn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  }

  function validate(quiet) {
    const meta = metaFor(source);
    if (!meta.needsField) { lastParse = null; return; }
    const text = rawInput.trim();
    if (!text) {
      lastParse = null;
      if (targetFieldNode) targetFieldNode.field.setHelper(meta.helper);
      return;
    }
    lastParse = parseTarget(source, text);
    if (!targetFieldNode) return;
    if (lastParse.ok) targetFieldNode.field.setOk(`\u2713 ${describeTarget(lastParse)}`);
    else if (!quiet) targetFieldNode.field.setError(lastParse.error);
    else targetFieldNode.field.setHelper(meta.helper);
  }

  function scheduleValidate() {
    if (validateTimer) clearTimeout(validateTimer);
    validateTimer = setTimeout(() => { validateTimer = null; validate(false); updateCollectEnabled(); }, 150);
    if (typeof validateTimer?.unref === 'function') validateTimer.unref();
  }

  function showCollectError(code, technical) {
    clear(errorSlot);
    const { message, safety } = humanFor(code, technical);
    errorSlot.append(note(message, safety ? 'danger' : 'warning'));
    if (technical && technical !== message) errorSlot.append(detailsLine('Details', technical));
  }

  // The pill sends the page it was clicked from; aim the collection at that exact
  // tab, because opening the dashboard moves focus and "the active Instagram tab"
  // is no longer the one the owner clicked.
  async function resolveTabId(from) {
    const query = globalThis.chrome?.tabs?.query;
    if (typeof query !== 'function') return { tabId: undefined };
    let found = [];
    try { found = await query({ url: '*://*.instagram.com/*' }); } catch { found = []; }
    if (!Array.isArray(found) || found.length === 0) return { tabId: undefined, noneFound: true };
    const norm = (u) => String(u ?? '').split('#')[0];
    if (from) {
      const match = found.find((t) => norm(t.url) === norm(from));
      if (match) return { tabId: match.id };
    }
    return { tabId: undefined };
  }

  async function doCollect() {
    const meta = metaFor(source);
    clear(errorSlot);
    if (meta.needsField) {
      const parsed = parseTarget(source, rawInput);
      if (!parsed.ok) {
        if (targetFieldNode) targetFieldNode.field.setError(parsed.error);
        showCollectError(parsed.code, parsed.error);
        return;
      }
      lastParse = parsed;
    }
    statusLine.textContent = 'Opening the source and reading it at a human pace\u2026';
    let tabId;
    const from = pendingFrom;
    pendingFrom = null;
    if (from) {
      const resolved = await resolveTabId(from);
      if (resolved.noneFound) {
        statusLine.textContent = '';
        clear(bannerSlot);
        showCollectError('no_tab', 'Could not find the Instagram tab you clicked from. Open it again and press Collect.');
        return;
      }
      tabId = resolved.tabId;
    }
    const out = await controller.collect({
      source,
      username: lastParse?.username ?? null,
      shortcode: lastParse?.shortcode ?? null,
      tag: lastParse?.tag ?? null,
      limit,
      statusIntervalMs: 1000,
      tabId,
    });
    clear(bannerSlot);
    if (out.ok) {
      statusLine.textContent = `Collected ${out.count}. Review the preview, then save it into a bucket.`;
      lastPreview = { runId: out.runId, result: out.result };
      renderPreview();
    } else {
      statusLine.textContent = '';
      showCollectError(out.code, out.reason);
      lastPreview = null;
      renderPreview();
    }
  }

  function renderLauncher() {
    collectBtn = btn('Collect', { variant: 'primary', busyLabel: 'Collecting\u2026', onClick: () => doCollect() });
    collectBtn.classList.add('btn--lg');
    renderSourcePicker();
    renderDetail();
    replaceCard(launcherCard, el('div', { class: 'col' }, [
      bannerSlot,
      stepSource,
      stepDetail,
      el('div', { class: 'step' }, [
        el('div', { class: 'step__label', text: 'Step 3 \u2013 Collect' }),
        el('div', { class: 'row' }, [collectBtn]),
        statusLine,
        errorSlot,
      ]),
    ]));
    updateCollectEnabled();
  }

  // The pill can open the dashboard with a source and target already chosen and
  // auto='1'. Pre-fill the form, then start once - unless a run is already going.
  function applyInitialRequest() {
    const req = ctx.initialRequest;
    if (req && !initialApplied) {
      initialApplied = true;
      pendingFrom = req.from ?? null;
      if (req.source && SOURCE_FIELDS[req.source]) source = req.source;
      rawInput = req.username
        ?? (req.shortcode ? `https://www.instagram.com/p/${req.shortcode}/` : (req.tag ? `#${req.tag}` : ''));
      renderLauncher();
      if (req.auto === '1') {
        const busy = new Set([RunPhase.PREPARING, RunPhase.RUNNING, RunPhase.WAITING, RunPhase.STOPPING]);
        if (busy.has(controller.state?.phase)) {
          pendingFrom = null;
          showCollectError(null, 'A run is already in progress.');
          return;
        }
        const label = describeTarget(parseTarget(source, rawInput)) || 'this page';
        clear(bannerSlot);
        bannerSlot.append(banner(`Started from Instagram: collecting ${label}.`, {
          variant: 'info',
          actions: [btn('Stop', { variant: 'danger', onClick: () => controller.stop('stopped by the owner') })],
        }));
        void doCollect();
      }
      return;
    }
    renderLauncher();
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
      return [`@${lead.username}`, scannedText(lead.fullName ?? ''), warmthBadge(lead.warmthTier ?? 'cold', lead.priorityScore ?? null)];
    });
    previewCard.append(card(`Preview \u2014 ${leads.length} collected`, [
      note('These people are not in your library yet. Save them into a bucket to keep them, or discard the collection.', 'info'),
      table(['Username', 'Name', 'Warmth'], rows),
      el('div', { class: 'row row--wrap mt-4' }, [
        field('Save into', {
          value: '',
          placeholder: 'Linen suppliers',
          hint: 'A bucket is a named list, like "Linen suppliers".',
          onInput: (value) => { bucketName = value; },
        }),
        btn('Save', {
          variant: 'primary', busyLabel: 'Saving\u2026',
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
        btn('Discard', { variant: 'danger', busyLabel: '\u2026', onClick: async () => { await controller.discard({ runId: lastPreview.runId }); lastPreview = null; renderPreview(); say('Collection discarded.'); } }),
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

  // The table caps its own height from the viewport (matching the CSS
  // max-height: min(70vh, 640px)), never a number hard-coded in JS.
  function tableViewportHeight() {
    const vh = typeof globalThis.innerHeight === 'number' && globalThis.innerHeight > 0 ? globalThis.innerHeight : 800;
    return Math.max(240, Math.min(Math.round(vh * 0.7), 640));
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
        columns: COLUMNS, rows, rowHeight: 38, viewportHeight: tableViewportHeight(), overscan: 10,
        rowClass: () => 'vtable__row--clickable',
        onRowClick: (row) => openDossier(row),
        emptyMessage: allLeads.length ? 'No people match these filters.' : 'No people collected yet \u2014 start with Step 1 above \u2191, then save them into a bucket.',
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
    applyInitialRequest();
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
    if (validateTimer) { clearTimeout(validateTimer); validateTimer = null; }
    vtable?.destroy();
    vtable = null;
    clear(root);
  }

  return { mount, refresh, destroy, root, get leads() { return allLeads; } };
}
