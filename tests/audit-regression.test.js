/**
 * Real-world 2026 Instagram pre-release audit regression suite.
 *
 * Pins every high-impact failure mode uncovered during end-to-end auditing
 * against real 2026 Instagram DOM snapshots and live multi-tab / mid-run stop
 * workflows:
 *  1. SVG `<title>` inside Follow/Following buttons ("FollowingDown chevron icon")
 *  2. Profile `<header>` scoping in `readRelationshipState`
 *  3. Strict `ariaLabel` matching in `findVisibleDialog` (never returning Post modal as Likes/Followers)
 *  4. Stacked Post + Likes dialog collection in `collectPostLikersDom`
 *  5. Sidebar viewer detection in `detectViewerFromDom` (never misidentifying visited profile)
 *  6. Non-blocking mid-run `STOP` & per-command reply keys in `storage/bridge.js`
 *  7. Owner Stop never trips the 24h circuit breaker in `api.js` / `runner.js`
 *  8. `EXECUTE_DM` directly on `/direct/new/<user>/` without redirect bounce
 *  9. `composeMessage` skips `selectAll`/`delete` on an empty composer
 * 10. Multi-tab `STOP` routing with `targetTabId`
 * 11. 2026 profile-prefixed post URLs (`/<user>/p/<code>/`, `/<user>/reel/<code>/`)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Doc } from '../scripts/lib/dom-shim.mjs';
const createDocument = () => new Doc();
import {
  Label,
  directThreadMatchesUser,
  findButtonByLabel,
  findVisibleDialog,
  isProfileUnavailable,
  threadBubbles,
  usernameFromPath,
  visibleButtonText,
} from '../src/content/selectors.js';
import {
  composeMessage,
  executeFollow,
  hasExistingThread,
  readComposerText,
  readRelationshipState,
} from '../src/content/actions.js';
import { detectViewerFromDom } from '../src/content/probe.js';
import { collectPostLikersDom } from '../src/content/browser-collector.js';
import { createHandlers, createContentRuntime } from '../src/content/main.js';
import { pageContextFrom } from '../src/content/launcher.js';
import { createBridge, memoryStorageAdapter, CommandType } from '../src/storage/bridge.js';
import { createLedger, parseHandlesInput, usernameFromUrl } from '../src/app/lib/api.js';
import { createRunController, RunPhase } from '../src/app/lib/runner.js';
import { ActionType, canExecute, initialGovernorState } from '../src/core/governor.js';
import { clampSafetySettings } from '../src/storage/settings.js';
import { resetDb } from '../src/storage/db.js';
import { installFakeIndexedDB } from './helpers/fake-indexeddb.mjs';

function el(doc, tag, attrs = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === 'string') {
      const span = doc.createElement('span');
      span.textContent = child;
      node.appendChild(span);
    } else {
      node.appendChild(child);
    }
  }
  return node;
}

describe('Pre-release 2026 Instagram audit regressions', () => {
  it('1. strips SVG <title> text so "FollowingDown chevron icon" resolves to Following', () => {
    const doc = createDocument();
    const header = el(doc, 'header', {}, [
      el(doc, 'button', {}, [
        el(doc, 'div', { text: 'Following' }),
        el(doc, 'svg', {}, [el(doc, 'title', { text: 'Down chevron icon' })]),
      ]),
      el(doc, 'div', { role: 'button', text: 'Message' }),
    ]);
    doc.body.appendChild(header);

    const btn = header.querySelector('button');
    assert.equal(visibleButtonText(btn), 'Following');
    const rel = readRelationshipState(doc);
    assert.equal(rel.state, 'following');
    assert.equal(rel.kind, Label.FOLLOWING);
    assert.ok(findButtonByLabel(doc, [Label.MESSAGE]));
  });

  it('2. readRelationshipState prefers profile <header> over Suggested Follow buttons below', () => {
    const doc = createDocument();
    const header = el(doc, 'header', {}, [
      el(doc, 'button', {}, [
        el(doc, 'div', { text: 'Following' }),
        el(doc, 'svg', {}, [el(doc, 'title', { text: 'Down chevron icon' })]),
      ]),
    ]);
    const main = el(doc, 'main', {}, [
      header,
      el(doc, 'section', {}, [
        el(doc, 'button', { text: 'Follow' }),
        el(doc, 'button', { text: 'Follow' }),
      ]),
    ]);
    doc.body.appendChild(main);

    const rel = readRelationshipState(doc);
    assert.equal(rel.state, 'following');
  });

  it('3. findVisibleDialog returns null when ariaLabel is requested and only an unrelated dialog is open', () => {
    const doc = createDocument();
    const postModal = el(doc, 'div', { role: 'dialog' }, [
      el(doc, 'a', { href: '/commenter1/', text: 'commenter1' }),
    ]);
    doc.body.appendChild(postModal);

    assert.equal(findVisibleDialog(doc), postModal);
    assert.equal(findVisibleDialog(doc, { ariaLabel: /^likes$/i }), null);
    assert.equal(findVisibleDialog(doc, { ariaLabel: /^followers$/i }), null);
  });

  it('4. collectPostLikersDom clicks liked_by inside open Post modal and scrapes the stacked Likes modal', async () => {
    const doc = createDocument();
    const likeTrigger = el(doc, 'a', { href: '/p/ABC123/liked_by/', text: '4,397 likes' });
    const postModal = el(doc, 'div', { role: 'dialog' }, [
      el(doc, 'a', { href: '/post_author/', text: 'post_author' }),
      el(doc, 'a', { href: '/commenter_only/', text: 'commenter_only' }),
      likeTrigger,
    ]);
    doc.body.appendChild(postModal);

    likeTrigger.addEventListener('click', () => {
      const likesModal = el(doc, 'div', { role: 'dialog', 'aria-label': 'Likes' }, [
        el(doc, 'a', { href: '/liker_one/', text: 'liker_one' }),
        el(doc, 'a', { href: '/liker_two/', text: 'liker_two' }),
        el(doc, 'a', { href: '/liker_three/', text: 'liker_three' }),
      ]);
      doc.body.appendChild(likesModal);
    });

    const res = await collectPostLikersDom({
      document: doc,
      location: { pathname: '/p/ABC123/' },
      wait: async () => {},
      random: () => 0.5,
    }, { shortcode: 'ABC123', limit: 10 });

    assert.equal(res.ok, true);
    assert.deepEqual(res.rows.map((r) => r.username), ['liker_one', 'liker_two', 'liker_three']);
  });

  it('5. detectViewerFromDom ignores target profile in <main> and reads logged-in user from sidebar', () => {
    const doc = createDocument();
    const sidebar = el(doc, 'div', {}, [
      el(doc, 'a', { href: 'https://www.instagram.com/ahmedsleem_/' }, [
        el(doc, 'img', { alt: "ahmedsleem_'s profile picture" }),
        el(doc, 'span', { text: 'Profile' }),
      ]),
    ]);
    const main = el(doc, 'main', {}, [
      el(doc, 'header', {}, [
        el(doc, 'a', { href: '/fightclubpoint/' }, [
          el(doc, 'img', { alt: "fightclubpoint's profile picture" }),
        ]),
      ]),
    ]);
    doc.body.appendChild(sidebar);
    doc.body.appendChild(main);

    const viewer = detectViewerFromDom(doc, '');
    assert.equal(viewer?.username, 'ahmedsleem_');
  });

  it('6. bridge processes STOP concurrently during an in-flight long COLLECT_LEADS command', async () => {
    const storage = memoryStorageAdapter();
    const sleep = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
    const dash = createBridge({ storage, workspaceId: '42', pollMs: 5, sleep });
    const tab = createBridge({ storage, workspaceId: '42', pollMs: 5, sleep });

    let aborted = false;
    let ac = null;
    const loopSig = { aborted: false };
    const loop = tab.runCommandLoop({
      signal: loopSig,
      handlers: {
        [CommandType.COLLECT_LEADS]: async () => {
          ac = new AbortController();
          return await new Promise((resolve) => {
            ac.signal.addEventListener('abort', () => {
              aborted = true;
              resolve({ ok: false, stoppedByOwner: true, reason: 'Stopped by owner.' });
            });
          });
        },
        [CommandType.STOP]: async () => {
          ac?.abort();
          return { stopped: true };
        },
      },
    });

    const collectP = dash.postCommand(CommandType.COLLECT_LEADS, { source: 'followers' }, { timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 25));
    const stopRes = await dash.postStop('owner clicked stop');
    const collectRes = await collectP;

    assert.equal(stopRes.ok, true);
    assert.equal(aborted, true);
    assert.equal(collectRes.ok, false);
    assert.equal(collectRes.result?.stoppedByOwner, true);
    loopSig.aborted = true;
    await loop;
  });

  it('7. owner Stop ends run in STOPPED without tripping the 24h circuit breaker', async () => {
    const restoreIdb = installFakeIndexedDB();
    const nowMs = 1_700_000_000_000;
    try {
      await resetDb();
      const ledger = createLedger({ state: { workspaceId: '99' }, now: () => nowMs });
      await ledger.ensureWorkspace({ workspaceId: '99', viewerUsername: 'ahmedsleem_' });
      await ledger.saveCollected({
        result: { leads: [{ username: 'target_lead', score: 80 }] },
      });
      const [lead] = await ledger.leads({});
      assert.ok(lead?.leadKey);

      // Owner Stop outcome MUST NOT trip the 24h circuit breaker
      const stopOut = await ledger.applyOutcome({
        leadKey: lead.leadKey,
        actionType: ActionType.FOLLOW,
        result: { ok: false, outcome: 'stopped', stoppedByOwner: true, reason: 'Stopped by owner.' },
      });
      assert.equal(stopOut.ownerStopped, true);
      assert.equal(stopOut.flagged, false);
      assert.equal(stopOut.governorState.lockedUntil, 0);

      // Real platform action block MUST STILL trip the 24h circuit breaker
      const blockOut = await ledger.applyOutcome({
        leadKey: lead.leadKey,
        actionType: ActionType.FOLLOW,
        result: { ok: false, outcome: 'stopped', actionBlocked: true, reason: 'Try again later.' },
      });
      assert.equal(blockOut.ownerStopped, false);
      assert.equal(blockOut.flagged, true);
      assert.ok(blockOut.governorState.lockedUntil > nowMs);
      // Runner.collect treats owner stop as STOPPED, not FAILED, and forwards tabId on stop()
      let stopCalledWith = null;
      const fakeApi = {
        ...ledger,
        async settings() { return {}; },
        tabs: {
          async listTabs() { return [{ id: 55, url: 'https://www.instagram.com/brand/', active: true }]; },
          async findInstagramTabs() { return [{ id: 55, url: 'https://www.instagram.com/brand/', active: true }]; },
          async ensureInstagramTab() { return { ok: true, tab: { id: 55, url: 'https://www.instagram.com/brand/' } }; },
          async focusDashboard() { return { ok: true }; },
        },
        watch() { return { dispose() {} }; },
        async sendWithNavigation() {
          return { ok: false, reason: 'Stopped by owner.', value: { ok: false, stoppedByOwner: true, reason: 'Stopped by owner.' }, tabId: 55 };
        },
        async stop(reason, opts) { stopCalledWith = { reason, opts }; return { ok: true }; },
      };
      const controller = createRunController({ api: fakeApi, sleep: async () => {}, now: () => nowMs });
      const out = await controller.collect({ source: 'followers', username: 'brand' });
      assert.equal(out.ok, false);
      assert.equal(out.stopped, true);
      assert.equal(out.phase, RunPhase.STOPPED);
      assert.equal(controller.state.phase, RunPhase.STOPPED);
      await controller.stop('manual');
      assert.equal(stopCalledWith.opts?.tabId, 55);
    } finally {
      await resetDb();
      restoreIdb?.uninstall?.();
    }
  });

  it('8. EXECUTE_DM acts directly on /direct/new/<user>/ without bouncing back to /<user>/', async () => {
    const doc = createDocument();
    doc.cookie = 'ds_user_id=999';
    const input = el(doc, 'div', { contenteditable: 'true', role: 'textbox', 'aria-label': 'Message' });
    const sendBtn = el(doc, 'button', { text: 'Send' });
    sendBtn.addEventListener('click', () => {
      const bubble = el(doc, 'div', { role: 'row', text: input.textContent });
      doc.body.appendChild(bubble);
      input.textContent = '';
    });
    doc.body.appendChild(input);
    doc.body.appendChild(sendBtn);

    const runtime = createContentRuntime({
      document: doc,
      getSelection: () => doc.selection,
      location: { pathname: '/direct/new/sara_design/' },
      wait: async () => {},
      random: () => 0.5,
    });
    const handlers = createHandlers(runtime);
    const res = await handlers[CommandType.EXECUTE_DM]({
      username: 'sara_design',
      message: 'Hi Sara, loved your studio work!',
    });

    assert.equal(res.needsNavigation, undefined);
    assert.equal(res.ok, true);
  });

  it('9. composeMessage does not fire selectAll/delete when the composer is already empty', async () => {
    const doc = createDocument();
    const cmds = [];
    const origExec = doc.execCommand.bind(doc);
    doc.execCommand = (cmd, ui, val) => {
      cmds.push(cmd);
      return origExec(cmd, ui, val);
    };
    const input = el(doc, 'div', { contenteditable: 'true', role: 'textbox', 'aria-label': 'Message' });
    doc.body.appendChild(input);

    const out = await composeMessage(
      { document: doc, getSelection: () => doc.selection, wait: async () => {}, random: () => 0.5 },
      { document: doc, message: 'Hi', pathname: '/direct/t/999/' },
    );
    assert.equal(out.ok, true);
    assert.ok(!cmds.includes('selectAll'));
    assert.ok(!cmds.includes('delete'));
    assert.equal(input.textContent, 'Hi');
  });

  it('10. postStop stamps targetTabId so only the targeted Instagram tab consumes STOP', async () => {
    const storage = memoryStorageAdapter();
    const sleep = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
    const dash = createBridge({ storage, workspaceId: '10', pollMs: 5, sleep });
    const idleTab = createBridge({ storage, workspaceId: '10', pollMs: 5, sleep });
    const activeTab = createBridge({ storage, workspaceId: '10', pollMs: 5, sleep });

    let idleGotStop = false;
    let activeGotStop = false;
    const sig = { aborted: false };
    const p1 = idleTab.runCommandLoop({
      signal: sig,
      getTabId: () => 101,
      handlers: { [CommandType.STOP]: async () => { idleGotStop = true; return { tab: 101 }; } },
    });
    const p2 = activeTab.runCommandLoop({
      signal: sig,
      getTabId: () => 102,
      handlers: { [CommandType.STOP]: async () => { activeGotStop = true; return { tab: 102 }; } },
    });

    const res = await dash.postStop('stop tab 102', { targetTabId: 102 });
    assert.equal(res.ok, true);
    assert.equal(activeGotStop, true);
    assert.equal(idleGotStop, false);
    sig.aborted = true;
    await Promise.all([p1, p2]);
  });

  it('11. 2026 profile-prefixed post URLs are classified as posts, never profiles', () => {
    for (const path of [
      '/fightclubpoint/p/Dfc2iPGyqto/',
      '/fightclubpoint/reel/C9xYz123AbC/',
      '/fightclubpoint/reels/C9xYz123AbC/',
      '/fightclubpoint/tv/C9xYz123AbC/',
    ]) {
      assert.equal(usernameFromPath(path), null, `usernameFromPath(${path})`);
      assert.equal(usernameFromUrl(`https://www.instagram.com${path}`), null, `usernameFromUrl(${path})`);
      const ctx = pageContextFrom(path);
      assert.equal(ctx.kind, 'post', `pageContextFrom(${path}).kind`);
      assert.ok(ctx.postCode, `pageContextFrom(${path}).postCode`);
    }
    assert.equal(usernameFromPath('/fightclubpoint/'), 'fightclubpoint');
    assert.equal(usernameFromUrl('https://www.instagram.com/fightclubpoint/'), 'fightclubpoint');
    assert.equal(pageContextFrom('/fightclubpoint/').kind, 'profile');
  });

  it('12. scheduleEnabled: false allows outreach outside 09:30-22:30 while keeping daily caps intact', () => {
    const lateNight = new Date(2026, 10, 16, 1, 15, 0); // 01:15 AM local
    const defaultSettings = clampSafetySettings({}).settings;
    const blocked = canExecute(ActionType.FOLLOW, {
      now: lateNight,
      governorState: initialGovernorState(),
      settings: defaultSettings,
      workspaceKey: '77',
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'outside the active window');

    const anytimeSettings = clampSafetySettings({ scheduleEnabled: false }).settings;
    assert.equal(anytimeSettings.scheduleEnabled, false);
    const allowed = canExecute(ActionType.FOLLOW, {
      now: lateNight,
      governorState: initialGovernorState(),
      settings: anytimeSettings,
      workspaceKey: '77',
    });
    assert.equal(allowed.ok, true);
  });

  it('13. brand-new 2026 Direct thread with "View profile" card & encryption notice is treated as empty', () => {
    const doc = createDocument();
    const grid = el(doc, 'div', { role: 'grid', 'aria-label': 'Messages in conversation with sara_design' }, [
      el(doc, 'div', { role: 'row' }, [
        el(doc, 'span', { text: 'Sara Design · Instagram' }),
        el(doc, 'a', { href: '/sara_design/', text: 'View profile' }),
      ]),
      el(doc, 'div', { role: 'row', text: 'Messages are end-to-end encrypted' }),
      el(doc, 'div', { role: 'row', text: 'Today 11:42 PM' }),
    ]);
    doc.body.appendChild(grid);

    assert.equal(threadBubbles(doc).length, 0);
    assert.equal(hasExistingThread(doc), false);

    // Once an actual message row arrives, it IS detected as a message bubble
    grid.appendChild(el(doc, 'div', { role: 'row', text: 'Hey Sara, loved your new collection!' }));
    assert.equal(threadBubbles(doc).length, 1);
    assert.equal(hasExistingThread(doc), true);
  });

  it('14. icon-only 2026 Send button with aria-label="Send" matches Label.SEND', () => {
    const doc = createDocument();
    const iconBtn = el(doc, 'div', { role: 'button', 'aria-label': 'Send' }, [
      el(doc, 'svg', {}, [el(doc, 'title', { text: 'Send' })]),
    ]);
    doc.body.appendChild(iconBtn);

    const hit = findButtonByLabel(doc, [Label.SEND]);
    assert.ok(hit);
    assert.equal(hit.button, iconBtn);
    assert.equal(hit.kind, Label.SEND);
  });

  it('15. multi-person DM run refuses to send Person B into Person A still-open /direct/t/ thread', async () => {
    const doc = createDocument();
    doc.cookie = 'ds_user_id=999';
    const main = el(doc, 'main', {}, [
      el(doc, 'a', { href: '/alice/', text: 'alice' }),
      el(doc, 'div', { contenteditable: 'true', role: 'textbox', 'aria-label': 'Message' }),
      el(doc, 'button', { text: 'Send' }),
    ]);
    doc.body.appendChild(main);

    assert.equal(directThreadMatchesUser(doc, 'alice'), true);
    assert.equal(directThreadMatchesUser(doc, 'bob'), false);

    const runtime = createContentRuntime({
      document: doc,
      getSelection: () => doc.selection,
      location: { pathname: '/direct/t/178411111/' },
      wait: async () => {},
      random: () => 0.5,
    });
    const handlers = createHandlers(runtime);
    const res = await handlers[CommandType.EXECUTE_DM]({
      username: 'bob',
      message: 'Hi Bob!',
    });

    assert.equal(res.ok, false);
    assert.equal(res.needsNavigation, true);
    assert.equal(res.url, 'https://www.instagram.com/bob/');
  });

  it('16. readComposerText strips Lexical zero-width chars and executeFollow detects deleted 404 profiles', async () => {
    const doc = createDocument();
    const editor = el(doc, 'div', { contenteditable: 'true', text: '\u200B\uFEFF' });
    assert.equal(readComposerText(editor), '');

    doc.body.appendChild(el(doc, 'h2', { text: "Sorry, this page isn't available." }));
    assert.equal(isProfileUnavailable(doc), true);
    const followRes = await executeFollow({ document: doc, wait: async () => {}, random: () => 0.5 }, { document: doc, readyTimeoutMs: 1000 });
    assert.equal(followRes.ok, false);
    assert.match(followRes.reason, /unavailable/i);
  });

  it('17. People addPeople + parseHandlesInput + deleteLead + deleteAllPeople work end-to-end', async () => {
    const parsed = parseHandlesInput('@Linen.Studio, https://www.instagram.com/cairo.coffee/\ninvalid handle!!\n..bad..\n@linen.studio');
    assert.deepEqual(parsed.valid, ['linen.studio', 'cairo.coffee']);
    assert.equal(parsed.invalid.length, 2);

    const restoreIdb = installFakeIndexedDB();
    try {
      await resetDb();
      const ledger = createLedger({ state: { workspaceId: '55' }, now: () => 1_700_000_000_000 });
      await ledger.ensureWorkspace({ workspaceId: '55', viewerUsername: 'owner' });
      const vip = await ledger.createGroup({ name: 'VIP' });

      const added = await ledger.addPeople({
        input: '@alice\nhttps://www.instagram.com/bob/\ncharlie',
        groupId: vip.groupId,
      });
      assert.equal(added.ok, true);
      assert.equal(added.added, 3);
      assert.equal((await ledger.leads({})).length, 3);

      // Untagging VIP keeps people in All people
      const untagged = await ledger.deleteAllPeople({ groupId: vip.groupId, mode: 'untag' });
      assert.equal(untagged.untagged, 3);
      assert.equal((await ledger.leads({})).length, 3);

      // Single delete
      await ledger.deleteLead('55:alice');
      assert.equal((await ledger.leads({})).length, 2);

      // Delete all at once
      const wiped = await ledger.deleteAllPeople({ groupId: null, mode: 'delete' });
      assert.equal(wiped.deleted, 2);
      assert.equal((await ledger.leads({})).length, 0);
    } finally {
      await resetDb();
      restoreIdb?.uninstall?.();
    }
  });
});
