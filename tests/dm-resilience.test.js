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
  caretToEnd,
  composeMessage,
  executeDm,
  newestIsOurs,
  openDm,
  readComposerText,
  splitGraphemes,
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
import { createOutreachView } from '../src/app/views/tab2-outreach.js';
import { ActionType } from '../src/core/governor.js';
import { DmState, RelState } from '../src/core/lifecycle.js';
import { QueueMode, buildQueue } from '../src/core/queue.js';
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

  test('Re-audit #1: cold invite that immediately swaps composer for "Invite sent" after Send reports DONE (not skipped!)', async () => {
    const ctx = makeCtx('/cold_prospect/');
    const sent = [];
    const { dock, editor, threadBody } = buildFloatingDock(ctx.document, {
      username: 'cold_prospect',
      sendButtonMode: 'none',
    });
    const sendBtn = makeRoleButton(ctx.document, 'Send', () => {
      const text = readComposerText(editor);
      sent.push(text);
      const bubble = ctx.document.createElement('div');
      bubble.setAttribute('role', 'article');
      bubble.textContent = text;
      threadBody.append(bubble);
      // Instagram swaps the composer for "Invite sent" on cold invites!
      editor.remove();
      sendBtn.remove();
      const notice = ctx.document.createElement('div');
      notice.textContent = 'Invite sent. You can send more messages after your invite is accepted.';
      dock.append(notice);
    });
    dock.append(sendBtn);
    ctx.document.body.append(dock);

    const dm = await executeDm(ctx, {
      document: ctx.document,
      username: 'cold_prospect',
      message: 'Hi! Would love to connect.',
    });
    assert.equal(dm.ok, true, JSON.stringify(dm));
    assert.equal(dm.outcome, ActionOutcome.DONE);
    assert.deepEqual(sent, ['Hi! Would love to connect.']);
  });

  test('Re-audit #2: icon-only button with svg[aria-label="Options"] + different <title> is still found', () => {
    const ctx = makeCtx('/icon_test/');
    const header = ctx.document.createElement('header');
    const btn = ctx.document.createElement('div');
    btn.setAttribute('role', 'button');
    const svg = ctx.document.createElement('svg');
    svg.setAttribute('aria-label', 'Options');
    const title = ctx.document.createElement('title');
    title.textContent = 'More';
    svg.append(title);
    btn.append(svg);
    header.append(btn);
    ctx.document.body.append(header);

    const found = findProfileOptionsButton(ctx.document);
    assert.ok(found);
    assert.equal(found.kind, Label.OPTIONS);
  });

  test('Re-audit #3: findSendButton skips aria-disabled="true" Send buttons until enabled', () => {
    const ctx = makeCtx('/studio_noor/');
    const { dock } = buildFloatingDock(ctx.document, { username: 'studio_noor', sendButtonMode: 'none' });
    const disabledSend = makeRoleButton(ctx.document, 'Send');
    disabledSend.setAttribute('aria-disabled', 'true');
    dock.append(disabledSend);
    ctx.document.body.append(dock);

    assert.equal(findSendButton(ctx.document, dock), null);
    disabledSend.removeAttribute('aria-disabled');
    assert.equal(findSendButton(ctx.document, dock)?.button, disabledSend);
  });

  test('Re-audit #4: openDm waits out a [role="progressbar"] spinner so delayed thread history is not missed', async () => {
    const ctx = makeCtx('/delayed_history/');
    buildProfileHeader(ctx.document, {
      username: 'delayed_history',
      onMessageClick: () => {
        const { dock, threadBody } = buildFloatingDock(ctx.document, {
          username: 'delayed_history',
          existingMessages: [],
        });
        const spinner = ctx.document.createElement('div');
        spinner.setAttribute('role', 'progressbar');
        threadBody.append(spinner);
        ctx.document.body.append(dock);
        // Simulate history arriving after 250ms and removing the spinner.
        const origWait = ctx.wait;
        let resolved = false;
        ctx.wait = async (ms) => {
          await origWait(ms);
          if (!resolved && ctx._t >= 200) {
            resolved = true;
            spinner.remove();
            const oldMsg = ctx.document.createElement('div');
            oldMsg.setAttribute('role', 'article');
            oldMsg.textContent = 'Older conversation message';
            threadBody.append(oldMsg);
          }
        };
      },
    });

    const opened = await openDm(ctx, { document: ctx.document, location: ctx.location, username: 'delayed_history' });
    assert.equal(opened.ok, true);
    assert.equal(opened.existingThread, true, 'must detect existing thread after progressbar finishes');
  });

  test('Re-audit #5: detectDmRestriction ignores composer draft text so own message cannot self-trigger', () => {
    const ctx = makeCtx('/studio_noor/');
    const { dock, editor } = buildFloatingDock(ctx.document, { username: 'studio_noor' });
    editor.textContent = "Sorry, my previous message failed to send — invite sent again!";
    ctx.document.body.append(dock);

    assert.equal(detectDmRestriction(dock), null);
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

/* -------- 4. Deep DM reliability, any-page discovery & mutualOnly default */

describe('Deep DM reliability (any-page discovery, Lexical isolated world, hard-nav watch, mutualOnly default)', () => {
  test('skips composers nested inside a display:none ancestor and picks the visible one', () => {
    const ctx = makeCtx('/brand_saffron/');
    const hiddenWrap = ctx.document.createElement('div');
    hiddenWrap.style.display = 'none';
    const hiddenEd = ctx.document.createElement('div');
    hiddenEd.setAttribute('contenteditable', 'true');
    hiddenEd.setAttribute('role', 'textbox');
    hiddenEd.setAttribute('aria-placeholder', 'Message...');
    hiddenEd.setAttribute('data-lexical-editor', 'true');
    hiddenWrap.append(hiddenEd);

    const visibleWrap = ctx.document.createElement('div');
    const visibleEd = ctx.document.createElement('div');
    visibleEd.setAttribute('contenteditable', 'true');
    visibleEd.setAttribute('role', 'textbox');
    visibleEd.setAttribute('aria-placeholder', 'Write a message...');
    visibleEd.setAttribute('data-lexical-editor', 'true');
    visibleWrap.append(visibleEd);

    ctx.document.body.append(hiddenWrap, visibleWrap);
    const surface = findDmSurface(ctx.document, '/brand_saffron/');
    assert.ok(surface);
    assert.equal(surface.editor, visibleEd, 'must skip hidden ancestor composer and pick visible one');
  });

  test('finds DM composer & Send button on /direct/t/ with pure <div> layout (no <main>/<section>) and on arbitrary pages', () => {
    // 1. /direct/t/ built entirely out of <div>s (no <main>, no <section>).
    const ctx = makeCtx('/direct/t/777111/');
    const appShell = ctx.document.createElement('div');
    const threadPane = ctx.document.createElement('div');
    const grid = ctx.document.createElement('div');
    grid.setAttribute('role', 'grid');
    const bar = ctx.document.createElement('div');
    const edWrap = ctx.document.createElement('div');
    const ed = ctx.document.createElement('div');
    ed.setAttribute('contenteditable', 'true');
    ed.setAttribute('role', 'textbox');
    ed.setAttribute('data-lexical-editor', 'true');
    const sibPlaceholder = ctx.document.createElement('div');
    sibPlaceholder.setAttribute('aria-hidden', 'true');
    sibPlaceholder.textContent = 'Message...';
    edWrap.append(ed, sibPlaceholder);

    // Icon-only "Press enter to send" button beside composer.
    const sendBtn = makeIconButton(ctx.document, 'Press enter to send');
    bar.append(edWrap, sendBtn);
    threadPane.append(grid, bar);
    appShell.append(threadPane);
    ctx.document.body.append(appShell);

    const surface = findDmSurface(ctx.document, '/direct/t/777111/');
    assert.ok(surface);
    assert.equal(surface.kind, 'direct_page');
    assert.equal(surface.editor, ed);
    assert.notEqual(surface.container, edWrap, 'container must NOT collapse to tiny editor.parentNode');
    assert.equal(findSendButton(ctx.document, surface.container, ed)?.button, sendBtn);

    // 2. Arbitrary page (/explore/) with a visible Lexical textbox and a feed comment box + Share button.
    const ctx2 = makeCtx('/explore/');
    const article = ctx2.document.createElement('article');
    const commentBox = ctx2.document.createElement('textarea');
    commentBox.setAttribute('placeholder', 'Add a comment…');
    const postSend = makeRoleButton(ctx2.document, 'Send');
    article.append(commentBox, postSend);

    const floating = ctx2.document.createElement('div');
    const anyEd = ctx2.document.createElement('div');
    anyEd.setAttribute('contenteditable', 'true');
    anyEd.setAttribute('role', 'textbox');
    anyEd.setAttribute('data-lexical-editor', 'true');
    const arabicSend = makeRoleButton(ctx2.document, 'إرسال الرسالة');
    floating.append(anyEd, arabicSend);
    ctx2.document.body.append(article, floating);

    const anySurface = findDmSurface(ctx2.document, '/explore/');
    assert.ok(anySurface);
    assert.equal(anySurface.editor, anyEd, 'must find visible DM Lexical box on any page and skip post comment');
    assert.equal(findSendButton(ctx2.document, anySurface.container, anyEd)?.button, arabicSend, 'must never click Send inside <article>');
  });

  test('dmContainerUserMatch preserves "Chat with ..." panels, ignores viewer handle & Chats sidebar, and reads avatar alt', () => {
    const ctx = makeCtx('/direct/t/888/');
    const root = ctx.document.createElement('div');
    root.setAttribute('aria-label', 'Chat with Craft Kamel');

    const sidebar = ctx.document.createElement('div');
    sidebar.setAttribute('aria-label', 'Chats');
    const otherLink = ctx.document.createElement('a');
    otherLink.setAttribute('href', '/unrelated_person/');
    sidebar.append(otherLink);

    const viewerLink = ctx.document.createElement('a');
    viewerLink.setAttribute('href', '/viewer_me/');

    const avatar = ctx.document.createElement('img');
    avatar.setAttribute('alt', "craft_kamel's profile picture");

    root.append(sidebar, viewerLink, avatar);

    const match = dmContainerUserMatch(root, 'craft_kamel', { viewerUsername: 'viewer_me' });
    assert.equal(match.matched, true);
    assert.equal(match.foundUsers.includes('viewer_me'), false);
    assert.equal(match.foundUsers.includes('unrelated_person'), false);
  });

  test('caretToEnd focuses editor, selects inside inner <p>, and fires selectionchange', () => {
    const ctx = makeCtx('/brand_saffron/');
    const ed = ctx.document.createElement('div');
    ed.setAttribute('contenteditable', 'true');
    ed.setAttribute('data-lexical-editor', 'true');
    const p = ctx.document.createElement('p');
    const br = ctx.document.createElement('br');
    p.append(br);
    ed.append(p);
    ctx.document.body.append(ed);

    const order = [];
    ed.focus = () => { order.push('focus'); };
    let selectedNode = null;
    ctx.document.createRange = () => ({
      selectNodeContents(node) { selectedNode = node; },
      collapse() {},
    });
    const fakeSel = {
      removeAllRanges() { order.push('removeAllRanges'); },
      addRange() { order.push('addRange'); },
    };
    ctx.getSelection = () => fakeSel;

    let selChangeCount = 0;
    ed.addEventListener('selectionchange', () => { selChangeCount += 1; });

    const res = caretToEnd(ctx, ed);
    assert.equal(res.ok, true);
    assert.equal(selectedNode, p, 'caret must land inside inner <p>, not outer <div>');
    assert.equal(order[0], 'focus', 'editor.focus() must run BEFORE setting selection');
    assert.ok(selChangeCount >= 1, 'selectionchange must be dispatched for Lexical');
  });

  test('composeMessage falls back to real plain-text paste when execCommand returns false', async () => {
    const ctx = makeCtx('/brand_saffron/');
    const { dock, editor } = buildFloatingDock(ctx.document, { username: 'brand_saffron' });
    ctx.document.body.append(dock);

    // Simulate Chromium Lexical ignoring execCommand('insertText') while
    // accepting ClipboardEvent('paste') with DataTransfer.
    ctx.document.execCommand = () => false;
    const origClipboard = globalThis.ClipboardEvent;
    const origDT = globalThis.DataTransfer;
    globalThis.DataTransfer = class FakeDT {
      constructor() { this._m = new Map(); }
      setData(k, v) { this._m.set(k, v); }
      getData(k) { return this._m.get(k) ?? ''; }
    };
    globalThis.ClipboardEvent = class FakePasteEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.clipboardData = init.clipboardData ?? null;
        this.bubbles = Boolean(init.bubbles);
        this.cancelable = Boolean(init.cancelable);
        this.composed = Boolean(init.composed);
      }
    };
    let pasteCount = 0;
    editor.addEventListener('paste', (ev) => {
      pasteCount += 1;
      editor._text = ev.clipboardData?.getData('text/plain') ?? '';
    });

    try {
      const out = await composeMessage(ctx, {
        document: ctx.document,
        message: 'Hello Saffron!',
        pathname: '/brand_saffron/',
      });
      assert.equal(out.ok, true);
      assert.equal(pasteCount, 1);
      assert.equal(readComposerText(editor), 'Hello Saffron!');
    } finally {
      globalThis.ClipboardEvent = origClipboard;
      globalThis.DataTransfer = origDT;
    }
  });

  test('clicking Message -> floating dock with display-name-only header (no /username/ link) + Notifications modal still sends', async () => {
    const ctx = makeCtx('/atelier_lina/');
    buildProfileHeader(ctx.document, { username: 'atelier_lina', hasMessageButton: true });
    const msgBtn = findProfileMessageButton(ctx.document).button;

    msgBtn.addEventListener('click', () => {
      // Dock header renders ONLY display name ("Lina Studio"), no /atelier_lina/ anchor.
      const dock = ctx.document.createElement('div');
      const header = ctx.document.createElement('div');
      const title = ctx.document.createElement('h2');
      title.textContent = 'Lina Studio';
      header.append(title, makeIconButton(ctx.document, 'Expand'), makeIconButton(ctx.document, 'Close'));
      const thread = ctx.document.createElement('div');
      const tray = ctx.document.createElement('div');
      const editor = ctx.document.createElement('div');
      editor.setAttribute('contenteditable', 'true');
      editor.setAttribute('role', 'textbox');
      editor.setAttribute('aria-placeholder', 'Message...');
      editor.setAttribute('data-lexical-editor', 'true');
      const sendBtn = makeIconButton(ctx.document, 'Press enter to send');
      sendBtn.addEventListener('click', () => {
        const txt = readComposerText(editor);
        editor._text = '';
        editor.children = [];
        const b = ctx.document.createElement('div');
        b.setAttribute('role', 'article');
        b.textContent = txt;
        thread.append(b);
      });
      tray.append(editor, sendBtn);
      dock.append(header, thread, tray);
      ctx.document.body.append(dock);

      // Also pop a "Turn on Notifications" dialog over the page!
      const notif = ctx.document.createElement('div');
      notif.setAttribute('role', 'dialog');
      const heading = ctx.document.createElement('h2');
      heading.textContent = 'Turn on Notifications';
      const notNow = makeRoleButton(ctx.document, 'Not Now');
      notNow.addEventListener('click', () => { notif.remove?.(); notif.parentNode?.removeChild?.(notif); });
      notif.append(heading, notNow);
      ctx.document.body.append(notif);
    });

    const opened = await openDm(ctx, {
      document: ctx.document,
      location: ctx.location,
      username: 'atelier_lina',
      timeoutMs: 1500,
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.openedByClick, true);

    const dm = await executeDm(ctx, {
      document: ctx.document,
      message: 'Hi Lina, love the ceramic pieces!',
      username: 'atelier_lina',
      trustedThread: true,
      pathname: '/atelier_lina/',
      settleMs: 1500,
    });
    assert.equal(dm.ok, true, `expected send to succeed: ${dm.reason}`);
    assert.equal(dm.outcome, ActionOutcome.DONE);
  });

  test('sendWithNavigation aborts dead 120s wait immediately on hard nav to /direct/t/ and sends with alreadyOpened:true (while never interrupting live SPA busy)', async () => {
    const store = new Map();
    const storage = {
      async get(k) { return store.has(k) ? structuredClone(store.get(k)) : null; },
      async set(k, v) { store.set(k, structuredClone(v)); },
      async remove(k) { store.delete(k); },
    };

    // --- Scenario A: Hard navigation kills old content script mid-EXECUTE_DM ---
    let tabState = { id: 9, url: 'https://www.instagram.com/brand_saffron/', status: 'complete' };
    let dmCalls = 0;
    const receivedPayloads = [];
    let scriptAlive = true;

    const chromeTabs = {
      async listTabs() { return [tabState]; },
      async tabById() { return { ...tabState }; },
      async waitForLoad() { tabState.status = 'complete'; return { ok: true, tab: { ...tabState } }; },
      async inject() { scriptAlive = true; return { ok: true }; },
      async navigate(_id, url) { tabState = { ...tabState, url, status: 'complete' }; return { ok: true, tab: { ...tabState } }; },
      async stampTabId() { return { ok: true, stamped: false }; },
    };

    const client = createApiClient({
      storage,
      tabs: chromeTabs,
      workspaceId: 'ws_hardnav',
      pollMs: 20,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 25))),
    });

    // Simulate the content script mailbox loop:
    // - First EXECUTE_DM claims the command, switches tab URL to /direct/t/999/,
    //   and dies (never writes a result!).
    // - After api.js injects on /direct/t/999/, second EXECUTE_DM arrives with
    //   alreadyOpened: true and succeeds immediately!
    const cmdKey = 'ig_crm_bridge_v1:ws_hardnav:command';
    const resKey = 'ig_crm_bridge_v1:ws_hardnav:result';
    let stopLoop = false;
    const responder = (async () => {
      while (!stopLoop) {
        const cmd = await storage.get(cmdKey);
        if (cmd) {
          if (cmd.type === CommandType.PING) {
            await storage.remove(cmdKey);
            if (scriptAlive) {
              const row = { commandId: cmd.commandId, ok: true, value: { pong: true, busy: false }, at: Date.now() };
              await storage.set(`${resKey}:${cmd.commandId}`, row);
              await storage.set(resKey, row);
            }
          } else if (cmd.type === CommandType.EXECUTE_DM) {
            await storage.remove(cmdKey);
            dmCalls += 1;
            receivedPayloads.push(cmd.payload);
            if (dmCalls === 1) {
              // Simulate hard navigation unloading old content script!
              scriptAlive = false;
              tabState = { id: 9, url: 'https://www.instagram.com/direct/t/999/', status: 'loading' };
            } else {
              const row = { commandId: cmd.commandId, ok: true, value: { ok: true, outcome: 'done' }, at: Date.now() };
              await storage.set(`${resKey}:${cmd.commandId}`, row);
              await storage.set(resKey, row);
            }
          }
        }
        await new Promise((r) => setTimeout(r, 15));
      }
    })();

    const startedAt = Date.now();
    const res = await client.sendWithNavigation(
      CommandType.EXECUTE_DM,
      { username: 'brand_saffron', message: 'Hi!' },
      { tabId: 9, timeoutMs: 30_000, settleMs: 10, navPollMs: 150, navGraceMs: 200 },
    );
    const elapsed = Date.now() - startedAt;
    stopLoop = true;
    await responder;

    assert.equal(res.ok, true, `hard-nav handoff must succeed: ${res.reason}`);
    assert.equal(dmCalls, 2);
    assert.equal(receivedPayloads[1]?.alreadyOpened, true, 'resumed command on /direct/t/ must pass alreadyOpened: true');
    assert.ok(elapsed < 5000, `must recover immediately without hanging for timeout (took ${elapsed}ms)`);
  });

  test('EXECUTE_DM with alreadyOpened:true on /direct/t/ hydrates and sends without bouncing back to profile', async () => {
    const ctx = makeCtx('/direct/t/555444/');
    // Start with empty /direct/t/ page (React still hydrating the composer!).
    // Mount the /direct/t/ composer + Send button on the 3rd virtual tick.
    let ticks = 0;
    let mounted = false;
    const origWait = ctx.wait;
    ctx.wait = async (ms) => {
      await origWait(ms);
      ticks += 1;
      if (!mounted && ticks >= 3) {
        mounted = true;
        const pane = ctx.document.createElement('div');
        const grid = ctx.document.createElement('div');
        grid.setAttribute('role', 'grid');
        const ed = ctx.document.createElement('div');
        ed.setAttribute('contenteditable', 'true');
        ed.setAttribute('role', 'textbox');
        ed.setAttribute('aria-placeholder', 'Message...');
        ed.setAttribute('data-lexical-editor', 'true');
        const send = makeRoleButton(ctx.document, 'Send');
        send.addEventListener('click', () => {
          const txt = readComposerText(ed);
          ed._text = '';
          ed.children = [];
          const b = ctx.document.createElement('div');
          b.setAttribute('role', 'article');
          b.textContent = txt;
          grid.append(b);
        });
        pane.append(grid, ed, send);
        ctx.document.body.append(pane);
      }
    };

    const runtime = createContentRuntime({
      document: ctx.document,
      location: ctx.location,
      cookieString: 'ds_user_id=99; csrftoken=abc',
      wait: ctx.wait,
      now: ctx.now,
      random: ctx.random,
    });
    const handlers = createHandlers(runtime);

    const out = await handlers[CommandType.EXECUTE_DM]({
      username: 'brand_saffron',
      message: 'Hey there!',
      alreadyOpened: true,
    });
    assert.equal(out.ok, true, `expected alreadyOpened /direct/t/ send to succeed: ${out.reason}`);
    assert.equal(out.outcome, ActionOutcome.DONE);
    assert.notEqual(out.needsNavigation, true, 'must NEVER bounce back to /brand_saffron/');
  });

  test('Only message mutuals (wait for follow-back) defaults to OFF in both queue planner and Outreach UI', async () => {
    const wsId = 'ws_mutual_default';
    const nowTs = new Date(2026, 5, 1, 14, 0, 0).getTime();

    // 1. Core queue planner defaults mutualOnly to false.
    const coldLead = leadRecord({ workspaceId: wsId, username: 'cold_lead_1' }, { relState: RelState.NONE, priorityScore: 70 });
    const builtDefault = buildQueue({ leads: [coldLead], mode: QueueMode.DM, now: nowTs, templateCount: 1 });
    assert.equal(builtDefault.queue.length, 1);
    assert.equal(builtDefault.queue[0].actionType, ActionType.DM_COLD);

    const builtMutualOnly = buildQueue({ leads: [coldLead], mode: QueueMode.DM, now: nowTs, templateCount: 1, policy: { mutualOnly: true } });
    assert.equal(builtMutualOnly.queue.length, 0);

    // 2. Outreach UI toggle starts unchecked on the Messages sub-tab.
    const doc = installDom();
    const root = doc.createElement('div');
    doc.body.append(root);
    const seenPolicies = [];
    const fakeApi = {
      workspaceId: wsId,
      async groups() { return []; },
      async templates() { return []; },
      async settings() { return {}; },
      async workspace() { return { workspaceId: wsId, governorState: null }; },
    };
    const fakeController = {
      state: { phase: 'idle' },
      subscribe() { return () => {}; },
      async outreach({ policy }) {
        seenPolicies.push(policy);
        return { ok: true, dryRun: true, plan: { counts: { ready: 0, queued: 0, skipped: 0, considered: 0, byCode: {} }, queue: [], canStart: false } };
      },
      stop() {},
    };
    const view = createOutreachView({ api: fakeApi, controller: fakeController });
    view.mount(root);
    await view.refresh();
    await new Promise((r) => setTimeout(r, 20));

    // Click the "Messages" sub-tab button.
    const msgTab = [...root.querySelectorAll('.subtab')].find((b) => /Messages/i.test(b.textContent));
    assert.ok(msgTab, 'Messages sub-tab must exist');
    msgTab._listeners?.click?.[0]?.({ target: msgTab });
    await new Promise((r) => setTimeout(r, 20));

    const mutualCheckbox = [...root.querySelectorAll('label')].find((l) => /Only message mutuals/i.test(l.textContent))?.querySelector('input[type="checkbox"]');
    assert.ok(mutualCheckbox, 'Only message mutuals toggle must render on Messages sub-tab');
    assert.equal(mutualCheckbox.checked, false, 'Only message mutuals must default to OFF');
    assert.equal(seenPolicies.at(-1)?.mutualOnly, false, 'planned DM policy must default mutualOnly to false');
    view.destroy?.();
  });
});

/* -------------------------------------------------------------------------- *
 * 5. Audit pass 2: Human grapheme typing, multilingual/positional Send,
 *    multi-line <br> verification, delayed Message hydration & /direct/ skip.
 * -------------------------------------------------------------------------- */

describe('Audit pass 2: human typing, all-scenarios Send, and edge-case resilience', () => {
  test('human typing sends one grapheme per keystroke with realistic cadence, emojis, Arabic, and single newline breaks', async () => {
    const ctx = makeCtx('/direct/t/555111/');
    const doc = ctx.document;
    const main = doc.createElement('main');
    const editor = doc.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-label', 'Message');
    editor.setAttribute('data-lexical-editor', 'true');
    const p = doc.createElement('p');
    editor.append(p);
    main.append(editor);
    doc.body.append(main);

    const insertedChunks = [];
    let lineBreakCalls = 0;
    const keydowns = [];
    editor.addEventListener('keydown', (e) => keydowns.push(e.key));

    const origExec = doc.execCommand.bind(doc);
    doc.execCommand = (cmd, ui, val) => {
      if (cmd === 'insertText') insertedChunks.push(val);
      if (cmd === 'insertLineBreak') lineBreakCalls += 1;
      return origExec(cmd, ui, val);
    };

    const msg = 'Hi 👋🏽!\nأهلاً';
    const out = await composeMessage(ctx, { document: doc, message: msg, pathname: '/direct/t/555111/' });
    assert.equal(out.ok, true, `expected human compose to succeed: ${out.reason}`);
    assert.equal(out.typedHuman, true);
    assert.deepEqual(insertedChunks, [...splitGraphemes('Hi 👋🏽!'), ...splitGraphemes('أهلاً')]);
    assert.ok(insertedChunks.includes('👋🏽'), 'emoji with skin-tone modifier must stay one intact grapheme');
    assert.equal(lineBreakCalls, 1, 'multi-line message must insert exactly ONE line break');
    assert.ok(!keydowns.includes('Enter'), 'must NOT fire redundant Shift+Enter keydown when execCommand(insertLineBreak) succeeded');
    assert.ok(keydowns.length >= insertedChunks.length, 'keydown telemetry fires per grapheme');
    assert.ok(ctx.waits.length >= insertedChunks.length, 'inter-keystroke pacing runs between graphemes');
  });

  test('human typing aborts immediately mid-sentence when Stop is triggered', async () => {
    const ctx = makeCtx('/direct/t/555222/');
    const doc = ctx.document;
    const main = doc.createElement('main');
    const editor = doc.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-label', 'Message');
    editor.setAttribute('data-lexical-editor', 'true');
    main.append(editor);
    doc.body.append(main);

    const controller = new AbortController();
    let count = 0;
    const origExec = doc.execCommand.bind(doc);
    doc.execCommand = (cmd, ui, val) => {
      if (cmd === 'insertText') {
        count += 1;
        if (count === 4) controller.abort();
      }
      return origExec(cmd, ui, val);
    };

    const out = await composeMessage(ctx, {
      document: doc,
      message: 'This is a long message that should stop immediately after four characters.',
      pathname: '/direct/t/555222/',
      signal: controller.signal,
    });
    assert.equal(out.ok, false);
    assert.equal(out.outcome, ActionOutcome.STOPPED);
    assert.equal(count, 4, 'must halt right after the abort without typing the rest of the sentence');
  });

  test('human typing fast-fails on first dropped grapheme into Chromium ISOLATED-world paste fallback', async () => {
    const ctx = makeCtx('/direct/t/555333/');
    const doc = ctx.document;
    const main = doc.createElement('main');
    const editor = doc.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-label', 'Message');
    editor.setAttribute('data-lexical-editor', 'true');
    main.append(editor);
    doc.body.append(main);

    let insertCalls = 0;
    doc.execCommand = (cmd) => {
      if (cmd === 'insertText') {
        insertCalls += 1;
        return true; // silently drops text without committing
      }
      return true;
    };

    const prevClip = globalThis.ClipboardEvent;
    const prevDt = globalThis.DataTransfer;
    try {
      globalThis.DataTransfer = class FakeDT {
        constructor() { this.map = new Map(); }
        setData(k, v) { this.map.set(k, v); }
        getData(k) { return this.map.get(k) ?? ''; }
      };
      globalThis.ClipboardEvent = class FakeClip {
        constructor(type, init) { this.type = type; this.clipboardData = init?.clipboardData; }
      };
      editor.addEventListener('paste', (ev) => {
        const pasted = ev?.clipboardData?.getData?.('text/plain') ?? '';
        if (pasted) editor.textContent = pasted;
      });

      const out = await composeMessage(ctx, {
        document: doc,
        message: 'A twenty-word message that should fast-fail after grapheme #1!',
        pathname: '/direct/t/555333/',
      });
      assert.equal(out.ok, true, `expected fast-fail paste fallback to succeed: ${out.reason}`);
      assert.equal(insertCalls, 1, 'must break out after grapheme #1 instead of typing all 62 chars into the void');
      assert.equal(readComposerText(editor), 'A twenty-word message that should fast-fail after grapheme #1!');
    } finally {
      globalThis.ClipboardEvent = prevClip;
      globalThis.DataTransfer = prevDt;
    }
  });

  test('<textarea> DM composer types progressively character-by-character with input events', async () => {
    const ctx = makeCtx('/direct/t/555444/');
    const doc = ctx.document;
    const main = doc.createElement('main');
    const ta = doc.createElement('textarea');
    ta.setAttribute('placeholder', 'Message...');
    main.append(ta);
    doc.body.append(main);

    const seenValues = [];
    ta.addEventListener('input', () => seenValues.push(ta.value));

    const out = await composeMessage(ctx, { document: doc, message: 'Hey!', pathname: '/direct/t/555444/' });
    assert.equal(out.ok, true, `expected textarea compose to succeed: ${out.reason}`);
    assert.equal(out.typedHuman, true);
    assert.deepEqual(seenValues, ['H', 'He', 'Hey', 'Hey!']);
  });

  test('HTML5 boolean [contenteditable=""] composer is discovered while [contenteditable="false"] is skipped', () => {
    const ctx = makeCtx('/direct/t/555555/');
    const doc = ctx.document;
    const main = doc.createElement('main');
    const readOnly = doc.createElement('div');
    readOnly.setAttribute('contenteditable', 'false');
    readOnly.setAttribute('aria-label', 'Message');
    const editable = doc.createElement('div');
    editable.setAttribute('contenteditable', '');
    editable.setAttribute('role', 'textbox');
    editable.setAttribute('aria-placeholder', 'Message...');
    main.append(readOnly, editable);
    doc.body.append(main);

    const surface = findDmSurface(doc, '/direct/t/555555/');
    assert.ok(surface, 'expected DM surface to be discovered');
    assert.equal(surface.editor, editable, 'must pick boolean contenteditable="" and skip contenteditable="false"');
  });

  test('multilingual Send buttons (FR/ES/DE/TR/IT/AR) and unlabelled positional Send icon are located reliably', () => {
    for (const label of ['Envoyer', 'Enviar', 'Senden', 'Gönder', 'Invia', 'إرسال']) {
      const ctx = makeCtx('/direct/t/555666/');
      const doc = ctx.document;
      const bar = doc.createElement('div');
      const editor = doc.createElement('div');
      editor.setAttribute('contenteditable', 'true');
      editor.setAttribute('aria-label', 'Message');
      const sendBtn = doc.createElement('div');
      sendBtn.setAttribute('role', 'button');
      sendBtn.textContent = label;
      bar.append(editor, sendBtn);
      doc.body.append(bar);

      const hit = findSendButton(doc, bar, editor);
      assert.ok(hit, `expected Send button to match locale label "${label}"`);
      assert.equal(hit.button, sendBtn);
    }

    // Unlabelled SVG Send icon inside composer bar (only matched with allowPositional: true,
    // while Voice Clip / Photo / Emoji / pointer-events:none buttons are strictly ignored!).
    const ctx2 = makeCtx('/direct/t/555667/');
    const doc2 = ctx2.document;
    const bar2 = doc2.createElement('div');
    const emojiBtn = makeIconButton(doc2, 'Choose an emoji');
    const editor2 = doc2.createElement('div');
    editor2.setAttribute('contenteditable', 'true');
    editor2.setAttribute('aria-label', 'Message');
    const voiceBtn = makeIconButton(doc2, 'Voice Clip');
    const disabledSend = doc2.createElement('button');
    disabledSend.textContent = 'Send';
    disabledSend.style.pointerEvents = 'none';
    const mysterySendIcon = doc2.createElement('div');
    mysterySendIcon.setAttribute('role', 'button');
    mysterySendIcon.append(doc2.createElement('svg'));
    bar2.append(emojiBtn, editor2, voiceBtn, disabledSend, mysterySendIcon);
    doc2.body.append(bar2);

    assert.equal(findSendButton(doc2, bar2, editor2, { allowPositional: false }), null, 'disabled pointer-events:none Send must be rejected');
    assert.equal(findSendButton(doc2, bar2, editor2, { allowPositional: true }), null, 'positional fallback must wait while media tray (Voice Clip) is still mounted');
    // Simulate Instagram swapping out Voice Clip after text lands in editor:
    bar2.children = bar2.children.filter((c) => c !== voiceBtn);
    const positional = findSendButton(doc2, bar2, editor2, { allowPositional: true });
    assert.ok(positional, 'positional fallback must find the lone unlabelled trailing icon button once media tray swaps out');
    assert.equal(positional.button, mysterySendIcon);
  });

  test('newestIsOurs verifies multi-line <br> bubbles whose textContent joins lines without spaces', () => {
    const ctx = makeCtx('/direct/t/555777/');
    const doc = ctx.document;
    const dock = doc.createElement('div');
    const bubble = doc.createElement('div');
    bubble.setAttribute('role', 'article');
    const s1 = doc.createElement('span');
    s1.textContent = 'Hi Sara,';
    const br = doc.createElement('br');
    const s2 = doc.createElement('span');
    s2.textContent = 'Love your pottery!';
    bubble.append(s1, br, s2);
    // Simulate a node where textContent drops the break ("Hi Sara,Love your pottery!")
    // and innerText isn't populated.
    Object.defineProperty(bubble, 'innerText', { get: () => '' });
    dock.append(bubble);
    doc.body.append(dock);

    assert.equal(bubble.textContent, 'Hi Sara,Love your pottery!');
    assert.equal(newestIsOurs(doc, 'Hi Sara,\nLove your pottery!', dock, null), true);
    assert.equal(newestIsOurs(doc, 'Love your pottery!\nHi Sara,', dock, null), false, 'lines must appear in order');
  });

  test('openDm waits briefly for delayed Message button hydration after Follow renders instead of jumping to Options', async () => {
    const ctx = makeCtx('/delayed_creator/');
    const doc = ctx.document;
    const header = doc.createElement('header');
    const follow = doc.createElement('button');
    follow.textContent = 'Follow';
    const options = makeIconButton(doc, 'Options');
    header.append(follow, options);
    doc.body.append(header);

    // Hydrate the Message button at t >= 400ms (after headerReady triggers).
    let hydrated = false;
    const baseWait = ctx.wait;
    ctx.wait = async (ms) => {
      await baseWait(ms);
      if (!hydrated && ctx._t >= 400) {
        hydrated = true;
        const msgBtn = doc.createElement('div');
        msgBtn.setAttribute('role', 'button');
        msgBtn.textContent = 'Message';
        msgBtn.addEventListener('click', () => {
          doc.body.append(buildFloatingDock(doc, { username: 'delayed_creator' }).dock);
        });
        header.append(msgBtn);
      }
    };

    const opened = await openDm(ctx, {
      document: doc,
      location: ctx.location,
      username: 'delayed_creator',
      readyTimeoutMs: 2000,
    });
    assert.equal(opened.ok, true, `expected openDm to succeed: ${opened.reason}`);
    assert.equal(opened.via, 'header-message', 'must click delayed header Message button instead of Options menu');
  });

  test('EXECUTE_DM with alreadyOpened:true on /direct/t/ dismisses Notifications modal and short-circuits on Invite sent', async () => {
    const ctx = makeCtx('/direct/t/999000111/');
    const doc = ctx.document;

    // Notifications modal overlays the thread initially
    const notif = doc.createElement('div');
    notif.setAttribute('role', 'dialog');
    const h = doc.createElement('span');
    h.textContent = 'Turn on Notifications';
    const notNow = doc.createElement('button');
    notNow.textContent = 'Not Now';
    notNow.addEventListener('click', () => {
      notif.parentNode.children = notif.parentNode.children.filter((c) => c !== notif);
    });
    notif.append(h, notNow);
    doc.body.append(notif);

    // Main thread renders "Invite sent" banner (no composer!)
    const main = doc.createElement('main');
    const banner = doc.createElement('div');
    banner.textContent = 'Invite sent. You can send more messages after your invite is accepted.';
    main.append(banner);
    doc.body.append(main);

    const runtime = createContentRuntime({
      document: doc,
      getSelection: () => doc.selection,
      location: ctx.location,
      cookieString: 'ds_user_id=99; csrftoken=abc',
      wait: ctx.wait,
      now: ctx.now,
      random: () => 0.5,
    });
    const handlers = createHandlers(runtime);
    const out = await handlers[CommandType.EXECUTE_DM]({
      username: 'private_creator',
      message: 'Hello!',
      alreadyOpened: true,
    });

    assert.equal(out.ok, false);
    assert.equal(out.outcome, ActionOutcome.SKIPPED);
    assert.equal(out.inviteAlreadySent, true, 'must return inviteAlreadySent instead of falling through to openDm');
    assert.equal(doc.querySelectorAll('[role="dialog"]').length, 0, 'Notifications popup must be dismissed');
  });
});



