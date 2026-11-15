import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../scripts/lib/dom-shim.mjs';
import { CommandType } from '../src/storage/bridge.js';
import {
  BUYER_INTENTS,
  CollectSource,
  DOM_ONLY_SOURCES,
  NEEDS_TARGET,
  SOURCE_EDGE_TYPE,
  collectCurrentPage,
  commentToUserRow,
  createContentRuntime,
  createHandlers,
  directUrl,
  profileUrl,
  runCommand,
  syncRelationships,
  threadUrl,
  toLeads,
} from '../src/content/main.js';
import { EdgeType } from '../src/core/scoring.js';

/* ------------------------------------------------------------- fake instagram */

const LOGGED_IN = 'sessionid=abc; csrftoken=tok; ds_user_id=77';

/** A page: profile, hashtag grid, or an open followers dialog. */
function page(kind = 'profile', options = {}) {
  const doc = installDom();
  if (options.dir) doc.dir = options.dir;
  const location = { href: 'https://www.instagram.com/', pathname: '/' };

  if (kind === 'profile') {
    location.href = `https://www.instagram.com/${options.username ?? 'sara_shop'}/`;
    location.pathname = `/${options.username ?? 'sara_shop'}/`;
    const header = doc.createElement('header');
    const section = doc.createElement('section');
    section.textContent = '1,200 Followers 300 Following 45 Posts';
    const follow = doc.createElement('button');
    follow.textContent = options.button ?? 'Follow';
    follow.addEventListener('click', () => {
      follow.textContent = options.settlesTo ?? 'Following';
      options.onFollowClick?.();
    });
    header.append(section, follow);
    const h1 = doc.createElement('h1');
    h1.textContent = options.username ?? 'sara_shop';
    doc.body.append(h1, header);
  }

  if (kind === 'grid') {
    location.href = 'https://www.instagram.com/explore/tags/linen/';
    location.pathname = '/explore/tags/linen/';
    for (const username of options.usernames ?? ['brand_eg', 'shop.cairo']) {
      const article = doc.createElement('article');
      const link = doc.createElement('a');
      link.setAttribute('href', `/${username}/`);
      article.append(link);
      doc.body.append(article);
    }
  }

  if (kind === 'dialog') {
    location.href = 'https://www.instagram.com/direct/inbox/';
    location.pathname = '/direct/inbox/';
    const dialog = doc.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const list = doc.createElement('div');
    list.setAttribute('style', 'overflow-y: auto;');
    list.scrollHeight = 800;
    list.clientHeight = 200;
    for (const username of options.usernames ?? ['ali', 'sara']) {
      const link = doc.createElement('a');
      link.setAttribute('href', `/${username}/`);
      const span = doc.createElement('span');
      span.textContent = username;
      link.append(span);
      list.append(link);
    }
    dialog.append(list);
    if (options.editor !== false) {
      const editor = doc.createElement('div');
      editor.setAttribute('contenteditable', 'true');
      dialog.append(editor);
      const send = doc.createElement('button');
      send.textContent = 'Send';
      send.addEventListener('click', () => {
        const thread = dialog.children[0];
        const bubble = doc.createElement('div');
        bubble.setAttribute('role', 'article');
        bubble.textContent = editor.innerText;
        editor.replaceChildren();
        editor._text = null;
        thread.append(bubble);
        options.onSend?.(bubble.textContent);
      });
      dialog.append(send);
    }
    doc.body.append(dialog);
  }

  if (kind === 'explore') {
    location.href = 'https://www.instagram.com/explore/';
    location.pathname = '/explore/';
  }

  return { doc, location };
}

/** Routes answered by URL substring or regex, recording every call. */
function transport(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [pattern, handler] of routes) {
      if (typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)) {
        const out = typeof handler === 'function' ? handler(url, init, calls) : handler;
        return { status: out.status ?? 200, headers: out.headers ?? null, json: async () => out.body };
      }
    }
    return { status: 404, headers: null, json: async () => ({ message: 'unrouted' }) };
  };
  return { fetchImpl, calls };
}

function runtime(kind = 'profile', options = {}, routes = []) {
  const { doc, location } = page(kind, options);
  const { fetchImpl, calls } = transport(routes);
  const clock = { t: 0 };
  const rt = createContentRuntime({
    document: doc,
    location,
    cookieString: options.cookieString ?? LOGGED_IN,
    appId: '936619743392459',
    asbd: '129477',
    docIds: options.docIds ?? ['doc-1'],
    fetchImpl,
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    wait: async (ms) => { clock.t += ms; },
    getSelection: () => doc.selection,
    viewer: options.viewer ?? null,
    navigate: options.navigate ?? null,
  });
  rt.handlers = createHandlers(rt, { navigate: options.navigate ?? null });
  return { rt, doc, location, calls, clock };
}

const userList = (usernames, extra = {}) => ({
  status: 200,
  body: { status: 'ok', big_list: false, users: usernames.map((username, index) => ({ pk: String(index + 1), username, full_name: username.toUpperCase() })), ...extra },
});

describe('urls and source taxonomy', () => {
  test('profile, thread and direct urls are built for instagram.com only', () => {
    assert.equal(profileUrl('sara_shop'), 'https://www.instagram.com/sara_shop/');
    assert.equal(profileUrl('@sara_shop'), 'https://www.instagram.com/sara_shop/');
    assert.equal(directUrl('sara'), 'https://www.instagram.com/direct/new/sara/');
    assert.equal(threadUrl('123'), 'https://www.instagram.com/direct/t/123/');
  });

  test('every collect source maps to exactly one edge type', () => {
    for (const source of Object.values(CollectSource)) {
      assert.ok(Object.values(EdgeType).includes(SOURCE_EDGE_TYPE[source]), `${source} has no edge type`);
    }
    assert.equal(SOURCE_EDGE_TYPE[CollectSource.FOLLOWERS], EdgeType.FOLLOWED_BY_SOURCE);
    assert.equal(SOURCE_EDGE_TYPE[CollectSource.FOLLOWING], EdgeType.FOLLOWS_SOURCE);
    assert.equal(SOURCE_EDGE_TYPE[CollectSource.POST_LIKERS], EdgeType.LIKED_POST);
    assert.equal(SOURCE_EDGE_TYPE[CollectSource.POST_COMMENTS], EdgeType.COMMENTED_POST);
  });

  test('the sources that need a target are listed, and the DOM-only ones are not', () => {
    assert.ok(NEEDS_TARGET.includes(CollectSource.FOLLOWERS));
    assert.ok(!NEEDS_TARGET.includes(CollectSource.HASHTAG_GRID));
    assert.ok(DOM_ONLY_SOURCES.includes(CollectSource.OPEN_LIST_DIALOG));
    assert.ok(!DOM_ONLY_SOURCES.includes(CollectSource.FOLLOWERS));
  });

  test('buyer intents are the commercial ones only', () => {
    assert.ok(BUYER_INTENTS.includes('price_question'));
    assert.ok(BUYER_INTENTS.includes('purchase_intent'));
    assert.ok(!BUYER_INTENTS.includes('praise_generic'));
    assert.ok(!BUYER_INTENTS.includes('spam'));
  });
});

describe('runtime context', () => {
  test('a profile page reports its account and the rendered relationship', () => {
    const { rt } = runtime('profile', { username: 'sara_shop', button: 'Following' });
    const context = rt.context();
    assert.equal(context.pageUsername, 'sara_shop');
    assert.equal(context.loggedIn, true);
    assert.equal(context.relationship, 'following');
    assert.equal(context.busy, false);
  });

  test('a chrome route reports no account', () => {
    const { rt } = runtime('explore');
    assert.equal(rt.context().pageUsername, null);
    assert.equal(rt.context().relationship, 'unknown');
  });

  test('a logged-out tab says so', () => {
    const { rt } = runtime('profile', { cookieString: 'csrftoken=x' });
    assert.equal(rt.context().loggedIn, false);
  });

  test('one run at a time is enforced by the runtime itself', async () => {
    const { rt } = runtime('grid');
    rt.beginRun('collect:hashtag_grid');
    assert.equal(rt.isBusy(), true);
    assert.throws(() => rt.beginRun('follow'), /already in progress/);
    const stopped = rt.stop('test');
    assert.equal(stopped.stopped, true);
    assert.equal(rt.isBusy(), false);
  });
});

describe('COLLECT_LEADS from the page', () => {
  test('a hashtag grid yields scored leads with provenance edges', async () => {
    const { rt, calls } = runtime('grid', { usernames: ['brand_eg', 'shop.cairo', 'ali_dev'] });
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, { source: CollectSource.HASHTAG_GRID, workspaceId: '77' });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.value.leads.length, 3);
    assert.equal(result.value.edges.length, 3);
    assert.equal(result.value.edges[0].edgeType, EdgeType.PROFILE_CAPTURE);
    assert.equal(result.value.edges[0].leadKey, `77:${result.value.leads[0].username.toLowerCase()}`);
    assert.equal(calls.length, 0, 'a grid scrape must not touch the network');
  });

  test('an open followers dialog is collected without a request', async () => {
    const { rt, calls } = runtime('dialog', { usernames: ['ali', 'sara', 'omar'], editor: false });
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, { source: CollectSource.OPEN_LIST_DIALOG, workspaceId: '77' });
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(result.value.leads.map((lead) => lead.username), ['ali', 'sara', 'omar']);
    assert.equal(calls.length, 0);
  });

  test('CURRENT_PAGE adapts: dialog first, then grid, then the profile itself', async () => {
    const dialog = runtime('dialog', { usernames: ['ali'], editor: false });
    const fromDialog = await runCommand(dialog.rt, CommandType.COLLECT_LEADS, { source: CollectSource.CURRENT_PAGE, workspaceId: '77' });
    assert.equal(fromDialog.value.leads[0].username, 'ali');

    const grid = runtime('grid', { usernames: ['brand_eg'] });
    const fromGrid = await runCommand(grid.rt, CommandType.COLLECT_LEADS, { source: CollectSource.CURRENT_PAGE, workspaceId: '77' });
    assert.equal(fromGrid.value.leads[0].username, 'brand_eg');

    const profile = runtime('profile', { username: 'sara_shop' });
    const fromProfile = await runCommand(profile.rt, CommandType.COLLECT_LEADS, { source: CollectSource.CURRENT_PAGE, workspaceId: '77' });
    assert.equal(fromProfile.ok, true, fromProfile.reason);
    assert.equal(fromProfile.value.leads[0].username, 'sara_shop');
    assert.equal(fromProfile.value.leads[0].followers, 1200);
  });

  test('a page with nothing to collect says so instead of returning zero leads', async () => {
    const { rt } = runtime('explore');
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, { source: CollectSource.CURRENT_PAGE, workspaceId: '77' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /renders no accounts/);
  });

  test('a logged-out tab may still scrape the page but not the api', async () => {
    const grid = runtime('grid', { cookieString: 'csrftoken=x' });
    const fromGrid = await runCommand(grid.rt, CommandType.COLLECT_LEADS, { source: CollectSource.HASHTAG_GRID, workspaceId: '77' });
    assert.equal(fromGrid.ok, true);

    const api = runtime('profile', { cookieString: 'csrftoken=x' });
    const fromApi = await runCommand(api.rt, CommandType.COLLECT_LEADS, { source: CollectSource.FOLLOWERS, workspaceId: '77' });
    assert.equal(fromApi.ok, false);
    assert.match(fromApi.reason, /not logged in/);
  });

  test('an unknown source is refused before anything runs', async () => {
    const { rt, calls } = runtime('grid');
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, { source: 'dm_inbox_of_strangers', workspaceId: '77' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /unknown source/);
    assert.equal(calls.length, 0);
  });
});

describe('COLLECT_LEADS from the api', () => {
  const profileBody = {
    data: {
      user: {
        id: '555',
        username: 'comp_a',
        is_private: false,
        edge_followed_by: { count: 9000 },
        edge_follow: { count: 400 },
      },
    },
  };

  test('followers of a target are collected, scored and given provenance', async () => {
    const { rt, calls } = runtime('profile', { username: 'sara_shop' }, [
      [/web_profile_info/, { body: profileBody }],
      [/friendships\/555\/followers/, () => userList(['ali', 'sara', 'omar'])],
    ]);
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, {
      source: CollectSource.FOLLOWERS,
      targetUsername: 'comp_a',
      workspaceId: '77',
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.value.leads.length, 3);
    assert.equal(result.value.sourceAccount, 'comp_a');
    assert.equal(result.value.target.id, '555');
    assert.equal(result.value.strategy, 'v1');
    assert.equal(result.value.edges[0].edgeType, EdgeType.FOLLOWED_BY_SOURCE);
    assert.equal(result.value.edges[0].sourceAccount, 'comp_a');
    assert.ok(calls.some((call) => call.url.includes('web_profile_info')));
    assert.ok(calls.some((call) => call.url.includes('friendships/555/followers')));
  });

  test('the target profile is read once per run, not once per source', async () => {
    const { rt, calls } = runtime('profile', {}, [
      [/web_profile_info/, { body: profileBody }],
      [/friendships\/555\/followers/, () => userList(['ali'])],
    ]);
    await runCommand(rt, CommandType.COLLECT_LEADS, { source: CollectSource.FOLLOWERS, targetUsername: 'comp_a', workspaceId: '77' });
    await runCommand(rt, CommandType.COLLECT_LEADS, { source: CollectSource.FOLLOWING, targetUsername: 'comp_a', workspaceId: '77' });
    assert.equal(calls.filter((call) => call.url.includes('web_profile_info')).length, 1);
  });

  test('a target with no numeric id is refused with the guidance wording and code, not treated as empty', async () => {
    const { rt } = runtime('profile', {}, [[/web_profile_info/, { body: { data: { user: { username: 'comp_a' } } } }]]);
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, { source: CollectSource.FOLLOWERS, targetUsername: 'comp_a', workspaceId: '77' });
    assert.equal(result.ok, false);
    assert.equal(result.value.code, 'no_numeric_id');
    assert.match(result.reason, /Could not get @comp_a's numeric ID from Instagram/);
  });

  test('a refused list read reports the tiers it tried', async () => {
    const { rt } = runtime('profile', {}, [
      [/web_profile_info/, { body: profileBody }],
      [/friendships/, { status: 400, body: { message: 'nope' } }],
      [/graphql\/query/, { body: { data: { user: { edge_followed_by: { edges: [], page_info: { has_next_page: false } } } } } }],
    ]);
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, { source: CollectSource.FOLLOWERS, targetUsername: 'comp_a', workspaceId: '77' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /v1/);
    assert.match(result.reason, /graphql/);
  });

  test('feedback_required is an account-level stop, not a failed collection', async () => {
    const { rt } = runtime('profile', {}, [
      [/web_profile_info/, { body: profileBody }],
      [/friendships/, { body: { message: 'feedback_required' } }],
    ]);
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, { source: CollectSource.FOLLOWERS, targetUsername: 'comp_a', workspaceId: '77' });
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'account');
    assert.match(result.reason, /feedback_required/);
    assert.equal(rt.isBusy(), false, 'a stopped run must release the tab');
  });

  test('likers need a shortcode resolved to a media id first', async () => {
    const { rt, calls } = runtime('profile', {}, [
      [/web_profile_info/, { body: profileBody }],
      [/media\/AbC\/info/, { body: { items: [{ id: '999', caption: { text: 'linen dress' } }] } }],
      [/api\/graphql/, { body: { data: { likes: { edges: [{ node: { username: 'ali', pk: '1' } }], page_info: { has_next_page: false } } } } }],
    ]);
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, {
      source: CollectSource.POST_LIKERS,
      targetUsername: 'comp_a',
      shortcode: 'AbC',
      workspaceId: '77',
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.value.leads[0].username, 'ali');
    assert.equal(result.value.edges[0].edgeType, EdgeType.LIKED_POST);
    assert.equal(result.value.edges[0].refId, 'AbC');
    assert.ok(calls.some((call) => call.url.includes('media/AbC/info')));
  });

  test('likers without a shortcode are refused', async () => {
    const { rt } = runtime('profile', {}, [[/web_profile_info/, { body: profileBody }]]);
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, { source: CollectSource.POST_LIKERS, targetUsername: 'comp_a', workspaceId: '77' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no shortcode/);
  });

  test('comments carry their text onto the edge and their intent onto the lead', async () => {
    const { rt } = runtime('profile', {}, [
      [/web_profile_info/, { body: profileBody }],
      [/media\/AbC\/info/, { body: { items: [{ id: '999' }] } }],
      [/api\/graphql/, {
        body: {
          data: {
            comments: {
              edges: [
                { node: { id: 'c1', text: 'How much is the price please?', owner: { username: 'buyer_one', id: '11' } } },
                { node: { id: 'c2', text: 'So beautiful, great work!', owner: { username: 'fan_two', id: '12' } } },
              ],
              page_info: { has_next_page: false },
            },
          },
        },
      }],
    ]);
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, {
      source: CollectSource.POST_COMMENTS,
      targetUsername: 'comp_a',
      shortcode: 'AbC',
      workspaceId: '77',
    });
    assert.equal(result.ok, true, result.reason);
    const buyer = result.value.leads.find((lead) => lead.username === 'buyer_one');
    const fan = result.value.leads.find((lead) => lead.username === 'fan_two');
    assert.equal(buyer.hasBuyerIntent, true);
    assert.equal(buyer.intentLabel, 'price_question');
    assert.ok(buyer.priorityScore > fan.priorityScore, 'a buyer-intent comment must outrank praise');
    assert.equal(fan.hasBuyerIntent, false);
    assert.equal(result.value.edges.find((edge) => edge.leadKey.endsWith('buyer_one')).sample, 'How much is the price please?');
  });

  test('comments without a harvested doc id are refused, not faked', async () => {
    const { rt } = runtime('profile', { docIds: [] }, [
      [/web_profile_info/, { body: profileBody }],
      [/media\/AbC\/info/, { body: { items: [{ id: '999' }] } }],
    ]);
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, {
      source: CollectSource.POST_COMMENTS,
      targetUsername: 'comp_a',
      shortcode: 'AbC',
      workspaceId: '77',
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /doc_id/);
  });
});

describe('toLeads', () => {
  test('the same person collected twice becomes one lead with two edges', () => {
    const built = toLeads({
      rows: [{ username: 'ali', pk: '1' }, { username: 'ALI', pk: '1' }],
      source: CollectSource.POST_LIKERS,
      sourceAccount: 'comp_a',
      workspaceId: '77',
    });
    assert.equal(built.leads.length, 1);
    assert.equal(built.leads[0].edges.length, 2);
    assert.equal(built.leads[0].lead.edgeCount, 2);
  });

  test('rows without a username are dropped', () => {
    const built = toLeads({ rows: [{}, null, { username: 'ali' }], source: CollectSource.FOLLOWERS, sourceAccount: 'c', workspaceId: '1' });
    assert.equal(built.leads.length, 1);
  });

  test('leadKey is workspace-scoped and lowercased', () => {
    const built = toLeads({ rows: [{ username: 'Ali.Dev' }], source: CollectSource.FOLLOWERS, sourceAccount: 'c', workspaceId: '77' });
    assert.equal(built.edges[0].leadKey, '77:alidev');
  });

  test('ranking is by score then username, unless the order is the point', () => {
    const rows = [{ username: 'zzz', pk: '1' }, { username: 'aaa', pk: '2' }];
    const ranked = toLeads({ rows, source: CollectSource.FOLLOWERS, sourceAccount: 'c', workspaceId: '1' });
    assert.deepEqual(ranked.leads.map((entry) => entry.lead.username), ['aaa', 'zzz']);
    const kept = toLeads({ rows, source: CollectSource.OPEN_LIST_DIALOG, sourceAccount: 'c', workspaceId: '1', keepOrder: true });
    assert.deepEqual(kept.leads.map((entry) => entry.lead.username), ['zzz', 'aaa']);
  });

  test('comment samples are capped so one lead cannot carry a whole thread', () => {
    const rows = [{ username: 'ali' }];
    const comments = Array.from({ length: 12 }, (_unused, index) => ({ username: 'ali', text: `comment ${index}`, id: `c${index}`, likes: index }));
    const built = toLeads({ rows, source: CollectSource.POST_COMMENTS, sourceAccount: 'c', workspaceId: '1', commentTexts: comments });
    assert.equal(built.edges[0].commentSamples.length, 5);
    assert.equal(built.edges[0].commentSamples[0].text, 'comment 0');
    assert.equal(built.leads[0].lead.edgeCount, 1, 'one person, one edge per source');
  });

  test('a comment row becomes a person row with its text alongside', () => {
    const row = commentToUserRow({ id: 'c1', text: 'price?', username: 'ali', ownerName: 'Ali', ownerId: '9', likes: 2, createdAt: 5 });
    assert.equal(row.username, 'ali');
    assert.equal(row.commentText, 'price?');
    assert.equal(row.pk, '9');
  });
});

describe('SYNC_RELATIONSHIPS', () => {
  const target = { data: { user: { id: '555', username: 'comp_a', edge_follow: { count: 3 } } } };

  test('mutual needs both directions, and a one-way follow is not mutual', async () => {
    const { rt, calls } = runtime('profile', { username: 'comp_a' }, [
      [/web_profile_info/, { body: target }],
      // Their following: ali, sara, omar.
      [/friendships\/555\/following/, () => userList(['ali', 'sara', 'omar'])],
      // My followers: ALI (different case, same person) and nada.
      [/friendships\/77\/followers/, () => userList(['ALI', 'nada'])],
      // My following: ali and sara.
      [/friendships\/77\/following\//, () => userList(['ali', 'sara'])],
    ]);
    const result = await runCommand(rt, CommandType.SYNC_RELATIONSHIPS, {
      targetUsername: 'comp_a',
      viewerId: '77',
      workspaceId: '77',
    });
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(result.value.counts, {
      theirFollowing: 3,
      myFollowers: 2,
      myFollowing: 2,
      mutual: 1,
      followsMe: 1,
      iFollowThem: 1,
    });
    // ali: they follow me and I follow them, matched across the case difference.
    const ali = result.value.rows.find((row) => row.username === 'ali');
    assert.equal(ali.relationship, 'mutual');
    assert.equal(ali.mutual, true);
    assert.equal(ali.followsMe, true);
    assert.equal(ali.relState, 'MUTUAL');
    // sara: I follow them, they do not follow me. Not the same fact as mutual.
    const sara = result.value.rows.find((row) => row.username === 'sara');
    assert.equal(sara.relationship, 'i_follow_them');
    assert.equal(sara.mutual, false);
    assert.equal(sara.followsMe, false);
    // omar: no relationship with me at all, so no lead and no row.
    assert.equal(result.value.rows.some((row) => row.username === 'omar'), false);
    assert.equal(calls.filter((call) => call.url.includes('/77/followers')).length, 1, 'phase two must actually run');
    assert.equal(calls.filter((call) => call.url.includes('/77/following')).length, 1, 'phase three must actually run');
  });

  test('someone the viewer already follows is mutual', async () => {
    const { rt } = runtime('profile', { username: 'comp_a' }, [
      [/web_profile_info/, { body: target }],
      [/friendships\/555\/following/, () => userList(['ali', 'sara'])],
      [/friendships\/77\/followers/, () => userList(['ali', 'sara'])],
      [/friendships\/77\/following\//, () => userList(['ali', 'sara'])],
    ]);
    const result = await runCommand(rt, CommandType.SYNC_RELATIONSHIPS, {
      targetUsername: 'comp_a',
      viewerId: '77',
      suspects: ['ali'],
      workspaceId: '77',
    });
    // Three suspects or fewer uses targeted lookups, so the full list is not read.
    assert.equal(result.value.strategy, 'targeted');
    const ali = result.value.rows.find((row) => row.username === 'ali');
    assert.equal(ali.relationship, 'mutual');
    assert.equal(ali.relState, 'MUTUAL');
  });

  test('targeted lookups replace a fifty-page re-read for a few suspects', async () => {
    const { rt, calls } = runtime('profile', { username: 'comp_a' }, [
      [/web_profile_info/, { body: target }],
      [/friendships\/555\/following/, () => userList(['ali', 'sara'])],
      [/friendships\/77\/followers/, (url) => userList(url.includes('query=ali') ? ['ali'] : [])],
      [/friendships\/77\/following\//, () => userList(['ali'])],
    ]);
    const result = await runCommand(rt, CommandType.SYNC_RELATIONSHIPS, {
      targetUsername: 'comp_a',
      viewerId: '77',
      suspects: ['ali'],
      workspaceId: '77',
    });
    assert.equal(result.value.plan.strategy, 'targeted');
    assert.ok(calls.some((call) => call.url.includes('query=ali')));
    assert.ok(!calls.some((call) => /\/77\/followers\/\?count=50&search_surface/.test(call.url) && !call.url.includes('query=')));
    assert.equal(result.ok, true, result.reason);
  });

  test('a viewer id the dashboard did not send is probed, not guessed', async () => {
    const { rt } = runtime('profile', { username: 'comp_a' }, [
      // The viewer probe asks for `?username=me`; the target read asks for comp_a.
      [/web_profile_info\/\?username=me/, { body: { data: { user: { id: '77', username: 'me', edge_followed_by: { count: 12 }, edge_follow: { count: 4 } } } } }],
      [/web_profile_info\/\?username=comp_a/, { body: target }],
      [/friendships\/555\/following/, () => userList(['ali'])],
      [/friendships\/77\/followers/, () => userList(['ali'])],
      [/friendships\/77\/following\//, () => userList(['ali'])],
    ]);
    const result = await runCommand(rt, CommandType.SYNC_RELATIONSHIPS, { targetUsername: 'comp_a' });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.value.viewerId, '77');
    assert.equal(result.value.rows[0].relationship, 'mutual');
  });

  test('a viewer who follows nobody syncs instead of failing on empty lists', async () => {
    const { rt } = runtime('profile', { username: 'comp_a' }, [
      [/web_profile_info\/\?username=me/, { body: { data: { user: { id: '77', username: 'me', edge_followed_by: { count: 0 }, edge_follow: { count: 0 } } } } }],
      [/web_profile_info\/\?username=comp_a/, { body: target }],
      [/friendships\/555\/following/, () => userList(['ali', 'sara'])],
      [/friendships\/77\/followers/, () => userList([])],
      [/friendships\/77\/following\//, () => userList([])],
    ]);
    const result = await runCommand(rt, CommandType.SYNC_RELATIONSHIPS, { targetUsername: 'comp_a' });
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(result.value.counts, { theirFollowing: 2, myFollowers: 0, myFollowing: 0, mutual: 0, followsMe: 0, iFollowThem: 0 });
    assert.equal(result.value.rows.length, 0, 'nobody has a relationship with a brand-new account');
  });

  test('an empty list the profile count contradicts is still refused', async () => {
    const { rt } = runtime('profile', { username: 'comp_a' }, [
      [/web_profile_info\/\?username=me/, { body: { data: { user: { id: '77', username: 'me', edge_followed_by: { count: 800 } } } } }],
      [/web_profile_info\/\?username=comp_a/, { body: target }],
      [/friendships\/555\/following/, () => userList(['ali'])],
      // 800 followers claimed, zero rows returned: that is a blocked read.
      [/friendships\/77\/followers/, () => userList([])],
      [/friendships\/77\/following\//, () => userList([])],
    ]);
    const result = await runCommand(rt, CommandType.SYNC_RELATIONSHIPS, { targetUsername: 'comp_a' });
    assert.equal(result.ok, false);
    assert.equal(result.value.phase, 'my-followers');
  });

  test('logged out, the sync refuses rather than reading a list it cannot', async () => {
    const { rt } = runtime('profile', { username: 'comp_a', cookieString: 'csrftoken=tok' }, [[/web_profile_info/, { body: target }]]);
    const result = await runCommand(rt, CommandType.SYNC_RELATIONSHIPS, { targetUsername: 'comp_a' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not logged in to Instagram/);
    assert.equal(rt.isBusy(), false, 'a refusal must still release the tab');
  });

  test('a failed phase two is reported as phase two', async () => {
    const { rt } = runtime('profile', { username: 'comp_a' }, [
      [/web_profile_info/, { body: target }],
      [/friendships\/555\/following/, () => userList(['ali'])],
      [/friendships\/77\/followers/, { status: 403, body: {} }],
    ]);
    const result = await runCommand(rt, CommandType.SYNC_RELATIONSHIPS, { targetUsername: 'comp_a', viewerId: '77' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /your follower list/);
    assert.equal(result.value.phase, 'my-followers');
    assert.equal(result.value.severity, 'blocked');
  });

  test('the sync result carries leads ready to upsert', async () => {
    const { rt } = runtime('profile', { username: 'comp_a' }, [
      [/web_profile_info/, { body: target }],
      [/friendships\/555\/following/, () => userList(['ali'])],
      [/friendships\/77\/followers/, () => userList(['ali'])],
      [/friendships\/77\/following\//, () => userList(['ali'])],
    ]);
    const result = await runCommand(rt, CommandType.SYNC_RELATIONSHIPS, { targetUsername: 'comp_a', viewerId: '77', workspaceId: '77' });
    assert.equal(result.value.leads.length, 1);
    assert.equal(result.value.leads[0].lead.username, 'ali');
    assert.equal(result.value.edges[0].edgeType, EdgeType.FOLLOWS_SOURCE);
  });
});

describe('actions through the router', () => {
  test('follow on the right page settles and is reported done', async () => {
    const { rt } = runtime('profile', { username: 'sara_shop', button: 'Follow', settlesTo: 'Following' });
    const result = await runCommand(rt, CommandType.EXECUTE_FOLLOW, { username: 'sara_shop' });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.value.state, 'following');
    assert.equal(result.value.stateAfter, 'following');
    assert.equal(rt.isBusy(), false);
  });

  test('follow on the wrong page asks for navigation instead of clicking blindly', async () => {
    const { rt } = runtime('profile', { username: 'sara_shop', button: 'Follow' });
    const result = await runCommand(rt, CommandType.EXECUTE_FOLLOW, { username: 'someone_else' });
    assert.equal(result.ok, false);
    assert.equal(result.value.needsNavigation, true);
    assert.equal(result.value.url, 'https://www.instagram.com/someone_else/');
  });

  test('a navigate function is used when the dashboard supplies one', async () => {
    const navigated = [];
    const { rt, location, doc } = runtime('profile', { username: 'sara_shop', button: 'Follow', settlesTo: 'Following' }, []);
    const navigate = async (url) => {
      navigated.push(url);
      // The dashboard moves the tab; the content script sees the new location.
      location.pathname = '/someone_else/';
      location.href = url;
      const header = doc.querySelector('header');
      header.children[1].textContent = 'Follow';
    };
    rt.handlers = createHandlers(rt, { navigate });
    const result = await runCommand(rt, CommandType.EXECUTE_FOLLOW, { username: 'someone_else' });
    assert.equal(result.ok, true, JSON.stringify(result.value));
    assert.deepEqual(navigated, ['https://www.instagram.com/someone_else/']);
  });

  test('unfollow runs the confirm sequence and releases the tab', async () => {
    const { rt, doc } = runtime('profile', { username: 'sara_shop', button: 'Following' });
    const followButton = doc.querySelector('header').children[1];
    followButton.addEventListener('click', () => {
      const dialog = doc.createElement('div');
      dialog.setAttribute('role', 'dialog');
      const confirm = doc.createElement('button');
      confirm.textContent = 'Unfollow';
      confirm.addEventListener('click', () => {
        followButton.textContent = 'Follow';
        doc.body.children = doc.body.children.filter((child) => child !== dialog);
      });
      dialog.append(confirm);
      doc.body.append(dialog);
    });
    const result = await runCommand(rt, CommandType.EXECUTE_UNFOLLOW, { username: 'sara_shop' });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.value.stateAfter, 'none');
    assert.equal(rt.isBusy(), false);
  });

  test('an empty message is refused before the tab is touched', async () => {
    const { rt } = runtime('dialog', { usernames: [], editor: true });
    const result = await runCommand(rt, CommandType.EXECUTE_DM, { message: '   ' });
    assert.equal(result.ok, false);
    assert.equal(result.value.outcome, 'refused');
    assert.match(result.reason, /empty/);
  });

  test('a dm into an open thread is composed, sent and verified', async () => {
    const sent = [];
    const { rt } = runtime('dialog', { usernames: [], editor: true, onSend: (text) => sent.push(text) });
    const result = await runCommand(rt, CommandType.EXECUTE_DM, {
      message: 'Hi Sara, I found you through the linen hashtag.',
      username: null,
    });
    assert.equal(result.ok, true, JSON.stringify(result.value));
    assert.equal(result.value.bytes > 20, true);
    assert.equal(sent.length, 1);
    assert.equal(rt.isBusy(), false);
  });

  test('an arabic message is delivered intact', async () => {
    const sent = [];
    const { rt } = runtime('dialog', { usernames: [], editor: true, dir: 'rtl', onSend: (text) => sent.push(text) });
    const message = 'مرحبًا سارة، وصلتني طلبية القماش اليوم وشكرًا لك';
    const result = await runCommand(rt, CommandType.EXECUTE_DM, { message });
    assert.equal(result.ok, true, JSON.stringify(result.value));
    assert.equal(sent[0].includes('مرحبًا سارة'), true);
    assert.equal(result.value.rtl, true);
  });

  test('OPEN_THREAD reports needsNavigation when the profile has no Message button', async () => {
    const { rt } = runtime('profile', { username: 'sara_shop', button: 'Follow' });
    const result = await runCommand(rt, CommandType.OPEN_THREAD, { username: 'sara_shop' });
    assert.equal(result.ok, false);
    assert.equal(result.value.needsNavigation, true);
  });

  test('OPEN_THREAD navigates to /direct/new/ when it can', async () => {
    const navigated = [];
    const { rt, doc } = runtime('profile', { username: 'sara_shop', button: 'Follow' });
    const navigate = async (url) => {
      navigated.push(url);
      const dialog = doc.createElement('div');
      dialog.setAttribute('role', 'dialog');
      const editor = doc.createElement('div');
      editor.setAttribute('contenteditable', 'true');
      dialog.append(editor);
      doc.body.append(dialog);
    };
    rt.handlers = createHandlers(rt, { navigate });
    const result = await runCommand(rt, CommandType.OPEN_THREAD, { username: 'sara_shop' });
    assert.equal(result.ok, true, JSON.stringify(result.value));
    assert.equal(result.value.via, 'navigation');
    assert.equal(result.value.composerFound, true);
    assert.deepEqual(navigated, ['https://www.instagram.com/direct/new/sara_shop/']);
    // A DOM node cannot cross the storage bridge, so it must never be returned.
    assert.equal(result.value.editor, undefined);
    assert.doesNotThrow(() => JSON.stringify(result.value));
  });
});

describe('stop and error classification', () => {
  test('PING and GET_CONTEXT answer without a run', async () => {
    const { rt } = runtime('profile', { username: 'sara_shop' });
    const ping = await runCommand(rt, CommandType.PING);
    assert.equal(ping.ok, true);
    assert.equal(ping.value.pong, true);
    assert.equal(ping.value.pageUsername, 'sara_shop');
    const context = await runCommand(rt, CommandType.GET_CONTEXT);
    assert.equal(context.value.loggedIn, true);
    assert.equal(rt.isBusy(), false);
  });

  test('an unknown command is answered, not thrown', async () => {
    const { rt } = runtime('profile');
    const result = await runCommand(rt, 'DELETE_ALL_LEADS');
    assert.equal(result.ok, false);
    assert.match(result.reason, /cannot handle/);
  });

  test('STOP ends a run in flight and reports what it stopped', async () => {
    const { rt } = runtime('grid', { usernames: ['a', 'b'] });
    rt.beginRun('collect:hashtag_grid');
    assert.equal(rt.isBusy(), true);
    const result = await runCommand(rt, CommandType.STOP, { reason: 'owner pressed stop' });
    assert.equal(result.ok, true);
    assert.equal(result.value.stopped, true);
    assert.equal(result.value.kind, 'collect:hashtag_grid');
    assert.equal(rt.isBusy(), false);
  });

  test('STOP with nothing running is still answered', async () => {
    const { rt } = runtime('grid');
    const result = await runCommand(rt, CommandType.STOP);
    assert.equal(result.ok, true);
    assert.equal(result.value.stopped, false);
  });

  test('a broken handler is reported with its error name, never thrown', async () => {
    const { rt } = runtime('profile');
    rt.handlers = { [CommandType.PING]: async () => { throw new TypeError('boom'); } };
    const result = await runCommand(rt, CommandType.PING);
    assert.equal(result.ok, false);
    assert.match(result.reason, /TypeError: boom/);
    assert.equal(result.severity, 'unknown');
  });

  test('a userFacing error keeps its own message for the owner', async () => {
    const { rt } = runtime('profile');
    class PacingStopped extends Error {
      constructor() { super('Scan stopped by user.'); this.name = 'PacingStopped'; this.userFacing = true; }
    }
    rt.handlers = { [CommandType.PING]: async () => { throw new PacingStopped(); } };
    const result = await runCommand(rt, CommandType.PING);
    assert.equal(result.reason, 'Scan stopped by user.');
    assert.equal(result.severity, 'stopped');
  });

  test('a second run in the same tab is refused while one is in flight', async () => {
    const { rt } = runtime('grid', { usernames: ['a'] });
    rt.beginRun('collect:hashtag_grid');
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, { source: CollectSource.HASHTAG_GRID, workspaceId: '77' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /already in progress/);
    rt.stop();
  });

  test('PROBE reports the live capability picture', async () => {
    const { rt } = runtime('profile', { username: 'sara_shop' }, [
      [/web_profile_info/, { body: { data: { user: { id: '77', username: 'me', edge_followed_by: { count: 10 }, edge_follow: { count: 5 } } } } }],
    ]);
    const result = await runCommand(rt, CommandType.PROBE);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.value.session.loggedIn, true);
    assert.equal(result.value.appId, '936619743392459');
    assert.equal(result.value.viewer.username, 'me');
    assert.equal(result.value.paths.internal_api.available, true);
    assert.ok(result.value.caveat.length > 20);
  });
});

describe('collect sources after the audit fixes', () => {
  const likersBody = { data: { likes: { edges: [{ node: { pk: '1', username: 'liker_a', full_name: 'A' } }, { node: { pk: '2', username: 'liker_b', full_name: 'B' } }], page_info: { has_next_page: false } } } };
  const mediaInfo = (id) => ({ body: { items: [{ id, taken_at: 1700000000, caption: { text: 'hi' } }] } });
  const profileWithPosts = { data: { user: { id: '77', username: 'sara_shop', full_name: 'Sara', edge_followed_by: { count: 10 }, edge_follow: { count: 5 }, edge_owner_to_timeline_media: { count: 2, edges: [{ node: { id: '111', shortcode: 'AAA' } }, { node: { id: '222', shortcode: 'BBB' } }] } } } };
  const privateProfile = { data: { user: { id: '88', username: 'priv_account', is_private: true, edge_followed_by: { count: 0 }, edge_owner_to_timeline_media: { count: 0, edges: [] } } } };

  test('a post source works from a shortcode alone, with no profile read (F3)', async () => {
    const { rt, calls } = runtime('explore', {}, [[/media\/AbC\/info/, mediaInfo('555')], [/graphql/, { body: likersBody }]]);
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, { source: CollectSource.POST_LIKERS, shortcode: 'AbC', workspaceId: '77' });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.value.leads.length, 2);
    assert.equal(result.value.sourceAccount, 'post/AbC');
    assert.ok(!calls.some((c) => /web_profile_info/.test(c.url)), 'a post source must not read a profile');
  });

  test('recent likers come from the profile payload media ids, not a guessed shortcode (F4)', async () => {
    const { rt, calls } = runtime('profile', { username: 'sara_shop' }, [[/web_profile_info/, { body: profileWithPosts }], [/graphql/, { body: likersBody }]]);
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, { source: CollectSource.PROFILE_RECENT_LIKERS, targetUsername: 'sara_shop', workspaceId: '77', limit: 20 });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.value.leads.length, 2);
    assert.equal(result.value.sourceAccount, 'sara_shop');
    assert.ok(calls.every((c) => !/\/media\//.test(c.url)), 'the media id came with the profile, so no shortcode lookup was needed');
  });

  test('a profile with no readable recent posts says so honestly (F4)', async () => {
    const { rt } = runtime('profile', { username: 'priv_account' }, [[/web_profile_info/, { body: privateProfile }]]);
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, { source: CollectSource.PROFILE_RECENT_LIKERS, targetUsername: 'priv_account', workspaceId: '77' });
    assert.equal(result.ok, false);
    assert.equal(result.value.code, 'no_recent_posts');
    assert.match(result.value.reason, /no readable recent posts/);
  });

  test('a hashtag collect navigates to the tag instead of scraping whatever is open (F6)', async () => {
    const { rt } = runtime('explore');
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, { source: CollectSource.HASHTAG_GRID, tag: 'linen', workspaceId: '77' });
    assert.equal(result.ok, false);
    assert.equal(result.value.needsNavigation, true);
    assert.equal(result.value.url, 'https://www.instagram.com/explore/tags/linen/');
    assert.match(result.value.reason, /Opening #linen/);
  });

  test('a hashtag collect on the tag page scrapes it and touches no network (F6)', async () => {
    const { rt, calls } = runtime('grid', { usernames: ['brand_eg', 'shop.cairo'] });
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, { source: CollectSource.HASHTAG_GRID, tag: 'linen', workspaceId: '77' });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.value.leads.length, 2);
    assert.equal(result.value.sourceAccount, '#linen');
    assert.equal(calls.length, 0);
  });

  test('resolveTarget falls back to fetchProfileById when userId is known and username read fails (F10)', async () => {
    const { rt, calls } = runtime('explore', {}, [
      [/web_profile_info/, { status: 404, body: { message: 'not found' } }],
      [/users\/555\/info/, { body: { user: { pk: '555', username: 'comp_a', full_name: 'Comp A', follower_count: 100, following_count: 20 } } }],
      [/friendships\/555\/followers/, { body: { users: [{ pk: '1', username: 'ali', full_name: 'Ali' }], next_max_id: null } }],
    ]);
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, {
      source: CollectSource.FOLLOWERS,
      targetUsername: 'comp_a',
      targetUserId: '555',
      workspaceId: '77',
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.value.leads.length, 1);
    assert.equal(result.value.leads[0].username, 'ali');
    assert.ok(calls.some((c) => /users\/555\/info/.test(c.url)), 'the by-id fallback must call users/{id}/info');
  });

  test('a 404 on an open profile page is not masked by an empty-id DOM scrape (F5)', async () => {
    const { rt } = runtime('profile', { username: 'comp_a' }, [
      [/web_profile_info/, { status: 404, body: { message: 'not found' } }],
    ]);
    const result = await runCommand(rt, CommandType.COLLECT_LEADS, {
      source: CollectSource.FOLLOWERS,
      targetUsername: 'comp_a',
      workspaceId: '77',
    });
    assert.equal(result.ok, false);
    assert.equal(result.value.code, 'not_found', 'must preserve not_found rather than turning it into no_numeric_id');
    assert.match(result.reason, /http_404/);
  });

  test('syncRelationships reports no_numeric_id with the guidance wording when ID is unavailable (F5)', async () => {
    const { rt } = runtime('profile', { username: 'comp_a' }, [
      [/web_profile_info/, { body: { data: { user: { username: 'comp_a' } } } }],
    ]);
    const result = await syncRelationships(rt, { targetUsername: 'comp_a', viewerId: '99' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'no_numeric_id');
    assert.match(result.reason, /Could not get @comp_a's numeric ID from Instagram/);
  });
});
