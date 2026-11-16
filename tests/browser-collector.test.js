import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../scripts/lib/dom-shim.mjs';
import {
  collectHashtagDom,
  collectOpenDialogDom,
  collectPostCommentsDom,
  collectPostLikersDom,
  collectProfileListDom,
  collectRecentPostLikersDom,
  scrollDialogForUsers,
} from '../src/content/browser-collector.js';
import {
  extractCommentsFromDom,
  extractDialogUsers,
  findActionBlockDialog,
  findCloseDialogButton,
  findDialogLoadMoreButton,
  findPostLikersTrigger,
  findProfileListTrigger,
  gridTileAuthors,
  hasFollowerCapNotice,
  userLinksFrom,
} from '../src/content/selectors.js';
import { HOST_ID } from '../src/content/launcher.js';
import { CollectSource, createContentRuntime, runCommand } from '../src/content/main.js';
import { CommandType } from '../src/storage/bridge.js';

function makeCtx(doc, pathname = '/', extra = {}) {
  let t = 1000;
  return {
    document: doc,
    location: { href: `https://www.instagram.com${pathname}`, pathname },
    wait: async (ms = 0) => { t += Math.max(10, Number(ms) || 10); },
    now: () => t,
    random: () => 0.5,
    domTimeoutMs: 400,
    ...extra,
  };
}

function addUserRow(doc, list, handle, fullName = '') {
  const row = doc.createElement('div');
  row.setAttribute('role', 'listitem');
  const a = doc.createElement('a');
  a.setAttribute('href', `/${handle}/`);
  a.textContent = handle;
  const span = doc.createElement('span');
  span.textContent = fullName || handle;
  const btn = doc.createElement('button');
  btn.textContent = 'Follow';
  row.append(a, span, btn);
  list.append(row);
  return a;
}

describe('browser-collector: 100% DOM automation (zero Instagram API calls)', () => {
  test('collectProfileListDom asks to navigate when tab is on a different page', async () => {
    const doc = installDom();
    const ctx = makeCtx(doc, '/');
    const res = await collectProfileListDom(ctx, { kind: 'followers', targetUsername: 'nile_linen', limit: 20 });
    assert.equal(res.ok, false);
    assert.equal(res.needsNavigation, true);
    assert.equal(res.url, 'https://www.instagram.com/nile_linen/');
  });

  test('collectProfileListDom clicks Followers, scrolls modal, skips owner & Suggested for you, and closes dialog', async () => {
    const doc = installDom();
    const header = doc.createElement('header');
    const followersLink = doc.createElement('a');
    followersLink.setAttribute('href', '/nile_linen/followers/');
    followersLink.textContent = '1,240 followers';
    followersLink.getBoundingClientRect = () => ({ left: 300, top: 120, width: 110, height: 24 });

    let dialogClosed = false;
    let scrollLoads = 0;

    followersLink.click = () => {
      const dialog = doc.createElement('div');
      dialog.setAttribute('role', 'dialog');

      const closeBtn = doc.createElement('button');
      const closeSvg = doc.createElement('svg');
      closeSvg.setAttribute('aria-label', 'Close');
      closeBtn.append(closeSvg);
      closeBtn.getBoundingClientRect = () => ({ left: 520, top: 80, width: 32, height: 32 });
      closeBtn.click = () => {
        dialogClosed = true;
        dialog.remove();
      };

      const list = doc.createElement('div');
      list.style.overflowY = 'auto';
      list.clientHeight = 300;
      list.scrollHeight = 900;
      list.getBoundingClientRect = () => ({ left: 200, top: 140, width: 360, height: 300 });

      addUserRow(doc, list, 'nile_linen', 'Nile Linen'); // profile owner -> excluded
      addUserRow(doc, list, 'sara_home', 'Sara Home');
      addUserRow(doc, list, 'karim_studio', 'Karim Studio');

      list.addEventListener('scroll', () => {
        if (scrollLoads === 0) {
          scrollLoads += 1;
          addUserRow(doc, list, 'nadia_design', 'Nadia Design');
          const boundary = doc.createElement('span');
          boundary.textContent = 'Suggested for you';
          list.append(boundary);
          const suggestedAnchor = addUserRow(doc, list, 'stranger_suggested', 'Stranger');
          boundary.compareDocumentPosition = (other) => (other === suggestedAnchor ? 4 : 2);
        }
      });

      dialog.append(closeBtn, list);
      doc.body.append(dialog);
    };

    header.append(followersLink);
    doc.body.append(header);

    const progress = [];
    const ctx = makeCtx(doc, '/nile_linen/');
    const res = await collectProfileListDom(ctx, {
      kind: 'followers',
      targetUsername: 'nile_linen',
      limit: 10,
      onProgress: (p) => progress.push(p),
    });

    assert.equal(res.ok, true);
    assert.equal(res.strategy, 'browser-dom');
    assert.deepEqual(res.rows.map((r) => r.username), ['sara_home', 'karim_studio', 'nadia_design']);
    assert.equal(dialogClosed, true, 'dialog closed cleanly after collecting');
    assert.ok(progress.length >= 2, 'live progress emitted');
  });

  test('collectRecentPostLikersDom opens recent posts, clicks Likes safely, scrolls stacked dialog, and steps with Next', async () => {
    const doc = installDom();
    const main = doc.createElement('main');

    const post1 = doc.createElement('a');
    post1.setAttribute('href', '/p/POST_ONE1/');
    post1.getBoundingClientRect = () => ({ left: 100, top: 300, width: 180, height: 180 });
    const post2 = doc.createElement('a');
    post2.setAttribute('href', '/p/POST_TWO2/');
    post2.getBoundingClientRect = () => ({ left: 300, top: 300, width: 180, height: 180 });

    const likersByPost = [
      ['hana_crafts', 'omar_ceramics'],
      ['omar_ceramics', 'leila_textiles', 'tarek_shop'],
    ];

    let currentIdx = 0;
    let heartClicked = false;

    const mountPostDialog = (idx) => {
      const existing = doc.querySelector('[role="dialog"]');
      if (existing) existing.remove();
      const postDlg = doc.createElement('div');
      postDlg.setAttribute('role', 'dialog');

      // Heart Like icon must NEVER be clicked
      const heart = doc.createElement('button');
      const heartSvg = doc.createElement('svg');
      heartSvg.setAttribute('aria-label', 'Like');
      heart.append(heartSvg);
      heart.click = () => { heartClicked = true; };

      // Safe "42 likes" trigger
      const likesBtn = doc.createElement('button');
      likesBtn.textContent = '42 likes';
      likesBtn.getBoundingClientRect = () => ({ left: 420, top: 440, width: 80, height: 24 });
      likesBtn.click = () => {
        const likesDlg = doc.createElement('div');
        likesDlg.setAttribute('role', 'dialog');
        const closeLikes = doc.createElement('button');
        const cs = doc.createElement('svg');
        cs.setAttribute('aria-label', 'Close');
        closeLikes.append(cs);
        closeLikes.click = () => likesDlg.remove();

        const list = doc.createElement('div');
        list.style.overflowY = 'auto';
        list.clientHeight = 260;
        list.scrollHeight = 320;
        for (const u of likersByPost[idx]) addUserRow(doc, list, u, u);
        likesDlg.append(closeLikes, list);
        doc.body.append(likesDlg);
      };

      const nextBtn = doc.createElement('button');
      const nextSvg = doc.createElement('svg');
      nextSvg.setAttribute('aria-label', 'Next');
      nextBtn.append(nextSvg);
      nextBtn.getBoundingClientRect = () => ({ left: 840, top: 320, width: 40, height: 40 });
      nextBtn.click = () => {
        currentIdx += 1;
        mountPostDialog(currentIdx);
      };

      const closePost = doc.createElement('button');
      const cps = doc.createElement('svg');
      cps.setAttribute('aria-label', 'Close');
      closePost.append(cps);
      closePost.click = () => postDlg.remove();

      postDlg.append(heart, likesBtn, nextBtn, closePost);
      doc.body.append(postDlg);
    };

    post1.click = () => mountPostDialog(0);
    main.append(post1, post2);
    doc.body.append(main);

    const ctx = makeCtx(doc, '/nile_linen/');
    const res = await collectRecentPostLikersDom(ctx, { targetUsername: 'nile_linen', limit: 10, maxPosts: 2 });

    assert.equal(res.ok, true);
    assert.equal(heartClicked, false, 'NEVER clicks the heart Like button');
    assert.deepEqual(
      res.rows.map((r) => r.username),
      ['hana_crafts', 'omar_ceramics', 'leila_textiles', 'tarek_shop'],
    );
    assert.equal(res.pages, 2);
  });

  test('collectPostCommentsDom clicks Load more comments and extracts Arabic & English comments for buyer-intent scoring', async () => {
    const doc = installDom();
    const article = doc.createElement('article');
    const scroller = doc.createElement('div');
    scroller.style.overflowY = 'auto';
    scroller.clientHeight = 300;
    scroller.scrollHeight = 800;

    const addComment = (handle, body) => {
      const li = doc.createElement('li');
      const a = doc.createElement('a');
      a.setAttribute('href', `/${handle}/`);
      a.textContent = handle;
      const span = doc.createElement('span');
      span.setAttribute('dir', 'auto');
      span.textContent = body;
      const time = doc.createElement('time');
      time.textContent = '3h';
      li.append(a, span, time);
      scroller.append(li);
    };

    addComment('mona_home', 'بكام الطقم ده؟ في شحن للقاهرة؟');

    const loadMore = doc.createElement('button');
    loadMore.textContent = 'Load more comments';
    loadMore.getBoundingClientRect = () => ({ left: 400, top: 480, width: 160, height: 30 });
    loadMore.click = () => {
      addComment('david_atelier', 'How much for wholesale orders?');
      loadMore.remove();
    };

    article.append(scroller, loadMore);
    doc.body.append(article);

    const ctx = makeCtx(doc, '/p/POST_ABC12/');
    const res = await collectPostCommentsDom(ctx, { shortcode: 'POST_ABC12', limit: 10 });

    assert.equal(res.ok, true);
    assert.deepEqual(res.rows.map((r) => r.username), ['mona_home', 'david_atelier']);
    assert.equal(res.commentTexts.length, 2);
    assert.match(res.commentTexts[0].text, /بكام/);
  });

  test('collectOpenDialogDom scrolls an already open dialog and aborts immediately on action-block', async () => {
    const doc = installDom();
    const dialog = doc.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const list = doc.createElement('div');
    list.style.overflowY = 'auto';
    list.clientHeight = 200;
    list.scrollHeight = 500;
    addUserRow(doc, list, 'yasmin_loom', 'Yasmin Loom');
    dialog.append(list);
    doc.body.append(dialog);

    const ctx = makeCtx(doc, '/nile_linen/');
    const res = await collectOpenDialogDom(ctx, { limit: 5 });
    assert.equal(res.ok, true);
    assert.deepEqual(res.rows.map((r) => r.username), ['yasmin_loom']);

    // Now test action-block dialog halts immediately with AccountFlagged
    const blockDlg = doc.createElement('div');
    blockDlg.setAttribute('role', 'dialog');
    blockDlg.textContent = 'Try Again Later';
    doc.body.append(blockDlg);
    await assert.rejects(() => collectOpenDialogDom(ctx, { limit: 5 }), /action-block/i);
  });

  test('collectFromSource via runCommand makes ZERO fetch calls to Instagram APIs', async () => {
    const doc = installDom();
    const header = doc.createElement('header');
    const link = doc.createElement('a');
    link.setAttribute('href', '/nile_linen/followers/');
    link.textContent = '10 followers';
    link.click = () => {
      const dlg = doc.createElement('div');
      dlg.setAttribute('role', 'dialog');
      const list = doc.createElement('div');
      list.style.overflowY = 'auto';
      list.clientHeight = 200;
      list.scrollHeight = 300;
      addUserRow(doc, list, 'amira_shop', 'Amira Shop');
      dlg.append(list);
      doc.body.append(dlg);
    };
    header.append(link);
    doc.body.append(header);

    let fetchCalled = 0;
    let t = 1000;
    const runtime = createContentRuntime({
      document: doc,
      location: { href: 'https://www.instagram.com/nile_linen/', pathname: '/nile_linen/' },
      cookieString: 'sessionid=abc; ds_user_id=77',
      fetchImpl: async () => { fetchCalled += 1; throw new Error('API fetch must NEVER be called!'); },
      wait: async (ms = 0) => { t += Math.max(10, Number(ms) || 10); },
      now: () => t,
      random: () => 0.5,
      domTimeoutMs: 300,
    });

    const answer = await runCommand(runtime, CommandType.COLLECT_LEADS, {
      source: CollectSource.FOLLOWERS,
      targetUsername: 'nile_linen',
      limit: 5,
    });

    assert.equal(fetchCalled, 0, 'ZERO Instagram API fetches were made');
    assert.equal(answer.ok, true);
    assert.equal(answer.value.strategy, 'browser-dom');
    assert.deepEqual(answer.value.leads.map((l) => l.username), ['amira_shop']);
  });

  test('2026 DOM fidelity: non-Array NodeList safety across all selector helpers', () => {
    const doc = installDom();
    const dlg = doc.createElement('div');
    dlg.setAttribute('role', 'dialog');
    const okBtn = doc.createElement('button');
    okBtn.textContent = 'OK';
    dlg.append(okBtn);
    doc.body.append(dlg);

    const nodeList = dlg.querySelectorAll('button');
    assert.equal(typeof nodeList.some, 'undefined', 'querySelectorAll must return a non-Array NodeList');
    assert.equal(typeof nodeList.map, 'undefined');
    assert.equal(typeof nodeList.find, 'undefined');

    assert.equal(findActionBlockDialog(doc), null);
    assert.deepEqual(userLinksFrom(doc), []);
    assert.deepEqual(gridTileAuthors(doc), []);
  });

  test('2026 profile HTML: clicks <a href="#">236K followers</a> and NEVER /followers/mutualOnly', async () => {
    const doc = installDom();
    const header = doc.createElement('header');

    // Trap link that appeared BEFORE real triggers in 2026 IG profile HTML:
    const mutualTrap = doc.createElement('a');
    mutualTrap.setAttribute('role', 'link');
    mutualTrap.setAttribute('href', 'https://www.instagram.com/fightclubpoint/followers/mutualOnly');
    mutualTrap.textContent = 'Followed by harrys_bestiee';
    let trapClicked = false;
    mutualTrap.click = () => { trapClicked = true; };

    const followersTrigger = doc.createElement('a');
    followersTrigger.setAttribute('role', 'link');
    followersTrigger.setAttribute('href', '#');
    followersTrigger.textContent = '236K followers';

    const followingTrigger = doc.createElement('a');
    followingTrigger.setAttribute('role', 'link');
    followingTrigger.setAttribute('href', '#');
    followingTrigger.textContent = '11 following';

    const followBtn = doc.createElement('button');
    followBtn.textContent = 'Following';

    header.append(mutualTrap, followersTrigger, followingTrigger, followBtn);
    doc.body.append(header);

    assert.equal(findProfileListTrigger(doc, 'followers'), followersTrigger);
    assert.equal(findProfileListTrigger(doc, 'following'), followingTrigger);

    // Wire clicking the real `#` trigger to open Instagram's Followers modal in-place
    followersTrigger.click = () => {
      const dlg = doc.createElement('div');
      dlg.setAttribute('role', 'dialog');
      dlg.setAttribute('aria-label', 'Followers');
      const scroller = doc.createElement('div');
      scroller.setAttribute('style', 'height:auto;overflow:hidden auto');
      scroller.clientHeight = 320;
      scroller.scrollHeight = 640;
      addUserRow(doc, scroller, 'real_follower_1', 'Real Follower');
      dlg.append(scroller);
      doc.body.append(dlg);
    };

    const res = await collectProfileListDom(makeCtx(doc, '/fightclubpoint/'), {
      kind: 'followers',
      targetUsername: 'fightclubpoint',
      limit: 10,
    });
    assert.equal(trapClicked, false, 'must NEVER click /followers/mutualOnly');
    assert.equal(res.ok, true);
    assert.deepEqual(res.rows.map((r) => r.username), ['real_follower_1']);
  });

  test('2026 Following dialog: two scrollers exclude Suggested for you, strip Verified, ignore See All Suggestions', () => {
    const doc = installDom();
    const dlg = doc.createElement('div');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-label', 'Following');

    const outer = doc.createElement('div');
    outer.style.overflowY = 'auto';
    outer.clientHeight = 400;
    outer.scrollHeight = 1200;

    // Scroller #1: real Following accounts with full URL + Verified badge
    const scroller1 = doc.createElement('div');
    scroller1.setAttribute('style', 'height:auto;overflow:hidden auto');
    const row1 = doc.createElement('div');
    const a1 = doc.createElement('a');
    a1.setAttribute('href', 'https://www.instagram.com/breakingbadzone/');
    a1.textContent = 'breakingbadzone Verified';
    const svg = doc.createElement('svg');
    svg.setAttribute('aria-label', 'Verified');
    const name1 = doc.createElement('span');
    name1.textContent = 'Breaking Bad Zone';
    const btn1 = doc.createElement('button');
    btn1.textContent = 'Follow';
    row1.append(a1, svg, name1, btn1);
    scroller1.append(row1);
    addUserRow(doc, scroller1, 'scorsesezone', 'Scorsese Zone');

    const suggestedHeading = doc.createElement('span');
    suggestedHeading.textContent = 'Suggested for you';

    // Scroller #2: Suggested strangers + See All Suggestions link
    const scroller2 = doc.createElement('div');
    scroller2.setAttribute('style', 'height:auto;overflow:hidden auto');
    addUserRow(doc, scroller2, 'suggested_stranger_1', 'Stranger One');
    const seeAllSug = doc.createElement('a');
    seeAllSug.setAttribute('href', 'https://www.instagram.com/explore/people/');
    seeAllSug.textContent = 'See All Suggestions';
    scroller2.append(seeAllSug);

    outer.append(scroller1, suggestedHeading, scroller2);
    dlg.append(outer);
    doc.body.append(dlg);

    const extracted = extractDialogUsers(dlg, { excludeUsername: 'fightclubpoint' });
    assert.equal(extracted.hitSuggested, true);
    assert.deepEqual(extracted.users.map((u) => u.username), ['breakingbadzone', 'scorsesezone']);
    assert.equal(extracted.users[0].isVerified, true);
    assert.equal(extracted.users[0].fullName, 'Breaking Bad Zone');
    assert.equal(findDialogLoadMoreButton(dlg), null, 'must ignore See All Suggestions');
  });

  test('2026 Followers dialog: scroll-up-down nudge, See all followers button, and partial cap notice', async () => {
    const doc = installDom();
    const dlg = doc.createElement('div');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-label', 'Followers');

    const capNotice = doc.createElement('span');
    capNotice.textContent = 'Only fightclubpoint can see all followers.';
    const list = doc.createElement('div');
    list.setAttribute('style', 'height:auto;overflow:hidden auto');
    list.clientHeight = 300;
    list.scrollHeight = 900;
    addUserRow(doc, list, 'fan_one', 'Fan One');

    // Track upward scroll nudge to simulate Instagram waking up its lazy loader
    let sawUpwardNudge = false;
    let lastTop = 0;
    list.addEventListener('scroll', () => {
      if (list.scrollTop < lastTop && !sawUpwardNudge) {
        sawUpwardNudge = true;
        addUserRow(doc, list, 'fan_two_after_nudge', 'Fan Two');
      }
      lastTop = list.scrollTop;
    });

    const seeAllBtn = doc.createElement('button');
    seeAllBtn.textContent = 'See all followers';
    let seeAllClicked = false;
    seeAllBtn.click = () => {
      seeAllClicked = true;
      seeAllBtn.remove();
      addUserRow(doc, list, 'fan_three_see_all', 'Fan Three');
    };

    dlg.append(capNotice, list, seeAllBtn);
    doc.body.append(dlg);

    assert.equal(hasFollowerCapNotice(dlg), true);
    const res = await scrollDialogForUsers(makeCtx(doc, '/fightclubpoint/'), dlg, {
      limit: 50,
      excludeUsername: 'fightclubpoint',
    });

    assert.equal(seeAllClicked, true, 'clicks See all followers button');
    assert.equal(sawUpwardNudge, true, 'performs upward nudge on stall to wake lazy loader');
    assert.equal(res.capped, true, 'recognizes partial cap cleanly');
    assert.deepEqual(
      res.rows.map((r) => r.username),
      ['fan_one', 'fan_three_see_all', 'fan_two_after_nudge'],
    );
  });

  test('2026 Post modal: prefers text liked_by link, ignores comment N likes buttons, finds backdrop Close, extracts h3 comments', () => {
    const doc = installDom();

    // Backdrop Close button OUTSIDE dialog #0 (exact 2026 Post modal structure)
    const backdropClose = doc.createElement('div');
    backdropClose.setAttribute('role', 'button');
    const closeSvg = doc.createElement('svg');
    closeSvg.setAttribute('aria-label', 'Close');
    backdropClose.append(closeSvg);
    doc.body.append(backdropClose);

    const postDialog = doc.createElement('div');
    postDialog.setAttribute('role', 'dialog');

    // Comment row with trap "<button>28 likes</button>"
    const ul = doc.createElement('ul');
    const li = doc.createElement('li');
    const h3 = doc.createElement('h3');
    const commentUser = doc.createElement('a');
    commentUser.setAttribute('href', 'https://www.instagram.com/buyer_lead/');
    commentUser.textContent = 'buyer_lead';
    h3.append(commentUser);
    const commentSpan = doc.createElement('span');
    commentSpan.setAttribute('dir', 'auto');
    commentSpan.textContent = 'How much is this jacket?';
    const permLink = doc.createElement('a');
    permLink.setAttribute('href', '/fightclubpoint/p/Dfc2iPGyqto/c/17999999999/');
    const timeEl = doc.createElement('time');
    timeEl.textContent = '18w';
    permLink.append(timeEl);
    const commentLikesTrap = doc.createElement('button');
    commentLikesTrap.textContent = '28 likes';
    const replyBtn = doc.createElement('button');
    replyBtn.textContent = 'Reply';
    li.append(h3, commentSpan, permLink, commentLikesTrap, replyBtn);
    ul.append(li);

    // Heart Like icon (must NEVER be clicked)
    const heartBtn = doc.createElement('div');
    heartBtn.setAttribute('role', 'button');
    const heartSvg = doc.createElement('svg');
    heartSvg.setAttribute('aria-label', 'Like');
    heartBtn.append(heartSvg);

    // Empty avatar liked_by link followed by real text liked_by link
    const avatarLikedBy = doc.createElement('a');
    avatarLikedBy.setAttribute('href', 'https://www.instagram.com/p/Dfc2iPGyqto/liked_by/');
    const textLikedBy = doc.createElement('a');
    textLikedBy.setAttribute('href', 'https://www.instagram.com/p/Dfc2iPGyqto/liked_by/');
    textLikedBy.textContent = '4,397 others';

    postDialog.append(ul, heartBtn, avatarLikedBy, textLikedBy);
    doc.body.append(postDialog);

    assert.equal(findPostLikersTrigger(postDialog), textLikedBy, 'picks text liked_by anchor, ignoring comment likes button and heart');
    assert.equal(findCloseDialogButton(postDialog, doc), backdropClose, 'falls back to document-level Close button for Post modal');

    const comments = extractCommentsFromDom(postDialog);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].username, 'buyer_lead');
    assert.equal(comments[0].text, 'How much is this jacket?');
  });

  test('stealth: live runtime has zero synthetic API client, zero cursor DOM overlay, and neutral host ID', () => {
    const doc = installDom();
    const runtime = createContentRuntime({
      document: doc,
      location: { href: 'https://www.instagram.com/sara/', pathname: '/sara/' },
      cookieString: 'sessionid=abc; ds_user_id=77',
    });
    assert.equal(runtime.request, null, 'live runtime does not create a synthetic x-ig-* API fetch client');
    assert.equal(runtime.virtualCursor, null, 'live runtime does not inject a foreign cursor overlay onto Instagram');
    assert.doesNotMatch(HOST_ID, /crm|bot|scraper|outreach/i, 'light-DOM launcher host ID is neutral');
  });
});
