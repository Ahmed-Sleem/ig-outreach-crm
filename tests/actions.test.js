import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../scripts/lib/dom-shim.mjs';
import { Label } from '../src/content/selectors.js';
import {
  ActionOutcome,
  SETTLE_MS,
  caretToEnd,
  composeMessage,
  executeDm,
  executeFollow,
  executeUnfollow,
  expectedComposerText,
  findComposer,
  hasExistingThread,
  humanClick,
  isActionBlocked,
  isDoubled,
  newestIsOurs,
  openDm,
  readComposerText,
  readRelationshipState,
  threadShowsSeen,
  waitFor,
} from '../src/content/actions.js';

/* ------------------------------------------------------- a fake Instagram DOM */

function makeCtx(options = {}) {
  const doc = installDom();
  if (options.dir) doc.dir = options.dir;
  const ctx = {
    document: doc,
    getSelection: () => doc.selection,
    now: () => ctx._t,
    wait: async (ms) => { ctx._t += ms; ctx.waits.push(ms); },
    _t: 0,
    waits: [],
    clicks: [],
  };
  return ctx;
}

function button(doc, text, onClick = null) {
  const node = doc.createElement('button');
  node.textContent = text;
  if (onClick) node.addEventListener('click', () => onClick(node));
  return node;
}

/** Replace a button in place, the way Instagram re-renders after a click. */
function swap(oldButton, text, onClick = null) {
  const parent = oldButton.parentNode;
  const index = parent.children.indexOf(oldButton);
  const next = button(parent.ownerDocument, text, onClick);
  parent.children[index] = next;
  next.parentNode = parent;
  return next;
}

function profilePage(ctx, { initial = 'Follow', settlesTo = 'Following', onClick = null } = {}) {
  const doc = ctx.document;
  const header = doc.createElement('header');
  const follow = button(doc, initial, (node) => {
    ctx.clicks.push(node.textContent);
    if (settlesTo) swap(node, settlesTo);
    onClick?.(node);
  });
  header.append(follow);
  doc.body.append(header);
  return follow;
}

function dmDialog(ctx, { bubbles = [], dir = null } = {}) {
  const doc = ctx.document;
  const dialog = doc.createElement('div');
  dialog.setAttribute('role', 'dialog');
  if (dir) dialog.dir = dir;
  const thread = doc.createElement('div');
  for (const text of bubbles) {
    const bubble = doc.createElement('div');
    bubble.setAttribute('role', 'article');
    bubble.textContent = text;
    thread.append(bubble);
  }
  const editor = doc.createElement('div');
  editor.setAttribute('contenteditable', 'true');
  const send = button(doc, 'Send');
  dialog.append(thread, editor, send);
  doc.body.append(dialog);
  return { dialog, editor, send, thread };
}

function blockDialog(ctx, text = 'Try Again Later') {
  const doc = ctx.document;
  const dialog = doc.createElement('div');
  dialog.setAttribute('role', 'dialog');
  const span = doc.createElement('span');
  span.textContent = text;
  dialog.append(span);
  doc.body.append(dialog);
  return dialog;
}

describe('reading the relationship state', () => {
  test('the rendered button decides, in English and Arabic', () => {
    for (const [text, state] of [['Follow', 'none'], ['Following', 'following'], ['Requested', 'requested'], ['Follow Back', 'follows_me'], ['متابعة', 'none'], ['أتابعه', 'following']]) {
      const ctx = makeCtx();
      profilePage(ctx, { initial: text, settlesTo: null });
      assert.equal(readRelationshipState(ctx.document).state, state, text);
    }
  });

  test('a page with no relationship button reports unknown, not none', () => {
    const ctx = makeCtx();
    const result = readRelationshipState(ctx.document);
    assert.equal(result.state, 'unknown');
    assert.equal(result.button, undefined);
    assert.match(result.reason, /no relationship button/);
  });

  test('"Following" is never mistaken for "Follow"', () => {
    const ctx = makeCtx();
    profilePage(ctx, { initial: 'Following', settlesTo: null });
    assert.equal(readRelationshipState(ctx.document).kind, Label.FOLLOWING);
  });
});

describe('humanClick', () => {
  test('scrolls into view and dispatches the full pointer sequence', async () => {
    const ctx = makeCtx();
    const node = button(ctx.document, 'Follow');
    ctx.document.body.append(node);
    const seen = [];
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) node.addEventListener(type, () => seen.push(type));
    await humanClick(ctx, node);
    assert.equal(node._scrolledIntoView, 1);
    assert.deepEqual(seen, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    assert.ok(ctx.waits.length >= 2, 'a click without pauses is not human');
  });

  test('clicking nothing is false, not a throw', async () => {
    const ctx = makeCtx();
    assert.equal(await humanClick(ctx, null), false);
  });
});

describe('waitFor', () => {
  test('finds a condition that appears later', async () => {
    const ctx = makeCtx();
    let ready = false;
    ctx.wait = async (ms) => { ctx._t += ms; if (ctx._t >= 300) ready = true; };
    const result = await waitFor(ctx, () => (ready ? 'yes' : null), { timeoutMs: 1000, intervalMs: 100 });
    assert.equal(result.found, true);
    assert.equal(result.value, 'yes');
    assert.ok(result.elapsedMs >= 300);
  });

  test('times out with a reason naming the condition', async () => {
    const ctx = makeCtx();
    const result = await waitFor(ctx, () => null, { timeoutMs: 500, intervalMs: 100, label: 'follow state' });
    assert.equal(result.found, false);
    assert.match(result.reason, /follow state did not appear/);
  });

  test('an abort stops the wait early', async () => {
    const ctx = makeCtx();
    const signal = { aborted: false };
    ctx.wait = async (ms) => { ctx._t += ms; signal.aborted = true; };
    const result = await waitFor(ctx, () => null, { timeoutMs: 60000, intervalMs: 100, signal });
    assert.equal(result.found, false);
    assert.equal(result.reason, 'aborted');
  });

  test('a throwing predicate is treated as not-found', async () => {
    const ctx = makeCtx();
    const result = await waitFor(ctx, () => { throw new Error('detached node'); }, { timeoutMs: 300, intervalMs: 100 });
    assert.equal(result.found, false);
  });
});

describe('executeFollow', () => {
  test('a public account settles into Following and is reported done', async () => {
    const ctx = makeCtx();
    profilePage(ctx, { initial: 'Follow', settlesTo: 'Following' });
    const result = await executeFollow(ctx, { document: ctx.document });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, ActionOutcome.DONE);
    assert.equal(result.state, 'following');
    assert.equal(result.requested, false);
    assert.deepEqual(ctx.clicks, ['Follow']);
  });

  test('a private account settles into Requested and is still done', async () => {
    const ctx = makeCtx();
    profilePage(ctx, { initial: 'Follow', settlesTo: 'Requested' });
    const result = await executeFollow(ctx, { document: ctx.document });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'requested');
    assert.equal(result.requested, true);
  });

  test('an Arabic session is followed through the Arabic button', async () => {
    const ctx = makeCtx({ dir: 'rtl' });
    profilePage(ctx, { initial: 'متابعة', settlesTo: 'أتابعه' });
    const result = await executeFollow(ctx, { document: ctx.document });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'following');
  });

  test('a click Instagram ignores is reported as not done', async () => {
    const ctx = makeCtx();
    profilePage(ctx, { initial: 'Follow', settlesTo: null });
    const result = await executeFollow(ctx, { document: ctx.document, settleMs: 600 });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, ActionOutcome.NOT_DONE);
    assert.equal(result.state, 'none');
    assert.match(result.reason, /did not appear/);
  });

  test('already following is skipped without a click', async () => {
    const ctx = makeCtx();
    profilePage(ctx, { initial: 'Following', settlesTo: null });
    const result = await executeFollow(ctx, { document: ctx.document });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, ActionOutcome.SKIPPED);
    assert.deepEqual(ctx.clicks, []);
  });

  test('a pending request is skipped: clicking again would cancel it', async () => {
    const ctx = makeCtx();
    profilePage(ctx, { initial: 'Requested', settlesTo: null });
    const result = await executeFollow(ctx, { document: ctx.document });
    assert.equal(result.outcome, ActionOutcome.SKIPPED);
    assert.deepEqual(ctx.clicks, []);
  });

  test('a page with no Follow button is refused', async () => {
    const ctx = makeCtx();
    const result = await executeFollow(ctx, { document: ctx.document });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, ActionOutcome.REFUSED);
  });

  test('an action-block dialog stops the run before clicking', async () => {
    const ctx = makeCtx();
    blockDialog(ctx);
    profilePage(ctx, { initial: 'Follow', settlesTo: 'Following' });
    assert.equal(isActionBlocked(ctx.document), true);
    const result = await executeFollow(ctx, { document: ctx.document });
    assert.equal(result.outcome, ActionOutcome.STOPPED);
    assert.deepEqual(ctx.clicks, []);
  });

  test('a block that appears after the click stops the run and is not counted as done', async () => {
    const ctx = makeCtx();
    profilePage(ctx, { initial: 'Follow', settlesTo: null, onClick: () => blockDialog(ctx) });
    const result = await executeFollow(ctx, { document: ctx.document, settleMs: 800 });
    assert.equal(result.outcome, ActionOutcome.STOPPED);
    assert.equal(result.ok, false);
  });

  test('the settlement window is the documented 3.5 seconds', () => {
    assert.equal(SETTLE_MS.follow, 3500);
    assert.equal(SETTLE_MS.unfollow, 3500);
  });
});

describe('executeUnfollow', () => {
  test('Following -> confirm dialog -> Unfollow -> Follow is one clean sequence', async () => {
    const ctx = makeCtx();
    const doc = ctx.document;
    const header = doc.createElement('header');
    const following = button(doc, 'Following', (node) => {
      ctx.clicks.push(node.textContent);
      const dialog = doc.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.append(button(doc, 'Cancel'), button(doc, 'Unfollow', (confirmNode) => {
        ctx.clicks.push(confirmNode.textContent);
        swap(node, 'Follow');
        dialog.remove?.();
        doc.body.children = doc.body.children.filter((child) => child !== dialog);
      }));
      doc.body.append(dialog);
    });
    header.append(following);
    doc.body.append(header);

    const result = await executeUnfollow(ctx, { document: doc });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'none');
    assert.deepEqual(ctx.clicks, ['Following', 'Unfollow']);
  });

  test('an unfollow whose confirm dialog never appears is not done', async () => {
    const ctx = makeCtx();
    profilePage(ctx, { initial: 'Following', settlesTo: null });
    const result = await executeUnfollow(ctx, { document: ctx.document });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, ActionOutcome.NOT_DONE);
    assert.match(result.reason, /confirm dialog did not appear/);
  });

  test('unfollowing someone you do not follow is skipped', async () => {
    const ctx = makeCtx();
    profilePage(ctx, { initial: 'Follow', settlesTo: null });
    const result = await executeUnfollow(ctx, { document: ctx.document });
    assert.equal(result.outcome, ActionOutcome.SKIPPED);
    assert.deepEqual(ctx.clicks, []);
  });

  test('a dialog that stays open after the confirm click is not done', async () => {
    const ctx = makeCtx();
    const doc = ctx.document;
    const header = doc.createElement('header');
    header.append(button(doc, 'Following', (node) => {
      const dialog = doc.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.append(button(doc, 'Unfollow', () => { ctx.clicks.push('Unfollow'); }));
      doc.body.append(dialog);
      void node;
    }));
    doc.body.append(header);
    const result = await executeUnfollow(ctx, { document: doc, settleMs: 600 });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, ActionOutcome.NOT_DONE);
  });
});

describe('the DM composer', () => {
  test('finds the composer inside a dialog and refuses a comment box', () => {
    const ctx = makeCtx();
    dmDialog(ctx);
    assert.equal(findComposer(ctx, { document: ctx.document, pathname: '/direct/inbox/' }).editor !== null, true);

    const bare = makeCtx();
    const comment = bare.document.createElement('div');
    comment.setAttribute('contenteditable', 'true');
    bare.document.body.append(comment);
    const result = findComposer(bare, { document: bare.document, pathname: '/p/AbCd/' });
    assert.equal(result.editor, null);
    assert.match(result.reason, /comment box/);
  });

  test('the caret is collapsed to the end of the composer', () => {
    const ctx = makeCtx();
    const { editor } = dmDialog(ctx);
    editor.append(ctx.document.createTextNode('old'));
    const result = caretToEnd(ctx, editor);
    assert.equal(result.ok, true);
    const range = ctx.document.selection.getRangeAt(0);
    assert.equal(range.collapsed, true);
    assert.equal(range.startContainer, editor);
  });

  test('direction is reported for the composer it is placed in', () => {
    const ctx = makeCtx();
    const { editor } = dmDialog(ctx, { dir: 'rtl' });
    assert.equal(caretToEnd(ctx, editor).rtl, true);
    const ltr = makeCtx();
    assert.equal(caretToEnd(ltr, dmDialog(ltr).editor).rtl, false);
  });

  test('expected text joins lines, because <br> renders as nothing', () => {
    assert.equal(expectedComposerText('line one\nline two'), 'line one line two');
    assert.equal(expectedComposerText('  spaced   text  '), 'spaced text');
    assert.equal(expectedComposerText(''), '');
  });

  test('a doubled draft is detected in both spacings', () => {
    assert.equal(isDoubled('hello hello', 'hello'), true);
    assert.equal(isDoubled('hellohello', 'hello'), true);
    assert.equal(isDoubled('hello', 'hello'), false);
    assert.equal(isDoubled('hello hello', ''), false);
  });

  test('an empty message is refused before the composer is touched', async () => {
    const ctx = makeCtx();
    const { editor } = dmDialog(ctx);
    const result = await composeMessage(ctx, { document: ctx.document, message: '   ', pathname: '/direct/' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /empty/);
    assert.equal(readComposerText(editor), '');
  });

  test('a message over the composer limit is refused', async () => {
    const ctx = makeCtx();
    dmDialog(ctx);
    const result = await composeMessage(ctx, { document: ctx.document, message: 'a'.repeat(1001), pathname: '/direct/' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /1000/);
  });

  test('an English message lands in the composer exactly once', async () => {
    const ctx = makeCtx();
    const { editor } = dmDialog(ctx);
    const result = await composeMessage(ctx, { document: ctx.document, message: 'Hi Sara, loved the linen collection.', pathname: '/direct/' });
    assert.equal(result.ok, true);
    assert.equal(result.rendered, 'Hi Sara, loved the linen collection.');
    assert.equal(result.lines, 1);
    assert.equal(result.rtl, false);
    assert.equal(readComposerText(editor), 'Hi Sara, loved the linen collection.');
  });

  test('an Arabic message lands intact in an RTL thread', async () => {
    const ctx = makeCtx({ dir: 'rtl' });
    const message = 'مرحبًا سارة، وصلتني طلبية القماش اليوم وشكرًا لك';
    const { editor } = dmDialog(ctx, { dir: 'rtl' });
    const result = await composeMessage(ctx, { document: ctx.document, message, pathname: '/direct/' });
    assert.equal(result.ok, true);
    assert.equal(result.rendered, expectedComposerText(message));
    assert.equal(result.rtl, true);
    assert.equal(readComposerText(editor), expectedComposerText(message));
  });

  test('a multi-line message is typed line by line', async () => {
    const ctx = makeCtx();
    const { editor } = dmDialog(ctx);
    const result = await composeMessage(ctx, { document: ctx.document, message: 'First line\nSecond line', pathname: '/direct/' });
    assert.equal(result.ok, true);
    assert.equal(result.lines, 2);
    assert.equal(ctx.document._execCommands.filter((c) => c === 'insertLineBreak').length, 1);
    assert.equal(readComposerText(editor), 'First line Second line');
  });

  test("someone else's draft is cleared before typing", async () => {
    const ctx = makeCtx();
    const { editor } = dmDialog(ctx);
    editor.append(ctx.document.createTextNode('an old draft'));
    const result = await composeMessage(ctx, { document: ctx.document, message: 'Fresh message', pathname: '/direct/' });
    assert.equal(result.ok, true);
    assert.equal(readComposerText(editor), 'Fresh message');
    assert.ok(ctx.document._execCommands.includes('selectAll'));
  });

  test('typing is paced, not instantaneous', async () => {
    const ctx = makeCtx();
    dmDialog(ctx);
    await composeMessage(ctx, { document: ctx.document, message: 'Hello there', pathname: '/direct/' });
    assert.ok(ctx.waits.length >= 1);
    assert.ok(ctx.waits.every((ms) => ms >= 60 && ms <= 150));
  });

  test('an abort while composing stops before the next line', async () => {
    const ctx = makeCtx();
    dmDialog(ctx);
    const signal = { aborted: true };
    const result = await composeMessage(ctx, { document: ctx.document, message: 'one\ntwo', signal, pathname: '/direct/' });
    assert.equal(result.outcome, ActionOutcome.STOPPED);
  });
});

describe('executeDm', () => {
  test('a first message is composed, sent and verified in the thread', async () => {
    const ctx = makeCtx();
    const { editor, send, thread } = dmDialog(ctx);
    send.addEventListener('click', () => {
      const text = readComposerText(editor);
      editor.children = [];
      editor._text = null;
      const bubble = ctx.document.createElement('div');
      bubble.setAttribute('role', 'article');
      bubble.textContent = text;
      thread.append(bubble);
    });
    const result = await executeDm(ctx, { document: ctx.document, message: 'Hi Sara, loved the linen collection.', pathname: '/direct/' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.outcome, ActionOutcome.DONE);
    assert.ok(result.clearedMs >= 0);
    assert.equal(result.seen, false);
  });

  test('a thread that already has messages is skipped', async () => {
    const ctx = makeCtx();
    const { send } = dmDialog(ctx, { bubbles: ['an earlier message'] });
    let sent = false;
    send.addEventListener('click', () => { sent = true; });
    const result = await executeDm(ctx, { document: ctx.document, message: 'Hi again', pathname: '/direct/' });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, ActionOutcome.SKIPPED);
    assert.equal(result.existingThread, true);
    assert.equal(sent, false);
  });

  test('allowExisting lets a follow-up through when the funnel decides so', async () => {
    const ctx = makeCtx();
    const { editor, send, thread } = dmDialog(ctx, { bubbles: ['their reply'] });
    send.addEventListener('click', () => {
      const bubble = ctx.document.createElement('div');
      bubble.setAttribute('role', 'article');
      bubble.textContent = readComposerText(editor);
      editor.children = [];
      editor._text = null;
      thread.append(bubble);
    });
    const result = await executeDm(ctx, { document: ctx.document, message: 'Thanks for replying', pathname: '/direct/', allowExisting: true });
    assert.equal(result.ok, true);
  });

  test('a Send that leaves the composer full is not done', async () => {
    const ctx = makeCtx();
    dmDialog(ctx);
    const result = await executeDm(ctx, { document: ctx.document, message: 'Hello', pathname: '/direct/', settleMs: 600 });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, ActionOutcome.NOT_DONE);
    assert.match(result.reason, /composer still holds/);
  });

  test('a cleared composer with no bubble in the thread is not done', async () => {
    const ctx = makeCtx();
    const { editor, send } = dmDialog(ctx);
    send.addEventListener('click', () => { editor.children = []; editor._text = null; });
    const result = await executeDm(ctx, { document: ctx.document, message: 'Hello', pathname: '/direct/', settleMs: 800 });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, ActionOutcome.NOT_DONE);
    assert.match(result.reason, /never appeared in the thread/);
  });

  test('no Send button at all is not done, and the draft stays put', async () => {
    const ctx = makeCtx();
    const { editor, send } = dmDialog(ctx);
    send.parentNode.children = send.parentNode.children.filter((child) => child !== send);
    const result = await executeDm(ctx, { document: ctx.document, message: 'Hello', pathname: '/direct/' });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, ActionOutcome.NOT_DONE);
    assert.match(result.reason, /no Send button/);
    assert.equal(readComposerText(editor), 'Hello');
  });

  test('an action block stops the run before composing', async () => {
    const ctx = makeCtx();
    dmDialog(ctx);
    blockDialog(ctx, 'حاول لاحقًا');
    const result = await executeDm(ctx, { document: ctx.document, message: 'Hello', pathname: '/direct/' });
    assert.equal(result.outcome, ActionOutcome.STOPPED);
  });

  test('a "Seen" receipt is read from the thread', () => {
    const ctx = makeCtx();
    const { thread } = dmDialog(ctx, { bubbles: ['my message'] });
    const seen = ctx.document.createElement('span');
    seen.textContent = 'Seen';
    const lastBubble = thread.children[thread.children.length - 1];
    lastBubble.parentNode.append(seen);
    assert.equal(threadShowsSeen(ctx.document), true);
    assert.equal(newestIsOurs(ctx.document, 'my message'), true);
    assert.equal(newestIsOurs(ctx.document, 'another message'), false);
  });

  test('an empty thread has no newest message and is not "seen"', () => {
    const ctx = makeCtx();
    dmDialog(ctx);
    assert.equal(hasExistingThread(ctx.document), false);
    assert.equal(threadShowsSeen(ctx.document), false);
    assert.equal(newestIsOurs(ctx.document, 'x'), false);
  });
});

describe('openDm', () => {
  test('the Message button opens the thread and the result stays serialisable', async () => {
    const ctx = makeCtx();
    const doc = ctx.document;
    const header = doc.createElement('header');
    header.append(button(doc, 'Message', () => { dmDialog(ctx); }));
    doc.body.append(header);
    const result = await openDm(ctx, { document: doc });
    assert.equal(result.ok, true);
    assert.equal(result.composerFound, true);
    assert.equal(result.existingThread, false);
    // The composer node stays in the tab: openDm's result crosses the storage
    // bridge, where a DOM node cannot be structured-cloned.
    assert.equal(result.editor, undefined);
    assert.doesNotThrow(() => JSON.stringify(result));
  });

  test('a profile with no Message button asks for navigation instead of failing silently', async () => {
    const ctx = makeCtx();
    profilePage(ctx, { initial: 'Follow', settlesTo: 'Following' });
    const result = await openDm(ctx, { document: ctx.document });
    assert.equal(result.ok, false);
    assert.equal(result.needsNavigation, true);
    assert.match(result.reason, /no Message button/);
  });

  test('a Message button that opens nothing is not done', async () => {
    const ctx = makeCtx();
    const doc = ctx.document;
    const header = doc.createElement('header');
    header.append(button(doc, 'Message'));
    doc.body.append(header);
    const result = await openDm(ctx, { document: doc, timeoutMs: 600 });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, ActionOutcome.NOT_DONE);
    assert.equal(result.needsNavigation, true);
  });
});

describe('composer failure modes', () => {
  test('a draft Lexical renders twice is cleared and never sent', async () => {
    const ctx = makeCtx();
    const { editor, send } = dmDialog(ctx);
    let sent = false;
    send.addEventListener('click', () => { sent = true; });
    // Instagram bug shape: the insert lands twice in the same editor.
    const realExec = ctx.document.execCommand.bind(ctx.document);
    ctx.document.execCommand = (command, ui, value) => {
      const out = realExec(command, ui, value);
      if (command === 'insertText') realExec('insertText', ui, value);
      return out;
    };
    const result = await composeMessage(ctx, { document: ctx.document, message: 'Hi Sara', pathname: '/direct/' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /twice/);
    assert.equal(readComposerText(editor), '');
    assert.equal(sent, false);
  });

  test('a partial draft is refused with both texts in the reason', async () => {
    const ctx = makeCtx();
    const { editor, send } = dmDialog(ctx);
    let sent = false;
    send.addEventListener('click', () => { sent = true; });
    const realExec = ctx.document.execCommand.bind(ctx.document);
    // Instagram bug shape: one word of the message never lands.
    ctx.document.execCommand = (command, ui, value) => {
      if (command !== 'insertText') return realExec(command, ui, value);
      for (const word of String(value).split(' ')) {
        if (word === 'Sara,') continue;
        realExec('insertText', ui, `${word} `);
      }
      return true;
    };
    const result = await composeMessage(ctx, { document: ctx.document, message: 'Hi Sara, loved it', pathname: '/direct/' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /the composer holds/);
    assert.equal(result.rendered, 'Hi loved it');
    assert.equal(result.expected, 'Hi Sara, loved it');
    assert.equal(sent, false);
    assert.ok(readComposerText(editor).length >= 0);
  });

  test('a composer that cannot be cleared refuses to type over a draft', async () => {
    const ctx = makeCtx();
    const { editor } = dmDialog(ctx);
    editor.append(ctx.document.createTextNode('someone else\'s draft'));
    ctx.document.execCommand = () => false; // clearing does nothing
    const result = await composeMessage(ctx, { document: ctx.document, message: 'My message', pathname: '/direct/' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /still holds text after clearing/);
    assert.equal(readComposerText(editor), "someone else's draft");
  });

  test('executeDm refuses end to end when the draft doubles after Send is armed', async () => {
    const ctx = makeCtx();
    const { editor, send } = dmDialog(ctx);
    let sent = false;
    send.addEventListener('click', () => { sent = true; });
    const realExec = ctx.document.execCommand.bind(ctx.document);
    let inserts = 0;
    ctx.document.execCommand = (command, ui, value) => {
      const out = realExec(command, ui, value);
      if (command === 'insertText') { inserts += 1; if (inserts === 1) realExec('insertText', ui, value); }
      return out;
    };
    const result = await executeDm(ctx, { document: ctx.document, message: 'Hi Sara', pathname: '/direct/' });
    assert.equal(result.ok, false);
    assert.equal(sent, false);
    assert.equal(readComposerText(editor), '');
  });
});
