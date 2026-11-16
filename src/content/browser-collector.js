/**
 * 100% Browser-driven, human-like DOM collection — ZERO Instagram API calls.
 *
 * Instead of sending private `/api/v1/` or `/graphql` fetch requests (which
 * Instagram rejects with HTTP 400 or rotates doc_ids on), this module drives
 * the real open instagram.com browser tab visibly in front of the owner:
 *
 *   - Moves a visible curved Bezier cursor onto real links and buttons
 *   - Clicks Followers, Following, recent posts, Likes counts and Load More
 *   - Scrolls modals and comment panes in natural multi-step wheel bursts
 *     with randomized pauses, occasional tiny scroll-backs and cursor drift
 *   - Reads usernames, display names and comments strictly from the live DOM
 *   - Stops before "Suggested for you" so suggested strangers are never mixed in
 *   - Halts immediately if Stop is clicked or an action-block modal appears
 *
 * Pure ES module with injected `ctx` (`document`, `location`, `wait`, `random`,
 * `signal`, `virtualCursor`) so every flow is unit-testable in Node.
 */

import { AccountFlagged, interruptibleWait } from './pacing.js';
import {
  humanArriveOnPage,
  humanClickTarget,
  humanDelayMs,
  humanNudgeScroll,
  humanPressEscape,
  humanScrollContainer,
} from './human.js';
import { waitFor } from './actions.js';
import {
  extractCommentsFromDom,
  extractDialogUsers,
  findActionBlockDialog,
  findCloseDialogButton,
  findCommentScrollContainer,
  findDialogLoadMoreButton,
  findDialogLoadingSpinner,
  findDialogs,
  findLoadMoreCommentsButton,
  findNextPostButton,
  findPostGridLinks,
  findPostLikersTrigger,
  findProfileListTrigger,
  findScrollableList,
  findVisibleDialog,
  gridTileAuthors,
  hasFollowerCapNotice,
  isPrivateAccountPage,
  profileLinkUsername,
  usernameFromPath,
} from './selectors.js';

export const IG_ORIGIN = 'https://www.instagram.com';

function cleanHandle(raw) {
  return String(raw ?? '').trim().replace(/^@+/, '').replace(/^\/+|\/+$/g, '');
}

export function profileUrlFor(username) {
  return `${IG_ORIGIN}/${encodeURIComponent(cleanHandle(username))}/`;
}

export function postUrlFor(shortcode) {
  const code = String(shortcode ?? '').trim().replace(/^\/+|\/+$/g, '');
  return `${IG_ORIGIN}/p/${encodeURIComponent(code)}/`;
}

export function tagUrlFor(tag) {
  const clean = String(tag ?? '').trim().replace(/^#+/, '');
  return `${IG_ORIGIN}/explore/tags/${encodeURIComponent(clean)}/`;
}

function sameHandle(a, b) {
  const la = cleanHandle(a).toLowerCase();
  const lb = cleanHandle(b).toLowerCase();
  return Boolean(la && lb && la === lb);
}

function checkBlocked(document) {
  const block = findActionBlockDialog(document);
  if (block) {
    throw new AccountFlagged({
      message: 'Instagram showed an action-block dialog ("Try Again Later"). Stopped immediately to protect your account.',
      reason: 'action_block',
      severity: 'account',
    });
  }
}

const NOOP_CURSOR = Object.freeze({
  show() {},
  move() {},
  pulseClick() {},
  label() {},
  hide() {},
});

function ensureCursor(ctx) {
  // Never inject foreign DOM overlay elements into Instagram during live runs;
  // use an injected cursor only when a caller/test explicitly supplies one.
  if (ctx.virtualCursor) return { cursor: ctx.virtualCursor, owned: false };
  return { cursor: NOOP_CURSOR, owned: false };
}

async function waitWhileLoading(ctx, scope, { maxWaitMs = 4200, signal = null } = {}) {
  const wait = ctx.wait ?? interruptibleWait;
  const stepMs = 350;
  let waited = 0;
  while (waited < maxWaitMs && !signal?.aborted) {
    if (!findDialogLoadingSpinner(scope)) break;
    await wait(stepMs, { signal });
    waited += stepMs;
  }
}

async function closeDialogHuman(ctx, dialog, { signal = null } = {}) {
  const closeBtn = findCloseDialogButton(dialog, ctx.document);
  if (closeBtn) {
    await humanClickTarget(ctx, closeBtn, { signal, label: 'Closing dialog…', hoverMinMs: 80, hoverMaxMs: 220 });
  } else {
    humanPressEscape(ctx.document);
  }
  const wait = ctx.wait ?? interruptibleWait;
  const random = typeof ctx.random === 'function' ? ctx.random : Math.random;
  await wait(humanDelayMs(240, 520, random), { signal });
}

/**
 * Shared human dialog scroller: accumulates unique users from any open
 * Followers, Following, or Likes modal while scrolling naturally.
 *
 * Handles all 2026 Instagram dialog behaviors:
 *   - Waits patiently while `<div role="progressbar">` / `Loading...` is active
 *   - Clicks in-dialog "See all followers" / "Load more" buttons (never "See All Suggestions")
 *   - Performs a scroll-up-then-down nudge when Instagram's virtual list stalls
 *   - Stops cleanly before "Suggested for you"
 *   - Treats Instagram-imposed partial caps ("Only X can see all followers", 50/100 limit)
 *     as a normal complete collection of everything Instagram made visible
 */
export async function scrollDialogForUsers(ctx, dialog, {
  limit = 200,
  excludeUsername = null,
  respectSuggestedBoundary = true,
  refId = null,
  phase = 'dialog',
  noun = 'people',
  maxStalls = 4,
  maxSteps = 120,
  onProgress = null,
  signal = null,
  existingMap = null,
} = {}) {
  const wait = ctx.wait ?? interruptibleWait;
  const random = typeof ctx.random === 'function' ? ctx.random : Math.random;
  const collected = existingMap ?? new Map();
  let stalls = 0;
  let steps = 0;
  let hitSuggested = false;
  let nudgedAtCount = -1;
  let loadMoreClicks = 0;

  const absorb = () => {
    const extracted = extractDialogUsers(dialog, { excludeUsername, respectSuggestedBoundary });
    if (extracted.hitSuggested) hitSuggested = true;
    let added = 0;
    for (const user of extracted.users) {
      const key = user.username.toLowerCase();
      if (collected.has(key)) continue;
      collected.set(key, {
        pk: null,
        username: user.username,
        full_name: user.fullName ?? '',
        is_verified: Boolean(user.isVerified),
        is_private: false,
        ...(refId ? { refId } : {}),
      });
      added += 1;
      if (collected.size >= limit) break;
    }
    return added;
  };

  // If the dialog opened with a loading spinner still active, let the first batch render
  await waitWhileLoading(ctx, dialog, { maxWaitMs: 3500, signal });
  if (signal?.aborted) {
    return { rows: [...collected.values()].slice(0, limit), steps, hitSuggested, capped: false };
  }

  // Initial read of whatever is already rendered in the dialog
  absorb();
  onProgress?.({
    phase,
    note: `Reading ${noun} (${collected.size}/${limit})…`,
    count: collected.size,
    limit,
    step: steps,
  });

  while (collected.size < limit && steps < maxSteps) {
    if (signal?.aborted) break;
    checkBlocked(ctx.document);
    if (hitSuggested && collected.size > 0) break;

    const scrollBox = findScrollableList(dialog) ?? dialog;
    steps += 1;
    const beforeSize = collected.size;

    // Click an explicit "See all followers" / "Load more" button if Instagram renders one
    const loadMoreBtn = loadMoreClicks < 8 ? findDialogLoadMoreButton(dialog) : null;
    if (loadMoreBtn) {
      loadMoreClicks += 1;
      onProgress?.({
        phase,
        note: `Loading more ${noun} (${collected.size}/${limit})…`,
        count: collected.size,
        limit,
        step: steps,
      });
      await humanClickTarget(ctx, loadMoreBtn, { signal, label: `Loading more ${noun}…` });
      await wait(humanDelayMs(700, 1400, random), { signal });
      await waitWhileLoading(ctx, dialog, { maxWaitMs: 4200, signal });
    } else {
      await humanScrollContainer(ctx, scrollBox, {
        signal,
        label: `Scrolling ${noun} (${collected.size}/${limit})…`,
      });
      if (signal?.aborted) break;
      await wait(humanDelayMs(650, 1450, random), { signal });
      await waitWhileLoading(ctx, dialog, { maxWaitMs: 4200, signal });
    }

    if (signal?.aborted) break;

    let added = absorb();
    onProgress?.({
      phase,
      note: `Reading ${noun} · ${collected.size}/${limit} collected`,
      count: collected.size,
      limit,
      step: steps,
    });

    if (collected.size >= limit) break;
    if (hitSuggested && collected.size > 0) break;

    if (added === 0 && collected.size === beforeSize) {
      stalls += 1;

      // On first stall at a given count, try a gentle scroll-up-then-down nudge
      // (wakes up Instagram's lazy list IntersectionObserver when it sticks)
      if (nudgedAtCount !== collected.size && !signal?.aborted) {
        nudgedAtCount = collected.size;
        await humanNudgeScroll(ctx, scrollBox, { signal, label: `Refreshing ${noun}…` });
        await wait(humanDelayMs(750, 1550, random), { signal });
        await waitWhileLoading(ctx, dialog, { maxWaitMs: 4200, signal });
        added = absorb();
        if (added > 0) {
          stalls = 0;
          onProgress?.({
            phase,
            note: `Reading ${noun} · ${collected.size}/${limit} collected`,
            count: collected.size,
            limit,
            step: steps,
          });
          continue;
        }
      }

      // If Instagram explicitly caps visible followers ("Only X can see all followers")
      // and a nudge loaded nothing more, stop gracefully right away.
      if (hasFollowerCapNotice(dialog) && stalls >= 2) break;
      if (stalls >= maxStalls) break;
    } else {
      stalls = 0;
    }
  }

  const rows = [...collected.values()].slice(0, limit);
  const capped = hasFollowerCapNotice(dialog) || (rows.length > 0 && rows.length < limit && !signal?.aborted);
  return {
    rows,
    steps,
    hitSuggested,
    capped,
  };
}

/* ------------------------------------------- 1. Followers / Following via DOM */

/**
 * Collect Followers or Following from a profile by visibly clicking the link
 * on instagram.com and human-scrolling the rendered dialog. Zero API calls.
 */
export async function collectProfileListDom(ctx, {
  kind = 'followers',
  targetUsername = null,
  limit = 200,
  onProgress = null,
  signal = null,
} = {}) {
  const document = ctx.document;
  const pathname = String(ctx.location?.pathname ?? document?.location?.pathname ?? '');
  const currentUser = usernameFromPath(pathname);
  const target = cleanHandle(targetUsername || currentUser);
  if (!target) {
    return { ok: false, rows: [], reason: 'Enter a profile username or open a profile page first.' };
  }

  // Must be on the target profile page first so the browser visits it visibly.
  if (!sameHandle(currentUser, target)) {
    return {
      ok: false,
      rows: [],
      needsNavigation: true,
      url: profileUrlFor(target),
      reason: `Opening @${target} in your browser…`,
    };
  }

  const { cursor, owned } = ensureCursor(ctx);
  const wait = ctx.wait ?? interruptibleWait;
  const random = typeof ctx.random === 'function' ? ctx.random : Math.random;
  const listKind = kind === 'following' ? 'following' : 'followers';
  const phase = listKind;

  try {
    checkBlocked(document);
    cursor.show(`Viewing @${target}…`);
    onProgress?.({ phase, note: `Looking at @${target}…` });
    await humanArriveOnPage(ctx, { signal, label: `Viewing @${target}…` });
    if (signal?.aborted) return { ok: false, rows: [], reason: 'Stopped by owner.' };

    // Wait briefly for the profile header & followers/following link to render
    const triggerWait = await waitFor(
      ctx,
      () => findProfileListTrigger(document, listKind),
      { timeoutMs: ctx.domTimeoutMs ?? 8000, intervalMs: 250, signal, label: `the ${listKind} link on @${target}` },
    );

    if (!triggerWait.found) {
      if (isPrivateAccountPage(document)) {
        return { ok: false, rows: [], reason: `@${target} is a private account; Instagram hides their ${listKind} list.` };
      }
      return {
        ok: false,
        rows: [],
        reason: `Could not find the ${listKind} button on @${target}'s page. Make sure the profile loaded and you are logged in.`,
      };
    }

    onProgress?.({ phase, note: `Opening @${target}'s ${listKind} list…` });
    const clicked = await humanClickTarget(ctx, triggerWait.value, {
      signal,
      label: `Clicking ${listKind}…`,
    });
    if (!clicked || signal?.aborted) return { ok: false, rows: [], reason: 'Stopped by owner.' };

    // Wait for Instagram's followers/following modal to appear & render rows
    const expectedLabel = listKind === 'following'
      ? /^(following|أتابع|يتابع|تتابعه)$/i
      : /^(followers|المتابعون|المتابعين)$/i;
    const dialogWait = await waitFor(
      ctx,
      () => {
        const dlg = findVisibleDialog(document, { ariaLabel: expectedLabel }) ?? findVisibleDialog(document);
        if (!dlg) return null;
        const { users } = extractDialogUsers(dlg, { excludeUsername: target });
        if (users.length > 0 || findScrollableList(dlg) || findDialogLoadingSpinner(dlg) || hasFollowerCapNotice(dlg)) {
          return dlg;
        }
        return null;
      },
      { timeoutMs: ctx.domTimeoutMs ?? 9000, intervalMs: 250, signal, label: `the ${listKind} dialog` },
    );

    if (!dialogWait.found) {
      if (isPrivateAccountPage(document)) {
        return { ok: false, rows: [], reason: `@${target} is private or hides their ${listKind} list.` };
      }
      return {
        ok: false,
        rows: [],
        reason: `Clicked ${listKind} on @${target}, but Instagram did not open the list (the account may hide it or require login).`,
      };
    }

    const dialog = dialogWait.value;
    // Brief human pause as the list pops open
    await wait(humanDelayMs(450, 950, random), { signal });

    const scraped = await scrollDialogForUsers(ctx, dialog, {
      limit,
      excludeUsername: target,
      respectSuggestedBoundary: true,
      phase,
      noun: listKind,
      onProgress,
      signal,
    });

    if (!signal?.aborted) {
      await closeDialogHuman(ctx, dialog, { signal });
    }

    return {
      ok: scraped.rows.length > 0,
      rows: scraped.rows,
      pages: Math.max(1, scraped.steps),
      strategy: 'browser-dom',
      reason: scraped.rows.length ? null : `No ${listKind} were visible in @${target}'s list.`,
    };
  } finally {
    if (owned) cursor.hide();
  }
}

/* ------------------------------------------- 2. Recent Post Likers via DOM */

/**
 * Collect people who liked an account's recent posts by visibly opening the
 * profile, clicking into recent posts one by one, clicking each post's Likes
 * trigger, and human-scrolling the Likes dialog. Zero API calls.
 */
export async function collectRecentPostLikersDom(ctx, {
  targetUsername = null,
  limit = 200,
  maxPosts = 6,
  onProgress = null,
  signal = null,
} = {}) {
  const document = ctx.document;
  const pathname = String(ctx.location?.pathname ?? document?.location?.pathname ?? '');
  const currentUser = usernameFromPath(pathname);
  const target = cleanHandle(targetUsername || currentUser);
  if (!target) {
    return { ok: false, rows: [], reason: 'Enter a profile username or open a profile page first.' };
  }

  if (!sameHandle(currentUser, target)) {
    return {
      ok: false,
      rows: [],
      needsNavigation: true,
      url: profileUrlFor(target),
      reason: `Opening @${target} in your browser…`,
    };
  }

  const { cursor, owned } = ensureCursor(ctx);
  const wait = ctx.wait ?? interruptibleWait;
  const random = typeof ctx.random === 'function' ? ctx.random : Math.random;
  const phase = 'profile_recent_likers';

  try {
    checkBlocked(document);
    cursor.show(`Browsing @${target}'s posts…`);
    onProgress?.({ phase, note: `Looking at @${target}'s profile…` });
    await humanArriveOnPage(ctx, { signal, label: `Browsing @${target}…` });
    if (signal?.aborted) return { ok: false, rows: [], reason: 'Stopped by owner.' };

    if (isPrivateAccountPage(document)) {
      return { ok: false, rows: [], code: 'no_recent_posts', reason: `@${target} is a private account; posts are hidden.` };
    }

    // Gentle scroll down into the post grid if posts aren't immediately visible
    let gridPosts = findPostGridLinks(document, maxPosts);
    if (!gridPosts.length) {
      const scroller = document.scrollingElement ?? document.documentElement ?? document.body;
      if (scroller) {
        await humanScrollContainer(ctx, scroller, { signal, ratioMin: 0.35, ratioMax: 0.6, allowMicroBehaviors: false, label: 'Scrolling to posts…' });
      }
      const postsWait = await waitFor(
        ctx,
        () => {
          const found = findPostGridLinks(document, maxPosts);
          return found.length ? found : null;
        },
        { timeoutMs: ctx.domTimeoutMs ?? 7000, intervalMs: 250, signal, label: `posts on @${target}` },
      );
      gridPosts = postsWait.found ? postsWait.value : [];
    }

    if (!gridPosts.length) {
      return {
        ok: false,
        rows: [],
        code: 'no_recent_posts',
        reason: `@${target} has no visible recent posts on this page.`,
      };
    }

    const totalPosts = Math.min(maxPosts, gridPosts.length);
    const collected = new Map();
    const perPostTarget = Math.max(10, Math.ceil(limit / totalPosts) + 4);
    let postsVisited = 0;

    // Open the first recent post visibly with the cursor
    onProgress?.({ phase, note: `Opening post 1 of ${totalPosts}…`, count: 0, limit });
    await humanClickTarget(ctx, gridPosts[0].element, { signal, label: `Opening post 1/${totalPosts}…` });

    const modalWait = await waitFor(
      ctx,
      () => findVisibleDialog(document),
      { timeoutMs: ctx.domTimeoutMs ?? 7000, intervalMs: 250, signal, label: 'post dialog' },
    );

    let postDialog = modalWait.found ? modalWait.value : null;

    for (let idx = 0; idx < totalPosts && collected.size < limit; idx += 1) {
      if (signal?.aborted) break;
      checkBlocked(document);
      postsVisited += 1;
      const postRef = gridPosts[idx]?.shortcode ?? `post_${idx + 1}`;
      const postScope = postDialog ?? document;

      // Brief human glance at the post before clicking likes
      await wait(humanDelayMs(550, 1250, random), { signal });
      if (signal?.aborted) break;

      const likesWait = await waitFor(
        ctx,
        () => findPostLikersTrigger(postScope),
        { timeoutMs: ctx.domTimeoutMs ?? 4500, intervalMs: 200, signal, label: 'likes count' },
      );

      if (likesWait.found) {
        const dialogCountBefore = findDialogs(document).length;
        onProgress?.({
          phase,
          note: `Post ${idx + 1}/${totalPosts}: opening likers…`,
          count: collected.size,
          limit,
        });
        await humanClickTarget(ctx, likesWait.value, {
          signal,
          label: `Post ${idx + 1}/${totalPosts}: clicking likes…`,
        });

        // Wait for the Likes dialog (usually stacked above the post modal)
        const likesDlgWait = await waitFor(
          ctx,
          () => {
            const labeled = findVisibleDialog(document, { ariaLabel: /^(likes|الإعجابات|تسجيلات الإعجاب)$/i });
            if (labeled && labeled !== postDialog) {
              const { users } = extractDialogUsers(labeled, { excludeUsername: target, respectSuggestedBoundary: false });
              if (users.length > 0 || findScrollableList(labeled) || findDialogLoadingSpinner(labeled)) return labeled;
            }
            const dialogs = findDialogs(document);
            if (dialogs.length > dialogCountBefore) {
              const top = dialogs[dialogs.length - 1];
              const { users } = extractDialogUsers(top, { excludeUsername: target, respectSuggestedBoundary: false });
              if (users.length > 0 || findScrollableList(top) || findDialogLoadingSpinner(top)) return top;
            }
            const top = findVisibleDialog(document);
            if (top && top !== postDialog) return top;
            return null;
          },
          { timeoutMs: ctx.domTimeoutMs ?? 7000, intervalMs: 250, signal, label: 'likes dialog' },
        );

        if (likesDlgWait.found) {
          const likesDialog = likesDlgWait.value;
          const postCap = Math.min(limit, collected.size + perPostTarget);
          await scrollDialogForUsers(ctx, likesDialog, {
            limit: postCap,
            excludeUsername: target,
            respectSuggestedBoundary: false,
            refId: postRef,
            phase,
            noun: `likers (post ${idx + 1}/${totalPosts})`,
            maxStalls: 4,
            onProgress,
            signal,
            existingMap: collected,
          });
          if (!signal?.aborted) {
            await closeDialogHuman(ctx, likesDialog, { signal });
          }
        }
      } else {
        onProgress?.({
          phase,
          note: `Post ${idx + 1}/${totalPosts}: likes hidden or unavailable, moving on…`,
          count: collected.size,
          limit,
        });
      }

      if (collected.size >= limit || idx >= totalPosts - 1 || signal?.aborted) break;

      // Step to the next recent post (prefer Instagram's Next arrow inside modal)
      const nextBtn = findNextPostButton(document);
      if (nextBtn && postDialog) {
        onProgress?.({
          phase,
          note: `Opening post ${idx + 2} of ${totalPosts}…`,
          count: collected.size,
          limit,
        });
        await humanClickTarget(ctx, nextBtn, { signal, label: `Next post (${idx + 2}/${totalPosts})…` });
        await wait(humanDelayMs(700, 1400, random), { signal });
        postDialog = findVisibleDialog(document) ?? postDialog;
      } else {
        // Fallback: close current post modal and click the next thumbnail in grid
        if (postDialog) {
          await closeDialogHuman(ctx, postDialog, { signal });
          postDialog = null;
        }
        const nextPost = gridPosts[idx + 1];
        if (!nextPost?.element) break;
        await humanClickTarget(ctx, nextPost.element, { signal, label: `Opening post ${idx + 2}/${totalPosts}…` });
        const reopened = await waitFor(ctx, () => findVisibleDialog(document), { timeoutMs: ctx.domTimeoutMs ?? 6000, intervalMs: 250, signal, label: 'next post dialog' });
        postDialog = reopened.found ? reopened.value : null;
      }
    }

    // Close the post modal cleanly when finished
    if (postDialog && !signal?.aborted) {
      await closeDialogHuman(ctx, postDialog, { signal });
    }

    const rows = [...collected.values()].slice(0, limit);
    return {
      ok: rows.length > 0,
      rows,
      pages: postsVisited,
      strategy: 'browser-dom',
      reason: rows.length
        ? null
        : `Checked ${postsVisited} recent post(s) on @${target}, but none exposed a clickable likers list (likes may be hidden by the author).`,
    };
  } finally {
    if (owned) cursor.hide();
  }
}

/* ------------------------------------------- 3. Single Post Likers via DOM */

/**
 * Collect everyone who liked one post/reel by visibly opening it, clicking the
 * Likes trigger, and human-scrolling the Likes dialog. Zero API calls.
 */
export async function collectPostLikersDom(ctx, {
  shortcode = null,
  limit = 200,
  onProgress = null,
  signal = null,
} = {}) {
  const document = ctx.document;
  const pathname = String(ctx.location?.pathname ?? document?.location?.pathname ?? '');
  const cleanCode = String(shortcode ?? '').trim();

  if (cleanCode && !pathname.includes(`/${cleanCode}`)) {
    return {
      ok: false,
      rows: [],
      needsNavigation: true,
      url: postUrlFor(cleanCode),
      reason: `Opening post ${cleanCode} in your browser…`,
    };
  }

  const { cursor, owned } = ensureCursor(ctx);
  const phase = 'post_likers';

  try {
    checkBlocked(document);
    cursor.show('Reading post…');
    onProgress?.({ phase, note: 'Opening post likes…' });
    await humanArriveOnPage(ctx, { signal, label: 'Viewing post…' });
    if (signal?.aborted) return { ok: false, rows: [], reason: 'Stopped by owner.' };

    const triggerWait = await waitFor(
      ctx,
      () => findPostLikersTrigger(document),
      { timeoutMs: ctx.domTimeoutMs ?? 8000, intervalMs: 250, signal, label: 'the likes link on this post' },
    );

    if (!triggerWait.found) {
      return {
        ok: false,
        rows: [],
        reason: 'Could not find a clickable likes button on this post (likes may be hidden or this post has none yet).',
      };
    }

    await humanClickTarget(ctx, triggerWait.value, { signal, label: 'Clicking likes…' });

    const dialogWait = await waitFor(
      ctx,
      () => {
        const dlg = findVisibleDialog(document, { ariaLabel: /^(likes|الإعجابات|تسجيلات الإعجاب)$/i }) ?? findVisibleDialog(document);
        if (!dlg) return null;
        const { users } = extractDialogUsers(dlg, { respectSuggestedBoundary: false });
        if (users.length > 0 || findScrollableList(dlg) || findDialogLoadingSpinner(dlg)) return dlg;
        return null;
      },
      { timeoutMs: ctx.domTimeoutMs ?? 8000, intervalMs: 250, signal, label: 'the Likes dialog' },
    );

    if (!dialogWait.found) {
      return { ok: false, rows: [], reason: 'Instagram did not open the Likes list for this post.' };
    }

    const scraped = await scrollDialogForUsers(ctx, dialogWait.value, {
      limit,
      respectSuggestedBoundary: false,
      refId: cleanCode || null,
      phase,
      noun: 'likers',
      onProgress,
      signal,
    });

    if (!signal?.aborted) {
      await closeDialogHuman(ctx, dialogWait.value, { signal });
    }

    return {
      ok: scraped.rows.length > 0,
      rows: scraped.rows,
      pages: Math.max(1, scraped.steps),
      refId: cleanCode || null,
      strategy: 'browser-dom',
      reason: scraped.rows.length ? null : 'No likers were visible in this post’s Likes list.',
    };
  } finally {
    if (owned) cursor.hide();
  }
}

/* ------------------------------------------- 4. Single Post Commenters via DOM */

/**
 * Collect commenters + full comment text on a post/reel by visibly scrolling
 * the comments pane and clicking "Load more comments" with the human cursor.
 * Feeds comment texts directly into buyer-intent scoring. Zero API calls.
 */
export async function collectPostCommentsDom(ctx, {
  shortcode = null,
  limit = 200,
  onProgress = null,
  signal = null,
} = {}) {
  const document = ctx.document;
  const pathname = String(ctx.location?.pathname ?? document?.location?.pathname ?? '');
  const cleanCode = String(shortcode ?? '').trim();

  if (cleanCode && !pathname.includes(`/${cleanCode}`)) {
    return {
      ok: false,
      rows: [],
      needsNavigation: true,
      url: postUrlFor(cleanCode),
      reason: `Opening post ${cleanCode} in your browser…`,
    };
  }

  const { cursor, owned } = ensureCursor(ctx);
  const wait = ctx.wait ?? interruptibleWait;
  const random = typeof ctx.random === 'function' ? ctx.random : Math.random;
  const phase = 'post_comments';

  try {
    checkBlocked(document);
    cursor.show('Reading comments…');
    onProgress?.({ phase, note: 'Reading comments on this post…' });
    await humanArriveOnPage(ctx, { signal, label: 'Reading comments…' });
    if (signal?.aborted) return { ok: false, rows: [], reason: 'Stopped by owner.' };

    // Wait briefly for comments/timestamps to render
    await waitFor(
      ctx,
      () => (extractCommentsFromDom(document).length > 0 ? true : null),
      { timeoutMs: ctx.domTimeoutMs ?? 6000, intervalMs: 250, signal, label: 'post comments' },
    );

    const byCommentKey = new Map();
    const usersByKey = new Map();
    let stalls = 0;
    let steps = 0;
    let loadMoreNoGain = 0;
    let nudgedAtCount = -1;

    const absorbComments = () => {
      const found = extractCommentsFromDom(document);
      let added = 0;
      for (const comment of found) {
        const cKey = `${comment.username.toLowerCase()}|${comment.text.slice(0, 80)}`;
        if (!byCommentKey.has(cKey)) {
          byCommentKey.set(cKey, {
            id: cKey,
            username: comment.username,
            ownerName: '',
            ownerId: null,
            text: comment.text,
            likes: 0,
            createdAt: comment.createdAt,
          });
        }
        const uKey = comment.username.toLowerCase();
        if (!usersByKey.has(uKey)) {
          usersByKey.set(uKey, {
            pk: null,
            username: comment.username,
            full_name: '',
            commentText: comment.text,
            commentId: cKey,
            commentLikes: 0,
            commentCreatedAt: comment.createdAt,
            ...(cleanCode ? { refId: cleanCode } : {}),
          });
          added += 1;
        }
        if (usersByKey.size >= limit) break;
      }
      return added;
    };

    absorbComments();
    onProgress?.({ phase, note: `Read ${usersByKey.size}/${limit} commenters…`, count: usersByKey.size, limit, step: 0 });

    while (usersByKey.size < limit && steps < 60) {
      if (signal?.aborted) break;
      checkBlocked(document);
      steps += 1;
      const before = usersByKey.size;

      // Guard against Instagram's known loop where "Load more comments" stays
      // visible without returning new unique commenters.
      const loadMore = loadMoreNoGain < 2 ? findLoadMoreCommentsButton(document) : null;
      if (loadMore) {
        onProgress?.({ phase, note: `Loading more comments (${usersByKey.size}/${limit})…`, count: usersByKey.size, limit, step: steps });
        await humanClickTarget(ctx, loadMore, { signal, label: 'Loading more comments…' });
        await wait(humanDelayMs(850, 1750, random), { signal });
        await waitWhileLoading(ctx, document, { maxWaitMs: 3500, signal });
      } else {
        const container = findCommentScrollContainer(document) ?? document.scrollingElement ?? document.documentElement;
        if (!container) break;
        await humanScrollContainer(ctx, container, { signal, label: `Scrolling comments (${usersByKey.size}/${limit})…` });
        await wait(humanDelayMs(700, 1450, random), { signal });
        await waitWhileLoading(ctx, document, { maxWaitMs: 3500, signal });
      }

      if (signal?.aborted) break;
      let added = absorbComments();
      onProgress?.({ phase, note: `Read ${usersByKey.size}/${limit} commenters…`, count: usersByKey.size, limit, step: steps });

      if (added === 0 && usersByKey.size === before) {
        if (loadMore) loadMoreNoGain += 1;
        stalls += 1;
        const container = findCommentScrollContainer(document);
        if (container && nudgedAtCount !== usersByKey.size && !signal?.aborted) {
          nudgedAtCount = usersByKey.size;
          await humanNudgeScroll(ctx, container, { signal, label: 'Loading comments…' });
          await wait(humanDelayMs(700, 1400, random), { signal });
          await waitWhileLoading(ctx, document, { maxWaitMs: 3500, signal });
          added = absorbComments();
          if (added > 0) {
            stalls = 0;
            loadMoreNoGain = 0;
            continue;
          }
        }
        if (stalls >= 4) break;
      } else {
        stalls = 0;
        if (loadMore) loadMoreNoGain = 0;
      }
    }

    const rows = [...usersByKey.values()].slice(0, limit);
    const commentTexts = [...byCommentKey.values()];

    return {
      ok: rows.length > 0,
      rows,
      commentTexts,
      pages: Math.max(1, steps),
      refId: cleanCode || null,
      strategy: 'browser-dom',
      reason: rows.length ? null : 'No comments could be read on this post.',
    };
  } finally {
    if (owned) cursor.hide();
  }
}

/* ------------------------------------------- 5. Hashtag / Open Dialog via DOM */

/**
 * Collect accounts from a hashtag page visibly in the browser.
 * Reads inline tile authors first; if Instagram renders image-only thumbnails
 * without inline handles, visibly opens posts in the modal to capture each
 * post's author handle. Zero API calls.
 */
export async function collectHashtagDom(ctx, {
  tag = null,
  limit = 100,
  onProgress = null,
  signal = null,
} = {}) {
  const document = ctx.document;
  const pathname = String(ctx.location?.pathname ?? document?.location?.pathname ?? '');
  const cleanTag = String(tag ?? '').trim().replace(/^#+/, '');

  if (cleanTag) {
    const wanted = `/explore/tags/${encodeURIComponent(cleanTag)}`;
    if (!pathname.toLowerCase().startsWith(wanted.toLowerCase())) {
      return {
        ok: false,
        rows: [],
        needsNavigation: true,
        url: tagUrlFor(cleanTag),
        reason: `Opening #${cleanTag} in your browser…`,
      };
    }
  }

  const { cursor, owned } = ensureCursor(ctx);
  const wait = ctx.wait ?? interruptibleWait;
  const random = typeof ctx.random === 'function' ? ctx.random : Math.random;
  const phase = 'hashtag_grid';

  try {
    checkBlocked(document);
    cursor.show(cleanTag ? `Browsing #${cleanTag}…` : 'Browsing hashtag…');
    await humanArriveOnPage(ctx, { signal, label: cleanTag ? `Browsing #${cleanTag}…` : 'Browsing grid…' });

    const collected = new Map();
    const pushUser = (username, fullName = '') => {
      const clean = cleanHandle(username);
      if (!clean) return;
      const key = clean.toLowerCase();
      if (collected.has(key)) return;
      collected.set(key, { pk: null, username: clean, full_name: fullName, is_private: false, is_verified: false });
    };

    // 1. Check direct tile authors first (fast, zero modal clicks needed if present)
    for (const row of gridTileAuthors(document)) {
      pushUser(row.username);
      if (collected.size >= limit) break;
    }

    // 2. If grid only shows image tiles without author links, visibly click through posts
    if (collected.size < limit) {
      const postLinks = findPostGridLinks(document, Math.min(limit, 18));
      if (postLinks.length > 0 && collected.size === 0) {
        onProgress?.({ phase, note: `Opening posts in #${cleanTag || 'grid'}…`, count: 0, limit });
        await humanClickTarget(ctx, postLinks[0].element, { signal, label: 'Opening first post…' });
        const dlgWait = await waitFor(ctx, () => findVisibleDialog(document), { timeoutMs: ctx.domTimeoutMs ?? 6000, intervalMs: 250, signal, label: 'hashtag post dialog' });
        let postDialog = dlgWait.found ? dlgWait.value : null;

        for (let i = 0; i < postLinks.length && collected.size < limit; i += 1) {
          if (signal?.aborted || !postDialog) break;
          checkBlocked(document);
          await wait(humanDelayMs(450, 950, random), { signal });

          // Author link is typically in the post dialog header
          const header = postDialog.querySelector?.('header') ?? postDialog;
          for (const link of header.querySelectorAll?.('a') ?? []) {
            const handle = profileLinkUsername(link.getAttribute?.('href') ?? '');
            if (handle) {
              pushUser(handle);
              break;
            }
          }
          onProgress?.({ phase, note: `Collected ${collected.size}/${limit} authors…`, count: collected.size, limit, step: i + 1 });

          if (collected.size >= limit || i >= postLinks.length - 1) break;
          const nextBtn = findNextPostButton(document);
          if (!nextBtn) break;
          await humanClickTarget(ctx, nextBtn, { signal, label: `Next post (${i + 2})…` });
          await wait(humanDelayMs(600, 1200, random), { signal });
          postDialog = findVisibleDialog(document) ?? postDialog;
        }

        if (postDialog && !signal?.aborted) {
          await closeDialogHuman(ctx, postDialog, { signal });
        }
      }
    }

    const rows = [...collected.values()].slice(0, limit);
    return {
      ok: rows.length > 0,
      rows,
      pages: 1,
      strategy: 'browser-dom',
      reason: rows.length ? null : 'No accounts could be read from this hashtag page.',
    };
  } finally {
    if (owned) cursor.hide();
  }
}

/**
 * Scroll whatever user-list dialog the owner already opened on instagram.com.
 */
export async function collectOpenDialogDom(ctx, { limit = 200, onProgress = null, signal = null } = {}) {
  const document = ctx.document;
  const dialog = findVisibleDialog(document);
  if (!dialog) {
    return {
      ok: false,
      rows: [],
      reason: 'No list dialog is open on Instagram right now. Open a Followers, Following, or Likes modal first.',
    };
  }

  const { cursor, owned } = ensureCursor(ctx);
  try {
    checkBlocked(document);
    cursor.show('Reading open list…');
    const scraped = await scrollDialogForUsers(ctx, dialog, {
      limit,
      respectSuggestedBoundary: true,
      phase: 'open_list_dialog',
      noun: 'open list',
      onProgress,
      signal,
    });
    return {
      ok: scraped.rows.length > 0,
      rows: scraped.rows,
      pages: Math.max(1, scraped.steps),
      strategy: 'browser-dom',
      reason: scraped.rows.length ? null : 'No accounts were found in the open dialog.',
    };
  } finally {
    if (owned) cursor.hide();
  }
}
