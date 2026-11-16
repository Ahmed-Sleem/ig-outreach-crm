import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../scripts/lib/dom-shim.mjs';
import {
  HOST_ID,
  LAUNCHER_TICK_MS,
  createLauncher,
  describeStatus,
  installLauncher,
  logoMark,
  pageContextFrom,
  pillLabel,
  quickActionsFor,
  shouldMount,
} from '../src/content/launcher.js';

function setup(pathname = '/sara_shop/', options = {}) {
  const doc = installDom();
  const location = { href: `https://www.instagram.com${pathname}`, pathname };
  const opened = [];
  const stops = [];
  const actions = [];
  const launcher = createLauncher({
    document: doc,
    location,
    open: (url) => {
      opened.push(url);
      return options.blockPopups ? null : { focus() {} };
    },
    onStop: () => stops.push(1),
    onAction: options.onAction ?? ((action) => { actions.push(action); return undefined; }),
    readStatus: options.readStatus ?? null,
    now: () => 0,
  });
  return { doc, location, launcher, opened, stops, actions };
}

const clickFirst = (ui, id) => {
  const button = [...ui.actions.children].find((node) => node.getAttribute('data-action') === id);
  assert.ok(button, `no action button for ${id}`);
  button.click();
  return button;
};

describe('page context', () => {
  test('a profile path yields the username', () => {
    assert.deepEqual(pageContextFrom('/sara_shop/', 'https://www.instagram.com/sara_shop/'), {
      kind: 'profile',
      username: 'sara_shop',
      postCode: null,
      tag: null,
      threadId: null,
      href: 'https://www.instagram.com/sara_shop/',
    });
  });

  test('post, reel, tag, thread and explore routes are told apart', () => {
    assert.equal(pageContextFrom('/p/Cx9abc/').kind, 'post');
    assert.equal(pageContextFrom('/p/Cx9abc/').postCode, 'Cx9abc');
    assert.equal(pageContextFrom('/reel/Cx9abc/').kind, 'post');
    assert.equal(pageContextFrom('/explore/tags/linen/').kind, 'tag');
    assert.equal(pageContextFrom('/explore/tags/linen/').tag, 'linen');
    assert.equal(pageContextFrom('/explore/').kind, 'explore');
    assert.equal(pageContextFrom('/direct/t/991/').kind, 'direct');
    assert.equal(pageContextFrom('/direct/t/991/').threadId, '991');
    assert.equal(pageContextFrom('/direct/inbox/').kind, 'direct');
    assert.equal(pageContextFrom('/accounts/login/').kind, 'other');
    assert.equal(pageContextFrom('/').kind, 'other');
  });

  test('an encoded tag is decoded, and a reserved segment is never a username', () => {
    assert.equal(pageContextFrom('/explore/tags/%D9%83%D8%AA%D8%A7%D9%86/').tag, 'كتان');
    assert.equal(pageContextFrom('/explore/').username, null);
    assert.equal(pageContextFrom('/direct/new/sara/').username, null);
  });

  test('the pill is offered on pages where work is possible and nowhere else', () => {
    for (const path of ['/sara_shop/', '/p/Cx9/', '/explore/', '/direct/inbox/', '/']) {
      assert.equal(shouldMount(path), true, path);
    }
    for (const path of ['/accounts/login/', '/challenge/', '/legal/terms/', '/oauth/', '/graphql/']) {
      assert.equal(shouldMount(path), false, path);
    }
  });

  test('the collapsed pill says what the page is for', () => {
    assert.equal(pillLabel(pageContextFrom('/sara_shop/')), 'Collect');
    assert.equal(pillLabel(pageContextFrom('/p/Cx9/')), 'Collect');
    assert.equal(pillLabel(pageContextFrom('/direct/inbox/')), 'CRM');
    assert.equal(pillLabel(null), 'CRM');
  });
});

describe('quick actions', () => {
  test('a profile offers three explicit collect actions plus adding that exact handle', () => {
    const actions = quickActionsFor(pageContextFrom('/sara_shop/', 'https://www.instagram.com/sara_shop/'));
    assert.deepEqual(actions.map((action) => action.id), ['collect-followers', 'collect-following', 'collect-recent-likers', 'add-to-outreach', 'open-dashboard']);
    const collect = actions[0];
    assert.equal(collect.tab, 'collector');
    assert.equal(collect.params.source, 'followers');
    assert.equal(collect.params.username, 'sara_shop', 'the handle must travel: focus moves when the dashboard opens');
    assert.equal(collect.params.here, '1');
    assert.equal(collect.params.auto, '1', 'a collect action starts immediately');
    assert.equal(collect.params.from, 'https://www.instagram.com/sara_shop/', 'the page it came from travels so the dashboard aims at this tab');
    assert.equal(actions[2].params.source, 'profile_recent_likers');
    const add = actions[3];
    assert.equal(add.tab, 'outreach');
    assert.equal(add.params.act, 'add');
    assert.match(add.label, /@sara_shop/);
    assert.equal(add.params.auto, undefined, 'an outreach action does not auto-start a collection');
  });

  test('a post offers likers and commenters; a hashtag page only offers the dashboard (hashtag/open-tab collection removed)', () => {
    const post = quickActionsFor(pageContextFrom('/p/Cx9abc/'));
    assert.deepEqual(post.map((action) => action.id), ['collect-post-likers', 'collect-post-commenters', 'open-dashboard']);
    assert.equal(post[0].params.source, 'post_likers');
    assert.equal(post[0].params.ref, 'Cx9abc');
    assert.equal(post[0].params.auto, '1');
    assert.equal(post[1].params.source, 'post_comments');
    assert.equal(post[1].params.ref, 'Cx9abc');
    const tag = quickActionsFor(pageContextFrom('/explore/tags/linen/'));
    assert.deepEqual(tag.map((action) => action.id), ['open-dashboard']);
    const explore = quickActionsFor(pageContextFrom('/explore/'));
    assert.deepEqual(explore.map((action) => action.id), ['open-dashboard']);
  });

  test('a thread offers the thread, and every route still offers the dashboard', () => {
    const direct = quickActionsFor(pageContextFrom('/direct/t/991/'));
    assert.equal(direct[0].id, 'open-thread');
    assert.equal(direct[0].params.thread, '991');
    for (const path of ['/sara_shop/', '/p/Cx9/', '/explore/', '/']) {
      const actions = quickActionsFor(pageContextFrom(path));
      assert.equal(actions[actions.length - 1].id, 'open-dashboard', path);
      for (const action of actions) {
        assert.ok(action.id && action.label && action.params, `${path} produced an incomplete action`);
      }
    }
  });
});

describe('status wording', () => {
  test('nothing to report reads as idle', () => {
    assert.deepEqual(describeStatus(null), { stage: 'Idle', detail: '', counter: '', progress: null, tone: 'muted', running: false });
    assert.equal(describeStatus({ nonsense: true }).stage, 'Idle');
  });

  test('every wait says how long and that it is deliberate', () => {
    const pacing = describeStatus({ type: 'pacing', waitMs: 3500, sessionCount: 2 });
    assert.equal(pacing.stage, 'Waiting');
    assert.equal(pacing.detail, 'Waiting 3.5s before the next read (human pacing).');
    assert.equal(pacing.counter, '2 requests this run');
    assert.equal(describeStatus({ type: 'pacing', waitMs: 3500, sessionCount: 1 }).counter, '1 request this run');
    assert.match(describeStatus({ type: 'throttled', waitMs: 60000 }).detail, /Per-minute limit reached — waiting 60\.0s/);
    const backoff = describeStatus({ type: 'backoff', waitMs: 15000, honouredRetryAfter: true });
    assert.equal(backoff.tone, 'warn');
    assert.match(backoff.detail, /its own retry-after/);
  });

  test('a hidden tab, a refusal and a stop are three different sentences', () => {
    assert.equal(describeStatus({ type: 'paused', reason: 'tab hidden' }).stage, 'Paused');
    assert.match(describeStatus({ type: 'paused' }).detail, /background/);
    assert.equal(describeStatus({ type: 'aborted', message: 'action block', severity: 'account' }).stage, 'Refused');
    assert.equal(describeStatus({ type: 'aborted', message: 'action block' }).detail, 'action block');
    assert.equal(describeStatus({ type: 'stopped' }).stage, 'Stopped');
    assert.equal(describeStatus({ kind: 'run-end', ok: false, reason: 'owner pressed stop' }).detail, 'owner pressed stop');
    assert.equal(describeStatus({ kind: 'run-end', ok: true, summary: '12 leads' }).stage, 'Done');
  });

  test('progress rows name the phase and count rows, pages and scrolls', () => {
    const row = describeStatus({ phase: 'my-followers', total: 120, page: 2, limit: 1000, source: 'me' });
    assert.equal(row.stage, 'Reading your followers');
    assert.equal(row.detail, 'From @me');
    assert.equal(row.counter, '120 rows so far · page 2');
    assert.equal(row.progress, 0.12);
    assert.equal(describeStatus({ phase: 'hashtag_grid', scrolls: 4, total: 36 }).counter, '36 rows so far · scroll 4');
    assert.equal(describeStatus({ phase: 'accept-check', suspects: 3 }).counter, '3 to check');
    assert.equal(describeStatus({ phase: 'post_comments', total: 8, post: 'Cx9' }).detail, 'Post Cx9');
  });

  test('a bar is only drawn when there is something honest to divide by', () => {
    assert.equal(describeStatus({ phase: 'followers', total: 40 }).progress, null);
    assert.equal(describeStatus({ phase: 'followers', total: 40, limit: 0 }).progress, null);
    assert.equal(describeStatus({ phase: 'followers', total: 1200, limit: 1000 }).progress, 1);
    assert.equal(describeStatus({ phase: 'unknown-phase', total: 5 }).stage, 'Working');
  });

  test('the managed-worker row takes over the pill', () => {
    const managed = describeStatus({ managed: true, runKind: 'autopilot' });
    assert.equal(managed.stage, 'Managed worker tab');
    assert.equal(managed.tone, 'managed');
    assert.equal(managed.running, true);
    assert.match(managed.detail, /autopilot/);
  });
});

describe('the pill in a page', () => {
  test('it mounts once, in a closed shadow root the page cannot reach', () => {
    const { doc, launcher } = setup();
    launcher.mount();
    const hosts = doc.body.children.filter((node) => node.id === HOST_ID);
    assert.equal(hosts.length, 1);
    assert.equal(launcher.isMounted, true);
    assert.equal(doc.getElementById(HOST_ID).shadowRoot, null, 'a closed root is not reachable from the host');
    assert.ok(launcher.root, 'the launcher keeps its own reference');
    assert.equal(launcher.host.style.zIndex, '2147483000');
    assert.equal(launcher.host.style.position, 'fixed');
    assert.equal(launcher.ui.pill.style.position, undefined, 'the pill itself is not fixed; the host is');
    assert.equal(doc.getElementById(HOST_ID).style.all, 'initial', 'shielding from page CSS comes first');
    launcher.mount();
    assert.equal(doc.body.children.filter((node) => node.id === HOST_ID).length, 1, 'a second mount must not stack a second pill');
  });

  test('a host left behind by an earlier install is replaced, not doubled', () => {
    const { doc, launcher } = setup();
    const stale = doc.createElement('div');
    stale.setAttribute('id', HOST_ID);
    doc.body.append(stale);
    launcher.mount();
    assert.equal(doc.body.children.filter((node) => node.id === HOST_ID).length, 1);
    assert.equal(doc.body.children.includes(stale), false);
  });

  test('the collapsed pill shows page actions only after a click', () => {
    const { launcher } = setup();
    const ui = launcher.mount();
    assert.equal(ui.panel.style.display, 'none');
    assert.equal(ui.pill.style.display, 'flex');
    assert.deepEqual([...ui.actions.children].map((node) => node.getAttribute('data-action')), ['collect-followers', 'collect-following', 'collect-recent-likers', 'add-to-outreach', 'open-dashboard']);
    ui.pill.click();
    assert.equal(launcher.isOpen, true);
    assert.equal(ui.panel.style.display, 'block');
    assert.equal(ui.pill.style.display, 'none');
    ui.collapse.click();
    assert.equal(launcher.isOpen, false);
    assert.equal(ui.panel.style.display, 'none');
  });

  test('clicking an action opens the dashboard with the handle in the query', () => {
    const { launcher, opened, actions } = setup();
    const ui = launcher.mount();
    clickFirst(ui, 'collect-followers');
    assert.equal(actions[0].id, 'collect-followers');
    assert.equal(opened.length, 1);
    const url = new URL(opened[0]);
    assert.equal(url.pathname, '/app/index.html');
    assert.equal(url.searchParams.get('tab'), 'collector');
    assert.equal(url.searchParams.get('source'), 'followers');
    assert.equal(url.searchParams.get('username'), 'sara_shop');
    assert.equal(url.searchParams.get('here'), '1');
    assert.equal(url.searchParams.get('auto'), '1');
  });

  test('an action a caller owns is not opened a second time', () => {
    const { doc, location } = setup();
    const owned = [];
    const launcher = createLauncher({
      document: doc,
      location,
      onAction: (action) => { owned.push(action.id); return false; },
      open: () => { throw new Error('must not open'); },
    });
    const ui = launcher.mount();
    assert.equal(launcher.runAction({ id: 'collect-followers', tab: 'collector', params: {} }), false);
    clickFirst(ui, 'add-to-outreach');
    assert.deepEqual(owned, ['collect-followers', 'add-to-outreach']);
  });

  test('a blocked popup is reported instead of failing silently', () => {
    const { launcher, opened } = setup('/sara_shop/', { blockPopups: true });
    const ui = launcher.mount();
    clickFirst(ui, 'collect-followers');
    assert.equal(opened.length, 1);
    assert.equal(ui.stage.textContent, 'Problem');
    assert.match(ui.detail.textContent, /blocked the new tab/);
    assert.equal(launcher.isOpen, true, 'the owner has to be able to read the problem');
  });

  test('nothing is built from markup strings', () => {
    const { launcher } = setup();
    launcher.mount();
    const svg = logoMark(launcher.ui.pill.ownerDocument, 16, '#3d5afe', '#1b7f4d');
    assert.equal(svg.tagName, 'svg');
    assert.deepEqual(svg.children.map((node) => node.tagName), ['path', 'rect', 'circle']);
    assert.equal(svg.getAttribute('aria-hidden'), 'true');
    // A username is untrusted text: it must land in textContent, never in markup.
    const hostile = setup('/a<script>alert(1)</' + 'script>/');
    const ui = hostile.launcher.mount();
    ui.pill.click();
    const add = [...ui.actions.children].find((node) => node.getAttribute('data-action') === 'add-to-outreach');
    // The literal text is there — as text. What must never happen is a node: the
    // markup has to come out escaped, so the page cannot execute it.
    assert.match(add.textContent, /Add @/);
    assert.equal(add.children.every((node) => node.tagName === 'span'), true, 'only our own spans, no parsed markup');
    assert.equal(add.outerHTML.includes('&lt;script&gt;'), true);
    assert.equal(add.querySelector('script'), null);
  });
});

describe('live status and the managed worker banner', () => {
  test('a pacing row is rendered in the pill', () => {
    const { launcher } = setup();
    const ui = launcher.mount();
    launcher.showStatus({ type: 'pacing', waitMs: 4200, sessionCount: 7 });
    assert.equal(ui.progressRow.style.display, 'block');
    assert.equal(ui.stage.textContent, 'Waiting');
    assert.equal(ui.detail.textContent, 'Waiting 4.2s before the next read (human pacing).');
    assert.equal(ui.counter.textContent, '7 requests this run');
  });

  test('a progress row moves the bar and names the phase', () => {
    const { launcher } = setup();
    const ui = launcher.mount();
    launcher.showStatus({ phase: 'their-following', total: 250, page: 3, limit: 1000, source: 'comp_a' });
    assert.equal(ui.stage.textContent, 'Reading who they follow');
    assert.equal(ui.bar.style.width, '25%');
    assert.equal(ui.counter.textContent, '250 rows so far · page 3');
  });

  test('the managed row turns the pill into a stop button', () => {
    const { launcher, stops } = setup();
    const ui = launcher.mount();
    launcher.showStatus({ managed: true, runKind: 'autopilot', note: 'Following 12 warm leads.' });
    assert.equal(launcher.isManaged, true);
    assert.equal(ui.banner.style.display, 'block');
    assert.equal(ui.bannerText.textContent, 'Following 12 warm leads.');
    assert.equal(ui.pillLabel.textContent, 'Stop');
    assert.equal(ui.pill.style.borderColor, '#b45309');
    // The pill itself stops the run: the control must not be behind a click.
    ui.pill.click();
    assert.equal(stops.length, 1);
    assert.equal(ui.stage.textContent, 'Stopped');
    assert.match(ui.detail.textContent, /Stop requested from this tab/);
    ui.bannerStop.click();
    assert.equal(stops.length, 2);
    launcher.showStatus({ managed: false });
    assert.equal(launcher.isManaged, false);
    assert.equal(ui.banner.style.display, 'none');
    assert.equal(ui.pillLabel.textContent, 'Collect');
  });

  test('status is pulled from the bridge on refresh', async () => {
    let calls = 0;
    const { launcher } = setup('/sara_shop/', {
      readStatus: async () => { calls += 1; return { type: 'throttled', waitMs: 20000 }; },
    });
    const ui = launcher.mount();
    await launcher.refresh();
    assert.equal(calls, 1);
    assert.equal(ui.stage.textContent, 'Rate limit');
    assert.equal(launcher.status.waitMs, 20000);
  });

  test('showDone and showError both end in something readable', () => {
    const { launcher } = setup();
    const ui = launcher.mount();
    launcher.showDone('38 leads collected.');
    assert.equal(ui.stage.textContent, 'Done');
    assert.equal(ui.detail.textContent, '38 leads collected.');
    launcher.showError('Instagram refused the request.');
    assert.equal(ui.stage.textContent, 'Problem');
    assert.equal(ui.detail.textContent, 'Instagram refused the request.');
  });
});

describe('surviving a single-page app', () => {
  test('navigation rewrites the actions for the new page', () => {
    const { launcher, location } = setup('/sara_shop/');
    const ui = launcher.mount();
    location.pathname = '/p/Cx9abc/';
    location.href = 'https://www.instagram.com/p/Cx9abc/';
    assert.equal(launcher.sync(), true);
    assert.deepEqual([...ui.actions.children].map((node) => node.getAttribute('data-action')), ['collect-post-likers', 'collect-post-commenters', 'open-dashboard']);
    assert.equal(ui.pillLabel.textContent, 'Collect');
  });

  test('a route where the pill is noise unmounts it', () => {
    const { launcher, location } = setup('/sara_shop/');
    launcher.mount();
    assert.equal(launcher.isMounted, true);
    location.pathname = '/accounts/login/';
    location.href = 'https://www.instagram.com/accounts/login/';
    assert.equal(launcher.sync(), false);
    assert.equal(launcher.isMounted, false);
    location.pathname = '/sara_shop/';
    location.href = 'https://www.instagram.com/sara_shop/';
    assert.equal(launcher.sync(), true);
    assert.equal(launcher.isMounted, true);
  });

  test('when Instagram wipes the node, the next tick puts it back', () => {
    const { doc, launcher } = setup();
    launcher.mount();
    doc.getElementById(HOST_ID).remove();
    assert.equal(launcher.isMounted, false);
    launcher.sync();
    assert.equal(launcher.isMounted, true);
    assert.equal(doc.body.children.filter((node) => node.id === HOST_ID).length, 1);
  });

  test('installLauncher ticks, collapses on navigation and stops cleanly', async () => {
    const { doc, location } = setup('/sara_shop/');
    const timers = [];
    let cleared = 0;
    const listeners = {};
    const installed = installLauncher({
      document: doc,
      location,
      open: () => ({}),
      setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
      clearInterval: () => { cleared += 1; },
      addEventListener: (type, fn) => { listeners[type] = fn; },
      tickMs: LAUNCHER_TICK_MS,
    });
    assert.equal(installed.launcher.isMounted, true);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, LAUNCHER_TICK_MS);
    assert.equal(typeof listeners.popstate, 'function');

    installed.launcher.setExpanded(true);
    location.pathname = '/p/Cx9/';
    location.href = 'https://www.instagram.com/p/Cx9/';
    const ticked = await timers[0].fn();
    assert.deepEqual(ticked, { mounted: true, navigated: true });
    assert.equal(installed.launcher.isOpen, false, 'a new page must not keep the old panel open');
    assert.deepEqual([...installed.launcher.ui.actions.children].map((node) => node.getAttribute('data-action')), ['collect-post-likers', 'collect-post-commenters', 'open-dashboard']);

    const again = await timers[0].fn();
    assert.equal(again.navigated, false);

    // A managed tab keeps its stop control open across navigation.
    installed.launcher.setManaged(true, { runKind: 'autopilot' });
    installed.launcher.setExpanded(true);
    location.pathname = '/sara_shop/';
    location.href = 'https://www.instagram.com/sara_shop/';
    await timers[0].fn();
    assert.equal(installed.launcher.isOpen, true);

    installed.stop();
    assert.equal(cleared, 1);
    assert.equal(installed.launcher.isMounted, false);
    const after = await timers[0].fn();
    assert.deepEqual(after, { mounted: false, navigated: false }, 'a stopped launcher does nothing');
  });

  test('the tick pulls the managed state from the bridge', async () => {
    const { doc, location } = setup('/sara_shop/');
    let status = { managed: true, runKind: 'autopilot' };
    const installed = installLauncher({
      document: doc,
      location,
      open: () => ({}),
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: null,
      readStatus: async () => status,
    });
    await installed.tick();
    assert.equal(installed.launcher.isManaged, true);
    assert.equal(installed.launcher.ui.pillLabel.textContent, 'Stop');
    status = { managed: false };
    await installed.tick();
    assert.equal(installed.launcher.isManaged, false);
    assert.equal(installed.launcher.ui.pillLabel.textContent, 'Collect');
    installed.stop();
  });
});
