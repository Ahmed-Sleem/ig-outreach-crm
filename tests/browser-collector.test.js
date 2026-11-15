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
} from '../src/content/browser-collector.js';
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
});
