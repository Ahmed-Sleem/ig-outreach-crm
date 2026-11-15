/**
 * Safety & Ranking settings.
 *
 * One screen where the owner dials in how aggressive the autopilot may be. Every
 * slider is capped at the governor's hard ceiling, so the UI cannot invite the
 * block the governor exists to prevent; and choosing a trust preset snaps the
 * whole limit set at once rather than making the owner tune fourteen numbers by
 * hand. Nothing is written until Save: a half-dragged slider must not silently
 * change what a running campaign is allowed to do.
 */

import { btn, card, chipList, field, modal, note, slider, toggle, el, clear, toast } from '../lib/ui.js';
import { HARD_CEILINGS, TrustPreset, presetLimits } from '../../core/governor.js';
import { clampSafetySettings } from '../../storage/settings.js';

const PRESETS = [
  { value: TrustPreset.CONSERVATIVE, label: 'Conservative' },
  { value: TrustPreset.BALANCED, label: 'Balanced' },
  { value: TrustPreset.ESTABLISHED, label: 'Established' },
  { value: TrustPreset.CUSTOM, label: 'Custom' },
];

const WEIGHT_FIELDS = [
  ['multiAccountOverlap', 'Active in several niche accounts', 50],
  ['buyerIntent', 'Buyer-intent comment', 50],
  ['postComment', 'Commented on a source post', 50],
  ['followsSource', 'Follows the source account', 50],
  ['followedBySource', 'Followed by the source account', 50],
  ['storySignal', 'Story engagement signal', 50],
  ['likeAndCommentBoth', 'Both liked and commented', 50],
  ['postLike', 'Liked a source post', 50],
];

/**
 * @param {{api: object, toast?: Function, onSaved?: Function}} ctx
 * @returns {{mount: (container: HTMLElement) => void, refresh: () => Promise<void>, destroy: () => void, root: HTMLElement}}
 */
export function createSettingsView(ctx = {}) {
  const api = ctx.api;
  if (!api) throw new Error('createSettingsView needs an api client');
  const say = ctx.toast ?? toast;

  // The draft is the single mutable copy. Sliders write here; Save writes the
  // store. Keeping them separate is what makes "Cancel" free.
  let draft = clampSafetySettings({}).settings;
  let savedSnapshot = '';

  const root = el('div', { class: 'col' });
  const clampNote = el('div');
  const presetRow = el('div', { class: 'row row--wrap' });
  const limitsCard = card('Daily limits', el('div'), { hint: 'capped at the governor ceiling' });
  const scheduleCard = card('Timing', el('div'), { hint: 'when outreach is allowed to run' });
  const weightsCard = card('Ranking', el('div'), { hint: 'how a lead earns priority' });
  const actions = el('div', { class: 'row row--end mt-4' });

  function snapshot(settings) { return JSON.stringify(settings.limits) + JSON.stringify(settings.schedule) + JSON.stringify(settings.rankingWeights) + settings.trustPreset; }

  function setPreset(name) {
    if (name === TrustPreset.CUSTOM) {
      draft = { ...draft, trustPreset: TrustPreset.CUSTOM };
    } else {
      draft = { ...draft, trustPreset: name, limits: { ...draft.limits, ...presetLimits(name) } };
    }
    render();
  }

  function patchLimit(key, value) {
    draft = { ...draft, trustPreset: TrustPreset.CUSTOM, limits: { ...draft.limits, [key]: value } };
    // Re-render only the preset chips: a limit change makes the set "custom",
    // but redrawing every slider under the owner's dragging thumb is jarring.
    renderPreset();
    renderActions();
  }

  function patchSchedule(key, value) {
    draft = { ...draft, schedule: { ...draft.schedule, [key]: value } };
    renderActions();
  }

  function patchWeight(key, value) {
    draft = { ...draft, rankingWeights: { ...draft.rankingWeights, [key]: value } };
    renderActions();
  }

  function renderPreset() {
    clear(presetRow);
    presetRow.append(
      el('span', { class: 'small dim', text: 'Trust preset' }),
      chipList(PRESETS, [draft.trustPreset], { multiple: false, onChange: (values) => setPreset(values[0] ?? TrustPreset.CUSTOM) }),
    );
  }

  function limitSlider(key, label, { min = 0, max, step = 1, format = null, hint = null }) {
    return slider(label, Number(draft.limits[key] ?? min), {
      min, max, step, format, hint,
      onChange: (value) => patchLimit(key, value),
    });
  }

  function renderLimits() {
    const body = el('div', { class: 'grid grid--2' });
    const colA = el('div', { class: 'col' }, [
      limitSlider('followsPerHour', 'Follows per hour', { max: HARD_CEILINGS.followsPerHour }),
      limitSlider('followsPerDay', 'Follows per day', { max: HARD_CEILINGS.followsPerDay }),
      limitSlider('unfollowsPerHour', 'Unfollows per hour', { max: HARD_CEILINGS.unfollowsPerHour }),
      limitSlider('unfollowsPerDay', 'Unfollows per day', { max: HARD_CEILINGS.unfollowsPerDay }),
      limitSlider('combinedMutationsPerDay', 'Combined follow+unfollow per day', { max: HARD_CEILINGS.combinedMutationsPerDay, hint: 'the shared daily budget for both directions' }),
    ]);
    const colB = el('div', { class: 'col' }, [
      limitSlider('warmDmsPerHour', 'Warm DMs per hour', { max: HARD_CEILINGS.warmDmsPerHour }),
      limitSlider('warmDmsPerDay', 'Warm DMs per day', { max: HARD_CEILINGS.warmDmsPerDay }),
      limitSlider('coldInvitesPerHour', 'Cold invites per hour', { max: HARD_CEILINGS.coldInvitesPerHour }),
      limitSlider('coldInvitesPerDay', 'Cold invites per day', { max: HARD_CEILINGS.coldInvitesPerDay }),
      limitSlider('minActionDelaySec', 'Min delay between actions', { min: HARD_CEILINGS.minActionDelaySec, max: HARD_CEILINGS.maxActionDelaySec, format: (v) => `${v}s` }),
      limitSlider('maxActionDelaySec', 'Max delay between actions', { min: HARD_CEILINGS.minActionDelaySec, max: HARD_CEILINGS.maxActionDelaySec, format: (v) => `${v}s` }),
    ]);
    body.append(colA, colB);
    replaceCard(limitsCard, body);
  }

  function renderSchedule() {
    const body = el('div', { class: 'grid grid--2' }, [
      field('Active from (local)', {
        type: 'time', value: draft.schedule.activeStartLocal,
        hint: 'Earliest local time outreach may start each day.',
        onInput: (value) => patchSchedule('activeStartLocal', value),
      }),
      field('Active until (local)', {
        type: 'time', value: draft.schedule.activeEndLocal,
        hint: 'Latest local time outreach may run each day.',
        onInput: (value) => patchSchedule('activeEndLocal', value),
      }),
      slider('Daily drift', Number(draft.schedule.dailyDriftMinutes ?? 20), {
        min: 0, max: 60, format: (v) => `${v} min`,
        hint: 'how much the window may shift day to day so the pattern is not mechanical',
        onChange: (value) => patchSchedule('dailyDriftMinutes', value),
      }),
      el('div', { class: 'col' }, [
        toggle('Warm-up ramp (7 days)', Boolean(draft.schedule.warmupRampEnabled), {
          hint: 'start a new account at 40% of its caps and climb to 100% over a week',
          onChange: (value) => patchSchedule('warmupRampEnabled', value),
        }),
        el('p', { class: 'field__help', text: 'The active window is capped at 14 hours a day; a longer window is corrected on save.' }),
      ]),
    ]);
    replaceCard(scheduleCard, body);
  }

  function renderWeights() {
    const body = el('div', { class: 'grid grid--2' });
    const left = el('div', { class: 'col' });
    const right = el('div', { class: 'col' });
    WEIGHT_FIELDS.forEach(([key, label, max], index) => {
      const control = slider(label, Number(draft.rankingWeights[key] ?? 0), {
        min: 0, max, onChange: (value) => patchWeight(key, value),
      });
      (index % 2 === 0 ? left : right).append(control);
    });
    right.append(toggle('Deprioritise mega-accounts', Boolean(draft.rankingWeights.deprioritizeMegaAccounts), {
      hint: 'lower the score of accounts with a very large following',
      onChange: (value) => patchWeight('deprioritizeMegaAccounts', value),
    }));
    body.append(left, right);
    replaceCard(weightsCard, body);
  }

  // Resetting throws away the owner's unsaved tuning, so it is a red-outline
  // button that asks once before clearing the draft. Nothing is written until Save.
  function confirmReset() {
    modal({
      title: 'Reset all settings to defaults?',
      body: note('Every limit, the active window and the ranking weights return to their defaults. This clears unsaved changes; nothing is written until you press Save.', 'warning'),
      actions: [
        { label: 'Cancel', variant: 'ghost' },
        { label: 'Reset to defaults', variant: 'danger-solid', onClick: () => { draft = clampSafetySettings({}).settings; render(); } },
      ],
    });
  }

  function renderActions() {
    const dirty = snapshot(draft) !== savedSnapshot;
    clear(actions);
    actions.append(
      dirty ? el('span', { class: 'small faint', text: 'Unsaved changes' }) : null,
      btn('Reset to defaults', { variant: 'danger', onClick: () => confirmReset() }),
      btn('Save settings', {
        variant: 'primary', disabled: !dirty, busyLabel: 'Saving…',
        onClick: async () => { await save(); },
      }),
    );
  }

  function renderClampNote() {
    clear(clampNote);
    const { clamped } = clampSafetySettings(draft);
    if (clamped.length) {
      clampNote.append(note(`Some values exceed the safety ceiling and will be corrected on save: ${clamped.join(', ')}.`, 'warning'));
    }
  }

  function replaceCard(cardNode, body) {
    // Keep the card head, swap only the body, so the title/hint never flicker.
    const head = cardNode.querySelector('.card__head');
    clear(cardNode);
    if (head) cardNode.append(head);
    cardNode.append(body);
  }

  function render() {
    renderPreset();
    renderLimits();
    renderSchedule();
    renderWeights();
    renderClampNote();
    renderActions();
  }

  async function save() {
    const { settings, clamped } = clampSafetySettings(draft);
    draft = settings;
    try {
      await api.saveSettings(settings);
      savedSnapshot = snapshot(settings);
      render();
      say(clamped.length ? `Saved. Corrected to the safety ceiling: ${clamped.join(', ')}.` : 'Settings saved.', clamped.length ? '' : 'success');
      ctx.onSaved?.(settings);
    } catch (error) {
      say(`Could not save settings: ${error?.message ?? error}`, 'error');
    }
  }

  async function refresh() {
    try {
      const loaded = await api.settings();
      draft = clampSafetySettings(loaded).settings;
      savedSnapshot = snapshot(draft);
    } catch (error) {
      say(`Could not load settings: ${error?.message ?? error}`, 'error');
    }
    render();
  }

  function mount(container) {
    clear(root);
    root.append(
      note('These limits are the contract between you and your account\'s longevity. The governor refuses to exceed them no matter what a campaign asks for.', 'info'),
      clampNote,
      presetRow,
      limitsCard,
      scheduleCard,
      weightsCard,
      actions,
    );
    container.append(root);
    void refresh();
  }

  function destroy() { clear(root); }

  return { mount, refresh, destroy, root, get draft() { return draft; } };
}
