import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../scripts/lib/dom-shim.mjs';
import {
  Label,
  LABEL_TEXT,
  collapse,
  composerScope,
  extractCommentsFromDom,
  extractDialogUsers,
  findActionBlockDialog,
  findButtonByLabel,
  findButtonsByLabel,
  findCloseDialogButton,
  findConfirmDialog,
  findDialogs,
  findLoadMoreCommentsButton,
  findNextPostButton,
  findPostGridLinks,
  findPostLikersTrigger,
  findProfileListTrigger,
  findScrollableList,
  findSuggestedBoundary,
  gridTileAuthors,
  isPrivateAccountPage,
  isReservedSegment,
  isRtlElement,
  isValidIgUsername,
  labelKind,
  profileLinkUsername,
  threadBubbles,
  userLinksFrom,
  usernameFromPath,
} from '../src/content/selectors.js';

/** Build a labelled button the way Instagram renders one. */
function button(doc, text, extra = {}) {
  const node = doc.createElement('button');
  node.textContent = text;
  for (const [key, value] of Object.entries(extra)) node.setAttribute(key, value);
  return node;
}

describe('label dictionary', () => {
  test('every label kind has at least an English and an Arabic form', () => {
    for (const kind of Object.values(Label)) {
      const texts = LABEL_TEXT[kind];
      assert.ok(Array.isArray(texts) && texts.length >= 2, `${kind} needs both languages`);
      assert.ok(texts.some((t) => /^[A-Za-z]/.test(t)), `${kind} needs an English form`);
      assert.ok(texts.some((t) => /[\u0600-\u06FF]/.test(t)), `${kind} needs an Arabic form`);
    }
  });

  test('matching is exact after collapse, never a substring', () => {
    assert.equal(labelKind('Follow'), Label.FOLLOW);
    assert.equal(labelKind('  Follow  '), Label.FOLLOW);
    assert.equal(labelKind('متابعة'), Label.FOLLOW);
    assert.equal(labelKind('إلغاء المتابعة'), Label.UNFOLLOW);
    // The classic misclick: "Following" contains "Follow".
    assert.equal(labelKind('Following'), Label.FOLLOWING);
    assert.equal(labelKind('Followers'), null);
    assert.equal(labelKind('Follow Back'), Label.FOLLOW_BACK);
    assert.equal(labelKind('Unfollow'), Label.UNFOLLOW);
    assert.equal(labelKind('Send'), Label.SEND);
    assert.equal(labelKind('Try Again Later'), Label.TRY_AGAIN_LATER);
    assert.equal(labelKind(''), null);
    assert.equal(labelKind(null), null);
  });

  test('no two kinds claim the same text', () => {
    const seen = new Map();
    for (const [kind, texts] of Object.entries(LABEL_TEXT)) {
      for (const text of texts) {
        const key = collapse(text);
        assert.ok(!seen.has(key), `${key} claimed by both ${seen.get(key)} and ${kind}`);
        seen.set(key, kind);
      }
    }
  });

  test('collapse normalises whitespace and bidi padding', () => {
    assert.equal(collapse('  Follow\n\tBack '), 'Follow Back');
    assert.equal(collapse(undefined), '');
  });
});

describe('username extraction', () => {
  test('reads the first path segment and skips chrome routes', () => {
    assert.equal(usernameFromPath('/sara_shop/'), 'sara_shop');
    assert.equal(usernameFromPath('/sara_shop/?hl=en'), 'sara_shop');
    assert.equal(usernameFromPath('sara.shop'), 'sara.shop');
    assert.equal(usernameFromPath('/'), null);
    assert.equal(usernameFromPath(''), null);
  });

  test('reserved segments are never usernames', () => {
    for (const seg of ['explore', 'reels', 'p', 'tv', 'stories', 'direct', 'accounts', 'challenge', 'reel']) {
      assert.equal(usernameFromPath(`/${seg}/abc/`), null, seg);
      assert.equal(isReservedSegment(seg), true, seg);
    }
    assert.equal(isReservedSegment('explore'), true);
    assert.equal(isReservedSegment('Explore'), true);
    assert.equal(isReservedSegment('sara_shop'), false);
  });

  test('a post shortcode is not a lead called "AbCdEf"', () => {
    assert.equal(usernameFromPath('/p/AbCdEfGh/'), null);
    assert.equal(usernameFromPath('/reel/AbCdEfGh/'), null);
  });
});

describe('button finders', () => {
  test('finds the Follow button and not the Following one', () => {
    const doc = installDom();
    doc.body.append(button(doc, 'Following'), button(doc, 'Follow'), button(doc, 'Message'));
    const hit = findButtonByLabel(doc, [Label.FOLLOW]);
    assert.equal(hit.kind, Label.FOLLOW);
    assert.equal(collapse(hit.button.textContent), 'Follow');
  });

  test('preference order decides which label wins', () => {
    const doc = installDom();
    doc.body.append(button(doc, 'Follow Back'), button(doc, 'Follow'));
    assert.equal(findButtonByLabel(doc, [Label.FOLLOW, Label.FOLLOW_BACK]).kind, Label.FOLLOW);
    assert.equal(findButtonByLabel(doc, [Label.FOLLOW_BACK, Label.FOLLOW]).kind, Label.FOLLOW_BACK);
    assert.equal(findButtonByLabel(doc, [Label.SEND]), null);
  });

  test('role=button counts, and non-labelled buttons are ignored', () => {
    const doc = installDom();
    const div = doc.createElement('div');
    div.setAttribute('role', 'button');
    div.textContent = 'متابعة';
    doc.body.append(div, button(doc, 'Like'), button(doc, ''));
    const found = findButtonsByLabel(doc, [Label.FOLLOW, Label.SEND]);
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, Label.FOLLOW);
  });
});

describe('dialogs', () => {
  test('findDialogs returns every open dialog', () => {
    const doc = installDom();
    const a = doc.createElement('div'); a.setAttribute('role', 'dialog');
    const b = doc.createElement('div'); b.setAttribute('role', 'dialog');
    doc.body.append(a, b);
    assert.equal(findDialogs(doc).length, 2);
  });

  test('findConfirmDialog returns the Unfollow button inside the dialog', () => {
    const doc = installDom();
    const dialog = doc.createElement('div'); dialog.setAttribute('role', 'dialog');
    dialog.append(button(doc, 'Cancel'), button(doc, 'Unfollow'));
    doc.body.append(dialog);
    const found = findConfirmDialog(doc);
    assert.ok(found);
    assert.equal(found.kind, Label.UNFOLLOW);
    assert.equal(found.dialog, dialog);
  });

  test('a confirm dialog elsewhere on the page is not treated as open', () => {
    const doc = installDom();
    doc.body.append(button(doc, 'Unfollow'));
    assert.equal(findConfirmDialog(doc), null);
  });

  test('findActionBlockDialog detects the action-block modal in both languages', () => {
    for (const text of ['Try Again Later', 'حاول لاحقًا']) {
      const doc = installDom();
      const dialog = doc.createElement('div'); dialog.setAttribute('role', 'dialog');
      const span = doc.createElement('span'); span.textContent = text; dialog.append(span);
      doc.body.append(dialog);
      assert.ok(findActionBlockDialog(doc), text);
    }
    const doc = installDom();
    const dialog = doc.createElement('div'); dialog.setAttribute('role', 'dialog');
    dialog.append(button(doc, 'Try Again Later'));
    doc.body.append(dialog);
    assert.ok(findActionBlockDialog(doc));
  });

  test('an ordinary dialog is not an action block', () => {
    const doc = installDom();
    const dialog = doc.createElement('div'); dialog.setAttribute('role', 'dialog');
    dialog.append(button(doc, 'Send'));
    doc.body.append(dialog);
    assert.equal(findActionBlockDialog(doc), null);
  });
});

describe('composer scoping', () => {
  test('a contenteditable inside a dialog is the DM composer', () => {
    const doc = installDom();
    const dialog = doc.createElement('div'); dialog.setAttribute('role', 'dialog');
    const editor = doc.createElement('div'); editor.setAttribute('contenteditable', 'true');
    dialog.append(editor); doc.body.append(dialog);
    assert.equal(composerScope(doc, '/direct/inbox/'), editor);
  });

  test('outside a dialog the composer must be on /direct and inside main', () => {
    const doc = installDom();
    const main = doc.createElement('main');
    const editor = doc.createElement('div'); editor.setAttribute('contenteditable', 'true');
    main.append(editor); doc.body.append(main);
    assert.equal(composerScope(doc, '/direct/inbox/'), editor);
    // The same editor on a post page is a comment box: typing into it is public.
    assert.equal(composerScope(doc, '/p/AbCd/'), null);
    assert.equal(composerScope(doc, '/sara_shop/'), null);
  });

  test('no editor at all returns null rather than throwing', () => {
    const doc = installDom();
    assert.equal(composerScope(doc, '/direct/'), null);
  });
});

describe('thread bubbles', () => {
  test('reads the last dialog when one is open', () => {
    const doc = installDom();
    const dialog = doc.createElement('div'); dialog.setAttribute('role', 'dialog');
    const mine = doc.createElement('div'); mine.setAttribute('role', 'article'); mine.textContent = 'hello';
    const theirs = doc.createElement('div'); theirs.setAttribute('role', 'article'); theirs.textContent = 'hi';
    dialog.append(theirs, mine); doc.body.append(dialog);
    const bubbles = threadBubbles(doc);
    assert.equal(bubbles.length, 2);
    assert.equal(bubbles[1].textContent, 'hello');
  });
});

describe('scrollable list detection', () => {
  test('picks the element with the most scroll room that is not hidden', () => {
    const doc = installDom();
    const hidden = doc.createElement('div');
    hidden.setAttribute('style', 'overflow-y: hidden;');
    hidden.scrollHeight = 5000; hidden.clientHeight = 100;
    const list = doc.createElement('div');
    list.setAttribute('style', 'overflow-y: auto;');
    list.scrollHeight = 900; list.clientHeight = 300;
    doc.body.append(hidden, list);
    assert.equal(findScrollableList(doc), list);
  });

  test('a page with nothing scrollable returns null', () => {
    const doc = installDom();
    assert.equal(findScrollableList(doc), null);
  });
});

describe('DOM row readers', () => {
  test('userLinksFrom dedups and keeps the display name', () => {
    const doc = installDom();
    const link = (href, name) => {
      const a = doc.createElement('a'); a.setAttribute('href', href);
      const span = doc.createElement('span'); span.textContent = name; a.append(span);
      return a;
    };
    doc.body.append(link('/ali.dev', 'Ali Dev'), link('/ali.dev?hl=ar', 'Ali Dev'), link('/explore/x/', 'X'), link('/p/AbC/', 'Post'));
    const rows = userLinksFrom(doc.body);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].username, 'ali.dev');
    assert.equal(rows[0].fullName, 'Ali Dev');
  });

  test('gridTileAuthors reads one author per tile', () => {
    const doc = installDom();
    for (const username of ['brand_eg', 'shop.cairo']) {
      const article = doc.createElement('article');
      const a = doc.createElement('a'); a.setAttribute('href', `/${username}/`);
      article.append(a); doc.body.append(article);
    }
    assert.deepEqual(gridTileAuthors(doc.body).map((r) => r.username), ['brand_eg', 'shop.cairo']);
  });
});

describe('direction', () => {
  test('a nearer declared direction wins over a farther one', () => {
    const doc = installDom();
    const rtl = doc.createElement('div'); rtl.dir = 'rtl';
    const ltr = doc.createElement('div'); ltr.dir = 'ltr';
    const leaf = doc.createElement('span');
    ltr.append(leaf); rtl.append(ltr); doc.body.append(rtl);
    assert.equal(isRtlElement(leaf), false);
    assert.equal(isRtlElement(ltr), false);
    assert.equal(isRtlElement(rtl), true);
  });

  test('an inherited rtl reaches a descendant that declares nothing', () => {
    const doc = installDom();
    const rtl = doc.createElement('div'); rtl.dir = 'rtl';
    const plain = doc.createElement('div');
    const leaf = doc.createElement('span');
    plain.append(leaf); rtl.append(plain); doc.body.append(rtl);
    assert.equal(isRtlElement(leaf), true);
    assert.equal(isRtlElement(plain), true);
  });

  test('with nothing declared anywhere, the document direction is used', () => {
    const doc = installDom();
    const leaf = doc.createElement('span');
    doc.body.append(leaf);
    doc.dir = 'rtl';
    assert.equal(isRtlElement(leaf), true);
    doc.dir = 'ltr';
    assert.equal(isRtlElement(leaf), false);
  });

  test('null is not rtl', () => {
    assert.equal(isRtlElement(null), false);
  });
});

describe('2026 browser-DOM collection selectors', () => {
  test('profileLinkUsername accepts single-segment handles and rejects routes/subpaths', () => {
    assert.equal(profileLinkUsername('/sara.atelier/'), 'sara.atelier');
    assert.equal(profileLinkUsername('https://www.instagram.com/cairo_craft/?hl=en'), 'cairo_craft');
    assert.equal(profileLinkUsername('/explore/'), null);
    assert.equal(profileLinkUsername('/sara.atelier/followers/'), null);
    assert.equal(profileLinkUsername('/p/CxYz123/'), null);
    assert.equal(isValidIgUsername('good_name.1'), true);
    assert.equal(isValidIgUsername('..bad'), false);
  });

  test('findProfileListTrigger locates followers & following in English and Arabic', () => {
    const doc = installDom();
    const header = doc.createElement('header');
    const aFollowers = doc.createElement('a');
    aFollowers.setAttribute('href', '/nile_linen/followers/');
    aFollowers.textContent = '1,240 followers';
    const aFollowing = doc.createElement('a');
    aFollowing.setAttribute('href', '/nile_linen/following/');
    aFollowing.textContent = '312 following';
    header.append(aFollowers, aFollowing);
    doc.body.append(header);
    assert.equal(findProfileListTrigger(doc, 'followers'), aFollowers);
    assert.equal(findProfileListTrigger(doc, 'following'), aFollowing);

    const arDoc = installDom();
    const arHeader = arDoc.createElement('header');
    const arBtn = arDoc.createElement('button');
    arBtn.textContent = '820 متابع';
    arHeader.append(arBtn);
    arDoc.body.append(arHeader);
    assert.equal(findProfileListTrigger(arDoc, 'followers'), arBtn);
  });

  test('extractDialogUsers reads clean rows, excludes owner, and skips Suggested for you', () => {
    const doc = installDom();
    const dialog = doc.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const list = doc.createElement('div');
    list.style.overflowY = 'auto';
    list.scrollHeight = 1200;
    list.clientHeight = 400;

    const addRow = (handle, name) => {
      const row = doc.createElement('div');
      row.setAttribute('role', 'listitem');
      const a = doc.createElement('a');
      a.setAttribute('href', `/${handle}/`);
      a.textContent = handle;
      const span = doc.createElement('span');
      span.textContent = name;
      const follow = button(doc, 'Follow');
      row.append(a, span, follow);
      list.append(row);
      return a;
    };

    const a1 = addRow('nadia_textiles', 'Nadia Textiles');
    const aOwner = addRow('target_brand', 'Target Brand');
    const suggestedHeading = doc.createElement('span');
    suggestedHeading.textContent = 'Suggested for you';
    list.append(suggestedHeading);
    const aSuggested = addRow('random_suggested', 'Random Suggested');

    // Simulate DOM order comparison for compareDocumentPosition (4 = FOLLOWING)
    suggestedHeading.compareDocumentPosition = (other) => (other === aSuggested ? 4 : 2);

    dialog.append(list);
    doc.body.append(dialog);

    assert.equal(findSuggestedBoundary(dialog), suggestedHeading);
    const { users, hitSuggested } = extractDialogUsers(dialog, { excludeUsername: 'target_brand' });
    assert.equal(hitSuggested, true);
    assert.deepEqual(users.map((u) => u.username), ['nadia_textiles']);
    assert.equal(users[0].fullName, 'Nadia Textiles');
    assert.ok(a1 && aOwner);
  });

  test('findPostGridLinks collects unique post & reel shortcodes in order', () => {
    const doc = installDom();
    const main = doc.createElement('main');
    for (const href of ['/p/ABC1234/', '/p/ABC1234/', '/reel/DEF5678/', '/explore/']) {
      const a = doc.createElement('a');
      a.setAttribute('href', href);
      main.append(a);
    }
    doc.body.append(main);
    const posts = findPostGridLinks(doc, 6);
    assert.deepEqual(posts.map((p) => p.shortcode), ['ABC1234', 'DEF5678']);
    assert.equal(posts[1].isReel, true);
  });

  test('findPostLikersTrigger finds likes/others trigger and NEVER clicks the heart Like button', () => {
    const doc = installDom();
    const article = doc.createElement('article');

    // Heart Like button MUST be skipped
    const heartBtn = doc.createElement('button');
    const heartSvg = doc.createElement('svg');
    heartSvg.setAttribute('aria-label', 'Like');
    heartBtn.append(heartSvg);
    heartBtn.textContent = 'Like';

    // Real "142 likes" trigger
    const likesBtn = doc.createElement('button');
    likesBtn.textContent = '142 likes';

    article.append(heartBtn, likesBtn);
    doc.body.append(article);

    assert.equal(findPostLikersTrigger(article), likesBtn);

    // Also test "/liked_by/" link priority
    const likedBy = doc.createElement('a');
    likedBy.setAttribute('href', '/p/ABC1234/liked_by/');
    likedBy.textContent = 'others';
    article.append(likedBy);
    assert.equal(findPostLikersTrigger(article), likedBy);
  });

  test('findNextPostButton, findCloseDialogButton, findLoadMoreCommentsButton work cleanly', () => {
    const doc = installDom();
    const dialog = doc.createElement('div');
    dialog.setAttribute('role', 'dialog');

    const nextBtn = doc.createElement('button');
    const nextSvg = doc.createElement('svg');
    nextSvg.setAttribute('aria-label', 'Next');
    nextBtn.append(nextSvg);

    const closeBtn = doc.createElement('button');
    const closeSvg = doc.createElement('svg');
    closeSvg.setAttribute('aria-label', 'Close');
    closeBtn.append(closeSvg);

    const hideReplies = button(doc, 'Hide replies');
    const loadMore = button(doc, 'Load more comments');

    dialog.append(nextBtn, closeBtn, hideReplies, loadMore);
    doc.body.append(dialog);

    assert.equal(findNextPostButton(dialog), nextBtn);
    assert.equal(findCloseDialogButton(dialog), closeBtn);
    assert.equal(findLoadMoreCommentsButton(dialog), loadMore);
  });

  test('extractCommentsFromDom walks semantic <time> rows without brittle CSS classes', () => {
    const doc = installDom();
    const post = doc.createElement('article');

    const li1 = doc.createElement('li');
    const u1 = doc.createElement('a');
    u1.setAttribute('href', '/karim_decor/');
    u1.textContent = 'karim_decor';
    const txt1 = doc.createElement('span');
    txt1.setAttribute('dir', 'auto');
    txt1.textContent = 'بكام الطقم ده؟ وهل في شحن للقاهرة؟';
    const t1 = doc.createElement('time');
    t1.setAttribute('datetime', '2026-11-10T10:00:00.000Z');
    t1.textContent = '2d';
    li1.append(u1, txt1, t1);

    const li2 = doc.createElement('li');
    const u2 = doc.createElement('a');
    u2.setAttribute('href', '/sara_studio/');
    u2.textContent = 'sara_studio';
    const txt2 = doc.createElement('span');
    txt2.setAttribute('dir', 'auto');
    txt2.textContent = 'How much for wholesale?';
    const t2 = doc.createElement('time');
    t2.textContent = '5h';
    li2.append(u2, txt2, t2);

    post.append(li1, li2);
    doc.body.append(post);

    const comments = extractCommentsFromDom(post);
    assert.equal(comments.length, 2);
    assert.equal(comments[0].username, 'karim_decor');
    assert.match(comments[0].text, /بكام/);
    assert.equal(comments[1].username, 'sara_studio');
    assert.equal(comments[1].text, 'How much for wholesale?');
  });

  test('isPrivateAccountPage detects English and Arabic private walls', () => {
    const doc = installDom();
    doc.body.textContent = 'This account is private';
    assert.equal(isPrivateAccountPage(doc.body), true);

    const arDoc = installDom();
    arDoc.body.textContent = 'هذا الحساب خاص';
    assert.equal(isPrivateAccountPage(arDoc.body), true);
  });
});
