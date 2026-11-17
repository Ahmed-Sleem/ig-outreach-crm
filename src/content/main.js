/**
 * The content-script brain: one command router, one run at a time.
 *
 * Everything the dashboard can ask an Instagram tab to do is a case in
 * `createHandlers` below. Nothing here decides HOW FAST to work — read spacing
 * comes from `pacing.js`, write spacing from `core/governor.js` in the dashboard
 * — and nothing here decides WHETHER an action is allowed, which is the
 * lifecycle's and the governor's job. This module's whole responsibility is to
 * turn a command into adapter and action calls, and to report honestly what came
 * back.
 *
 * Dependencies are injected (`document`, `location`, `cookieString`, adapters,
 * actions, pacing) so the router is unit-testable without a browser.
 */

import { Pacer, PacingStopped, AccountFlagged, interruptibleWait } from './pacing.js';
import { detectSession, detectAppId, detectAsbd, detectViewerFromDom, harvestDocIds, probeViewer, runProbe } from './probe.js';
import {
  collectHashtagDom,
  collectOpenDialogDom,
  collectPostCommentsDom,
  collectPostLikersDom,
  collectProfileListDom,
  collectRecentPostLikersDom,
} from './browser-collector.js';
import { createVirtualCursor } from './human.js';
import {
  ApiError,
  createApi,
  fetchComments,
  fetchFriendshipList,
  fetchLikers,
  fetchMediaIdForShortcode,
  fetchProfileById,
  readProfileByUsername,
  lookupFollowship,
  normaliseProfile,
  normaliseUserRow,
  normaliseUserRows,
  scrapeGridAuthors,
  scrapeModalUserList,
  scrapeOpenProfile,
  scrapeProfileFromDom,
} from './adapters.js';
import {
  composerScope,
  detectDmRestriction,
  directThreadMatchesUser,
  dmContainerUserMatch,
  extractDialogUsers,
  findDmSurface,
  findOpenDmDock,
  findVisibleDialog,
  usernameFromPath,
} from './selectors.js';
import {
  executeDm,
  executeFollow,
  executeUnfollow,
  openDm,
  readRelationshipState,
  waitFor,
} from './actions.js';
import { RelationshipKind, buildFollowerIndex, nameKey, planSync, relStateFor } from '../core/relationship.js';
import { Intent, classifyComment } from '../core/comments.js';
import { EdgeType, scoreLead } from '../core/scoring.js';
import { ACTIVE_WORKSPACE_KEY, CommandType, chromeStorageAdapter, createBridge } from '../storage/bridge.js';
import { installLauncher } from './launcher.js';

/** What Tab 1 can collect from. Every value maps to exactly one edge type. */
export const CollectSource = Object.freeze({
  FOLLOWERS: 'followers',
  FOLLOWING: 'following',
  POST_LIKERS: 'post_likers',
  POST_COMMENTS: 'post_comments',
  PROFILE_RECENT_LIKERS: 'profile_recent_likers',
  HASHTAG_GRID: 'hashtag_grid',
  SAVED_GRID: 'saved_grid',
  OPEN_LIST_DIALOG: 'open_list_dialog',
  CURRENT_PAGE: 'current_page',
});

export const SOURCE_EDGE_TYPE = Object.freeze({
  [CollectSource.FOLLOWERS]: EdgeType.FOLLOWED_BY_SOURCE,
  [CollectSource.FOLLOWING]: EdgeType.FOLLOWS_SOURCE,
  [CollectSource.POST_LIKERS]: EdgeType.LIKED_POST,
  [CollectSource.PROFILE_RECENT_LIKERS]: EdgeType.LIKED_POST,
  [CollectSource.POST_COMMENTS]: EdgeType.COMMENTED_POST,
  [CollectSource.HASHTAG_GRID]: EdgeType.PROFILE_CAPTURE,
  [CollectSource.SAVED_GRID]: EdgeType.PROFILE_CAPTURE,
  [CollectSource.OPEN_LIST_DIALOG]: EdgeType.PROFILE_CAPTURE,
  [CollectSource.CURRENT_PAGE]: EdgeType.PROFILE_CAPTURE,
});

/** Sources that need a target account, and therefore a profile read first. */
export const NEEDS_TARGET = Object.freeze([
  CollectSource.FOLLOWERS,
  CollectSource.FOLLOWING,
  CollectSource.POST_LIKERS,
  CollectSource.POST_COMMENTS,
  CollectSource.PROFILE_RECENT_LIKERS,
]);

/**
 * The subset of `NEEDS_TARGET` that genuinely needs a resolved profile (a numeric
 * id) before it can read. Post sources work from a shortcode alone, so gating them
 * behind a profile read is what made them impossible to run from the dashboard.
 */
export const NEEDS_PROFILE = Object.freeze([
  CollectSource.FOLLOWERS,
  CollectSource.FOLLOWING,
  CollectSource.PROFILE_RECENT_LIKERS,
]);

/** Sources served from the rendered page with no request at all. */
export const DOM_ONLY_SOURCES = Object.freeze([
  CollectSource.HASHTAG_GRID,
  CollectSource.SAVED_GRID,
  CollectSource.OPEN_LIST_DIALOG,
]);

export const IG_ORIGIN = 'https://www.instagram.com';

export function profileUrl(username) {
  return `${IG_ORIGIN}/${encodeURIComponent(String(username ?? '').replace(/^@+/, ''))}/`;
}

export function directUrl(username) {
  return `${IG_ORIGIN}/direct/new/${encodeURIComponent(String(username ?? '').replace(/^@+/, ''))}/`;
}

export function threadUrl(threadId) {
  return `${IG_ORIGIN}/direct/t/${encodeURIComponent(String(threadId ?? ''))}/`;
}

/**
 * The runtime every command shares: identity, session, pacing and the abort
 * controller of the run in flight.
 */
export function createContentRuntime(deps = {}) {
  const document = deps.document ?? (typeof globalThis !== 'undefined' ? globalThis.document : null);
  const location = deps.location ?? (typeof globalThis !== 'undefined' ? globalThis.location : null);
  const cookieString = deps.cookieString ?? document?.cookie ?? '';
  const session = detectSession(cookieString);
  const { appId, source: appIdSource } = deps.appId ? { appId: deps.appId, source: 'injected' } : detectAppId(document);
  const { asbd, source: asbdSource } = deps.asbd ? { asbd: deps.asbd, source: 'injected' } : detectAsbd(cookieString);
  const docIds = deps.docIds ?? harvestDocIds(document);

  const request = deps.request ?? (deps.fetchImpl
    ? createApi({
      fetchImpl: deps.fetchImpl,
      appId,
      asbd,
      csrfToken: session.csrfToken,
    })
    : null);

  const domViewer = detectViewerFromDom(document, cookieString);
  let ownedVisualizer = null;

  const runtime = {
    document,
    location,
    session: domViewer && !session.loggedIn
      ? { ...session, loggedIn: true, sessionUserId: session.sessionUserId ?? (domViewer.id || null) }
      : session,
    appId,
    appIdSource,
    asbd,
    asbdSource,
    docIds,
    request,
    deps,
    /** The run in flight, if any. One at a time, enforced here and in the bridge. */
    current: null,
    pacer: null,
    controller: null,
    profileCache: new Map(),
    viewer: deps.viewer ?? domViewer ?? null,
    // Mounted ONLY during an active run inside a closed Shadow DOM so the owner
    // can watch live actions in front of them, and removed completely on endRun().
    virtualCursor: deps.virtualCursor ?? null,

    refreshSession() {
      const freshCookies = deps.cookieString ?? document?.cookie ?? '';
      const freshSession = detectSession(freshCookies);
      const freshDomViewer = detectViewerFromDom(document, freshCookies);
      if (freshDomViewer) {
        if (!runtime.viewer || (!runtime.viewer.username && freshDomViewer.username) || (!runtime.viewer.id && freshDomViewer.id)) {
          runtime.viewer = { ...(runtime.viewer ?? {}), ...freshDomViewer, id: freshDomViewer.id || runtime.viewer?.id || '', username: freshDomViewer.username || runtime.viewer?.username || '' };
        }
      }
      runtime.session = (freshSession.loggedIn || Boolean(runtime.viewer?.username || runtime.viewer?.id))
        ? { ...freshSession, loggedIn: true, sessionUserId: freshSession.sessionUserId ?? (runtime.viewer?.id || null) }
        : freshSession;
      return runtime.session;
    },

    get pathname() {
      return location?.pathname ?? '';
    },
    /** The account this page belongs to, or null on a chrome route. */
    get pageUsername() {
      return usernameFromPath(location?.pathname ?? '');
    },
    isBusy() {
      return Boolean(runtime.current);
    },
    /** Begin a run: arms the abort controller and the pacer. */
    beginRun(kind, { pacing = {}, status = null } = {}) {
      if (runtime.current) throw new Error(`a ${runtime.current} run is already in progress`);
      const controller = new AbortController();
      runtime.controller = controller;
      runtime.pacer = new Pacer({
        ...pacing,
        now: deps.now,
        sleep: deps.sleep,
        isHidden: deps.isHidden ?? (() => document?.visibilityState === 'hidden'),
      });
      runtime.current = kind;
      runtime.signal = controller.signal;
      runtime.status = status;
      // Mount the closed-Shadow-DOM live visualizer ONLY while a task is active
      // (and remove it cleanly in endRun) so the owner can see every move, click,
      // target highlight, and live count right on the Instagram page.
      if (!deps.virtualCursor && deps.liveVisualizer !== false && document?.body) {
        try {
          ownedVisualizer?.destroy?.();
          ownedVisualizer = createVirtualCursor(document, {
            onStop: () => { runtime.stop('stopped-from-page'); },
          });
          runtime.virtualCursor = ownedVisualizer;
          ownedVisualizer.show('Starting…');
        } catch {
          ownedVisualizer = null;
        }
      }
      // Pacing events are the reason a run looks slow, so they travel to the
      // dashboard and to the pill in this tab instead of staying in the pacer.
      // Wired once per run: onStatus appends, and a second listener would send
      // every wait twice.
      if (typeof status === 'function') {
        runtime.pacer.onStatus((event) => {
          if (event?.reason) runtime.virtualCursor?.label?.(String(event.reason));
          status({ kind: 'pacing', runKind: kind, ...event });
        });
      }
      return controller.signal;
    },
    endRun() {
      if (ownedVisualizer) {
        ownedVisualizer.destroy();
        ownedVisualizer = null;
        runtime.virtualCursor = deps.virtualCursor ?? null;
      } else {
        runtime.virtualCursor?.hide?.();
      }
      runtime.current = null;
      runtime.controller = null;
      runtime.pacer = null;
      runtime.signal = null;
      runtime.status = null;
    },
    /** Stop the run in flight. Always safe, always immediate. */
    stop(reason = 'stopped') {
      const was = runtime.current;
      runtime.virtualCursor?.hide?.();
      runtime.controller?.abort();
      runtime.pacer?.stop();
      runtime.endRun();
      return { stopped: Boolean(was), kind: was ?? null, reason };
    },
    context() {
      const currentSession = runtime.refreshSession();
      return {
        url: location?.href ?? null,
        pathname: runtime.pathname,
        pageUsername: runtime.pageUsername,
        loggedIn: currentSession.loggedIn,
        viewerUsername: runtime.viewer?.username || null,
        viewerId: runtime.viewer?.id || currentSession.sessionUserId || null,
        appIdSource,
        asbdSource,
        docIdCount: docIds.length,
        busy: runtime.isBusy(),
        currentRun: runtime.current,
        relationship: document ? readRelationshipState(document).state : 'unknown',
      };
    },
  };
  return runtime;
}

/** The ctx object every adapter and action in this file receives. */
export function ctxOf(runtime, { status = null } = {}) {
  return {
    document: runtime.document,
    location: runtime.location,
    request: runtime.request,
    pacer: runtime.pacer,
    wait: runtime.deps.wait ?? interruptibleWait,
    random: runtime.deps.random,
    now: runtime.deps.now,
    domTimeoutMs: runtime.deps.domTimeoutMs,
    getSelection: runtime.deps.getSelection,
    virtualCursor: runtime.virtualCursor,
    signal: runtime.signal,
    status,
  };
}

/* ------------------------------------------------------------------ collecting */

/** Intents that mean "this person is asking to buy something". */
export const BUYER_INTENTS = Object.freeze([
  Intent.PRICE,
  Intent.PURCHASE_INTENT,
  Intent.SHIPPING,
  Intent.AVAILABILITY,
  Intent.SIZING,
]);

/** The guidance shown whenever every ID source failed to produce a numeric id. */
function noNumericIdMessage(name) {
  const clean = String(name ?? '').replace(/^@+/, '') || 'this account';
  return `Could not get @${clean}'s numeric ID from Instagram. Open their profile in this tab, wait for it to load, and press Collect again.`;
}

/** One profile read per run: the same target is asked for by every source. */
export async function resolveTarget(runtime, { username = null, userId = null, force = false } = {}) {
  const key = nameKey(username) || `id:${userId}`;
  if (!force && runtime.profileCache.has(key)) return runtime.profileCache.get(key);
  const ctx = ctxOf(runtime);
  let profile = null;
  let reason = null;
  let code = null;
  if (username) {
    const byName = await readProfileByUsername(ctx, {
      username,
      signal: runtime.signal,
      appId: runtime.appId,
      canRetryAppId: runtime.appIdSource !== 'injected',
      document: runtime.document,
    });
    if (byName.ok) profile = byName.user;
    else { reason = byName.reason; code = byName.code ?? null; }
  }
  if (!profile && userId) {
    // Wired straight from the adapters, like the by-name reader above, so this
    // fallback is live rather than a guarded no-op that always reports "unavailable".
    const byId = await fetchProfileById(ctx, { userId, signal: runtime.signal });
    if (byId.ok) profile = byId.user;
    else reason = reason ?? byId.reason;
  }
  if (!profile) {
    // The page itself, when it is the profile we were asked about.
    // Never accept an empty-id DOM scrape as a "success": doing so would mask an
    // earlier 404 or refusal and die later with a misleading no-numeric-id error.
    if (runtime.pageUsername && nameKey(runtime.pageUsername) === nameKey(username)) {
      const scraped = scrapeOpenProfile(runtime.document, { location: runtime.location });
      const recoveredId = scraped.ok ? (scraped.user.id || userId || '') : '';
      if (scraped.ok && recoveredId) profile = { ...scraped.user, id: recoveredId };
    }
  }
  if (!profile) {
    const finalReason = code === 'no_numeric_id'
      ? noNumericIdMessage(username ?? userId)
      : (reason ?? `could not read the profile for ${username ?? userId}`);
    return { ok: false, profile: null, code, reason: finalReason };
  }
  const cached = { ok: true, profile, reason: null };
  runtime.profileCache.set(key, cached);
  return cached;
}

/** A shortcode out of a post href: /p/CODE/, /reel/CODE/, /reels/CODE/, /tv/CODE/. */
function shortcodeFromHref(href) {
  const match = String(href ?? '').match(/\/(?:p|reels|reel|tv)\/([A-Za-z0-9_-]{6,})/);
  return match?.[1] ?? null;
}

/**
 * The recent posts to read likers from. The profile payload's own timeline comes
 * first because it carries the media id (no extra request); only when the open
 * page really is that profile are the rendered post anchors used as a fallback.
 * At most six posts, as before.
 */
function recentPostsFor(runtime, target) {
  const posts = [];
  const seen = new Set();
  const push = (mediaId, shortcode) => {
    const key = shortcode || mediaId;
    if (!key || seen.has(key)) return;
    seen.add(key);
    posts.push({ mediaId: mediaId || null, shortcode: shortcode || null });
  };
  for (const post of target?.recentPosts ?? []) push(post.mediaId, post.shortcode);
  const onThisProfile = runtime.pageUsername && target?.username && nameKey(runtime.pageUsername) === nameKey(target.username);
  if (posts.length < 6 && onThisProfile) {
    for (const anchor of runtime.document?.querySelectorAll?.('a') ?? []) {
      const code = shortcodeFromHref(anchor.getAttribute?.('href'));
      if (code) push(null, code);
      if (posts.length >= 6) break;
    }
  }
  return posts.slice(0, 6);
}

/**
 * Collect from one source strictly via visible human-like browser DOM
 * automation (ZERO Instagram API calls).
 *
 * Always returns `{ ok, rows, leads, edges, reason }` — or `{ ok: false,
 * needsNavigation: true, url, reason }` when the open Instagram tab needs to
 * navigate to the target profile, post, or hashtag first.
 */
export async function collectFromSource(runtime, {
  source,
  targetUsername = null,
  targetUserId = null,
  shortcode = null,
  tag = null,
  limit = 200,
  weights = {},
  workspaceId = 'default',
  onProgress = null,
} = {}) {
  if (!Object.values(CollectSource).includes(source)) {
    return { ok: false, rows: [], edges: [], reason: `unknown source: ${source}` };
  }
  const ctx = ctxOf(runtime, { status: onProgress });
  const cleanTarget = String(targetUsername ?? runtime.pageUsername ?? '').trim().replace(/^@+/, '') || null;

  // Provenance label: how the dashboard names where a lead came from.
  let sourceAccount;
  if (NEEDS_PROFILE.includes(source)) sourceAccount = cleanTarget ?? 'current-page';
  else if (source === CollectSource.POST_LIKERS || source === CollectSource.POST_COMMENTS) sourceAccount = shortcode ? `post/${shortcode}` : (runtime.pageUsername ?? 'current-page');
  else if (source === CollectSource.HASHTAG_GRID && tag) sourceAccount = `#${String(tag).replace(/^#+/, '')}`;
  else sourceAccount = runtime.pageUsername ?? 'current-page';

  let result;

  switch (source) {
    case CollectSource.FOLLOWERS:
    case CollectSource.FOLLOWING:
      result = await collectProfileListDom(ctx, {
        kind: source === CollectSource.FOLLOWERS ? 'followers' : 'following',
        targetUsername: cleanTarget,
        limit,
        signal: runtime.signal,
        onProgress,
      });
      break;

    case CollectSource.PROFILE_RECENT_LIKERS:
      result = await collectRecentPostLikersDom(ctx, {
        targetUsername: cleanTarget,
        limit,
        signal: runtime.signal,
        onProgress,
      });
      break;

    case CollectSource.POST_LIKERS:
      result = await collectPostLikersDom(ctx, {
        shortcode,
        limit,
        signal: runtime.signal,
        onProgress,
      });
      break;

    case CollectSource.POST_COMMENTS:
      result = await collectPostCommentsDom(ctx, {
        shortcode,
        limit,
        signal: runtime.signal,
        onProgress,
      });
      break;

    case CollectSource.OPEN_LIST_DIALOG:
      result = await collectOpenDialogDom(ctx, {
        limit,
        signal: runtime.signal,
        onProgress,
      });
      break;

    case CollectSource.HASHTAG_GRID:
      result = await collectHashtagDom(ctx, {
        tag,
        limit,
        signal: runtime.signal,
        onProgress,
      });
      break;

    case CollectSource.SAVED_GRID:
      result = scrapeGridAuthors(runtime.document, { limit });
      break;

    case CollectSource.CURRENT_PAGE:
    default:
      result = collectCurrentPage(runtime, { limit });
      break;
  }

  if (!result?.ok) {
    return {
      ok: false,
      rows: [],
      edges: [],
      reason: result?.reason ?? 'the source returned nothing',
      ...(result?.needsNavigation ? { needsNavigation: true, url: result.url } : {}),
      ...(result?.code ? { code: result.code } : {}),
      source,
    };
  }

  const built = toLeads({
    rows: result.rows ?? [],
    source,
    sourceAccount,
    workspaceId,
    weights,
    refId: result.refId ?? null,
    commentTexts: result.commentTexts ?? null,
    targetIsPrivate: false,
    // Keep visual on-screen order for dialog/grid reads; score-rank engagement sources.
    keepOrder: DOM_ONLY_SOURCES.includes(source) || source === CollectSource.CURRENT_PAGE,
  });

  return {
    ok: true,
    source,
    sourceAccount,
    target: cleanTarget ? { username: cleanTarget, id: targetUserId ? String(targetUserId) : null, isPrivate: false } : null,
    scored: built.leads,
    leads: built.leads.map((entry) => entry.lead),
    edges: built.edges,
    reason: built.leads.length ? null : 'the source returned rows but none had a username',
    pages: result.pages ?? null,
    strategy: result.strategy ?? 'browser-dom',
  };
}

/** A comment row becomes a person row; the text travels on the edge. */
export function commentToUserRow(comment) {
  return {
    pk: comment.ownerId || null,
    username: comment.username,
    full_name: comment.ownerName,
    commentText: comment.text,
    commentId: comment.id,
    commentLikes: comment.likes,
    commentCreatedAt: comment.createdAt,
  };
}

/** Whatever this page renders: an open dialog, a grid, or the profile itself. */
export function collectCurrentPage(runtime, { limit = 200 } = {}) {
  const document = runtime.document;
  const topDialog = findVisibleDialog(document);
  if (topDialog) {
    const { users } = extractDialogUsers(topDialog, { respectSuggestedBoundary: true });
    if (users.length) {
      const rows = users.slice(0, limit).map((u) => ({
        username: u.username,
        full_name: u.fullName ?? '',
        is_verified: Boolean(u.isVerified),
      }));
      return { ok: true, rows, reason: null, via: 'open list dialog' };
    }
  }
  const path = runtime.pathname;
  if (/^\/(explore\/tags|explore\/locations|saved)\b/.test(path)) {
    const grid = scrapeGridAuthors(document, { limit });
    if (grid.ok) return { ...grid, via: 'grid tiles' };
  }
  const scraped = scrapeProfileFromDom(document);
  if (scraped.ok) {
    const username = runtime.pageUsername ?? scraped.user.username;
    // Reshape into the v1 field names so the one normaliser in adapters.js is
    // the only place that decides what a user row looks like.
    const row = normaliseUserRow({
      pk: scraped.user.id || null,
      username,
      full_name: scraped.user.fullName,
      follower_count: scraped.user.followers,
      follow_count: scraped.user.following,
      profile_pic_url: scraped.user.profilePicUrl,
      is_private: scraped.user.isPrivate,
      is_verified: scraped.user.isVerified,
    });
    if (row.username) return { ok: true, rows: [row], reason: null, via: 'open profile', profile: scraped.user };
  }
  return { ok: false, rows: [], reason: 'this page renders no accounts to collect' };
}

/**
 * Turn collected rows into lead rows plus their provenance edges, and score them.
 *
 * The edge is what makes a second collection safe: `db.upsertEdge` keys on
 * leadKey + edgeType + sourceAccount + refId, so re-collecting the same post
 * updates timestamps instead of double-counting the signal.
 */
export function toLeads({ rows, source, sourceAccount, workspaceId, weights = {}, refId = null, commentTexts = null, targetIsPrivate = false, keepOrder = false }) {
  const edgeType = SOURCE_EDGE_TYPE[source] ?? EdgeType.PROFILE_CAPTURE;
  const byKey = new Map();
  // One representative comment per person for intent, but every comment for the
  // samples: a person who asked the price three times is a different lead from
  // one who asked once, and the dossier shows the words.
  const commentsByKey = new Map();
  const samplesByKey = new Map();
  for (const comment of commentTexts ?? []) {
    const commentKey = nameKey(comment.username);
    if (!commentsByKey.has(commentKey)) commentsByKey.set(commentKey, comment);
    if (!samplesByKey.has(commentKey)) samplesByKey.set(commentKey, []);
    const samples = samplesByKey.get(commentKey);
    if (samples.length < 5) {
      samples.push({ text: String(comment.text ?? '').slice(0, 300), likes: comment.likes ?? 0, at: comment.createdAt ?? null });
    }
  }

  for (const raw of rows ?? []) {
    const user = normaliseUserRows([raw])[0];
    if (!user?.username) continue;
    const key = nameKey(user.username);
    const comment = commentsByKey.get(key);
    const intent = comment ? classifyComment(comment.text ?? comment.commentText ?? '') : null;
    const buyerIntent = Boolean(intent && BUYER_INTENTS.includes(intent.primary));

    if (!byKey.has(key)) {
      byKey.set(key, {
        lead: {
          username: user.username,
          fullName: user.fullName,
          igUserId: user.id || null,
          isPrivate: user.isPrivate,
          isVerified: user.isVerified,
          avatarUrl: user.profilePicUrl,
          followers: user.followers,
          following: user.following,
          hasBuyerIntent: buyerIntent,
          targetIsPrivate,
        },
        edges: [],
        commentSamples: [],
        intentFlags: [],
      });
    }
    const entry = byKey.get(key);
    if (buyerIntent && !entry.lead.hasBuyerIntent) entry.lead.hasBuyerIntent = true;
    entry.edges.push({
      edgeType,
      sourceAccount,
      refId: refId ?? (raw?.refId ?? null),
      sample: comment ? String(comment.text ?? '').slice(0, 180) : null,
      intentFlags: intent ? [intent.primary] : [],
    });
    if (intent) entry.intentFlags.push(intent.primary);
  }

  for (const [key, entry] of byKey) {
    const samples = samplesByKey.get(key);
    if (samples?.length) {
      entry.commentSamples = samples.map((sample) => ({
        ...sample,
        intent: classifyComment(sample.text).primary,
      }));
    }
  }

  const leads = [...byKey.entries()].map(([key, entry]) => {
    const scored = scoreLead(entry.lead, entry.edges, weights);
    const primaryIntent = mostCommon(entry.intentFlags);
    return {
      key,
      lead: {
        username: entry.lead.username,
        fullName: entry.lead.fullName,
        igUserId: entry.lead.igUserId,
        isPrivate: entry.lead.isPrivate,
        isVerified: entry.lead.isVerified,
        isBusiness: false,
        biography: '',
        profilePicUrl: entry.lead.avatarUrl ?? '',
        followers: entry.lead.followers,
        following: entry.lead.following,
        priorityScore: scored.score,
        warmthTier: scored.tier,
        scoreParts: Object.fromEntries(scored.breakdown.map((row) => [row.label, row.points])),
        edgeCount: entry.edges.length,
        sourceAccounts: scored.uniqueSources.length ? scored.uniqueSources : [sourceAccount],
        edgeTypes: [edgeType],
        intentLabel: primaryIntent,
        hasBuyerIntent: entry.lead.hasBuyerIntent,
        buyerIntent: scored.buyerIntent,
        mega: scored.mega,
        workspaceId,
      },
      edges: entry.edges.map((edge) => ({
        workspaceId,
        leadKey: `${workspaceId}:${key}`,
        username: entry.lead.username,
        commentSamples: entry.commentSamples,
        ...edge,
      })),
      score: scored.score,
    };
  });

  if (!keepOrder) {
    leads.sort((a, b) => (b.score - a.score) || String(a.lead.username).localeCompare(String(b.lead.username)));
  }
  return { leads, edges: leads.flatMap((entry) => entry.edges) };
}

function mostCommon(values) {
  if (!values?.length) return null;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/* ------------------------------------------------------------------- commands */

/**
 * Three-phase relationship sync.
 *
 * Phase one reads who the target follows; phase two reads who follows the
 * viewer; phase three reads who the viewer follows. Only the intersection of
 * one and two proves a follow-back, and only a follow-back makes a DM a
 * conversation rather than a request. Phase three is what keeps "they follow me"
 * from being reported as mutual. When the viewer's follower list is large and
 * only a few accepts are in doubt, `planSync` chooses targeted `?query=` lookups
 * over a fifty-page re-read.
 */
export async function syncRelationships(runtime, {
  targetUsername = null,
  targetUserId = null,
  viewerId = null,
  followingLimit = 1000,
  myFollowersLimit = 1000,
  myFollowingLimit = 400,
  suspects = [],
  weights = {},
  workspaceId = 'default',
  onProgress = null,
} = {}) {
  const resolvedViewerId = viewerId ?? runtime.viewer?.id ?? null;
  if (!resolvedViewerId) {
    return { ok: false, reason: 'the logged-in account id is unknown; open instagram.com and let the extension probe it first' };
  }
  const target = await resolveTarget(runtime, { username: targetUsername ?? runtime.pageUsername, userId: targetUserId });
  if (!target.ok) return { ok: false, reason: target.reason, code: target.code ?? null };
  if (!target.profile.id) return { ok: false, reason: noNumericIdMessage(target.profile.username), code: 'no_numeric_id' };

  const ctx = ctxOf(runtime, { status: onProgress });
  onProgress?.({ phase: 'their-following', source: target.profile.username });
  let theirFollowing;
  try {
    theirFollowing = await fetchFriendshipList(ctx, {
      userId: target.profile.id,
      path: 'following',
      limit: followingLimit,
      signal: runtime.signal,
      onProgress: (progress) => onProgress?.({ phase: 'their-following', ...progress }),
    });
  } catch (error) {
    return { ok: false, reason: `their following list: ${error.message}`, phase: 'their-following', severity: error.severity ?? null };
  }
  theirFollowing = listReadWithCount(theirFollowing, target.profile.following, 'their-following');
  if (!theirFollowing.ok) return { ok: false, reason: `their following list: ${theirFollowing.reason}`, phase: 'their-following' };

  let myFollowers = { ok: true, rows: [], strategy: 'skipped' };
  if (suspects.length > 0 && suspects.length <= 8) {
    onProgress?.({ phase: 'accept-check', suspects: suspects.length });
    const rows = [];
    for (const username of suspects) {
      if (runtime.signal?.aborted) break;
      const hit = await lookupFollowship(ctx, { userId: resolvedViewerId, username, path: 'followers', signal: runtime.signal });
      if (hit.ok && hit.found) rows.push(hit.user);
    }
    myFollowers = { ok: true, rows, strategy: 'targeted' };
  } else {
    onProgress?.({ phase: 'my-followers' });
    try {
      myFollowers = await fetchFriendshipList(ctx, {
        userId: resolvedViewerId,
        path: 'followers',
        limit: myFollowersLimit,
        signal: runtime.signal,
        onProgress: (progress) => onProgress?.({ phase: 'my-followers', ...progress }),
      });
    } catch (error) {
      return { ok: false, reason: `your follower list: ${error.message}`, phase: 'my-followers', severity: error.severity ?? null };
    }
    myFollowers = listReadWithCount(myFollowers, runtime.viewer?.followers, 'my-followers');
    if (!myFollowers.ok) return { ok: false, reason: `your follower list: ${myFollowers.reason}`, phase: 'my-followers' };
  }

  // Phase three: who the viewer follows. Without it "mutual" can only mean
  // "they follow me", which is not the same fact and would put a cold stranger
  // in the warm-DM queue.
  onProgress?.({ phase: 'my-following' });
  let myFollowing = { ok: true, rows: [], strategy: 'skipped' };
  try {
    myFollowing = await fetchFriendshipList(ctx, {
      userId: resolvedViewerId,
      path: 'following',
      limit: myFollowingLimit,
      signal: runtime.signal,
      onProgress: (progress) => onProgress?.({ phase: 'my-following', ...progress }),
    });
  } catch (error) {
    return { ok: false, reason: `your following list: ${error.message}`, phase: 'my-following', severity: error.severity ?? null };
  }
  myFollowing = listReadWithCount(myFollowing, runtime.viewer?.following, 'my-following');
  if (!myFollowing.ok) return { ok: false, reason: `your following list: ${myFollowing.reason}`, phase: 'my-following' };

  const plan = planSync({ suspectCount: suspects.length, myFollowerCount: myFollowers.rows.length });
  const index = buildFollowerIndex({
    following: theirFollowing.rows,
    myFollowers: myFollowers.rows,
    iFollow: myFollowing.rows,
  });

  const rows = index.rows
    .filter((row) => row.kind !== RelationshipKind.NONE)
    .map((row) => ({
      username: row.user.username,
      fullName: row.user.fullName,
      igUserId: row.user.id || null,
      isPrivate: row.user.isPrivate,
      relationship: row.kind,
      relState: relStateFor(row),
      mutual: row.mutual,
      followsMe: row.theyFollowMe,
    }));

  const leads = toLeads({
    rows: rows.map((row) => ({ username: row.username, full_name: row.fullName, pk: row.igUserId, is_private: row.isPrivate })),
    source: CollectSource.FOLLOWING,
    sourceAccount: target.profile.username,
    workspaceId,
    weights,
  });

  return {
    ok: true,
    reason: null,
    target: { username: target.profile.username, id: target.profile.id, isPrivate: target.profile.isPrivate },
    viewerId: String(resolvedViewerId),
    strategy: myFollowers.strategy,
    plan,
    counts: {
      theirFollowing: theirFollowing.rows.length,
      myFollowers: myFollowers.rows.length,
      myFollowing: myFollowing.rows.length,
      mutual: index.mutualCount,
      followsMe: rows.filter((row) => row.followsMe).length,
      iFollowThem: rows.filter((row) => row.relationship === RelationshipKind.I_FOLLOW_THEM).length,
    },
    rows,
    leads: leads.leads,
    edges: leads.edges,
    followingStrategy: theirFollowing.strategy,
  };
}

/**
 * The command table. `bridge.runCommandLoop({ handlers: createHandlers(runtime) })`
 * is the whole content script: one loop, one run at a time, honest results.
 */
export function createHandlers(runtime, deps = {}) {
  const navigate = deps.navigate ?? null;

  /** True when this tab is not on the account we were asked to act on. */
  function wrongPage(username) {
    if (!username) return false;
    return nameKey(runtime.pageUsername) !== nameKey(username);
  }

  async function actOnProfile(payload, run) {
    const username = payload?.username ?? null;
    if (wrongPage(username)) {
      if (!navigate) return { ok: false, reason: `this tab is on ${runtime.pathname}, not /${username}/`, needsNavigation: true, url: profileUrl(username) };
      await navigate(profileUrl(username));
      const arrived = await waitFor(ctxOf(runtime), () => (nameKey(runtime.pageUsername) === nameKey(username) ? true : null), {
        timeoutMs: payload?.navigationTimeoutMs ?? 8000,
        signal: runtime.signal,
        label: `navigation to /${username}/`,
      });
      if (!arrived.found) return { ok: false, reason: arrived.reason, needsNavigation: true, url: profileUrl(username) };
    }
    return run();
  }

  return {
    [CommandType.PING]: async () => ({ pong: true, ...runtime.context() }),

    [CommandType.GET_CONTEXT]: async () => runtime.context(),

    [CommandType.PROBE]: async () => {
      const hasInjectedTransport = Boolean(runtime.deps.request || runtime.deps.fetchImpl);
      const probe = await runProbe({
        document: runtime.document,
        location: runtime.location,
        cookieString: runtime.deps.cookieString ?? runtime.document?.cookie ?? '',
        // In the real browser (no injected transport), NEVER call Instagram APIs:
        // viewer is detected strictly from live DOM + cookies.
        request: (runtime.deps.probeRequest === false || !hasInjectedTransport) ? null : runtime.request,
      });
      if (probe.viewer?.id || probe.viewer?.username) {
        runtime.viewer = {
          ...(runtime.viewer ?? {}),
          ...probe.viewer,
          id: probe.viewer.id || runtime.viewer?.id || '',
          username: probe.viewer.username || runtime.viewer?.username || '',
        };
      }
      runtime.refreshSession();
      return probe;
    },

    [CommandType.COLLECT_LEADS]: async (payload, ctx) => {
      const source = payload?.source ?? CollectSource.CURRENT_PAGE;
      const started = await beginRun(runtime, `collect:${source}`, { pacing: payload?.pacing, status: ctx.postStatus, refuseWhenLoggedOut: DOM_ONLY_SOURCES.includes(source) ? false : true });
      if (!started.ok) return started;
      try {
        const result = await collectFromSource(runtime, { ...payload, source, onProgress: ctx.postStatus });
        return result;
      } finally {
        runtime.endRun();
      }
    },

    [CommandType.SYNC_RELATIONSHIPS]: async (payload, ctx) => {
      const started = await beginRun(runtime, 'sync-relationships', { pacing: payload?.pacing, status: ctx.postStatus });
      if (!started.ok) return started;
      try {
        if (!runtime.viewer) await ensureViewer(runtime);
        const result = await syncRelationships(runtime, { ...payload, viewerId: payload?.viewerId ?? runtime.viewer?.id ?? null, onProgress: ctx.postStatus });
        return result;
      } finally {
        runtime.endRun();
      }
    },

    [CommandType.EXECUTE_FOLLOW]: async (payload, ctx) => actOnProfile(payload, async () => {
      const started = await beginRun(runtime, 'follow', { pacing: payload?.pacing, status: ctx?.postStatus });
      if (!started.ok) return started;
      try {
        const readyTimeoutMs = runtime.domReadyTimeoutMs ?? (runtime.wait ? 0 : 4500);
        const result = await executeFollow(ctxOf(runtime, { status: ctx?.postStatus }), { document: runtime.document, signal: runtime.signal, readyTimeoutMs });
        return { ...result, username: payload?.username ?? runtime.pageUsername, stateAfter: readRelationshipState(runtime.document).state };
      } finally {
        runtime.endRun();
      }
    }),

    [CommandType.EXECUTE_UNFOLLOW]: async (payload, ctx) => actOnProfile(payload, async () => {
      const started = await beginRun(runtime, 'unfollow', { pacing: payload?.pacing, status: ctx?.postStatus });
      if (!started.ok) return started;
      try {
        const readyTimeoutMs = runtime.domReadyTimeoutMs ?? (runtime.wait ? 0 : 4500);
        const result = await executeUnfollow(ctxOf(runtime, { status: ctx?.postStatus }), {
          document: runtime.document,
          signal: runtime.signal,
          readyTimeoutMs,
          allowRequested: payload?.cleanupAction === 'WITHDRAW_REQUEST',
        });
        return { ...result, username: payload?.username ?? runtime.pageUsername, stateAfter: readRelationshipState(runtime.document).state };
      } finally {
        runtime.endRun();
      }
    }),

    [CommandType.OPEN_THREAD]: async (payload, ctx) => actOnProfile(payload, async () => {
      const readyTimeoutMs = runtime.domReadyTimeoutMs ?? (runtime.wait ? 0 : 4500);
      const result = await openDm(ctxOf(runtime, { status: ctx?.postStatus }), {
        document: runtime.document,
        location: runtime.location,
        username: payload?.username ?? runtime.pageUsername,
        signal: runtime.signal,
        readyTimeoutMs,
      });
      if (!result.ok && result.needsNavigation && navigate) {
        const username = payload?.username ?? runtime.pageUsername;
        await navigate(directUrl(username));
        const arrived = await waitFor(ctxOf(runtime), () => (runtime.document.querySelector('[contenteditable="true"]') ? true : null), {
          timeoutMs: 8000,
          signal: runtime.signal,
          label: 'the direct thread',
        });
        if (!arrived.found) return { ...result, url: directUrl(username) };
        return {
          ok: true,
          outcome: 'done',
          via: 'navigation',
          url: directUrl(username),
          composerFound: Boolean(runtime.document.querySelector('[contenteditable="true"]')),
        };
      }
      return result;
    }),

    [CommandType.EXECUTE_DM]: async (payload, ctx = {}) => {
      const message = String(payload?.message ?? '');
      if (!message.trim()) return { ok: false, outcome: 'refused', reason: 'the message is empty' };
      const targetUsername = payload?.username ?? runtime.pageUsername ?? null;
      const targetKey = nameKey(payload?.username ?? '');
      const viewerUsername = payload?.viewerUsername ?? runtime.viewer?.username ?? null;
      const alreadyOpened = Boolean(payload?.alreadyOpened);
      const matchOpts = viewerUsername ? { viewerUsername } : {};

      const runDmFlow = async () => {
        const started = await beginRun(runtime, 'dm', { pacing: payload?.pacing, status: ctx?.postStatus });
        if (!started.ok) return started;
        try {
          const dmCtx = ctxOf(runtime, { status: ctx?.postStatus });
          const readyTimeoutMs = runtime.domReadyTimeoutMs ?? (runtime.wait ? 0 : 5000);
          const curPath = String(runtime.location?.pathname ?? runtime.pathname ?? '');
          let curSurface = findDmSurface(runtime.document, curPath);
          let trustedThread = alreadyOpened;

          // When the dashboard just followed a hard navigation to /direct/...
          // after clicking Message on the profile, the composer may still be
          // hydrating on this page — wait for it right here instead of
          // bouncing back to the profile.
          if (alreadyOpened && !curSurface?.editor) {
            const hydrateMs = Math.max(readyTimeoutMs, 6000);
            const hydrated = await waitFor(dmCtx, () => {
              const s = findDmSurface(runtime.document, String(runtime.location?.pathname ?? runtime.pathname ?? ''));
              if (s?.editor) return { surface: s };
              const scope = findOpenDmDock(runtime.document)
                ?? runtime.document?.querySelector?.('main, [role="main"]')
                ?? runtime.document?.body;
              const r = detectDmRestriction(scope);
              if (r) return { restriction: r };
              return null;
            }, { timeoutMs: hydrateMs, intervalMs: 150, signal: runtime.signal, label: 'DM composer on page' });
            if (hydrated.found && hydrated.value?.surface) {
              curSurface = hydrated.value.surface;
            }
          }

          // An already-open composer counts when:
          //  - alreadyOpened is set (we just landed here from clicking Message), OR
          //  - no specific target was requested, OR
          //  - we are on /direct/new/<target>, OR
          //  - the container visibly matches <target>, OR
          //  - we are on /direct/t/ and the container shows NO conflicting user
          //    (e.g. display-name-only header).
          const curMatch = curSurface?.container && targetKey
            ? dmContainerUserMatch(curSurface.container, targetKey, matchOpts)
            : null;
          let openedForTarget = Boolean(curSurface?.editor) && (
            alreadyOpened
            || !targetKey
            || curPath.toLowerCase().startsWith(`/direct/new/${targetKey}`)
            || Boolean(curMatch?.matched)
            || (curPath.toLowerCase().startsWith('/direct/t/') && curMatch?.foundUsers?.length === 0)
          );

          if (!openedForTarget) {
            const opened = await openDm(dmCtx, {
              document: runtime.document,
              location: runtime.location,
              username: targetUsername,
              viewerUsername,
              signal: runtime.signal,
              readyTimeoutMs,
            });
            if (!opened.ok) {
              // Never force navigation to the deprecated /direct/new/<user>/ URL
              // during an outreach run: if the profile offers no Message button
              // or Send message option, mark it skipped/unavailable so the
              // outreach runner moves smoothly to the next lead.
              const noMessagingOption = opened.outcome === 'refused' && Boolean(opened.needsNavigation);
              return {
                ...opened,
                ...(noMessagingOption ? { outcome: 'skipped', dmUnavailable: true } : {}),
                needsNavigation: false,
                username: targetUsername,
              };
            }
            openedForTarget = true;
            if (opened.openedByClick) trustedThread = true;
          }

          const finalPath = String(runtime.location?.pathname ?? runtime.pathname ?? '');
          const result = await executeDm(dmCtx, {
            document: runtime.document,
            message,
            username: targetUsername,
            viewerUsername,
            trustedThread,
            signal: runtime.signal,
            pathname: finalPath || (openedForTarget ? '/direct/' : ''),
            allowExisting: Boolean(payload?.allowExisting),
          });
          return { ...result, username: targetUsername, bytes: new TextEncoder().encode(message).length };
        } finally {
          runtime.endRun();
        }
      };

      // Act directly on the current page without bouncing back to /<user>/ when:
      //  - alreadyOpened is set and we are on /direct/ or a composer is visible, OR
      //  - no specific username was asked for and a DM composer is visible, OR
      //  - we are on /direct/new/<target>, OR
      //  - we are on /direct/t/... with a composer matching <target> (or showing
      //    no conflicting user, e.g. display-name-only header), OR
      //  - any page currently shows an open DM composer matching <target>.
      const pathLower = String(runtime.pathname ?? '').toLowerCase();
      const surface = findDmSurface(runtime.document, runtime.pathname);
      const hasComposer = Boolean(surface?.editor);
      const surfaceMatch = (surface?.container && targetKey)
        ? dmContainerUserMatch(surface.container, targetKey, matchOpts)
        : null;
      const onDirectForTarget = (alreadyOpened && (pathLower.startsWith('/direct') || hasComposer))
        || (!targetKey && hasComposer)
        || (Boolean(targetKey) && hasComposer && Boolean(surfaceMatch?.matched))
        || (Boolean(targetKey) && pathLower.startsWith(`/direct/new/${targetKey}`))
        || (Boolean(targetKey) && pathLower.startsWith('/direct/t/') && hasComposer && (
          directThreadMatchesUser(runtime.document, targetKey, matchOpts)
          || surfaceMatch?.foundUsers?.length === 0
        ));
      if (onDirectForTarget) return runDmFlow();
      return actOnProfile(payload, runDmFlow);
    },

    [CommandType.STOP]: async (payload) => runtime.stop(payload?.reason ?? 'stopped from the dashboard'),
  };
}

/**
 * Arm a run: refuse when the session or the tab cannot support it, then own the
 * abort controller and the pacer until `endRun`.
 */
export async function beginRun(runtime, kind, { pacing = {}, status = null, refuseWhenLoggedOut = true } = {}) {
  if (runtime.isBusy()) return { ok: false, reason: `a ${runtime.current} run is already in progress in this tab` };
  runtime.refreshSession?.();
  if (refuseWhenLoggedOut && !runtime.session.loggedIn) {
    return {
      ok: false,
      outcome: 'stopped',
      severity: 'session',
      loggedOut: true,
      reason: 'this tab is not logged in to Instagram; log in normally, then run again',
    };
  }
  runtime.beginRun(kind, { pacing, status });
  return { ok: true };
}

/**
 * Run one command with full error classification.
 *
 * The content loop never throws to the bridge: a stopped run, an account flag
 * and a transport failure all come back as `{ ok: false, reason }` with a
 * severity the dashboard can act on. "Stopped by the owner" and "Instagram
 * flagged the account" must not read the same in the UI.
 */
export async function runCommand(runtime, type, payload = {}, ctx = {}) {
  const handlers = runtime.handlers ?? createHandlers(runtime, ctx.deps ?? {});
  const handler = handlers[type];
  if (!handler) return { ok: false, reason: `this tab cannot handle ${type}`, severity: null };
  try {
    const value = await handler(payload, { postStatus: ctx.postStatus ?? (async () => {}), command: { type, payload } });
    return { ok: value?.ok !== false, reason: value?.reason ?? null, value, severity: value?.severity ?? null };
  } catch (error) {
    return { ok: false, ...classifyCommandError(error) };
  } finally {
    if (runtime.current) runtime.endRun();
  }
}

/**
 * One error shape for the bridge: `{ reason, value, severity }`.
 *
 * Classified by name rather than by `instanceof`, because a content script that
 * loaded its modules twice (Instagram's own SPA navigation can do it) would
 * otherwise report a stop as an unknown crash.
 */
export function classifyCommandError(error) {
  const name = error?.name ?? 'Error';
  const message = error?.message ?? 'unknown failure';
  if (name === 'PacingStopped' || error?.userFacing === true && name === 'PacingStopped') {
    return { reason: message, value: null, severity: 'stopped' };
  }
  if (name === 'PacingLimit') return { reason: message, value: null, severity: 'limit' };
  if (name === 'AccountFlagged') return { reason: message, value: null, severity: error?.severity ?? 'account' };
  if (name === 'ApiError') return { reason: message, value: null, severity: error?.severity ?? 'unknown' };
  if (name === 'AbortError') return { reason: 'the run was stopped', value: null, severity: 'stopped' };
  if (error?.userFacing === true) return { reason: message, value: null, severity: error?.severity ?? 'stopped' };
  return { reason: `${name}: ${message}`, value: null, severity: 'unknown' };
}

/**
 * An "empty list" refusal is a tier-chain verdict, not a fact: every read path
 * returned zero rows, so the code cannot tell a genuinely empty list from a
 * blocked one. The profile count resolves the ambiguity for free — if Instagram
 * says this account follows nobody, zero rows is the truth and the sync should
 * carry on rather than fail on a brand-new account.
 */
function listReadWithCount(result, knownCount, phase) {
  if (result?.ok) return result;
  const looksEmpty = /empty list/.test(String(result?.reason ?? ''));
  if (looksEmpty && Number(knownCount) === 0) {
    return { ok: true, rows: [], strategy: 'empty-confirmed', reason: null, phase };
  }
  return { ...result, phase };
}

/**
 * The logged-in viewer, probed once per tab and remembered.
 *
 * Accept detection and the relationship sync both need the viewer's numeric id, and
 * re-probing it on every command burns a read for something that cannot change
 * without a page reload.
 */
export async function ensureViewer(runtime) {
  runtime.refreshSession?.();
  if (runtime.viewer?.username || runtime.viewer?.id) return runtime.viewer;
  if (!runtime.session.loggedIn) return null;
  const fromDom = detectViewerFromDom(runtime.document, runtime.deps?.cookieString ?? runtime.document?.cookie ?? '');
  if (fromDom) {
    runtime.viewer = fromDom;
    return fromDom;
  }
  const hasInjectedTransport = Boolean(runtime.deps?.request || runtime.deps?.fetchImpl);
  if (runtime.deps?.probeRequest !== false && hasInjectedTransport) {
    const probed = await probeViewer({
      request: runtime.request,
      appId: runtime.appId,
      asbd: runtime.asbd,
      signal: runtime.signal,
    });
    runtime.viewer = probed;
    return probed;
  }
  return null;
}

/* ------------------------------------------------------------------ bootstrap */

/** A sleep that never keeps the process alive on its own. */
function sleepFor(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    if (typeof timer?.unref === 'function') timer.unref();
  });
}

/** How long to wait before bringing a dead command loop back. */
export const CONTENT_LOOP_RESTART_MS = 4000;

/** How many times the loop may die and come back before this tab gives up. */
export const CONTENT_LOOP_MAX_RESTARTS = 6;

/**
 * Everything this tab needs to serve the dashboard: a mailbox loop, the pill,
 * and a watcher that follows the owner to another account.
 *
 * Built as a factory with injected dependencies rather than as module-level
 * side effects, so the whole bootstrap is testable without a browser and so a
 * page that imports this module twice does not end up with two loops answering
 * the same mailbox (which would run every command twice).
 */
export function createContentBootstrap(deps = {}) {
  const chromeApi = 'chrome' in deps ? deps.chrome : (globalThis.chrome ?? null);
  const document = 'document' in deps ? deps.document : (globalThis.document ?? null);
  const location = deps.location ?? globalThis.location ?? null;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? sleepFor;
  const storage = deps.storage ?? (chromeApi?.storage?.local ? chromeStorageAdapter(chromeApi) : null);
  const runtime = deps.runtime ?? createContentRuntime({ ...deps, document, location, now });
  const restartMs = Number.isFinite(deps.restartMs) ? deps.restartMs : CONTENT_LOOP_RESTART_MS;
  const maxRestarts = Number.isFinite(deps.maxRestarts) ? deps.maxRestarts : CONTENT_LOOP_MAX_RESTARTS;

  const state = {
    workspaceId: null,
    bridge: null,
    signal: null,
    loop: null,
    launcher: null,
    listener: null,
    started: false,
    stopped: false,
    restarts: 0,
    reason: null,
    lastError: null,
    commands: 0,
  };

  const bridgeFor = deps.bridgeFor
    ?? ((workspaceId) => createBridge({
      storage,
      workspaceId,
      now,
      sleep,
      pollMs: deps.pollMs,
      commandTimeoutMs: deps.commandTimeoutMs,
    }));

  // No navigate function on purpose. A content script that sets location.href
  // destroys itself mid-command, so the tab answers "wrong profile, go here"
  // and the dashboard - which owns chrome.tabs - moves the tab and re-sends.
  const handlers = deps.handlers ?? createHandlers(runtime, { navigate: deps.navigate ?? null });

  async function readWorkspaceId() {
    if (deps.workspaceId) return String(deps.workspaceId);
    if (!storage) return 'default';
    try {
      const row = await storage.get(ACTIVE_WORKSPACE_KEY);
      return row?.workspaceId ? String(row.workspaceId) : 'default';
    } catch {
      return 'default';
    }
  }

  async function supervise(workspaceId) {
    let current = String(workspaceId ?? 'default');
    while (!state.stopped) {
      const bridge = bridgeFor(current);
      const signal = { aborted: false };
      state.bridge = bridge;
      state.workspaceId = current;
      state.signal = signal;
      let loopResult = null;
      const tabIdSym = Symbol.for('content_tab_id');
      const getTabId = deps.getTabId ?? (() => {
        const id = globalThis[tabIdSym];
        return id === null || id === undefined ? null : Number(id);
      });
      try {
        loopResult = await bridge.runCommandLoop({
          handlers,
          isBusy: () => runtime.isBusy(),
          signal,
          getTabId,
          onCommand: () => { state.commands += 1; },
        });
      } catch (error) {
        state.lastError = `${error?.name ?? 'Error'}: ${error?.message ?? error}`;
      }
      if (loopResult?.invalidated || storage?.isDead?.()) {
        state.stopped = true;
        try { state.pill?.stop?.(); } catch { /* already gone */ }
        return { stopped: true, invalidated: true, workspaceId: current };
      }
      if (state.stopped || signal.aborted) return { stopped: true, workspaceId: current };
      // A loop that ends on its own is a dead mailbox: the extension would stop
      // answering and the owner would see only a spinner. Bring it back, but not
      // forever - a page that kills it six times in a row has a real problem,
      // and the pill says so instead of burning the tab's CPU in a tight retry.
      state.restarts += 1;
      if (state.restarts > maxRestarts) {
        state.reason = `the mailbox stopped answering ${state.restarts - 1} times in a row; reload this Instagram tab`;
        return { stopped: false, gaveUp: true, reason: state.reason };
      }
      await sleep(restartMs);
      current = await readWorkspaceId();
    }
    return { stopped: true, workspaceId: current };
  }

  async function restartFor(workspaceId) {
    const id = String(workspaceId ?? 'default');
    if (id === state.workspaceId && state.loop) return state.workspaceId;
    if (state.signal) state.signal.aborted = true;
    const previous = state.loop;
    state.loop = null;
    if (previous) { try { await previous; } catch { /* the loop is already gone */ } }
    if (state.stopped) return id;
    state.restarts = 0;
    state.loop = supervise(id);
    return id;
  }

  /** Follow the owner to another account: a new workspace is a new mailbox. */
  function watchWorkspace() {
    const onChanged = chromeApi?.storage?.onChanged;
    if (typeof onChanged?.addListener !== 'function') return null;
    const listener = (changes, area) => {
      if (area && area !== 'local') return;
      const change = changes?.[ACTIVE_WORKSPACE_KEY];
      if (!change) return;
      const next = change.newValue?.workspaceId;
      if (!next || String(next) === state.workspaceId) return;
      void restartFor(String(next));
    };
    onChanged.addListener(listener);
    state.listener = listener;
    return listener;
  }

  function installPill() {
    if (deps.launcher === false) return null;
    const install = deps.installLauncher ?? installLauncher;
    const installedPill = install({
      document,
      location,
      now,
      tickMs: deps.launcherTickMs,
      setInterval: deps.setInterval,
      clearInterval: deps.clearInterval,
      addEventListener: deps.addEventListener,
      open: deps.open,
      getURL: deps.getURL,
      onAction: deps.onAction,
      readStatus: async () => (state.bridge ? state.bridge.readStatus() : null),
      onStop: () => {
        const stopped = runtime.stop('stopped from this tab');
        void state.bridge?.postStatus({ kind: 'run-end', ok: false, reason: 'Stopped from this tab.', at: now() });
        return stopped;
      },
    });
    state.launcher = installedPill;
    return installedPill;
  }

  async function start() {
    if (state.started) return { ok: true, alreadyStarted: true, workspaceId: state.workspaceId };
    if (!storage) {
      state.reason = 'this page has no extension storage, so it cannot talk to the CRM';
      return { ok: false, reason: state.reason };
    }
    state.started = true;
    const workspaceId = await readWorkspaceId();
    state.workspaceId = workspaceId;
    state.loop = supervise(workspaceId);
    watchWorkspace();
    installPill();
    return { ok: true, workspaceId };
  }

  function stop(reason = 'content bootstrap stopped') {
    state.stopped = true;
    state.reason = reason;
    if (state.signal) state.signal.aborted = true;
    runtime.stop(reason);
    try { state.launcher?.stop?.(); } catch { /* the pill is already gone */ }
    const onChanged = chromeApi?.storage?.onChanged;
    if (state.listener && typeof onChanged?.removeListener === 'function') onChanged.removeListener(state.listener);
    state.listener = null;
    return { stopped: true, reason, commands: state.commands };
  }

  return {
    runtime,
    state,
    start,
    stop,
    restartFor,
    readWorkspaceId,
    handlers,
    bridge: () => state.bridge,
    /** Run one command locally, without the mailbox. Used by the pill and tests. */
    run: (type, payload, ctx = {}) => runCommand(runtime, type, payload, { ...ctx, deps: { navigate: deps.navigate ?? null } }),
  };
}

/** The single installation for this page. */
let pageBootstrap = null;

/**
 * The entry point content.js calls.
 *
 * Never throws and never rejects: a content script that dies during bootstrap
 * takes the whole extension down with it, and the only visible symptom would be
 * a dashboard that waits forever. Everything is caught, reported to the console
 * and reflected in the returned object.
 */
export async function installMessageHandlers(deps = {}) {
  if (pageBootstrap) return pageBootstrap;
  try {
    const bootstrap = createContentBootstrap(deps);
    pageBootstrap = bootstrap;
    const started = await bootstrap.start();
    if (!started.ok) {
      /* keep instagram.com host console clean; status is exposed via storage bridge */
    }
    return bootstrap;
  } catch (error) {
    pageBootstrap = null;
    return { ok: false, reason: `${error?.name ?? 'Error'}: ${error?.message ?? error}`, start: async () => ({ ok: false }), stop: () => ({ stopped: true }) };
  }
}

/** Drop the page-level installation. Tests, and a tab that must start over. */
export function resetMessageHandlers() {
  const previous = pageBootstrap;
  pageBootstrap = null;
  try { previous?.stop?.('reset'); } catch { /* nothing to clean up */ }
  return previous ? true : false;
}
