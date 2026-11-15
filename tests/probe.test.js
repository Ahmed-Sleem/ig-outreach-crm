import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../scripts/lib/dom-shim.mjs';
import {
  APP_ID_CANDIDATES,
  ASBD_CANDIDATES,
  Path,
  detectAppId,
  detectAsbd,
  detectPageTokens,
  detectSession,
  detectViewerFromDom,
  findEmbeddedJson,
  harvestDocIds,
  probeDom,
  probeViewer,
  readCookies,
  runProbe,
} from '../src/content/probe.js';

function pageWithScripts(texts) {
  const doc = installDom();
  for (const text of texts) {
    const script = doc.createElement('script');
    script.textContent = text;
    doc.body.append(script);
  }
  return doc;
}

const LOGGED_IN = 'sessionid=abc%3D%3D; csrftoken=Tok123; ds_user_id=77; asbd=129477';
const LOGGED_OUT = 'csrftoken=Tok123';

describe('cookie reading', () => {
  test('values containing = survive intact', () => {
    const cookies = readCookies(LOGGED_IN);
    assert.equal(cookies.sessionid, 'abc==');
    assert.equal(cookies.csrftoken, 'Tok123');
    assert.equal(cookies.ds_user_id, '77');
    assert.equal(cookies.asbd, '129477');
  });

  test('an empty or malformed cookie string yields no session', () => {
    assert.deepEqual(readCookies(''), {});
    assert.deepEqual(readCookies(null), {});
    // A pair with no key is dropped rather than stored under ''.
    assert.deepEqual(readCookies('nonsense; ; =x'), {});
  });

  test('a logged-in session is detected from sessionid or ds_user_id', () => {
    assert.equal(detectSession(LOGGED_IN).loggedIn, true);
    assert.equal(detectSession('ds_user_id=77').loggedIn, true);
    assert.equal(detectSession(LOGGED_OUT).loggedIn, false);
    assert.equal(detectSession('').loggedIn, false);
    assert.equal(detectSession(LOGGED_IN).csrfToken, 'Tok123');
    assert.equal(detectSession(LOGGED_OUT).sessionUserId, null);
  });

  test('asbd comes from the cookie when present, otherwise a known constant', () => {
    assert.deepEqual(detectAsbd(LOGGED_IN), { asbd: '129477', source: 'cookie' });
    assert.deepEqual(detectAsbd(LOGGED_OUT), { asbd: ASBD_CANDIDATES[0], source: 'fallback-constant' });
  });
});

describe('app id and doc id discovery', () => {
  test('the app id is read from the page bundle', () => {
    const doc = pageWithScripts(['var x = {"X-IG-App-ID":"936619743392459"};']);
    assert.deepEqual(detectAppId(doc), { appId: '936619743392459', source: 'page' });
  });

  test('alternate bundle spellings are recognised', () => {
    assert.equal(detectAppId(pageWithScripts(['x-ig-app-id: "1217981644879628"'])).appId, '1217981644879628');
    assert.equal(detectAppId(pageWithScripts(['appId = "936619743392459"'])).appId, '936619743392459');
  });

  test('a page without the id falls back to a constant and says so', () => {
    const result = detectAppId(pageWithScripts(['nothing here']));
    assert.equal(result.appId, APP_ID_CANDIDATES[0]);
    assert.equal(result.source, 'fallback-constant');
  });

  test('doc ids are harvested, deduped, and never invented', () => {
    const doc = pageWithScripts([
      '{"doc_id":"1234567890123456"}',
      'fetch("?doc_id=9876543210987654")',
      '{"doc_id":"1234567890123456"}',
      'short: doc_id=123',
    ]);
    const ids = harvestDocIds(doc);
    assert.deepEqual(ids.sort(), ['1234567890123456', '9876543210987654'].sort());
    assert.deepEqual(harvestDocIds(pageWithScripts(['no ids'])), []);
  });

  test('page tokens are read when the bundle carries them', () => {
    const doc = pageWithScripts([
      'requireLazy(["LSD"],[],{"token":"AVqB1xY"});',
      'requireLazy(["DTSGInitialData"],[],{"token":"AQHabc"});',
    ]);
    assert.deepEqual(detectPageTokens(doc), { lsd: 'AVqB1xY', fbDtsg: 'AQHabc' });
    assert.deepEqual(detectPageTokens(pageWithScripts(['nothing'])), { lsd: null, fbDtsg: null });
  });
});

describe('embedded json and dom probes', () => {
  test('application/json blobs that look like profile data are listed', () => {
    const doc = installDom();
    const useful = doc.createElement('script');
    useful.setAttribute('type', 'application/json');
    useful.id = 'blob-1';
    useful.textContent = `{"require":[${'x'.repeat(60)}],"user":{"id":"1"}}`;
    const noise = doc.createElement('script');
    noise.setAttribute('type', 'application/json');
    noise.textContent = '{"a":1}';
    doc.body.append(useful, noise);
    const found = findEmbeddedJson(doc);
    assert.equal(found.length, 1);
    assert.equal(found[0].id, 'blob-1');
  });

  test('probeDom reports which selectors still match, including failures', () => {
    const doc = installDom();
    const dialog = doc.createElement('div'); dialog.setAttribute('role', 'dialog');
    const editor = doc.createElement('div'); editor.setAttribute('contenteditable', 'true');
    dialog.append(editor); doc.body.append(dialog);
    const result = probeDom(doc);
    assert.equal(result.dialogs.ok, true);
    assert.equal(result.composer.ok, true);
    assert.equal(result.postLinks.ok, false);
    assert.equal(result.profileHeader.count, 0);
  });
});

describe('probeViewer', () => {
  test('the web profile alias is tried first', async () => {
    const seen = [];
    const request = async (url) => {
      seen.push(url);
      return { data: { user: { id: '77', username: 'me', full_name: 'Me', edge_followed_by: { count: 100 }, edge_follow: { count: 50 }, is_private: false } } };
    };
    const viewer = await probeViewer({ request, appId: '1', asbd: '1' });
    assert.equal(viewer.username, 'me');
    assert.equal(viewer.followers, 100);
    assert.equal(viewer.following, 50);
    assert.equal(viewer.source, 'web_profile_info');
    assert.equal(seen.length, 1);
  });

  test('the accounts endpoint is the fallback', async () => {
    const seen = [];
    const request = async (url) => {
      seen.push(url);
      if (url.includes('web_profile_info')) return { data: {} };
      return { user: { pk: 77, username: 'me2', follower_count: 10, following_count: 5, is_private: true } };
    };
    const viewer = await probeViewer({ request, appId: '1', asbd: '1' });
    assert.equal(viewer.username, 'me2');
    assert.equal(viewer.id, '77');
    assert.equal(viewer.followers, 10);
    assert.equal(viewer.isPrivate, true);
    assert.equal(viewer.source, 'accounts_current_user');
    assert.equal(seen.length, 2);
  });

  test('a logged-out viewer is null, never a fake account', async () => {
    const request = async () => ({ message: 'login_required' });
    assert.equal(await probeViewer({ request, appId: '1', asbd: '1' }), null);
  });

  test('a transport failure is null, not a throw', async () => {
    const request = async () => { throw new Error('offline'); };
    assert.equal(await probeViewer({ request, appId: '1', asbd: '1' }), null);
  });
});

describe('runProbe', () => {
  test('logged out: the internal api is reported unavailable', async () => {
    const doc = pageWithScripts(['{"X-IG-App-ID":"936619743392459"}']);
    const probe = await runProbe({ document: doc, cookieString: LOGGED_OUT, location: { href: 'https://www.instagram.com/sara_shop/' } });
    assert.equal(probe.session.loggedIn, false);
    assert.equal(probe.paths[Path.INTERNAL_API].available, false);
    assert.equal(probe.appIdSource, 'page');
    assert.equal(probe.viewer, null);
    assert.ok(probe.caveat.length > 20);
  });

  test('logged in with a page app id: high confidence, and the viewer is fetched', async () => {
    const doc = pageWithScripts(['{"X-IG-App-ID":"936619743392459"}', '{"doc_id":"1234567890123456"}']);
    const request = async () => ({ data: { user: { id: '77', username: 'me', edge_followed_by: { count: 1 }, edge_follow: { count: 1 } } } });
    const probe = await runProbe({ document: doc, cookieString: LOGGED_IN, location: { href: 'https://www.instagram.com/' }, request });
    assert.equal(probe.session.loggedIn, true);
    assert.equal(probe.paths[Path.INTERNAL_API].available, true);
    assert.equal(probe.paths[Path.INTERNAL_API].confidence, 'high');
    assert.equal(probe.viewer.username, 'me');
    assert.equal(probe.docIdCount, 1);
    assert.equal(probe.anyPathAvailable, true);
  });

  test('logged in without a page app id: available but low confidence', async () => {
    const doc = pageWithScripts(['nothing']);
    const probe = await runProbe({ document: doc, cookieString: LOGGED_IN });
    assert.equal(probe.paths[Path.INTERNAL_API].available, true);
    assert.equal(probe.paths[Path.INTERNAL_API].confidence, 'low');
    assert.match(probe.paths[Path.INTERNAL_API].detail, /may be stale/);
  });

  test('a viewer lookup failure never fails the probe', async () => {
    const doc = pageWithScripts(['{"X-IG-App-ID":"936619743392459"}']);
    const request = async () => { throw new Error('offline'); };
    const probe = await runProbe({ document: doc, cookieString: LOGGED_IN, request });
    assert.equal(probe.viewer, null);
    assert.equal(probe.paths[Path.INTERNAL_API].available, true);
  });
});

describe('detectViewerFromDom (zero-API browser viewer detection)', () => {
  test('reads the signed-in handle from the navigation rail Profile link', () => {
    const doc = installDom();
    const nav = doc.createElement('nav');
    const explore = doc.createElement('a');
    explore.setAttribute('href', '/explore/');
    explore.textContent = 'Explore';
    const profile = doc.createElement('a');
    profile.setAttribute('href', '/cairo_atelier/');
    const img = doc.createElement('img');
    img.setAttribute('alt', "cairo_atelier's profile picture");
    profile.append(img);
    const label = doc.createElement('span');
    label.textContent = 'Profile';
    profile.append(label);
    nav.append(explore, profile);
    doc.body.append(nav);

    const viewer = detectViewerFromDom(doc, 'ds_user_id=991122');
    assert.equal(viewer.username, 'cairo_atelier');
    assert.equal(viewer.id, '991122');
    assert.equal(viewer.source, 'dom_nav_profile');
  });

  test('reads Arabic profile picture alt text when no Profile label is present', () => {
    const doc = installDom();
    const nav = doc.createElement('div');
    nav.setAttribute('role', 'navigation');
    const img = doc.createElement('img');
    img.setAttribute('alt', 'صورة الملف الشخصي لـ nour_craft');
    nav.append(img);
    doc.body.append(nav);

    const viewer = detectViewerFromDom(doc, 'ds_user_id=4455');
    assert.equal(viewer.username, 'nour_craft');
    assert.equal(viewer.id, '4455');
    assert.equal(viewer.source, 'dom_nav_avatar');
  });

  test('reads embedded page script viewer JSON without any network call', async () => {
    const doc = pageWithScripts([
      '{"viewer":{"id":"881234","username":"nile_goods","full_name":"Nile Goods"}}',
    ]);
    let networkCalled = false;
    const probe = await runProbe({
      document: doc,
      cookieString: 'ds_user_id=881234',
      request: async () => { networkCalled = true; return null; },
    });
    assert.equal(networkCalled, false, 'DOM viewer detection makes zero API calls');
    assert.equal(probe.viewer.username, 'nile_goods');
    assert.equal(probe.viewer.id, '881234');
    assert.equal(probe.session.loggedIn, true);
  });

  test('ignores reserved routes in nav links', () => {
    const doc = installDom();
    const nav = doc.createElement('nav');
    const a = doc.createElement('a');
    a.setAttribute('href', '/accounts/');
    a.textContent = 'Profile';
    nav.append(a);
    doc.body.append(nav);

    assert.equal(detectViewerFromDom(doc, ''), null);
  });
});
