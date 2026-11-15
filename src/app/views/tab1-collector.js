/**
 * Tab 1 — Collect.
 *
 * Four separated sub-tabs keep every collection source clean and self-contained:
 *   • From an account  (Followers · Following · Recent likers)
 *   • From a post      (Likers · Commenters)
 *   • From a hashtag   (Hashtag posts)
 *   • From open tab    (Open list dialog · Saved posts · This page)
 *
 * Every collection runs visibly in the user's open Instagram tab at a human
 * pace (real mouse paths, clicks, and scrolling — zero Instagram API calls).
 * Results land in a Preview card first so nothing enters Your people until the
 * owner picks a bucket (pre-selected to the ready Default bucket) and presses
 * Save.
 */

import {
  banner, btn, card, clear, detailsLine, el, field, note,
  scannedText, segmented, table, toast, warmthBadge,
} from '../lib/ui.js';
import { CollectSource } from '../../content/main.js';
import { RunPhase } from '../lib/runner.js';
import { SOURCE_FIELDS, SOURCE_GROUPS, describeTarget, parseTarget } from '../lib/target.js';
import { isDefaultBucket } from '../lib/api.js';

const NEW_BUCKET_VALUE = '__new__';

/**
 * @param {{api: object, controller: object, toast?: Function, onRunEvent?: Function, onSync?: Function, onChanged?: Function, onOpenPeople?: Function, setBadge?: Function, initialRequest?: object}} ctx
 */
export function createCollectorView(ctx = {}) {
  const api = ctx.api;
  const controller = ctx.controller;
  if (!api) throw new Error('createCollectorView needs an api client');
  if (!controller) throw new Error('createCollectorView needs a run controller');
  const say = ctx.toast ?? toast;

  const root = el('div', { class: 'col' });
  const subtabsBar = el('nav', { class: 'subtabs', role: 'tablist', 'aria-label': 'Collection sources' });
  const launcherCard = card('From an account', el('div'), { hint: 'nothing is saved until you press Save' });
  const previewCard = el('div');

  let groups = [];
  let lastPreview = null;
  let lastSavedBanner = null;
  const unsubscribe = [];

  /* ---------------------------------------------------------------- launcher */

  let source = CollectSource.FOLLOWERS;
  let rawInput = '';
  let limit = 200;
  let lastParse = null;
  let validateTimer = null;
  let targetFieldNode = null;
  let collectBtn = null;
  let initialApplied = false;
  let pendingFrom = null;

  const stepMode = el('div', { class: 'col' });
  const stepDetail = el('div', { class: 'col' });
  const statusLine = el('div', { class: 'status-line small dim', role: 'status', 'aria-live': 'polite' });
  const errorSlot = el('div', { class: 'col' });
  const bannerSlot = el('div');

  const HUMAN = {
    invalid_username: () => 'That does not look like an Instagram username. Use letters, numbers, . and _ only.',
    not_found: (name) => `Instagram could not find @${name}. Check the spelling, or the account may be private, removed or renamed.`,
    login_required: () => 'You are logged out of Instagram in this browser. Log in, reload the tab, then try again.',
    rate_limited: () => 'Instagram asked us to slow down. The run was paused. Wait a few minutes before trying again.',
    no_numeric_id: (name) => `Could not open @${name} in Instagram. Open their profile in the Instagram tab, wait for it to load, then press Collect.`,
    no_recent_posts: (name) => `@${name} has no visible recent posts (private account, or no posts yet).`,
    private_account: (name) => `@${name} is a private account. Follow and get accepted before reading their lists.`,
    network: () => 'Could not reach Instagram. Check your connection.',
    no_tab: () => 'No Instagram tab is open. Open instagram.com in a tab and try again.',
  };

  function targetName() {
    return lastParse?.username ?? lastParse?.shortcode ?? lastParse?.tag ?? (rawInput.trim() || 'this account');
  }

  function humanFor(code, technical) {
    if (code === 'blocked') return { message: technical ?? 'Instagram blocked an action.', safety: true };
    const make = HUMAN[code];
    if (make) return { message: make(targetName()), safety: false };
    return { message: technical ?? 'The collection did not finish.', safety: false };
  }

  function metaFor(src) { return SOURCE_FIELDS[src] ?? SOURCE_FIELDS.current_page; }

  function groupOfSource(src) {
    return SOURCE_GROUPS.find((g) => g.options.some((o) => o.value === src)) ?? SOURCE_GROUPS[0];
  }

  function renderSubtabs() {
    clear(subtabsBar);
    const activeGroup = groupOfSource(source);
    for (const group of SOURCE_GROUPS) {
      const on = group.id === activeGroup.id;
      subtabsBar.append(el('button', {
        class: `subtab ${on ? 'subtab--on' : ''}`.trim(),
        role: 'tab',
        type: 'button',
        'aria-selected': on ? 'true' : 'false',
        'data-collect-tab': group.id,
        text: group.label,
        onclick: () => setSource(group.options[0].value),
      }));
    }
    const titleNode = launcherCard.querySelector('.card__title');
    if (titleNode) titleNode.textContent = activeGroup.label;
  }

  function renderModePicker() {
    clear(stepMode);
    const group = groupOfSource(source);
    if (group.options.length > 1) {
      stepMode.append(el('div', { class: 'step__label', text: 'What to read' }));
      const options = group.options.map((o) => ({ id: o.value, label: o.label }));
      stepMode.append(segmented(options, source, { onSelect: (value) => setSource(value) }));
    }
  }

  function setSource(next) {
    source = next;
    renderSubtabs();
    renderModePicker();
    renderDetail();
  }

  function renderDetail() {
    clear(stepDetail);
    const meta = metaFor(source);
    if (meta.needsField) {
      const f = field(meta.label, {
        value: rawInput,
        placeholder: meta.placeholder,
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
    stepDetail.append(field('How many people', {
      type: 'number',
      value: String(limit),
      hint: 'Between 1 and 5000. Runs visibly in your Instagram tab at a human pace.',
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
    lastSavedBanner = null;
    if (meta.needsField) {
      const parsed = parseTarget(source, rawInput);
      if (!parsed.ok) {
        if (targetFieldNode) targetFieldNode.field.setError(parsed.error);
        showCollectError(parsed.code, parsed.error);
        return;
      }
      lastParse = parsed;
    }
    statusLine.textContent = 'Opening Instagram visibly and collecting at a human pace\u2026';
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
      statusLine.textContent = `Collected ${out.count}. Review the preview below, then save into a bucket.`;
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
    renderSubtabs();
    renderModePicker();
    renderDetail();
    replaceCard(launcherCard, el('div', { class: 'col' }, [
      bannerSlot,
      stepMode,
      stepDetail,
      note('Runs visibly in your open Instagram tab with human cursor movement and scrolling — no Instagram API calls.', 'info'),
      el('div', { class: 'row row--wrap' }, [collectBtn]),
      statusLine,
      errorSlot,
    ]));
    updateCollectEnabled();
  }

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

  function defaultGroupId() {
    const def = groups.find((g) => isDefaultBucket(g, api.workspaceId));
    return def?.groupId ?? groups[0]?.groupId ?? '';
  }

  function renderPreview() {
    clear(previewCard);
    if (!lastPreview) {
      if (lastSavedBanner) previewCard.append(lastSavedBanner);
      return;
    }
    const result = lastPreview.result ?? {};
    const leads = Array.isArray(result.leads) ? result.leads : [];
    if (!leads.length) {
      previewCard.append(note(result.reason ?? 'That source returned nobody to preview.', 'warning'));
      return;
    }

    let selectedBucketId = defaultGroupId();
    let newBucketName = '';

    const bucketSelect = el('select', { class: 'select', 'aria-label': 'Save into bucket', style: { minWidth: '210px' } });
    for (const group of groups) {
      const label = isDefaultBucket(group, api.workspaceId) ? `${group.name} (ready)` : group.name;
      bucketSelect.append(el('option', { value: group.groupId, text: label }));
    }
    bucketSelect.append(el('option', { value: NEW_BUCKET_VALUE, text: '+ Create new bucket…' }));
    if (selectedBucketId) bucketSelect.value = selectedBucketId;

    const newBucketWrap = el('div', { style: { display: selectedBucketId ? 'none' : 'block' } });
    const newBucketField = field('New bucket name', {
      value: '',
      placeholder: 'Linen suppliers',
      hint: 'Creates a new bucket tab in Your people.',
      onInput: (value) => { newBucketName = value; },
    });
    newBucketWrap.append(newBucketField);

    bucketSelect.addEventListener('change', () => {
      selectedBucketId = bucketSelect.value;
      newBucketWrap.style.display = selectedBucketId === NEW_BUCKET_VALUE ? 'block' : 'none';
    });

    const rows = leads.slice(0, 50).map((entry) => {
      const lead = entry?.lead ?? entry;
      return [`@${lead.username}`, scannedText(lead.fullName ?? ''), warmthBadge(lead.warmthTier ?? 'cold', lead.priorityScore ?? null)];
    });

    previewCard.append(card(`Preview \u2014 ${leads.length} collected`, [
      note('These people are not in Your people yet. Choose a bucket (Default is ready) and press Save, or discard the collection.', 'info'),
      table(['Username', 'Name', 'Warmth'], rows),
      el('div', { class: 'row row--wrap mt-4' }, [
        el('label', { class: 'field', style: { marginBottom: '0' } }, [
          el('span', { class: 'field__label', text: 'Save into bucket' }),
          bucketSelect,
        ]),
        newBucketWrap,
        btn('Save', {
          variant: 'primary',
          busyLabel: 'Saving\u2026',
          onClick: async () => {
            const creatingNew = selectedBucketId === NEW_BUCKET_VALUE;
            if (creatingNew && !newBucketName.trim()) {
              say('Enter a name for the new bucket.', 'error');
              return;
            }
            const saved = await controller.commit({
              result,
              groupId: creatingNew ? null : (selectedBucketId || null),
              groupName: creatingNew ? newBucketName.trim() : null,
              runId: lastPreview.runId,
            });
            if (saved.ok) {
              const targetGroup = groups.find((g) => g.groupId === saved.groupId)?.name ?? (creatingNew ? newBucketName.trim() : 'Default');
              say(`Saved ${saved.saved} new, updated ${saved.updated} in "${targetGroup}".`, 'success');
              lastPreview = null;
              lastSavedBanner = banner(`Saved ${saved.saved + saved.updated} people into "${targetGroup}".`, {
                variant: 'info',
                actions: ctx.onOpenPeople
                  ? [btn('Open in Your people →', { variant: 'primary', onClick: () => ctx.onOpenPeople(saved.groupId) })]
                  : [],
              });
              await refresh();
              renderPreview();
              ctx.onChanged?.();
            } else {
              say(saved.reason ?? 'Could not save the collection.', 'error');
            }
          },
        }),
        btn('Discard', {
          variant: 'danger',
          busyLabel: '\u2026',
          onClick: async () => {
            await controller.discard({ runId: lastPreview.runId });
            lastPreview = null;
            renderPreview();
            say('Collection discarded.');
          },
        }),
      ]),
    ], { hint: `run ${lastPreview.runId ?? ''}` }));
  }

  /* --------------------------------------------------------------- lifecycle */

  function replaceCard(cardNode, body) {
    const head = cardNode.querySelector('.card__head');
    clear(cardNode);
    if (head) cardNode.append(head);
    cardNode.append(body);
  }

  async function refresh() {
    try {
      groups = (await api.groups()) ?? [];
    } catch {
      groups = [];
    }
    if (lastPreview) renderPreview();
  }

  function mount(container) {
    clear(root);
    root.append(subtabsBar, launcherCard, previewCard);
    container.append(root);
    applyInitialRequest();
    renderPreview();
    if (ctx.onRunEvent) {
      unsubscribe.push(ctx.onRunEvent((event) => {
        if (event.type === 'saved' || event.type === 'collected') void refresh();
      }));
    }
    if (ctx.onSync) {
      unsubscribe.push(ctx.onSync(() => void refresh()));
    }
    void refresh();
  }

  function destroy() {
    for (const off of unsubscribe.splice(0)) { try { off?.(); } catch { /* already gone */ } }
    if (validateTimer) { clearTimeout(validateTimer); validateTimer = null; }
    clear(root);
  }

  return {
    id: 'collector',
    mount,
    refresh,
    destroy,
    root,
    setSource,
    get source() { return source; },
  };
}
