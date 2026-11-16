/**
 * End-to-end synthetic tests for:
 *  1. Collect tab source cleanup (only From an account & From a post).
 *  2. 2026 desktop Instagram DM surfaces (floating bottom-right dock,
 *     /direct/t/ full page, three-dots Options -> Send message, no Send
 *     message, restrictions, invite-sent locks, existing conversations,
 *     stale dock closing, Lexical composer + delayed Send + Enter fallback,
 *     hard-reload /direct/t/ recovery).
 *  3. Universal default skip-on-per-account-failure across Follow, Messages,
 *     and Unfollow — continuing smoothly on per-account issues while stopping
 *     immediately on real/systemic errors (action block, logged-out session,
 *     closed tab, consecutive systemic failures).
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../scripts/lib/dom-shim.mjs';
import { installFakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import { SOURCE_GROUPS } from '../src/app/lib/target.js';
import {
  Label,
  composerScope,
  detectDmRestriction,
  dmContainerUserMatch,
  findDmDockCloseButton,
  findDmSurface,
  findOpenDmDock,
  findOptionsDialogSendMessage,
  findProfileMessageButton,
  findProfileOptionsButton,
  findSendButton,
  threadBubbles,
} from '../src/content/selectors.js';
import {
  ActionOutcome,
  composeMessage,
  executeDm,
  openDm,
  readComposerText,
} from '../src/content/actions.js';
import { createContentRuntime, createHandlers } from '../src/content/main.js';
import {
  createApiClient,
  createLedger,
  eventsForOutcome,
} from '../src/app/lib/api.js';
import {
  RunPhase,
  createRunController,
} from '../src/app/lib/runner.js';
import { ActionType } from '../src/core/governor.js';
import { DmState, RelState } from '../src/core/lifecycle.js';
import { QueueMode } from '../src/core/queue.js';
import { EntropyPoolRNG } from '../src/core/random.js';
import { CommandType } from '../src/storage/bridge.js';
import {
  clearAll,
  getLead,
  getWorkspace,
  leadRecord,
  putTemplate,
  putWorkspace,
  resetDb,
  templateRecord,
  upsertLead,
} from '../src/storage/db.js';

/* ----------------------------------------------------------- DOM builders */

function makeCtx(pathname = '/studio_noor/') {
  const doc = installDom();
  const location = { pathname, href: `https://www.instagram.com${pathname}` };
  doc.location = location;
  const ctx = {
    document: doc,
    location,
    getSelection: () => doc.selection,
    now: () => ctx._t,
    wait: async (ms) => { ctx._t += ms; ctx.waits.push(ms); },
    _t: 0,
    waits: [],
  };
  return ctx;
}

function makeIconButton(doc, svgTitle, onClick = null) {
  const btn = doc.createElement('div');
  btn.setAttribute('role', 'button');
  const svg = doc.createElement('svg');
  const title = doc.createElement('title');
  title.textContent = svgTitle;
  svg.append(title);
  btn.append(svg);
  if (onClick) btn.addEventListener('click', () => onClick(btn));
  return btn;
}

function makeRoleButton(doc, label, onClick = null) {
  const btn = doc.createElement('div');
  btn.setAttribute('role', 'button');
  btn.textContent = label;
  if (onClick) btn.addEventListener('click', () => onClick(btn));
  return btn;
}

/**
 * Build a realistic 2026 Instagram floating bottom-right Direct chat dock
 * (NO `[role="dialog"]`, Lexical `data-lexical-editor="true"` composer,
 * `<svg><title>` Close/Expand/Go back chrome, header & View profile `<a>`).
 */
function buildFloatingDock(doc, {
  username = 'studio_noor',
  existingMessages = [],
  restrictionText = null,
  includeComposer = true,
  sendButtonMode = 'delayed', // 'immediate' | 'delayed' | 'icon' | 'none'
  enterSubmits = false,
  onSend = null,
  onClose = null,
} = {}) {
  const dock = doc.createElement('div');
  dock.setAttribute('style', '--x-height:521px;--x-width:360px');

  const topBar = doc.createElement('div');
  const backBtn = makeIconButton(doc, 'Go back');
  const profileLink = doc.createElement('a');
  profileLink.setAttribute('href', `https://www.instagram.com/${username}/`);
  profileLink.textContent = username;
  const expandBtn = makeIconButton(doc, 'Expand');
  const closeBtn = makeIconButton(doc, 'Close', () => {
    dock.remove();
    onClose?.();
  });
  topBar.append(backBtn, profileLink, expandBtn, closeBtn);
  dock.append(topBar);

  const threadBody = doc.createElement('div');
  if (existingMessages.length === 0) {
    const viewProfile = doc.createElement('a');
    viewProfile.setAttribute('href', `https://www.instagram.com/${username}/`);
    viewProfile.textContent = 'View profile';
    threadBody.append(viewProfile);
  } else {
    for (const msg of existingMessages) {
      const bubble = doc.createElement('div');
      bubble.setAttribute('role', 'article');
      bubble.textContent = msg;
      threadBody.append(bubble);
    }
  }
  if (restrictionText) {
    const notice = doc.createElement('div');
    notice.textContent = restrictionText;
    threadBody.append(notice);
  }
  dock.append(threadBody);

  let editor = null;
  let sendBtn = null;

  if (includeComposer) {
    const tray = doc.createElement('div');
    const emojiBtn = makeIconButton(doc, 'Choose an emoji');
    editor = doc.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-placeholder', 'Message...');
    editor.setAttribute('data-lexical-editor', 'true');
    const voiceBtn = makeIconButton(doc, 'Voice Clip');
    const photoBtn = makeIconButton(doc, 'Add Photo or Video');
    tray.append(emojiBtn, editor, voiceBtn, photoBtn);
    dock.append(tray);

    const deliver = () => {
      const text = readComposerText(editor);
      if (!text) return;
      onSend?.(text);
      const bubble = doc.createElement('div');
      bubble.setAttribute('role', 'article');
      bubble.textContent = text;
      threadBody.append(bubble);
      editor.textContent = '';
    };

    const mountSend = () => {
      if (sendBtn) return;
      if (sendButtonMode === 'icon') {
        sendBtn = makeIconButton(doc, 'Send', deliver);
      } else {
        sendBtn = makeRoleButton(doc, 'Send', deliver);
      }
      tray.append(sendBtn);
    };

    if (sendButtonMode === 'immediate' || sendButtonMode === 'icon') {
      mountSend();
    } else if (sendButtonMode === 'delayed') {
      // Simulate Lexical mounting the Send button on a follow-up tick after text lands.
      const origExec = doc.execCommand.bind(doc);
      doc.execCommand = (cmd, showUi, val) => {
        const res = origExec(cmd, showUi, val);
        if (cmd === 'insertText' && readComposerText(editor)) {
          queueMicrotask(() => mountSend());
        }
        return res;
      };
    }

    if (enterSubmits) {
      editor.addEventListener('keydown', (ev) => {
        if (ev?.key === 'Enter' && !ev?.shiftKey) deliver();
      });
    }
  }

  return { dock, editor, threadBody, closeBtn };
}

function buildProfileHeader(doc, {
  username = 'studio_noor',
  relationship = 'Following',
  hasMessageButton = true,
  hasOptionsButton = true,
  onMessageClick = null,
  onOptionsClick = null,
} = {}) {
  const main = doc.createElement('main');
  const header = doc.createElement('header');
  const heading = doc.createElement('h2');
  heading.textContent = username;
  header.append(heading);

  const relBtn = makeRoleButton(doc, relationship);
  header.append(relBtn);

  if (hasMessageButton) {
    header.append(makeRoleButton(doc, 'Message', onMessageClick));
  }
  if (hasOptionsButton) {
    header.append(makeIconButton(doc, 'Options', onOptionsClick));
  }

  // Also place a post <article> with a comment box on the profile page so tests
  // verify neither comment boxes nor profile posts are ever mistaken for DMs.
  const feedPost = doc.createElement('article');
  const commentBox = doc.createElement('div');
  commentBox.setAttribute('contenteditable', 'true');
  commentBox.setAttribute('aria-placeholder', 'Add a comment...');
  feedPost.append(commentBox);

  main.append(header, feedPost);
  doc.body.append(main);
  return { main, header };
}

/* ------------------------------------------- 1. Collect tab cleanup tests */

describe('Collect tab cleanup', () => {
  test('SOURCE_GROUPS only offers From an account and From a post (hashtag and open tab removed)', () => {
    assert.deepEqual(
      SOURCE_GROUPS.map((g) => ({ id: g.id, label: g.label })),
      [
        { id: 'account', label: 'From an account' },
        { id: 'post', label: 'From a post' },
      ],
    );
    const allSources = SOURCE_GROUPS.flatMap((g) => g.options.map((o) => o.value));
    assert.equal(allSources.includes('hashtag_grid'), false);
    assert.equal(allSources.includes('current_page'), false);
  });
});

/* ------------------------------- 2. 2026 DM selectors & DOM anatomy tests */

describe('2026 DM selectors', () => {
  test('recognises floating chat dock with zero [role="dialog"] and rejects post comment boxes', () => {
    const ctx = makeCtx('/studio_noor/');
    buildProfileHeader(ctx.document, { username: 'studio_noor' });
    // Before dock opens: comment box on page must be rejected!
    assert.equal(findDmSurface(ctx.document, '/studio_noor/'), null);
    assert.equal(composerScope(ctx.document, '/studio_noor/'), null);

    // After floating dock opens: surface is found as kind="dock", user matches, bubbles === 0!
    const { dock, editor } = buildFloatingDock(ctx.document, { username: 'studio_noor' });
    ctx.document.body.append(dock);

    const surface = findDmSurface(ctx.document, '/studio_noor/');
    assert.ok(surface);
    assert.equal(surface.kind, 'dock');
    assert.equal(surface.editor, editor);
    assert.deepEqual(dmContainerUserMatch(surface.container, 'studio_noor'), {
      matched: true,
      foundUsers: ['studio_noor'],
    });
    assert.equal(threadBubbles(ctx.document, surface.container).length, 0);
    assert.ok(findDmDockCloseButton(surface.container));
  });

  test('detects profile Options icon button via <svg><title>Options</title></svg> and Options dialog Send message', () => {
    const ctx = makeCtx('/atelier_zayd/');
    buildProfileHeader(ctx.document, {
      username: 'atelier_zayd',
      hasMessageButton: false,
      hasOptionsButton: true,
    });
    assert.equal(findProfileMessageButton(ctx.document), null);
    const optBtn = findProfileOptionsButton(ctx.document);
    assert.ok(optBtn);
    assert.equal(optBtn.kind, Label.OPTIONS);

    const dialog = ctx.document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    for (const item of ['Block', 'Restrict', 'Report', 'Share to...', 'About this account', 'Send message', 'Cancel']) {
      dialog.append(makeRoleButton(ctx.document, item));
    }
    ctx.document.body.append(dialog);

    const found = findOptionsDialogSendMessage(ctx.document);
    assert.ok(found);
    assert.equal(found.isOptionsMenu, true);
    assert.equal(found.sendMessageButton.textContent, 'Send message');
    assert.equal(found.cancelButton.textContent, 'Cancel');
  });

  test('detectDmRestriction classifies unavailable, invite-sent, and failed notices (EN + AR)', () => {
    const doc = installDom();
    const box = doc.createElement('div');

    box.textContent = "You can't message this account unless they follow you.";
    assert.equal(detectDmRestriction(box)?.kind, 'unavailable');

    box.textContent = 'Not everyone can message this account.';
    assert.equal(detectDmRestriction(box)?.kind, 'unavailable');

    box.textContent = 'لا يمكنك مراسلة هذا الحساب إلا إذا كان يتابعك.';
    assert.equal(detectDmRestriction(box)?.kind, 'unavailable');

    box.textContent = 'Invite sent · You can send more messages after your invite is accepted.';
    assert.equal(detectDmRestriction(box)?.kind, 'invite_sent');

    box.textContent = 'Message failed to send';
    assert.equal(detectDmRestriction(box)?.kind, 'send_failed');
  });

  test('findSendButton matches both text Send and <svg><title>Send</title></svg> inside dock', () => {
    const ctx = makeCtx('/studio_noor/');
    const { dock } = buildFloatingDock(ctx.document, { username: 'studio_noor', sendButtonMode: 'icon' });
    ctx.document.body.append(dock);
    const hit = findSendButton(ctx.document, dock);
    assert.ok(hit);
    assert.equal(hit.kind, Label.SEND);
  });
});

/* --------------------------------------- 3. All 10 DM execution paths */

describe('DM human flow & exception paths', () => {
  test('Path 1: profile Message opens floating bottom-right dock with delayed Send button and delivers cleanly', async () => {
    const ctx = makeCtx('/studio_noor/');
    const sent = [];
    buildProfileHeader(ctx.document, {
      username: 'studio_noor',
      onMessageClick: () => {
        const { dock } = buildFloatingDock(ctx.document, {
          username: 'studio_noor',
          sendButtonMode: 'delayed',
          onSend: (t) => sent.push(t),
        });
        ctx.document.body.append(dock);
      },
    });

    const opened = await openDm(ctx, { document: ctx.document, location: ctx.location, username: 'studio_noor' });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal(opened.surfaceKind, 'dock');
    assert.equal(opened.existingThread, false);

    const dm = await executeDm(ctx, {
      document: ctx.document,
      username: 'studio_noor',
      message: 'Hi Noor, loved your ceramics collection!',
    });
    assert.equal(dm.ok, true, JSON.stringify(dm));
    assert.equal(dm.surfaceKind, 'dock');
    assert.deepEqual(sent, ['Hi Noor, loved your ceramics collection!']);
  });

  test('Path 2: profile Message SPA-navigates to /direct/t/<id>/ full page and delivers cleanly', async () => {
    const ctx = makeCtx('/clay_house/');
    const sent = [];
    buildProfileHeader(ctx.document, {
      username: 'clay_house',
      onMessageClick: () => {
        // Simulate SPA navigation to /direct/t/884422/
        ctx.document.body.children = [];
        ctx.location.pathname = '/direct/t/884422/';
        const main = ctx.document.createElement('main');
        const link = ctx.document.createElement('a');
        link.setAttribute('href', '/clay_house/');
        link.textContent = 'clay_house';
        const editor = ctx.document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.setAttribute('role', 'textbox');
        editor.setAttribute('aria-placeholder', 'Message...');
        editor.setAttribute('data-lexical-editor', 'true');
        const sendBtn = makeRoleButton(ctx.document, 'Send', () => {
          const text = readComposerText(editor);
          sent.push(text);
          const bubble = ctx.document.createElement('div');
          bubble.setAttribute('role', 'article');
          bubble.textContent = text;
          main.append(bubble);
          editor.textContent = '';
        });
        main.append(link, editor, sendBtn);
        ctx.document.body.append(main);
      },
    });

    const opened = await openDm(ctx, { document: ctx.document, location: ctx.location, username: 'clay_house' });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal(opened.surfaceKind, 'direct_page');

    const dm = await executeDm(ctx, {
      document: ctx.document,
      pathname: ctx.location.pathname,
      username: 'clay_house',
      message: 'Hello Clay House team!',
    });
    assert.equal(dm.ok, true, JSON.stringify(dm));
    assert.equal(dm.surfaceKind, 'direct_page');
    assert.deepEqual(sent, ['Hello Clay House team!']);
  });

  test('Path 3: profile with NO Message button opens Options (•••) -> Send message -> floating dock and sends', async () => {
    const ctx = makeCtx('/atelier_zayd/');
    const sent = [];
    buildProfileHeader(ctx.document, {
      username: 'atelier_zayd',
      hasMessageButton: false,
      hasOptionsButton: true,
      onOptionsClick: () => {
        const dialog = ctx.document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        for (const item of ['Block', 'Restrict', 'Report', 'Share to...', 'About this account']) {
          dialog.append(makeRoleButton(ctx.document, item));
        }
        dialog.append(makeRoleButton(ctx.document, 'Send message', () => {
          dialog.remove();
          const { dock } = buildFloatingDock(ctx.document, {
            username: 'atelier_zayd',
            sendButtonMode: 'immediate',
            onSend: (t) => sent.push(t),
          });
          ctx.document.body.append(dock);
        }));
        dialog.append(makeRoleButton(ctx.document, 'Cancel', () => dialog.remove()));
        ctx.document.body.append(dialog);
      },
    });

    const opened = await openDm(ctx, { document: ctx.document, location: ctx.location, username: 'atelier_zayd' });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal(opened.via, 'options-menu');
    assert.equal(opened.surfaceKind, 'dock');

    const dm = await executeDm(ctx, {
      document: ctx.document,
      username: 'atelier_zayd',
      message: 'Quick hello via Options menu!',
    });
    assert.equal(dm.ok, true, JSON.stringify(dm));
    assert.deepEqual(sent, ['Quick hello via Options menu!']);
  });

  test('Path 4: profile with NO Message button and NO Send message in Options menu closes dialog and skips cleanly', async () => {
    const ctx = makeCtx('/locked_account/');
    let closed = false;
    buildProfileHeader(ctx.document, {
      username: 'locked_account',
      hasMessageButton: false,
      hasOptionsButton: true,
      onOptionsClick: () => {
        const dialog = ctx.document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        for (const item of ['Block', 'Restrict', 'Report', 'About this account']) {
          dialog.append(makeRoleButton(ctx.document, item));
        }
        dialog.append(makeRoleButton(ctx.document, 'Cancel', () => {
          closed = true;
          dialog.remove();
        }));
        ctx.document.body.append(dialog);
      },
    });

    const opened = await openDm(ctx, { document: ctx.document, location: ctx.location, username: 'locked_account' });
    assert.equal(opened.ok, false);
    assert.equal(opened.outcome, ActionOutcome.SKIPPED);
    assert.equal(opened.dmUnavailable, true);
    assert.equal(closed, true);
  });

  test('Path 5: floating dock with existing [role="article"] messages skips cleanly without typing', async () => {
    const ctx = makeCtx('/linens_east/');
    buildProfileHeader(ctx.document, {
      username: 'linens_east',
      onMessageClick: () => {
        const { dock } = buildFloatingDock(ctx.document, {
          username: 'linens_east',
          existingMessages: ['Previous outreach message', 'Their reply'],
        });
        ctx.document.body.append(dock);
      },
    });

    const opened = await openDm(ctx, { document: ctx.document, location: ctx.location, username: 'linens_east' });
    assert.equal(opened.ok, true);
    assert.equal(opened.existingThread, true);

    const dm = await executeDm(ctx, {
      document: ctx.document,
      username: 'linens_east',
      message: 'Should never be typed',
    });
    assert.equal(dm.ok, false);
    assert.equal(dm.outcome, ActionOutcome.SKIPPED);
    assert.equal(dm.existingThread, true);
  });

  test('Path 6: floating dock with restriction notice ("can\'t message unless they follow you") and NO composer skips cleanly', async () => {
    const ctx = makeCtx('/followers_only/');
    buildProfileHeader(ctx.document, {
      username: 'followers_only',
      onMessageClick: () => {
        const { dock } = buildFloatingDock(ctx.document, {
          username: 'followers_only',
          includeComposer: false,
          restrictionText: "You can't message this account unless they follow you.",
        });
        ctx.document.body.append(dock);
      },
    });

    const opened = await openDm(ctx, { document: ctx.document, location: ctx.location, username: 'followers_only' });
    assert.equal(opened.ok, false);
    assert.equal(opened.outcome, ActionOutcome.SKIPPED);
    assert.equal(opened.dmUnavailable, true);
  });

  test('Path 7: floating dock with "Invite sent" lock returns SKIPPED + inviteAlreadySent', async () => {
    const ctx = makeCtx('/invited_lead/');
    buildProfileHeader(ctx.document, {
      username: 'invited_lead',
      onMessageClick: () => {
        const { dock } = buildFloatingDock(ctx.document, {
          username: 'invited_lead',
          includeComposer: false,
          restrictionText: 'Invite sent. You can send more messages after your invite is accepted.',
        });
        ctx.document.body.append(dock);
      },
    });

    const opened = await openDm(ctx, { document: ctx.document, location: ctx.location, username: 'invited_lead' });
    assert.equal(opened.ok, false);
    assert.equal(opened.outcome, ActionOutcome.SKIPPED);
    assert.equal(opened.inviteAlreadySent, true);
  });

  test('Path 8: stale floating dock for Person A is closed before opening Person B, never messaging Person A twice', async () => {
    const ctx = makeCtx('/atelier_zayd/');
    const sentTo = [];
    let staleClosed = false;

    // Person A's stale floating dock is still sitting open on Person B's profile!
    const stale = buildFloatingDock(ctx.document, {
      username: 'studio_noor',
      sendButtonMode: 'immediate',
      onSend: (t) => sentTo.push({ user: 'studio_noor', text: t }),
      onClose: () => { staleClosed = true; },
    });
    ctx.document.body.append(stale.dock);

    buildProfileHeader(ctx.document, {
      username: 'atelier_zayd',
      onMessageClick: () => {
        const fresh = buildFloatingDock(ctx.document, {
          username: 'atelier_zayd',
          sendButtonMode: 'immediate',
          onSend: (t) => sentTo.push({ user: 'atelier_zayd', text: t }),
        });
        ctx.document.body.append(fresh.dock);
      },
    });

    const rt = createContentRuntime({
      document: ctx.document,
      location: ctx.location,
      wait: ctx.wait,
      now: ctx.now,
      cookie: 'sessionid=abc; csrftoken=tok; ds_user_id=1',
      domReadyTimeoutMs: 0,
    });
    const handlers = createHandlers(rt);
    const res = await handlers[CommandType.EXECUTE_DM]({
      username: 'atelier_zayd',
      message: 'Hello Zayd only!',
    });

    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(staleClosed, true, 'stale dock for studio_noor must be closed first');
    assert.deepEqual(sentTo, [{ user: 'atelier_zayd', text: 'Hello Zayd only!' }]);
  });

  test('Path 9: Lexical dock with no Send button falls back to Enter-to-send and verifies delivery', async () => {
    const ctx = makeCtx('/roast_guild/');
    const sent = [];
    const { dock } = buildFloatingDock(ctx.document, {
      username: 'roast_guild',
      sendButtonMode: 'none',
      enterSubmits: true,
      onSend: (t) => sent.push(t),
    });
    ctx.document.body.append(dock);

    const dm = await executeDm(ctx, {
      document: ctx.document,
      username: 'roast_guild',
      message: 'Love your single-origin espresso!',
      sendButtonTimeoutMs: 150,
    });
    assert.equal(dm.ok, true, JSON.stringify(dm));
    assert.deepEqual(sent, ['Love your single-origin espresso!']);
  });

  test('Path 10: sendWithNavigation recovers cleanly when clicking Message hard-reloads the tab onto /direct/t/', async () => {
    let sendCount = 0;
    const waitForLoadCalls = [];
    const fakeTabs = {
      async tabById(id) {
        return { id, url: 'https://www.instagram.com/direct/t/555123/', status: 'complete' };
      },
      async waitForLoad(id) {
        waitForLoadCalls.push(id);
        return { ok: true, tab: { id, url: 'https://www.instagram.com/direct/t/555123/', status: 'complete' } };
      },
      async navigate() {
        return { ok: true };
      },
      async listTabs() { return []; },
      async inject() { return { ok: true }; },
      async stampTabId() { return { ok: true, stamped: true }; },
    };

    const storage = new Map();
    const adapter = {
      get: async (k) => (typeof k === 'string' ? { [k]: storage.get(k) } : Object.fromEntries([...storage.entries()])),
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) storage.set(k, v); },
      remove: async (k) => { storage.delete(k); },
    };

    const client = createApiClient({
      storage: adapter,
      tabs: fakeTabs,
      workspaceId: '99',
      sleep: async () => {},
    });

    // Stub client.send to simulate profile content script disconnect on first call,
    // followed by success once resumed directly inside /direct/t/555123/.
    client.send = async (type, payload) => {
      sendCount += 1;
      if (sendCount === 1) {
        return { ok: false, reason: 'timed out during navigation', timedOut: true, value: null, severity: 'unknown' };
      }
      return { ok: true, value: { ok: true, outcome: 'done', username: payload.username }, elapsedMs: 120 };
    };

    const res = await client.sendWithNavigation(
      CommandType.EXECUTE_DM,
      { username: 'clay_house', message: 'Hi there!' },
      { tabId: 42, settleMs: 0 },
    );

    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(sendCount, 2);
    assert.deepEqual(waitForLoadCalls, [42]);
  });
});

/* ---------------- 4. Universal default skip-vs-stop across ALL 3 modes */

describe('Universal skip-on-per-account-failure (Follow, Messages, Unfollow)', () => {
  const NOW = new Date(2026, 5, 10, 12, 0, 0).getTime();
  const WS = '88';
  let idb;

  before(() => { idb = installFakeIndexedDB(); });
  after(() => { idb?.uninstall?.(); });
  beforeEach(async () => {
    resetDb();
    await clearAll();
    await putWorkspace({ workspaceId: WS, viewerUsername: 'owner_studio' });
  });

  function makeRunnerApi(handlerByUser) {
    const state = { workspaceId: WS };
    const ledger = createLedger({ state, now: () => NOW });
    const attempted = [];
    const tabs = {
      async listTabs() { return [{ id: 1, url: 'https://www.instagram.com/', active: true, discarded: false }]; },
      async focus() { return { ok: true }; },
      async focusDashboard() { return { ok: true }; },
      async openInstagram() { return { ok: true, tab: { id: 1, url: 'https://www.instagram.com/' } }; },
    };
    return {
      ...ledger,
      attempted,
      tabs,
      workspaceId: WS,
      async prepare() { return { ok: true, targetTabId: 1 }; },
      async send() { return { ok: true, value: { ok: true } }; },
      async sendWithNavigation(type, payload) {
        attempted.push({ type, username: payload.username });
        const fn = handlerByUser[payload.username];
        if (!fn) return { ok: true, value: { ok: true, outcome: 'done' }, elapsedMs: 50 };
        return fn(type, payload);
      },
      async stop() { return { ok: true }; },
      watch() { return { dispose() {} }; },
    };
  }

  function seededRng() {
    return new EntropyPoolRNG({ seed: [7, 13, 19, 29], clock: () => NOW, microClock: () => 1, randomWords: () => new Uint32Array([7, 13, 19, 29]) });
  }

  test('eventsForOutcome maps dmUnavailable, inviteAlreadySent, and profileUnavailable cleanly', () => {
    const lead = leadRecord({ workspaceId: WS, username: 'clay_house' }, { relState: RelState.MUTUAL });

    const unavail = eventsForOutcome({
      actionType: ActionType.DM_WARM,
      lead,
      result: { ok: false, outcome: 'skipped', dmUnavailable: true, reason: 'no Send message option' },
      now: NOW,
    });
    assert.equal(unavail.outcome, 'skipped');
    assert.equal(unavail.observed, 'dm-unavailable');
    assert.equal(unavail.patch.dmState, DmState.DM_UNAVAILABLE);

    const invited = eventsForOutcome({
      actionType: ActionType.DM_COLD,
      lead,
      result: { ok: false, outcome: 'skipped', inviteAlreadySent: true, reason: 'Invite sent' },
      now: NOW,
    });
    assert.equal(invited.outcome, 'skipped');
    assert.equal(invited.observed, 'invite-already-sent');
    assert.equal(invited.patch.dmState, DmState.DM_SENT_REQUEST);

    const follow404 = eventsForOutcome({
      actionType: ActionType.FOLLOW,
      lead: leadRecord({ workspaceId: WS, username: 'gone_user' }),
      result: { ok: false, outcome: 'skipped', profileUnavailable: true, reason: 'profile unavailable' },
      now: NOW,
    });
    assert.equal(follow404.outcome, 'skipped');
    assert.equal(follow404.observed, 'profile-unavailable');
    assert.equal(follow404.patch.relState, RelState.NONE);
  });

  test('Messages mode skips dmUnavailable, existingThread, inviteAlreadySent, profileUnavailable & a single throw, then delivers to the next healthy lead', async () => {
    const bodies = [
      'Hi {{first_name}}, loved your {{handle}} studio work!',
      'Hey {{first_name}}, big fan of what you share on {{handle}}.',
      'Hello {{first_name}}, saw {{handle}} and wanted to connect.',
    ];
    for (let i = 0; i < bodies.length; i += 1) {
      await putTemplate(templateRecord({ workspaceId: WS, label: `T${i}`, body: bodies[i], enabled: true }));
    }

    const users = [
      'u1_no_option',
      'u2_existing',
      'u3_invited',
      'u4_deleted',
      'u5_single_throw',
      'u6_healthy',
    ];
    for (let i = 0; i < users.length; i += 1) {
      await upsertLead(leadRecord(
        { workspaceId: WS, username: users[i] },
        { relState: RelState.MUTUAL, priorityScore: 95 - i },
      ));
    }

    const api = makeRunnerApi({
      u1_no_option: async () => ({ ok: false, reason: 'no Send message option', value: { ok: false, outcome: 'skipped', dmUnavailable: true, reason: 'no Send message option' } }),
      u2_existing: async () => ({ ok: false, reason: 'existing thread', value: { ok: false, outcome: 'skipped', existingThread: true, reason: 'existing thread' } }),
      u3_invited: async () => ({ ok: false, reason: 'invite already sent', value: { ok: false, outcome: 'skipped', inviteAlreadySent: true, reason: 'invite already sent' } }),
      u4_deleted: async () => ({ ok: false, reason: 'profile deleted', value: { ok: false, outcome: 'skipped', profileUnavailable: true, reason: 'profile deleted' } }),
      u5_single_throw: async () => { throw new Error('transient DOM detach'); },
      u6_healthy: async () => ({ ok: true, value: { ok: true, outcome: 'done' }, elapsedMs: 120 }),
    });

    const controller = createRunController({ api, now: () => NOW, sleep: async () => {}, rng: seededRng() });
    const summary = await controller.outreach({ mode: QueueMode.DM, policy: { mutualOnly: true }, limit: 10 });

    assert.equal(summary.ok, true, JSON.stringify(summary));
    assert.equal(summary.phase, RunPhase.DONE);
    assert.equal(summary.counts.done, 1);
    assert.equal(summary.counts.skipped, 4);
    assert.equal(summary.counts.failed, 1);
    assert.equal(api.attempted.length, 6);

    assert.equal((await getLead(`${WS}:u1_no_option`)).dmState, DmState.DM_UNAVAILABLE);
    assert.equal((await getLead(`${WS}:u2_existing`)).dmState, DmState.DM_EXISTING_THREAD_SKIPPED);
    assert.equal((await getLead(`${WS}:u3_invited`)).dmState, DmState.DM_SENT_REQUEST);
    assert.equal((await getLead(`${WS}:u4_deleted`)).dmState, DmState.DM_UNAVAILABLE);
    assert.equal((await getLead(`${WS}:u6_healthy`)).dmState, DmState.DM_SENT_PRIMARY);
  });

  test('Follow mode skips unavailable, already-following, and single failure, then follows the next healthy account', async () => {
    const users = ['f1_404', 'f2_already', 'f3_blip', 'f4_healthy'];
    for (let i = 0; i < users.length; i += 1) {
      await upsertLead(leadRecord({ workspaceId: WS, username: users[i] }, { priorityScore: 90 - i }));
    }

    const api = makeRunnerApi({
      f1_404: async () => ({ ok: false, reason: 'deleted', value: { ok: false, outcome: 'skipped', profileUnavailable: true, reason: 'deleted' } }),
      f2_already: async () => ({ ok: false, reason: 'already following', value: { ok: false, outcome: 'skipped', reason: 'already following' } }),
      f3_blip: async () => ({ ok: false, reason: 'click did not settle', value: { ok: false, outcome: 'not_done', reason: 'click did not settle' } }),
      f4_healthy: async () => ({ ok: true, value: { ok: true, outcome: 'done', requested: false } }),
    });

    const controller = createRunController({ api, now: () => NOW, sleep: async () => {}, rng: seededRng() });
    const summary = await controller.outreach({ mode: QueueMode.FOLLOW, limit: 10 });

    assert.equal(summary.ok, true);
    assert.equal(summary.phase, RunPhase.DONE);
    assert.equal(summary.counts.done, 1);
    assert.equal(summary.counts.skipped, 2);
    assert.equal(summary.counts.failed, 1);
    assert.equal((await getLead(`${WS}:f1_404`)).relState, RelState.NONE);
    assert.equal((await getLead(`${WS}:f4_healthy`)).relState, RelState.FOLLOWING);
  });

  test('Unfollow mode skips unavailable & single failure, then unfollows the next healthy account', async () => {
    const oldFollow = NOW - 15 * 86_400_000;
    const users = ['u1_404', 'u2_blip', 'u3_healthy'];
    for (let i = 0; i < users.length; i += 1) {
      await upsertLead(leadRecord(
        { workspaceId: WS, username: users[i] },
        { relState: RelState.FOLLOWING, followedViaExtension: true, followedAt: oldFollow, priorityScore: 80 - i },
      ));
    }

    const api = makeRunnerApi({
      u1_404: async () => ({ ok: false, reason: 'deleted', value: { ok: false, outcome: 'skipped', profileUnavailable: true, reason: 'deleted' } }),
      u2_blip: async () => ({ ok: false, reason: 'confirm dialog slow', value: { ok: false, outcome: 'not_done', reason: 'confirm dialog slow' } }),
      u3_healthy: async () => ({ ok: true, value: { ok: true, outcome: 'done' } }),
    });

    const controller = createRunController({ api, now: () => NOW, sleep: async () => {}, rng: seededRng() });
    const summary = await controller.outreach({ mode: QueueMode.UNFOLLOW, limit: 10 });

    assert.equal(summary.ok, true);
    assert.equal(summary.phase, RunPhase.DONE);
    assert.equal(summary.counts.done, 1);
    assert.equal(summary.counts.skipped, 1);
    assert.equal(summary.counts.failed, 1);
    assert.equal((await getLead(`${WS}:u3_healthy`)).relState, RelState.UNFOLLOWED);
  });

  test('Fatal errors (logged-out session & closed tab) stop the run cleanly without tripping the 24h action-block breaker', async () => {
    for (const u of ['s1', 's2']) {
      await upsertLead(leadRecord({ workspaceId: WS, username: u }, { priorityScore: 90 }));
    }

    const apiLoggedOut = makeRunnerApi({
      s1: async () => ({
        ok: false,
        reason: 'this tab is not logged in to Instagram',
        severity: 'session',
        value: { ok: false, outcome: 'stopped', severity: 'session', loggedOut: true, reason: 'this tab is not logged in to Instagram' },
      }),
    });

    const c1 = createRunController({ api: apiLoggedOut, now: () => NOW, sleep: async () => {}, rng: seededRng() });
    const res1 = await c1.outreach({ mode: QueueMode.FOLLOW, limit: 10 });
    assert.equal(res1.ok, false);
    assert.equal(res1.phase, RunPhase.FAILED);
    assert.equal(apiLoggedOut.attempted.length, 1, 'must stop immediately without attempting lead #2');
    const wsAfter = await getWorkspace(WS);
    assert.equal(Number(wsAfter?.governorState?.lockedUntil ?? 0), 0, 'logged-out stop must NOT lock out the 24h circuit breaker');

    const apiClosedTab = makeRunnerApi({
      s1: async () => ({
        ok: false,
        reason: 'the tab was closed while it was loading',
        severity: 'tab',
        value: { ok: false, outcome: 'not_done', severity: 'tab', reason: 'the tab was closed while it was loading' },
      }),
    });
    const c2 = createRunController({ api: apiClosedTab, now: () => NOW, sleep: async () => {}, rng: seededRng() });
    const res2 = await c2.outreach({ mode: QueueMode.FOLLOW, limit: 10 });
    assert.equal(res2.ok, false);
    assert.equal(res2.phase, RunPhase.FAILED);
    assert.equal(apiClosedTab.attempted.length, 1, 'closed tab must stop immediately without retrying');
  });
});
