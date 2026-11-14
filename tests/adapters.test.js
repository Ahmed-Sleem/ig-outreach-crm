import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../scripts/lib/dom-shim.mjs';
import {
  ApiError,
  FRIENDSHIP_PAGE_SIZE,
  I_ORIGIN,
  LEGACY_QUERY_HASHES,
  WWW_ORIGIN,
  buildQuery,
  callGraphql,
  createApi,
  cursorOf,
  fetchComments,
  fetchFriendshipList,
  fetchLikers,
  fetchMediaIdForShortcode,
  fetchProfileById,
  fetchProfileByUsername,
  findNodeWith,
  firstDocId,
  hasMoreOf,
  lookupFollowship,
  normaliseProfile,
  normaliseUserRow,
  parseBody,
  parseCountText,
  rowKeyOf,
  rowsOfEdges,
  rowsOfUserList,
  scrapeGridAuthors,
  scrapeModalUserList,
  scrapeOpenProfile,
  scrapeProfileFromDom,
  spaceRead,
  walkPaged,
} from '../src/content/adapters.js';

/* ------------------------------------------------------------- fake transport */

/** A transport that answers by matching the request URL, and records every call. */
function fakeTransport(routes, { onRequest = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    onRequest?.(url, init);
    for (const [pattern, handler] of routes) {
      if (typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)) {
        const out = typeof handler === 'function' ? handler(url, init, calls.length) : handler;
        return { status: out.status ?? 200, headers: out.headers ?? null, json: async () => out.body };
      }
    }
    return { status: 404, headers: null, json: async () => ({ message: 'unrouted' }) };
  };
  return { fetchImpl, calls };
}

/** A pacer that never delays, and records what it was told. */
function fakePacer() {
  const pacer = { stopped: false, successes: 0, errors: [], nextDelay: () => 0 };
  pacer.noteSuccess = () => { pacer.successes += 1; };
  pacer.noteError = (verdict) => { pacer.errors.push(verdict?.reason ?? verdict); };
  return pacer;
}

function makeCtx(routes, options = {}) {
  const { fetchImpl, calls } = fakeTransport(routes, options);
  const pacer = fakePacer();
  const request = createApi({ fetchImpl, appId: '936619743392459', asbd: '129477', csrfToken: 'csrf-token' });
  const waits = [];
  return { ctx: { request, pacer, wait: async (ms) => { waits.push(ms); } }, calls, pacer, waits };
}

/** One page of a v1 `users: []` response, wrapped the way the transport returns it. */
function userListPage(usernames, { next = null, big = false, status = 200 } = {}) {
  return {
    status,
    body: {
      status: 'ok',
      big_list: big,
      next_max_id: next,
      users: usernames.map((username, index) => ({ pk: String(index + 1), username, full_name: username.toUpperCase(), is_private: false })),
    },
  };
}

describe('response parsing helpers', () => {
  test('parseBody accepts objects and JSON text', () => {
    assert.deepEqual(parseBody({ a: 1 }), { a: 1 });
    assert.deepEqual(parseBody('{"a":1}'), { a: 1 });
    assert.equal(parseBody('not json'), 'not json');
    assert.equal(parseBody(null), null);
  });

  test('cursor and has_more are read from both endpoint families', () => {
    assert.equal(cursorOf({ next_max_id: 'C1' }), 'C1');
    assert.equal(cursorOf({ page_info: { end_cursor: 'C2' } }), 'C2');
    assert.equal(cursorOf({ data: { page_info: { end_cursor: 'C3' } } }), 'C3');
    assert.equal(cursorOf({}), null);
    assert.equal(hasMoreOf({ big_list: true }), true);
    assert.equal(hasMoreOf({ has_more: true }), true);
    assert.equal(hasMoreOf({ page_info: { has_next_page: true } }), true);
    assert.equal(hasMoreOf({ users: [] }), false);
  });

  test('user rows come from users[], items[] and graphql edges', () => {
    assert.equal(rowsOfUserList({ users: [{ username: 'a' }] }).length, 1);
    assert.equal(rowsOfUserList({ items: [{ user: { username: 'a' } }] })[0].username, 'a');
    assert.equal(rowsOfUserList({}).length, 0);
    assert.equal(rowsOfEdges({ data: { user: { edge_follow: { edges: [{ node: { username: 'a' } }] } } } }, 'edge_follow')[0].username, 'a');
    assert.deepEqual(rowsOfEdges({}), []);
  });

  test('buildQuery drops empty parameters', () => {
    assert.equal(buildQuery({ count: 50, max_id: null, query: '' }), '?count=50');
    assert.equal(buildQuery({}), '');
    assert.equal(buildQuery({ query: 'ali dev' }), '?query=ali+dev');
  });

  test('rowKeyOf dedups by username first, then id', () => {
    assert.equal(rowKeyOf({ username: 'Ali' }), rowKeyOf({ username: 'ali' }));
    assert.equal(rowKeyOf({ pk: 5 }), 'i:5');
    assert.equal(rowKeyOf({ code: 'AbC' }), 'i:AbC');
  });

  test('firstDocId never invents a doc id', () => {
    assert.equal(firstDocId(['', null, '123456']), '123456');
    assert.equal(firstDocId([]), null);
  });

  test('findNodeWith digs a named connection out of a nested body', () => {
    const body = { data: { xdt_shortcode_media: { comments: { edges: [] } } } };
    assert.ok(findNodeWith(body, 'comments'));
    assert.equal(findNodeWith(body, 'nothing'), null);
    assert.equal(findNodeWith(null, 'comments'), null);
  });
});

describe('createApi', () => {
  test('sends the ids and the csrf token Instagram expects', async () => {
    const { ctx, calls } = makeCtx([[/anything/, { status: 200, body: { ok: true } }]]);
    const res = await ctx.request(`${WWW_ORIGIN}/anything`);
    assert.equal(res.status, 200);
    const headers = calls[0].init.headers;
    assert.equal(headers['x-ig-app-id'], '936619743392459');
    assert.equal(headers['x-asbd-id'], '129477');
    assert.equal(headers['x-csrftoken'], 'csrf-token');
    assert.equal(calls[0].init.credentials, 'include');
    assert.equal(calls[0].init.method, 'GET');
  });

  test('a POST carries a form body and its own headers win', async () => {
    const { ctx, calls } = makeCtx([[/graphql/, { status: 200, body: {} }]]);
    await ctx.request(`${WWW_ORIGIN}/api/graphql/`, { method: 'POST', body: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-ig-app-id': 'override' } });
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, 'a=1');
    assert.equal(calls[0].init.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(calls[0].init.headers['x-ig-app-id'], 'override');
  });
});

describe('spaceRead', () => {
  test('a 200 is reported to the pacer as success', async () => {
    const { ctx, pacer } = makeCtx([[/ok/, { status: 200, body: { users: [] } }]]);
    const res = await spaceRead(ctx, `${WWW_ORIGIN}/ok`);
    assert.equal(res.verdict.action, 'ok');
    assert.equal(pacer.successes, 1);
  });

  test('a 429 is a backoff, not a stop', async () => {
    const { ctx, pacer } = makeCtx([[/slow/, { status: 429, body: {}, headers: { get: (k) => (k === 'retry-after' ? '7' : null) } }]]);
    const res = await spaceRead(ctx, `${WWW_ORIGIN}/slow`);
    assert.equal(res.verdict.action, 'backoff');
    assert.equal(res.verdict.retryAfterMs, 7000);
    assert.equal(pacer.errors[0], 'http_429');
  });

  test('feedback_required stops the session and tells the pacer why', async () => {
    const { ctx, pacer } = makeCtx([[/flagged/, { status: 200, body: { message: 'feedback_required' } }]]);
    await assert.rejects(() => spaceRead(ctx, `${WWW_ORIGIN}/flagged`), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.severity, 'account');
      assert.equal(error.reason, 'feedback_required');
      assert.match(error.message, /feedback_required/);
      return true;
    });
    assert.equal(pacer.errors[0], 'feedback_required');
  });

  test('challenge_required and checkpoint_required also stop', async () => {
    for (const body of [{ message: 'challenge_required' }, { message: 'checkpoint_required' }, { spam: true }]) {
      const { ctx } = makeCtx([[/x/, { status: 400, body }]]);
      await assert.rejects(() => spaceRead(ctx, `${WWW_ORIGIN}/x`), ApiError);
    }
  });

  test('a stopped pacer refuses to read at all', async () => {
    const { ctx, pacer, calls } = makeCtx([[/never/, { status: 200, body: {} }]]);
    pacer.stopped = true;
    await assert.rejects(() => spaceRead(ctx, `${WWW_ORIGIN}/never`), /already stopped/);
    assert.equal(calls.length, 0);
  });

  test('the pacer delay is spent through the injectable wait', async () => {
    const { fetchImpl } = fakeTransport([[/x/, { status: 200, body: {} }]]);
    const waits = [];
    const ctx = {
      request: createApi({ fetchImpl, appId: '1' }),
      pacer: { stopped: false, nextDelay: () => 4242, noteSuccess() {}, noteError() {} },
      wait: async (ms) => { waits.push(ms); },
    };
    await spaceRead(ctx, `${WWW_ORIGIN}/x`);
    assert.deepEqual(waits, [4242]);
  });
});

describe('walkPaged', () => {
  test('follows next_max_id until the endpoint says it is done', async () => {
    const { ctx, calls } = makeCtx([[/friendships/, (url) => (url.includes('max_id') ? userListPage(['c', 'd']) : userListPage(['a', 'b'], { next: 'C1', big: true }))]]);
    const result = await walkPaged(ctx, { url: `${WWW_ORIGIN}/api/v1/friendships/9/followers/`, pageParams: { count: 50 } });
    assert.equal(result.ok, true);
    assert.equal(result.rows.length, 4);
    assert.equal(result.pages, 2);
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /max_id=C1/);
  });

  test('duplicate usernames across pages are stored once', async () => {
    const { ctx } = makeCtx([[/friendships/, (url) => (url.includes('max_id') ? userListPage(['a', 'x']) : userListPage(['a', 'b'], { next: 'C1', big: true }))]]);
    const result = await walkPaged(ctx, { url: `${WWW_ORIGIN}/api/v1/friendships/9/followers/` });
    assert.deepEqual(result.rows.map((r) => r.username), ['a', 'b', 'x']);
  });

  test('limit stops the walk mid-page and reports why', async () => {
    const { ctx } = makeCtx([[/friendships/, () => userListPage(['a', 'b', 'c', 'd'], { next: 'C1', big: true })]]);
    const result = await walkPaged(ctx, { url: `${WWW_ORIGIN}/api/v1/friendships/9/followers/`, limit: 3 });
    assert.equal(result.rows.length, 3);
    assert.equal(result.stopped, true);
    assert.equal(result.reason, 'limit reached');
  });

  test('a cursor that never advances is refused, not looped', async () => {
    const { ctx, calls } = makeCtx([[/friendships/, () => userListPage(['a'], { next: 'SAME', big: true })]]);
    const result = await walkPaged(ctx, { url: `${WWW_ORIGIN}/api/v1/friendships/9/followers/` });
    assert.equal(result.ok, false);
    assert.match(result.reason, /cursor did not advance/);
    assert.ok(calls.length < 10, `walked away after ${calls.length} calls`);
  });

  test('"continue" with no cursor is refused', async () => {
    const { ctx } = makeCtx([[/friendships/, { body: { users: [{ username: 'a' }], big_list: true } }]]);
    const result = await walkPaged(ctx, { url: `${WWW_ORIGIN}/api/v1/friendships/9/followers/` });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no cursor/);
  });

  test('progress is reported per page', async () => {
    const { ctx } = makeCtx([[/friendships/, (url) => (url.includes('max_id') ? userListPage(['c']) : userListPage(['a', 'b'], { next: 'C1', big: true }))]]);
    const seen = [];
    await walkPaged(ctx, { url: `${WWW_ORIGIN}/api/v1/friendships/9/followers/`, onProgress: (p) => seen.push([p.page, p.total, p.fresh]) });
    assert.deepEqual(seen, [[1, 2, 2], [2, 3, 1]]);
  });

  test('an aborted signal stops before the next request', async () => {
    const signal = { aborted: false };
    const { ctx, calls } = makeCtx([[/friendships/, () => userListPage(['a'], { next: 'C1', big: true })]]);
    const promise = walkPaged(ctx, { url: `${WWW_ORIGIN}/api/v1/friendships/9/followers/`, signal });
    signal.aborted = true;
    const result = await promise;
    assert.equal(result.stopped, true);
    assert.equal(result.reason, 'aborted');
    assert.ok(calls.length <= 1);
  });

  test('repeated 429s give up instead of hammering', async () => {
    const { ctx, calls, waits } = makeCtx([[/friendships/, { status: 429, body: {} }]]);
    const result = await walkPaged(ctx, { url: `${WWW_ORIGIN}/api/v1/friendships/9/followers/`, maxConsecutiveFailures: 3 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /consecutive http_429/);
    assert.equal(calls.length, 3);
    assert.equal(waits.length, 3);
    assert.ok(waits.every((ms) => ms >= 30000), 'backoff must be minutes, not milliseconds');
  });

  test('an explicit Retry-After outranks our own backoff', async () => {
    const { ctx, waits } = makeCtx([[/friendships/, { status: 429, body: {}, headers: { get: () => '90' } }]]);
    await walkPaged(ctx, { url: `${WWW_ORIGIN}/api/v1/friendships/9/followers/`, maxConsecutiveFailures: 1 });
    assert.deepEqual(waits, [90000]);
  });
});

describe('fetchFriendshipList', () => {
  test('tier 1 is the same-origin web endpoint', async () => {
    const { ctx, calls } = makeCtx([[/friendships/, () => userListPage(['a'])]]);
    const result = await fetchFriendshipList(ctx, { userId: '9', path: 'followers' });
    assert.equal(result.ok, true);
    assert.equal(result.strategy, 'v1');
    assert.equal(calls[0].url.startsWith(`${WWW_ORIGIN}/api/v1/friendships/9/followers/`), true);
    assert.match(calls[0].url, /search_surface=follow_list_page/);
  });

  test('page size is the documented default', () => {
    assert.equal(FRIENDSHIP_PAGE_SIZE, 50);
  });

  test('a 400 on tier 1 falls through to the mobile origin', async () => {
    const { ctx, calls } = makeCtx([
      [/^https:\/\/www\.instagram\.com/, { status: 400, body: { message: 'bad' } }],
      [/^https:\/\/i\.instagram\.com/, () => userListPage(['a', 'b'])],
    ]);
    const result = await fetchFriendshipList(ctx, { userId: '9', path: 'following' });
    assert.equal(result.ok, true);
    assert.equal(result.strategy, 'v1-mobile');
    assert.ok(calls.some((c) => c.url.startsWith(I_ORIGIN)));
  });

  test('an empty tier-1 list falls through to legacy graphql, and says so when that is empty too', async () => {
    const { ctx, calls } = makeCtx([
      [/friendships/, { body: { users: [], big_list: false, status: 'ok' } }],
      [/graphql\/query/, { body: { data: { user: { edge_followed_by: { edges: [], page_info: { has_next_page: false } } } } } }],
    ]);
    const result = await fetchFriendshipList(ctx, { userId: '9', path: 'followers' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /graphql/);
    assert.ok(calls.some((c) => c.url.includes(`query_hash=${LEGACY_QUERY_HASHES.followers}`)));
  });

  test('legacy graphql is only a candidate when there is no search query', async () => {
    const { ctx, calls } = makeCtx([[/friendships/, () => userListPage(['a'])]]);
    await fetchFriendshipList(ctx, { userId: '9', path: 'followers', query: 'ali' });
    assert.equal(calls.some((c) => c.url.includes('graphql')), false);
    assert.match(calls[0].url, /query=ali/);
  });

  test('feedback_required on any tier stops the whole read', async () => {
    const { ctx, pacer } = makeCtx([[/friendships/, { body: { message: 'feedback_required' } }]]);
    await assert.rejects(() => fetchFriendshipList(ctx, { userId: '9', path: 'followers' }), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.severity, 'account');
      return true;
    });
    assert.equal(pacer.errors[0], 'feedback_required');
  });

  test('a missing user id is refused before any request', async () => {
    const { ctx, calls } = makeCtx([]);
    const result = await fetchFriendshipList(ctx, { userId: '', path: 'followers' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no user id/);
    assert.equal(calls.length, 0);
  });

  test('an unknown path is refused', async () => {
    const { ctx, calls } = makeCtx([]);
    const result = await fetchFriendshipList(ctx, { userId: '9', path: 'blockers' });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
  });
});

describe('lookupFollowship', () => {
  test('one targeted page answers an accept check', async () => {
    const { ctx, calls } = makeCtx([[/friendships/, () => userListPage(['Ali.Dev', 'other'])]]);
    const result = await lookupFollowship(ctx, { userId: '9', username: 'ali.dev' });
    assert.equal(result.ok, true);
    assert.equal(result.found, true);
    assert.equal(result.user.username, 'Ali.Dev');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /query=ali\.dev/);
  });

  test('not finding the name is an answer, not an error', async () => {
    const { ctx } = makeCtx([[/friendships/, () => userListPage(['other'])]]);
    const result = await lookupFollowship(ctx, { userId: '9', username: 'ali' });
    assert.equal(result.ok, true);
    assert.equal(result.found, false);
    assert.equal(result.user, null);
    assert.match(result.reason, /not in the first page/);
  });

  test('a refused lookup reports the refusal', async () => {
    const { ctx } = makeCtx([[/.*/, { status: 403, body: {} }]]);
    await assert.rejects(() => lookupFollowship(ctx, { userId: '9', username: 'ali' }), ApiError);
  });
});

describe('profiles', () => {
  const webBody = {
    data: {
      user: {
        id: '77', username: 'sara_shop', full_name: 'Sara', biography: 'Cairo', is_private: false,
        is_business_account: true, edge_followed_by: { count: 1200 }, edge_follow: { count: 300 },
        edge_owner_to_timeline_media: { count: 45 }, profile_pic_url_hd: 'https://cdn/pic.jpg',
        external_url: 'https://shop.example', public_email: 'hi@shop.example',
      },
    },
  };

  test('web_profile_info is the first source and is normalised', async () => {
    const { ctx, calls } = makeCtx([[/web_profile_info/, { body: webBody }]]);
    const result = await fetchProfileByUsername(ctx, { username: 'sara_shop' });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'web_profile_info');
    assert.equal(result.user.id, '77');
    assert.equal(result.user.followers, 1200);
    assert.equal(result.user.following, 300);
    assert.equal(result.user.posts, 45);
    assert.equal(result.user.isBusiness, true);
    assert.equal(result.user.publicEmail, 'hi@shop.example');
    assert.match(calls[0].url, /username=sara_shop/);
  });

  test('a refused profile read says so instead of returning an empty account', async () => {
    const { ctx } = makeCtx([[/web_profile_info/, { status: 404, body: { message: 'not found' } }]]);
    const result = await fetchProfileByUsername(ctx, { username: 'ghost' });
    assert.equal(result.ok, false);
    assert.equal(result.user, null);
    assert.match(result.reason, /refused/);
  });

  test('a 200 with no user in the body is still a refusal', async () => {
    const { ctx } = makeCtx([[/web_profile_info/, { body: { data: {} } }]]);
    const result = await fetchProfileByUsername(ctx, { username: 'ghost' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /HTTP 200/);
  });

  test('users/{id}/info is read from the mobile origin', async () => {
    const { ctx, calls } = makeCtx([[/users\/77\/info/, { body: { user: { pk: 77, username: 'sara', follower_count: 12, media_count: 3 } } }]]);
    const result = await fetchProfileById(ctx, { userId: '77' });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'users_info');
    assert.equal(result.user.followers, 12);
    assert.equal(result.user.posts, 3);
    assert.ok(calls[0].url.startsWith(I_ORIGIN));
  });

  test('counts missing from the payload become 0, not NaN', () => {
    const user = normaliseProfile({ username: 'a' });
    assert.equal(user.followers, 0);
    assert.equal(user.following, 0);
    assert.equal(user.posts, 0);
    assert.equal(user.externalUrl, null);
    assert.equal(user.publicPhone, null);
  });

  test('a media shortcode resolves to an id', async () => {
    const { ctx } = makeCtx([[/media\/AbC\/info/, { body: { items: [{ id: '555', taken_at: 1700000000, caption: { text: 'hi' } }] } }]]);
    const result = await fetchMediaIdForShortcode(ctx, { shortcode: 'AbC' });
    assert.equal(result.ok, true);
    assert.equal(result.mediaId, '555');
    assert.equal(result.caption, 'hi');
    assert.ok(result.takenAt > 0);
  });
});

describe('graphql calls', () => {
  test('doc ids are tried in order and a stale one is not retried', async () => {
    const { ctx, calls } = makeCtx([
      [/doc_id=111/, { status: 400, body: { message: 'stale' } }],
      [/doc_id=222/, { body: { data: { ok: true } } }],
    ]);
    const result = await callGraphql(ctx, { docIds: ['111', '222'], variables: { first: 50 } });
    assert.equal(result.ok, true);
    assert.equal(result.docId, '222');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.method, 'POST');
    assert.match(calls[0].init.body, /variables=/);
    assert.equal(calls[0].init.headers['content-type'], 'application/x-www-form-urlencoded');
  });

  test('an account flag on the first doc id stops the chain', async () => {
    const { ctx, calls } = makeCtx([[/doc_id=111/, { body: { message: 'feedback_required' } }]]);
    await assert.rejects(() => callGraphql(ctx, { docIds: ['111', '222'], variables: {} }), ApiError);
    assert.equal(calls.length, 1);
  });

  test('a 429 stops the chain too: waiting will not make a rate limit into data', async () => {
    const { ctx, calls } = makeCtx([[/doc_id=111/, { status: 429, body: {} }]]);
    const result = await callGraphql(ctx, { docIds: ['111', '222'], variables: {} });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
    assert.match(result.reason, /http_429/);
  });

  test('with no doc ids at all the reason is explicit', async () => {
    const { ctx, calls } = makeCtx([]);
    const result = await callGraphql(ctx, { docIds: [], variables: {} });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no doc_id candidates/);
    assert.equal(calls.length, 0);
  });

  test('a legacy query_hash is the last candidate', async () => {
    const { ctx, calls } = makeCtx([
      [/doc_id=111/, { status: 400, body: {} }],
      [/query_hash=abc/, { body: { data: { legacy: true } } }],
    ]);
    const result = await callGraphql(ctx, { docIds: ['111'], variables: {}, queryHash: 'abc' });
    assert.equal(result.ok, true);
    assert.equal(result.queryHash, 'abc');
    assert.equal(calls.length, 2);
  });
});

describe('comments and likers', () => {
  test('comments are refused before any request when no doc id exists', async () => {
    const { ctx, calls } = makeCtx([]);
    const result = await fetchComments(ctx, { mediaId: '555', docIds: [] });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no doc_id candidates/);
    assert.equal(calls.length, 0);
  });

  test('comments without a media id are refused', async () => {
    const { ctx, calls } = makeCtx([]);
    const result = await fetchComments(ctx, { mediaId: '', docIds: ['1'] });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no media id/);
    assert.equal(calls.length, 0);
  });

  test('likers without an id or shortcode are refused', async () => {
    const { ctx, calls } = makeCtx([]);
    const result = await fetchLikers(ctx, { docIds: ['1'] });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
  });

  test('likers are refused when no doc id exists', async () => {
    const { ctx, calls } = makeCtx([]);
    const result = await fetchLikers(ctx, { shortcode: 'AbC', docIds: [] });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no doc_id candidates/);
    assert.equal(calls.length, 0);
  });
});

describe('DOM-only adapters', () => {
  function dialogWith(doc, usernames, { scrollHeight = 900, clientHeight = 300 } = {}) {
    const dialog = doc.createElement('div'); dialog.setAttribute('role', 'dialog');
    const list = doc.createElement('div'); list.setAttribute('style', 'overflow-y: auto;');
    list.scrollHeight = scrollHeight; list.clientHeight = clientHeight;
    for (const username of usernames) {
      const link = doc.createElement('a'); link.setAttribute('href', `/${username}/`);
      const span = doc.createElement('span'); span.textContent = username.toUpperCase();
      link.append(span); list.append(link);
    }
    dialog.append(list); doc.body.append(dialog);
    return list;
  }

  test('reads the rows a dialog renders and stops scrolling when nothing new appears', async () => {
    const doc = installDom();
    const list = dialogWith(doc, ['ali', 'sara', 'omar']);
    const result = await scrapeModalUserList({ wait: async () => {} }, { document: doc, findList: () => list, settleMs: 1 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.rows.map((r) => r.username), ['ali', 'sara', 'omar']);
    assert.ok(result.scrolls <= 4, `stalled after ${result.scrolls} scrolls`);
  });

  test('a limit stops the scrape early', async () => {
    const doc = installDom();
    const list = dialogWith(doc, ['a', 'b', 'c', 'd', 'e']);
    const result = await scrapeModalUserList({ wait: async () => {} }, { document: doc, findList: () => list, limit: 2, settleMs: 1 });
    assert.equal(result.rows.length, 2);
    assert.equal(result.stopped, true);
  });

  test('no open dialog is reported, not guessed at', async () => {
    const doc = installDom();
    const result = await scrapeModalUserList({ wait: async () => {} }, { document: doc, findList: () => null });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no open list dialog/);
  });

  test('an abort signal stops between scrolls', async () => {
    const doc = installDom();
    const list = dialogWith(doc, ['a'], { scrollHeight: 5000, clientHeight: 100 });
    const signal = { aborted: false };
    let scrolls = 0;
    const result = await scrapeModalUserList(
      { wait: async () => { scrolls += 1; if (scrolls > 1) signal.aborted = true; } },
      { document: doc, findList: () => list, settleMs: 1, signal },
    );
    assert.equal(result.reason, 'aborted');
    assert.ok(scrolls <= 3);
  });

  test('a dialog with no account rows says so', async () => {
    const doc = installDom();
    const list = dialogWith(doc, []);
    const result = await scrapeModalUserList({ wait: async () => {} }, { document: doc, findList: () => list, settleMs: 1 });
    assert.equal(result.rows.length, 0);
    assert.match(result.reason, /no account rows/);
  });

  test('grid authors are read one per tile', () => {
    const doc = installDom();
    for (const username of ['brand_eg', 'shop.cairo', 'brand_eg']) {
      const article = doc.createElement('article');
      const link = doc.createElement('a'); link.setAttribute('href', `/${username}/`);
      article.append(link); doc.body.append(article);
    }
    const result = scrapeGridAuthors(doc);
    assert.deepEqual(result.rows.map((r) => r.username), ['brand_eg', 'shop.cairo']);
  });

  test('an empty grid is not an empty lead list', () => {
    const doc = installDom();
    const result = scrapeGridAuthors(doc);
    assert.equal(result.ok, false);
    assert.match(result.reason, /no account tiles/);
  });

  test('the open profile is read from the URL and the DOM', () => {
    const doc = installDom();
    const h1 = doc.createElement('h1'); h1.textContent = 'sara_shop';
    const header = doc.createElement('header'); const section = doc.createElement('section');
    section.textContent = '1,200 Followers 300 Following 45 Posts';
    header.append(section); doc.body.append(h1, header);
    const result = scrapeOpenProfile(doc, { location: { href: 'https://www.instagram.com/sara_shop/?hl=en' } });
    assert.equal(result.ok, true);
    assert.equal(result.user.username, 'sara_shop');
    assert.equal(result.user.followers, 1200);
    assert.equal(result.user.following, 300);
  });

  test('Arabic-Indic counts are parsed', () => {
    assert.equal(parseCountText('١٬٢٠٠'), 1200);
    assert.equal(parseCountText('١٢٫٣ ألف'), 12300);
    assert.equal(parseCountText('۱۲۰۰'), 1200);
    assert.equal(parseCountText('١٬٢٠٠'), 1200);
  });

  test('a DOM scrape with no username element is refused', () => {
    const doc = installDom();
    const result = scrapeProfileFromDom(doc);
    assert.equal(result.ok, false);
    assert.match(result.reason, /no username/);
  });

  test('normaliseUserRow keeps the anonymous-avatar flag scoring depends on', () => {
    const row = normaliseUserRow({ pk: '3', username: 'a', has_anonymous_profile_picture: true, profile_pic_url: 'u' });
    assert.equal(row.hasAnonymousPic, true);
    assert.equal(row.profilePicUrl, 'u');
    assert.equal(row.followers, null);
  });
});
