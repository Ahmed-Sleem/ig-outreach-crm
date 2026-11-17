/**
 * Tab 2 — Outreach: follow, message and clean up.
 *
 * The control room, one column top to bottom. A bucket selector across the top
 * picks which people a run touches and a small stat row summarises the funnel;
 * the run header plans a run (a dry run that costs nothing and touches no tab),
 * shows the governor's budget and gate in plain words, then starts, streams and
 * stops the real thing. Below it the message studio edits the template pool and
 * lints it against the same rules the sender enforces, so a message that would be
 * refused at send time is refused here, while it is still being written. Pool
 * health and the template list sit in a collapsed section at the bottom.
 *
 * The runner does the acting; this view only decides WHAT to ask for (mode,
 * bucket, policy) and renders what the runner reports. It never touches a tab or
 * the governor directly.
 */

import {
  btn, card, el, clear, field, modal, note, stat, table, toggle, toast,
  warmthBadge, scannedText, isRtlText, fmtNum,
} from '../lib/ui.js';
import { RunPhase, messageContextFor } from '../lib/runner.js';
import { QueueMode, humanDurationMs, clockAt } from '../../core/queue.js';
import { CleanupMode } from '../../core/lifecycle.js';
import { EntropyPoolRNG } from '../../core/random.js';
import { countMessageVariations, sampleRenders } from '../../core/templates.js';
import {
  MESSAGE_BYTE_LIMIT, MIN_POOL_TEMPLATES, MIN_POOL_VARIATIONS,
  lintTemplate, lintPool,
} from '../../core/linter.js';
import { templateRecord, putTemplate, deleteTemplate } from '../../storage/db.js';

const MODES = [
  { value: QueueMode.FOLLOW, id: 'follow', label: 'Follow', cardTitle: 'Follow run', cta: 'Start Follow run' },
  { value: QueueMode.DM, id: 'dm', label: 'Messages', cardTitle: 'Messages run', cta: 'Start Messages run' },
  { value: QueueMode.UNFOLLOW, id: 'unfollow', label: 'Unfollow', cardTitle: 'Unfollow run', cta: 'Start Unfollow run' },
];

const CLEANUP_MODES = [
  { value: CleanupMode.NON_RESPONDERS, label: 'Non-responders only (protect follow-backs)' },
  { value: CleanupMode.STALE_REQUESTS, label: 'Withdraw stale pending requests' },
  { value: CleanupMode.FULL_CYCLE, label: 'Full cycle (clean campaign mutuals too)' },
];

const FUNNEL_BY_MODE = {
  [QueueMode.FOLLOW]: [
    ['untouched', 'Untouched'],
    ['queued', 'Queued'],
    ['requested', 'Awaiting accept'],
    ['following', 'Following'],
    ['mutual', 'Mutual'],
  ],
  [QueueMode.DM]: [
    ['mutual', 'Mutual'],
    ['following', 'Following'],
    ['messaged', 'Messaged'],
    ['replied', 'Replied'],
  ],
  [QueueMode.UNFOLLOW]: [
    ['requested', 'Awaiting accept'],
    ['following', 'Following'],
    ['mutual', 'Mutual'],
    ['replied', 'Replied'],
  ],
};

const RUNNING_PHASES = new Set([RunPhase.PREPARING, RunPhase.RUNNING, RunPhase.WAITING, RunPhase.STOPPING]);

/**
 * @param {{api: object, controller: object, toast?: Function, onRunEvent?: Function, onSync?: Function, onChanged?: Function, setBadge?: Function}} ctx
 */
export function createOutreachView(ctx = {}) {
  const api = ctx.api;
  const controller = ctx.controller;
  if (!api) throw new Error('createOutreachView needs an api client');
  if (!controller) throw new Error('createOutreachView needs a run controller');
  const say = ctx.toast ?? toast;

  const root = el('div', { class: 'outreach' });
  const subtabsBar = el('nav', { class: 'subtabs', role: 'tablist', 'aria-label': 'Outreach mode' });
  const bucketBar = el('nav', { class: 'bucket-bar' });
  const funnelRow = el('div', { class: 'stat-row' });
  const autopilotCard = card('Follow run', el('div'));
  const budgetRow = el('div', { class: 'grid grid--4' });
  const gateNote = el('div');
  // The header carries the quota meters and the Start/Stop controls together.
  const headerWrap = el('div', { class: 'outreach__header' }, [autopilotCard, budgetRow, gateNote]);
  const queueCard = card('Queue preview', el('div'), { hint: 'a dry run costs nothing' });
  const logCard = card('Run log', el('div', { class: 'runlog' }));
  const studioCard = card('Message studio', el('div'));
  // Pool health and the template list are reference material inside Messages.
  const poolBody = el('div', { class: 'col' });
  const poolDetails = el('details', { class: 'details--section' }, [
    el('summary', { text: 'Pool health & templates' }),
    poolBody,
  ]);
  const messagesSlot = el('div', { class: 'col' });

  let groups = [];
  let leads = [];
  let templates = [];
  let selectedGroupId = null;
  let mode = QueueMode.FOLLOW;
  let plan = null;
  let running = false;
  let runLog = [];
  let limit = 100;
  const rng = new EntropyPoolRNG();
  const unsubscribe = [];

  // Policy is per-mode and rebuilt from the controls each time, so a toggle is
  // never stale relative to what the runner is handed.
  const policyState = {
    allowRefollow: false,
    mutualOnly: false,
    allowExistingThread: false,
    cleanupMode: CleanupMode.NON_RESPONDERS,
    graceDays: 5,
    staleRequestDays: 10,
    campaignFinished: false,
  };

  function currentPolicy() {
    if (mode === QueueMode.DM) {
      return { mutualOnly: policyState.mutualOnly, allowExistingThread: policyState.allowExistingThread };
    }
    if (mode === QueueMode.UNFOLLOW) {
      return {
        cleanupMode: policyState.cleanupMode,
        graceMs: policyState.graceDays * 86_400_000,
        staleRequestMs: policyState.staleRequestDays * 86_400_000,
        campaignFinished: policyState.campaignFinished,
      };
    }
    return { allowRefollow: policyState.allowRefollow };
  }

  function isRunning() { return running || RUNNING_PHASES.has(controller.state.phase); }

  function modeMeta(m = mode) {
    return MODES.find((entry) => entry.value === m) ?? MODES[0];
  }

  function setMode(nextMode) {
    mode = nextMode;
    renderSubtabs();
    renderFunnel();
    renderControls();
    renderMessagesSlot();
    void refreshPlan();
  }

  function renderSubtabs() {
    clear(subtabsBar);
    for (const option of MODES) {
      const on = mode === option.value;
      subtabsBar.append(el('button', {
        class: `subtab ${on ? 'subtab--on' : ''}`.trim(),
        role: 'tab',
        type: 'button',
        'aria-selected': on ? 'true' : 'false',
        'data-outreach-tab': option.id,
        text: option.label,
        onclick: () => setMode(option.value),
      }));
    }
  }

  function renderMessagesSlot() {
    clear(messagesSlot);
    if (mode === QueueMode.DM) {
      renderStudio();
      messagesSlot.append(studioCard, poolDetails);
    }
  }

  /* ------------------------------------------------------- buckets & funnel */

  function scopedLeads() {
    if (selectedGroupId === null) return leads;
    return leads.filter((lead) => (lead.groupIds ?? []).includes(selectedGroupId));
  }

  function funnelCounts() {
    const counts = { untouched: 0, queued: 0, requested: 0, following: 0, mutual: 0, replied: 0, messaged: 0 };
    for (const lead of scopedLeads()) {
      const rel = lead.relState ?? 'NONE';
      const dm = lead.dmState ?? 'NONE';
      if (rel === 'NONE' && dm === 'NONE') counts.untouched += 1;
      if (rel === 'FOLLOW_QUEUED') counts.queued += 1;
      if (rel === 'FOLLOW_REQUESTED') counts.requested += 1;
      if (rel === 'FOLLOWING') counts.following += 1;
      if (rel === 'MUTUAL') counts.mutual += 1;
      if (dm === 'DM_REPLIED') counts.replied += 1;
      if (dm.startsWith('DM_SENT')) counts.messaged += 1;
    }
    return counts;
  }

  function renderSelectors() { renderBuckets(); renderFunnel(); }

  // The bucket selector is a horizontal row of chips above the content.
  // Choosing one narrows the queue and funnel summary to that bucket.
  function renderBuckets() {
    clear(bucketBar);
    bucketBar.append(el('span', { class: 'bucket-bar__label', text: 'Bucket' }));
    const chips = el('div', { class: 'chips' });
    chips.append(bucketChip('All people', leads.length, selectedGroupId === null, () => { selectedGroupId = null; renderSelectors(); void refreshPlan(); }));
    for (const group of groups) {
      const count = leads.filter((lead) => (lead.groupIds ?? []).includes(group.groupId)).length;
      chips.append(bucketChip(group.name, count, selectedGroupId === group.groupId, () => { selectedGroupId = group.groupId; renderSelectors(); void refreshPlan(); }));
    }
    bucketBar.append(chips);
    bucketBar.append(btn('+ New bucket', { variant: 'sm ghost', onClick: () => newBucket() }));
  }

  function bucketChip(label, count, on, onClick) {
    return el('button', {
      class: `chip ${on ? 'chip--on' : ''}`.trim(), type: 'button',
      'aria-pressed': on ? 'true' : 'false', onclick: onClick,
    }, [el('span', { text: label }), el('span', { class: 'chip__count', text: String(count) })]);
  }

  // Funnel counts scoped to the current outreach sub-tab (Follow / Messages / Unfollow).
  function renderFunnel() {
    clear(funnelRow);
    const counts = funnelCounts();
    const items = FUNNEL_BY_MODE[mode] ?? FUNNEL_BY_MODE[QueueMode.FOLLOW];
    for (const [key, label] of items) {
      funnelRow.append(el('div', { class: 'stat-row__item' }, [
        el('span', { class: 'stat-row__label', text: label }),
        el('span', { class: 'stat-row__value', text: String(counts[key] ?? 0) }),
      ]));
    }
  }

  function newBucket() {
    let name = '';
    modal({
      title: 'New bucket',
      body: field('Bucket name', { value: '', placeholder: 'Ramadan campaign', onInput: (value) => { name = value; } }),
      actions: [
        { label: 'Cancel', variant: 'ghost' },
        {
          label: 'Create', variant: 'primary',
          onClick: async () => {
            const trimmed = name.trim();
            if (!trimmed) { say('A bucket needs a name.', 'error'); return false; }
            await api.createGroup({ name: trimmed });
            say(`Bucket "${trimmed}" created.`, 'success');
            await refresh();
            ctx.onChanged?.();
          },
        },
      ],
    });
  }

  /* ------------------------------------------------------------- autopilot */

  function renderBudget() {
    clear(budgetRow);
    const budget = plan?.budget ?? null;
    if (!budget) { budgetRow.append(note('Plan a run to see the governor budget.', '')); return; }
    const locked = Boolean(budget.lockedUntil);
    const dominant = mode === QueueMode.DM ? budget.warmDm : mode === QueueMode.UNFOLLOW ? budget.unfollow : budget.follow;
    const dmLine = mode === QueueMode.DM ? budget.coldDm : budget.warmDm;
    budgetRow.append(
      stat('Remaining today (combined)', fmtNum(budget.combinedRemainingToday), { sub: budget.scheduleOpen ? 'window open' : `window opens ${clockAt(budget.windowOpensAt) ?? '—'}` }),
      stat(mode === QueueMode.UNFOLLOW ? 'Unfollows' : mode === QueueMode.DM ? 'Warm DMs' : 'Follows', `${dominant.used.daily}/${dominant.dailyCap}`, { sub: `${dominant.remainingThisHour} left this hour` }),
      stat(mode === QueueMode.DM ? 'Cold invites' : 'Warm DMs', `${dmLine.used.daily}/${dmLine.dailyCap}`, { sub: 'daily sub-cap' }),
      stat('Warm-up', budget.warmupFactor >= 1 ? 'full' : `${Math.round(budget.warmupFactor * 100)}%`, { sub: locked ? 'locked' : `day ${budget.warmupDay}` }),
    );
    clear(gateNote);
    const outsideWindow = plan?.gate?.reason === 'outside the active window' || (!locked && !budget.scheduleOpen);
    if (locked) {
      gateNote.append(note(`Everything is locked until ${clockAt(budget.lockedUntil)} — ${budget.lockReason ?? 'safety lock'}. Starting again early only extends the platform's patience.`, 'danger'));
    } else if (outsideWindow) {
      const startH = plan?.settings?.schedule?.activeStartLocal ?? '09:30';
      const endH = plan?.settings?.schedule?.activeEndLocal ?? '22:30';
      const opens = clockAt(budget.windowOpensAt ?? plan?.gate?.opensAt) ?? startH;
      const box = el('div', { class: 'note note--warning row row--wrap' }, [
        el('span', {
          class: 'grow',
          text: `Paused by your local active-hours schedule (${startH}–${endH}; opens at ${opens}). You have not hit any follow/DM limit — turn off the active-hours window if you want to run right now.`,
        }),
        btn('Run at any hour', {
          variant: 'sm primary',
          onClick: async () => {
            await api.saveSettings({ scheduleEnabled: false });
            say('Active-hours restriction disabled. Daily & hourly caps still apply.', 'success');
            await refreshPlan();
            ctx.onChanged?.();
          },
        }),
      ]);
      gateNote.append(box);
    } else if (plan && !plan.canStart) {
      gateNote.append(note(plan.gateMessage ?? 'The governor will not start this run right now.', 'warning'));
    }
  }

  function renderControls() {
    const meta = modeMeta();
    const titleNode = autopilotCard.querySelector('.card__title');
    if (titleNode) titleNode.textContent = meta.cardTitle;

    const busy = isRunning();
    const actionRow = el('div', { class: 'row row--wrap mt-4' }, [
      el('label', { class: 'row small dim' }, ['Up to', el('input', {
        class: 'input', type: 'number', value: String(limit), style: { width: '84px' },
        oninput: (event) => { limit = Math.max(1, Math.min(5000, Number(event.target.value) || 100)); },
      }), 'actions']),
      el('span', { class: 'grow' }),
      btn('Plan (dry run)', { disabled: busy, busyLabel: 'Planning…', onClick: () => refreshPlan() }),
      busy
        ? btn('Stop', { variant: 'danger', onClick: () => { controller.stop('stopped by the owner'); say('Stopping after the current action…'); } })
        : btn(meta.cta, { variant: 'primary', disabled: !plan?.canStart, busyLabel: 'Running…', onClick: () => start() }),
    ]);

    replaceCard(autopilotCard, el('div', { class: 'autopilot' }, [
      policyRow(),
      actionRow,
    ]));
  }

  function policyRow() {
    const wrap = el('div', { class: 'row row--wrap' });
    if (mode === QueueMode.DM) {
      wrap.append(
        toggle('Only message mutuals (wait for follow-back)', policyState.mutualOnly, { hint: 'safest: guarantees primary-inbox delivery', onChange: (v) => { policyState.mutualOnly = v; void refreshPlan(); } }),
        toggle('Allow an existing thread', policyState.allowExistingThread, { onChange: (v) => { policyState.allowExistingThread = v; void refreshPlan(); } }),
      );
    } else if (mode === QueueMode.UNFOLLOW) {
      const select = el('select', { class: 'select', style: { maxWidth: '360px' } });
      for (const option of CLEANUP_MODES) select.append(el('option', { value: option.value, text: option.label }));
      select.value = policyState.cleanupMode;
      select.addEventListener('change', () => { policyState.cleanupMode = select.value; void refreshPlan(); });
      wrap.append(
        el('label', { class: 'field', style: { marginBottom: '0' } }, [el('span', { class: 'field__label', text: 'Cleanup scope' }), select]),
        toggle('Campaign finished (allow cleaning mutuals)', policyState.campaignFinished, { onChange: (v) => { policyState.campaignFinished = v; void refreshPlan(); } }),
      );
    } else {
      wrap.append(toggle('Allow re-following people we unfollowed', policyState.allowRefollow, { hint: 'off by default: re-following looks like churn', onChange: (v) => { policyState.allowRefollow = v; void refreshPlan(); } }));
    }
    return wrap;
  }

  async function start() {
    running = true;
    renderControls();
    say('Run started. Watch the log; Stop lands after the current action.');
    const summary = await controller.outreach({ mode, groupId: selectedGroupId, policy: currentPolicy(), limit, dryRun: false });
    running = false;
    renderControls();
    if (summary?.ok) {
      say(`Run finished: ${summary.counts.done} done, ${summary.counts.refused} refused, ${summary.counts.skipped} skipped.`, 'success');
    } else {
      say(`Run ended: ${summary?.reason ?? 'unknown reason'}`, 'error');
    }
    await refreshPlan();
    await refresh();
    ctx.onChanged?.();
  }

  async function refreshPlan() {
    if (isRunning()) return;
    const out = await controller.outreach({ mode, groupId: selectedGroupId, policy: currentPolicy(), limit, dryRun: true });
    plan = out?.plan ?? null;
    renderBudget();
    renderQueue();
    renderControls();
    ctx.setBadge?.('outreach', { ready: plan?.counts?.ready ?? 0, queued: plan?.counts?.queued ?? 0 });
  }

  function renderQueue() {
    const body = el('div');
    if (!plan) { replaceCard(queueCard, note('Plan a run to preview the queue.', '')); return; }
    const counts = plan.counts ?? {};
    body.append(el('div', { class: 'row row--wrap mb-2' }, [
      stat('Ready', fmtNum(counts.ready ?? 0)),
      stat('Queued', fmtNum(counts.queued ?? 0)),
      stat('Skipped', fmtNum(counts.skipped ?? 0), { sub: Object.entries(counts.byCode ?? {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'none' }),
      stat('Estimated time', plan.estimate?.humanReadable ?? '—', { sub: plan.estimate ? `${plan.estimate.breaks} breaks · ${plan.estimate.distractions} distractions` : null }),
    ]));
    const top = (plan.queue ?? []).slice(0, 12);
    if (!top.length) {
      const dmMutualEmpty = mode === QueueMode.DM && policyState.mutualOnly && (counts.considered ?? 0) > 0;
      const emptyMsg = dmMutualEmpty
        ? 'Nobody in this bucket follows you back yet. Turn off "Only message mutuals" above to message people as cold invites (within your cold-invite cap), or run Follow first.'
        : (counts.ready === 0
          ? 'Nobody is waiting for this action right now: everyone in scope was already actioned, is protected, or is inside a spacing delay.'
          : 'The queue is empty.');
      body.append(note(emptyMsg, ''));
    } else if (mode === QueueMode.DM) {
      body.append(table(
        ['#', 'Username', 'Warmth', 'Action', 'Message preview'],
        top.map((entry) => [
          String(entry.rank),
          `@${entry.lead.username}`,
          warmthBadge(entry.lead.warmthTier, entry.lead.priorityScore),
          String(entry.actionType ?? ''),
          previewFor(entry.lead),
        ]),
        { numeric: [0] },
      ));
    } else {
      body.append(table(
        ['#', 'Username', 'Warmth', 'Action'],
        top.map((entry) => [
          String(entry.rank),
          `@${entry.lead.username}`,
          warmthBadge(entry.lead.warmthTier, entry.lead.priorityScore),
          String(entry.actionType ?? ''),
        ]),
        { numeric: [0] },
      ));
    }
    replaceCard(queueCard, body);
  }

  function previewFor(lead) {
    const enabled = templates.filter((t) => t.enabled !== false);
    if (!enabled.length) return '—';
    const context = messageContextFor(lead, { viewerUsername: null });
    const sample = enabled[0].body;
    try {
      const rendered = sampleRenders(sample, context, rng, 1)[0] ?? '';
      return rendered.length > 60 ? `${rendered.slice(0, 59)}…` : rendered;
    } catch { return '—'; }
  }

  /* ---------------------------------------------------------------- run log */

  function pushLog(line) {
    runLog.push(line);
    if (runLog.length > 200) runLog = runLog.slice(-200);
    renderLog();
  }

  function renderLog() {
    const body = logCard.querySelector('.runlog') ?? el('div', { class: 'runlog' });
    clear(body);
    if (!runLog.length) { body.append(el('div', { class: 'small dim', text: 'Nothing has run yet.' })); }
    for (const line of runLog.slice(-60)) {
      body.append(el('div', { class: `runlog__line ${line.tone ? `runlog__line--${line.tone}` : ''}` }, [
        el('span', { class: 'runlog__time', text: line.time }),
        el('span', { text: line.text }),
      ]));
    }
    if (!logCard.querySelector('.runlog')) logCard.append(body);
  }

  function onRunEvent(event) {
    const time = clockAt(event.at ?? Date.now()) ?? '';
    switch (event.type) {
      case 'plan': pushLog({ time, text: `Planned ${event.ready} ready of ${event.queued} queued (${event.skipped} skipped).` }); break;
      case 'session': pushLog({ time, text: `Session opened on ${event.tabLabel ?? 'your Instagram tab'}; ${event.planned} planned.` }); break;
      case 'delay': pushLog({ time, text: `Waiting ${humanDurationMs(event.ms)} before ${event.actionType} @${event.username}.` }); break;
      case 'waiting': pushLog({ time, text: `${event.label ?? 'Waiting'} — ${event.human} left.` }); break;
      case 'action': pushLog({ time, text: `${event.actionType} @${event.username}${event.messagePreview ? ` — "${event.messagePreview}"` : ''}` }); break;
      case 'outcome': {
        const tone = event.ok ? 'ok' : (event.outcome === 'skipped' ? '' : event.outcome === 'refused' ? 'refused' : 'failed');
        const label = event.outcome === 'skipped'
          ? `Skipped @${event.username}${event.reason ? ` (${event.reason})` : ''} — continuing`
          : `@${event.username}: ${event.outcome}${event.reason ? ` (${event.reason})` : ''}`;
        pushLog({ time, tone, text: `${label} · ${event.combinedRemainingToday} left today.` });
        break;
      }
      case 'skip': pushLog({ time, text: `Skipped @${event.username ?? event.leadKey}: ${event.reason}` }); break;
      case 'refusal': pushLog({ time, tone: 'refused', text: `Refused @${event.username}: ${event.reason}` }); break;
      case 'summary': pushLog({ time, tone: event.ok ? 'ok' : 'failed', text: `Run ${event.ok ? 'finished' : 'ended'}: ${event.counts.done} done, ${event.counts.refused} refused, ${event.counts.failed} failed, ${event.counts.skipped} skipped.${event.reason ? ` ${event.reason}` : ''}` }); break;
      case 'warning': pushLog({ time, tone: 'refused', text: event.reason }); break;
      default: break;
    }
    if (event.type === 'summary') { running = false; renderControls(); void refreshPlan(); }
  }

  /* --------------------------------------------------------- message studio */

  // The linter reads {body, title, active}; the store keeps {body, label,
  // enabled}. Map on the way in so a stored pool lints correctly.
  function lintShape(template) {
    return { body: template.body ?? '', title: template.label || 'Untitled template', active: template.enabled !== false };
  }

  let editing = { templateId: null, label: '', body: '', enabled: true };

  function newTemplate() {
    editing = { templateId: null, label: '', body: '', enabled: true };
    renderStudio();
  }

  function editTemplate(template) {
    editing = { templateId: template.templateId, label: template.label ?? '', body: template.body ?? '', enabled: template.enabled !== false };
    renderStudio();
  }

  async function saveTemplate() {
    const body = editing.body.trim();
    if (!body) { say('A template needs a message body.', 'error'); return; }
    const record = templateRecord({
      workspaceId: api.workspaceId,
      body,
      label: editing.label.trim() || 'Untitled template',
      enabled: editing.enabled,
      templateId: editing.templateId,
    });
    await putTemplate(record);
    editing = { templateId: record.templateId, label: record.label, body: record.body, enabled: record.enabled };
    say(editing.templateId ? 'Template saved.' : 'Template created.', 'success');
    await loadTemplates();
    renderStudio();
    void refreshPlan();
    ctx.onChanged?.();
  }

  async function removeTemplate(templateId) {
    if (!templateId) { newTemplate(); return; }
    await deleteTemplate(templateId);
    say('Template deleted.');
    await loadTemplates();
    if (editing.templateId === templateId) newTemplate();
    else renderStudio();
    void refreshPlan();
    ctx.onChanged?.();
  }

  function editorReadouts() {
    const variations = countMessageVariations(editing.body);
    const lint = lintTemplate(lintShape(editing), { cold: mode !== QueueMode.DM || policyState.mutualOnly === false });
    const context = messageContextFor({ username: 'sample', fullName: 'Sample Person' }, { viewerUsername: null });
    let preview = '';
    try { preview = sampleRenders(editing.body, context, rng, 1)[0] ?? ''; } catch { preview = ''; }
    return { variations, lint, preview };
  }

  function renderEditor() {
    const readouts = editorReadouts();
    const previewNode = el('div', { class: 'studio__preview' });
    const metaNode = el('div', { class: 'studio__meta' });
    const lintNode = el('div', { class: 'col' });

    function paint() {
      const r = editorReadouts();
      clear(previewNode);
      previewNode.append(r.preview ? scannedText(r.preview) : el('span', { class: 'faint', text: 'A rendered sample appears here.' }));
      if (r.preview && isRtlText(r.preview)) previewNode.setAttribute('dir', 'rtl');
      clear(metaNode);
      metaNode.append(
        el('span', { text: `${r.lint.bytes} / ${MESSAGE_BYTE_LIMIT} bytes` }),
        el('span', { text: `${r.variations} variation${r.variations === 1 ? '' : 's'}` }),
        el('span', { text: r.lint.errors.length ? `${r.lint.errors.length} blocking` : 'no blocking issues' }),
      );
      clear(lintNode);
      for (const error of r.lint.errors) lintNode.append(linterRow('fail', '✕', error));
      for (const warning of r.lint.warnings) lintNode.append(linterRow('warn', '!', warning));
      if (!r.lint.errors.length && !r.lint.warnings.length) lintNode.append(linterRow('ok', '✓', 'Passes the pre-send linter.'));
    }

    const bodyField = el('textarea', {
      class: 'input input--area', rows: '6', placeholder: 'Hi {{first_name|there}}, {loved|liked} your {linen|cotton} work…',
      oninput: (event) => { editing.body = event.target.value; paint(); },
    });
    bodyField.value = editing.body;
    const labelField = el('input', { class: 'input', type: 'text', placeholder: 'Warm linen opener', value: editing.label, oninput: (event) => { editing.label = event.target.value; } });

    const editor = el('div', { class: 'studio__composer' }, [
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'Label' }), labelField]),
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'Message (spintax {a|b} and {{first_name|fallback}} allowed)' }), bodyField]),
      el('div', { class: 'field__label', text: 'Sample render' }),
      previewNode,
      metaNode,
      lintNode,
      el('div', { class: 'row row--wrap mt-2' }, [
        toggle('Enabled', editing.enabled, { onChange: (v) => { editing.enabled = v; } }),
        el('span', { class: 'grow' }),
        btn('New', { variant: 'ghost', onClick: () => newTemplate() }),
        btn('Delete', { variant: 'danger', disabled: !editing.templateId, onClick: () => removeTemplate(editing.templateId) }),
        btn('Save template', { variant: 'primary', busyLabel: 'Saving…', onClick: () => saveTemplate() }),
      ]),
    ]);
    paint();
    return editor;
  }

  function linterRow(tone, mark, text) {
    return el('div', { class: `linter__row linter__row--${tone}` }, [
      el('span', { class: 'linter__mark', text: mark }),
      el('span', { class: 'small', text }),
    ]);
  }

  function renderPoolHealth() {
    const mapped = templates.map(lintShape);
    const result = lintPool(mapped, { cold: true });
    const enabled = templates.filter((t) => t.enabled !== false).length;
    const totalVariations = result.perTemplate.reduce((sum, r) => sum + r.variations, 0);
    const rows = [];
    if (result.pool.errors.length || result.pool.warnings.length) {
      for (const error of result.pool.errors) rows.push(linterRow('fail', '✕', error));
      for (const warning of result.pool.warnings) rows.push(linterRow('warn', '!', warning));
    } else {
      rows.push(linterRow('ok', '✓', `Pool is healthy: ${enabled} templates, ${totalVariations} distinct renders.`));
    }
    return el('div', { class: 'col' }, [
      el('div', { class: 'row row--wrap small dim' }, [
        el('span', { text: `${enabled} enabled / ${templates.length} total` }),
        el('span', { text: `· ${totalVariations} renders (floor ${MIN_POOL_VARIATIONS})` }),
        el('span', { text: `· pool floor ${MIN_POOL_TEMPLATES} templates` }),
      ]),
      ...rows,
    ]);
  }

  function renderTemplateList() {
    if (!templates.length) return note('No templates yet. Write one, save it, and the pool health will tell you when you have enough variety to send safely.', '');
    return table(
      ['', 'Label', 'Renders', 'Bytes', ''],
      templates.map((template) => {
        const lint = lintTemplate(lintShape(template), { cold: true });
        return [
          el('input', {
            type: 'checkbox', checked: template.enabled !== false ? 'checked' : null,
            onchange: async (event) => { await putTemplate({ ...template, enabled: event.target.checked }); await loadTemplates(); renderStudio(); void refreshPlan(); },
          }),
          template.label || 'Untitled',
          String(lint.variations),
          String(lint.bytes),
          el('button', { class: 'btn btn--sm btn--ghost', text: 'Edit', onclick: () => editTemplate(template) }),
        ];
      }),
      { numeric: [2, 3] },
    );
  }

  function renderStudio() {
    replaceCard(studioCard, renderEditor());
    renderPoolSection();
  }

  function renderPoolSection() {
    clear(poolBody);
    poolBody.append(
      card('Pool health', renderPoolHealth()),
      card('Templates', renderTemplateList(), { hint: `${templates.length}` }),
    );
  }

  /* ------------------------------------------------------------------ shell */

  function replaceCard(cardNode, body) {
    const head = cardNode.querySelector('.card__head');
    clear(cardNode);
    if (head) cardNode.append(head);
    cardNode.append(body);
  }

  async function loadTemplates() {
    try { templates = await api.templates(); } catch { templates = []; }
  }

  async function refresh() {
    try {
      [leads, groups] = await Promise.all([api.leads({ limit: 20_000 }), api.groups()]);
    } catch (error) {
      say(`Could not load outreach data: ${error?.message ?? error}`, 'error');
      leads = []; groups = [];
    }
    await loadTemplates();
    renderSubtabs();
    renderSelectors();
    renderControls();
    renderMessagesSlot();
    renderLog();
    await refreshPlan();
  }

  function mount(container) {
    clear(root);
    // Clean separated sub-tabs (Follow | Messages | Unfollow) at top;
    // messagesSlot mounts Message studio + Pool health ONLY on the Messages sub-tab.
    root.append(subtabsBar, bucketBar, funnelRow, headerWrap, queueCard, messagesSlot, logCard);
    container.append(root);
    renderSubtabs();
    renderMessagesSlot();
    if (ctx.onRunEvent) unsubscribe.push(ctx.onRunEvent(onRunEvent));
    if (ctx.onSync) unsubscribe.push(ctx.onSync((message) => {
      if (['LEADS_UPSERTED', 'LEAD_STATE_CHANGED', 'GOVERNOR_TICK', 'CIRCUIT_BREAKER_TRIPPED'].includes(message?.type)) {
        void refresh();
      }
    }));
    void refresh();
  }

  function destroy() {
    for (const off of unsubscribe.splice(0)) { try { off?.(); } catch { /* already gone */ } }
    clear(root);
  }

  return {
    id: 'outreach',
    mount,
    refresh,
    destroy,
    root,
    onRunEvent,
    setMode,
    get mode() { return mode; },
    get plan() { return plan; },
  };
}
