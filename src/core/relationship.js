/**
 * Two-axis relationship state and the follower index that computes it.
 *
 * Pure JS. No DOM, no chrome, no network: it takes the two lists the content
 * layer fetched and returns the truth about every account in them. Everything
 * else (scoring, lifecycle, the cleaner) consumes this output.
 *
 * Why two lists: Instagram never tells you "this account follows you back" in a
 * single field you can trust. The only reliable answer is the intersection of
 * who they follow and who follows you, which is why a sync is always two paged
 * reads — their following, then your followers — and why the second read exists
 * at all (GAP-08: without it every accept detection is a guess).
 */

import { RelState } from './lifecycle.js';

export const RelationshipKind = Object.freeze({
  MUTUAL: 'mutual',
  THEY_FOLLOW_ME: 'they_follow_me',
  I_FOLLOW_THEM: 'i_follow_them',
  NONE: 'none',
});

/** The four kinds, ordered most to least valuable, for UI legends and sorts. */
export const RELATIONSHIP_ORDER = Object.freeze([
  RelationshipKind.MUTUAL,
  RelationshipKind.THEY_FOLLOW_ME,
  RelationshipKind.I_FOLLOW_THEM,
  RelationshipKind.NONE,
]);

export function relationshipKind({ theyFollowMe, iFollowThem }) {
  if (theyFollowMe && iFollowThem) return RelationshipKind.MUTUAL;
  if (theyFollowMe) return RelationshipKind.THEY_FOLLOW_ME;
  if (iFollowThem) return RelationshipKind.I_FOLLOW_THEM;
  return RelationshipKind.NONE;
}

/**
 * Case- and dot-insensitive key. Instagram forbids dots in new usernames but
 * legacy accounts keep them, and `a.b` and `ab` have collided historically.
 * Normalising means one account can never occupy two rows.
 */
export function nameKey(username) {
  return String(username ?? '').toLowerCase().replace(/\./g, '');
}

/**
 * Normalise one raw user object from any Instagram list shape into the record
 * the rest of the app uses. Unknown fields stay absent rather than `undefined`
 * so JSON round-trips are stable.
 */
export function normaliseUser(raw) {
  const user = {
    id: String(raw?.pk ?? raw?.id ?? raw?.pk_id ?? ''),
    username: String(raw?.username ?? ''),
    fullName: String(raw?.full_name ?? raw?.fullName ?? ''),
    isPrivate: Boolean(raw?.is_private ?? raw?.isPrivate),
    isVerified: Boolean(raw?.is_verified ?? raw?.isVerified),
    followers: raw?.follower_count ?? raw?.followers ?? null,
    following: raw?.follow_count ?? raw?.following ?? null,
    profilePicUrl: String(raw?.profile_pic_url ?? raw?.profile_pic_url_hd ?? raw?.profilePicUrl ?? ''),
    friendship: raw?.friendship_status ?? raw?.friendshipStatus ?? null,
  };
  if (user.followers !== null) user.followers = Number(user.followers) || 0;
  if (user.following !== null) user.following = Number(user.following) || 0;
  return user;
}

/**
 * Read the `friendship_status` object Instagram attaches to a user when the
 * viewer is logged in. `following` there is what the UI shows; the list
 * membership is what the server actually did. Both are kept.
 */
export function friendshipFlags(status) {
  return {
    following: Boolean(status?.following),
    followedBy: Boolean(status?.followed_by ?? status?.followedBy),
    outgoingRequest: Boolean(status?.outgoing_request ?? status?.outgoingRequest),
    incomingRequest: Boolean(status?.incoming_request ?? status?.incomingRequest),
    blocking: Boolean(status?.blocking),
    isPrivate: Boolean(status?.is_private ?? status?.isPrivate),
  };
}

/**
 * The authoritative relationship index for one target account.
 *
 * `following` is who the target follows; `myFollowers` is who follows the
 * viewer. The intersection is the set of people who will see a DM from the
 * viewer as a message request rather than a stranger's, which is what makes a
 * lead warm.
 */
export function buildFollowerIndex({ following = [], myFollowers = [], iFollow = [] } = {}) {
  const followingKeys = new Set(following.map((u) => nameKey(u?.username)));
  const myFollowerKeys = new Set(myFollowers.map((u) => nameKey(u?.username)));
  const iFollowKeys = new Set(iFollow.map((u) => nameKey(u?.username)));
  const byKey = new Map();
  const register = (raw, flags) => {
    const user = normaliseUser(raw);
    if (!user.username) return;
    const key = nameKey(user.username);
    byKey.set(key, { user, key, ...flags });
  };
  for (const raw of following) register(raw, { theyFollowMe: myFollowerKeys.has(nameKey(raw?.username)), iFollowThem: iFollowKeys.has(nameKey(raw?.username)) });
  for (const raw of iFollow) {
    const key = nameKey(raw?.username);
    if (byKey.has(key)) continue;
    register(raw, { theyFollowMe: myFollowerKeys.has(key), iFollowThem: true });
  }
  const rows = [...byKey.values()].map((row) => {
    const kind = relationshipKind(row);
    return { ...row, kind, mutual: kind === RelationshipKind.MUTUAL };
  });
  return {
    rows,
    byKey,
    followingCount: followingKeys.size,
    myFollowerCount: myFollowerKeys.size,
    mutualCount: rows.filter((r) => r.mutual).length,
    /** Does `username` follow the viewer? The accept-detect answer. */
    followsMe(username) {
      return myFollowerKeys.has(nameKey(username));
    },
    /** Does the target follow `username`? Used for competitor overlap. */
    targetFollows(username) {
      return followingKeys.has(nameKey(username));
    },
  };
}

/** Map an index row onto the authoritative relationship state enum. */
export function relStateFor(row) {
  if (row?.mutual) return RelState.MUTUAL;
  if (row?.kind === RelationshipKind.I_FOLLOW_THEM) return RelState.FOLLOWING;
  if (row?.kind === RelationshipKind.THEY_FOLLOW_ME) return RelState.FOLLOWED_BY_ONLY;
  return RelState.NONE;
}

/**
 * Who to check when an accept is suspected. A targeted `?query=` lookup is one
 * page; a full re-read of your followers is 50 pages for a 10k list and burns
 * the daily read budget for nothing.
 */
export const SyncStrategy = Object.freeze({
  TARGETED: 'targeted',
  FULL: 'full',
  INCREMENTAL: 'incremental',
});

export function planSync({ suspectCount = 0, myFollowerCount = 0, fullSyncEvery = 30 } = {}) {
  const suspect = Number(suspectCount) || 0;
  const followers = Number(myFollowerCount) || 0;
  if (suspect <= 0) return { strategy: SyncStrategy.INCREMENTAL, pages: 0, reason: 'Nothing queued for accept detection.' };
  // A targeted search page holds 12 rows and answers one username reliably.
  if (suspect <= 8) return { strategy: SyncStrategy.TARGETED, pages: suspect, reason: `${suspect} suspect(s): targeted lookups are cheaper than a full re-read.` };
  const fullPages = Math.max(1, Math.ceil(followers / 50));
  if (suspect >= 24 || fullPages <= suspect) {
    return { strategy: SyncStrategy.FULL, pages: fullPages, reason: `${suspect} suspects: one full follower re-read (${fullPages} pages) beats ${suspect} lookups.` };
  }
  return {
    strategy: SyncStrategy.TARGETED,
    pages: suspect,
    reason: `${suspect} suspects vs ${fullPages} pages for a full read: targeted. Full sync every ${fullSyncEvery} runs keeps the index honest.`,
  };
}
