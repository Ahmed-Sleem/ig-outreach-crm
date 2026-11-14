/**
 * Priority ranking: which collected people deserve attention first.
 *
 * The score is an arithmetic sum of provenance facts, each with a weight the
 * user can tune in one place. Nothing is learned, nothing is guessed, and
 * every row can show the exact breakdown behind its rank — an opaque ranking
 * is one the user cannot audit, and this is a CRM they act on with their own
 * account.
 *
 * Counting rules that keep a second scan honest:
 *  - engagement is counted per POST, not per row. Fifteen comments under one
 *    post are one post commented (the raw count is kept separately);
 *  - cross-account overlap carries the highest multiplier, because a person
 *    active in several accounts of the same niche is the warmest signal the
 *    collector can see;
 *  - provenance lives in lead_edges, so re-scanning updates lastSeenAt without
 *    inflating scores or resetting lifecycle state.
 *
 * Pure.
 */

export const EdgeType = Object.freeze({
  LIKED_POST: 'LIKED_POST',
  COMMENTED_POST: 'COMMENTED_POST',
  FOLLOWS_SOURCE: 'FOLLOWS_SOURCE',
  FOLLOWED_BY_SOURCE: 'FOLLOWED_BY_SOURCE',
  STORY_VIEW: 'STORY_VIEW',
  STORY_LIKE: 'STORY_LIKE',
  PROFILE_CAPTURE: 'PROFILE_CAPTURE',
  CSV_IMPORT: 'CSV_IMPORT',
});

/** Edge types that name a source account a person was active around. */
const SOURCE_EDGES = Object.freeze([
  EdgeType.LIKED_POST,
  EdgeType.COMMENTED_POST,
  EdgeType.FOLLOWS_SOURCE,
  EdgeType.FOLLOWED_BY_SOURCE,
  EdgeType.STORY_VIEW,
  EdgeType.STORY_LIKE,
]);

/**
 * Instagram's default avatar URLs, by CDN object id. A person who never set a
 * picture is far less likely to be a reachable buyer, so they rank below an
 * otherwise identical lead with a face. Adapted from InstagramUnfollowers (MIT).
 */
export const BLANK_AVATAR_MARKERS = Object.freeze([
  '44884218_345707102882519_2446069589734326272_n',
  '464760996_1254146839119862_3605321457742435801_n',
]);

export function hasBlankAvatar(avatarUrl) {
  const url = String(avatarUrl ?? '');
  return BLANK_AVATAR_MARKERS.some((id) => url.includes(id));
}

/** Accounts at or above this follower count are broadcasters, not peers. */
export const MEGA_ACCOUNT_FOLLOWERS = 100000;
const MEGA_MULTIPLIER = 0.6;
const BLANK_AVATAR_PENALTY = 15;

export const DEFAULT_WEIGHTS = Object.freeze({
  multiAccountOverlap: 30,
  followsSource: 12,
  followedBySource: 8,
  postComment: 16,
  postLike: 6,
  buyerIntent: 22,
  likeAndCommentBoth: 8,
  storySignal: 10,
  deprioritizeMegaAccounts: true,
});

export const WarmthTier = Object.freeze({
  HOT: 'hot',
  WARM: 'warm',
  LUKEWARM: 'lukewarm',
  COLD: 'cold',
});

export function warmthTier(score) {
  if (score >= 70) return WarmthTier.HOT;
  if (score >= 40) return WarmthTier.WARM;
  if (score >= 15) return WarmthTier.LUKEWARM;
  return WarmthTier.COLD;
}

/** Distinct post ids an edge type touches — the per-post dedup. */
function distinctPosts(edges, type) {
  return new Set(edges.filter((e) => e.edgeType === type && e.refId).map((e) => e.refId));
}

/**
 * Score one lead from its provenance edges.
 *
 * @param {object} lead
 * @param {object[]} edges provenance rows for this lead
 * @param {object} [weights]
 * @returns {{score: number, breakdown: object[], postsLiked: number,
 *            postsCommented: number, totalLikes: number, totalComments: number,
 *            uniqueSources: string[], tier: string}}
 */
export function scoreLead(lead, edges = [], weights = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const rows = edges ?? [];
  const breakdown = [];

  const likeEdges = rows.filter((e) => e.edgeType === EdgeType.LIKED_POST);
  const commentEdges = rows.filter((e) => e.edgeType === EdgeType.COMMENTED_POST);
  const postsLiked = distinctPosts(rows, EdgeType.LIKED_POST).size;
  const postsCommented = distinctPosts(rows, EdgeType.COMMENTED_POST).size;

  const sources = new Set(
    rows.filter((e) => SOURCE_EDGES.includes(e.edgeType) && e.sourceAccount).map((e) => e.sourceAccount),
  );
  const uniqueSources = [...sources].sort();

  if (uniqueSources.length > 1) {
    breakdown.push({
      label: `active around ${uniqueSources.length} source accounts`,
      points: (uniqueSources.length - 1) * w.multiAccountOverlap,
    });
  }
  if (rows.some((e) => e.edgeType === EdgeType.FOLLOWS_SOURCE)) {
    breakdown.push({ label: 'follows a source account', points: w.followsSource });
  }
  if (rows.some((e) => e.edgeType === EdgeType.FOLLOWED_BY_SOURCE)) {
    breakdown.push({ label: 'followed by a source account', points: w.followedBySource });
  }
  if (postsCommented > 0) {
    breakdown.push({ label: `commented on ${postsCommented} post(s)`, points: postsCommented * w.postComment });
  }
  if (postsLiked > 0) {
    breakdown.push({ label: `liked ${postsLiked} post(s)`, points: postsLiked * w.postLike });
  }
  if (postsLiked > 0 && postsCommented > 0) {
    breakdown.push({ label: 'both liked and commented', points: w.likeAndCommentBoth });
  }
  const buyerIntent = lead?.hasBuyerIntent === true
    || commentEdges.some((e) => (e.intentFlags ?? []).includes('price_question'))
    || commentEdges.some((e) => (e.intentFlags ?? []).includes('purchase_intent'));
  if (buyerIntent) {
    breakdown.push({ label: 'buyer-intent comment', points: w.buyerIntent });
  }
  if (rows.some((e) => e.edgeType === EdgeType.STORY_VIEW || e.edgeType === EdgeType.STORY_LIKE)) {
    breakdown.push({ label: 'story signal', points: w.storySignal });
  }

  let score = breakdown.reduce((sum, row) => sum + row.points, 0);

  if (hasBlankAvatar(lead?.avatarUrl)) {
    score -= BLANK_AVATAR_PENALTY;
    breakdown.push({ label: 'no profile picture', points: -BLANK_AVATAR_PENALTY });
  }

  const mega = w.deprioritizeMegaAccounts !== false
    && Number(lead?.followersCount ?? 0) >= MEGA_ACCOUNT_FOLLOWERS;
  if (mega) {
    score = Math.round(score * MEGA_MULTIPLIER);
    breakdown.push({ label: 'broadcast-scale account, deprioritised', points: Math.round(score * (MEGA_MULTIPLIER - 1)) });
  }

  return {
    score: Math.max(0, Math.round(score)),
    breakdown,
    postsLiked,
    postsCommented,
    totalLikes: likeEdges.length,
    totalComments: commentEdges.length,
    uniqueSources,
    buyerIntent,
    mega,
    tier: warmthTier(Math.max(0, Math.round(score))),
  };
}

/**
 * Rank leads, highest first. Ties break on source breadth then username, so
 * the same input always produces the same order — a ranking that reshuffles
 * itself between two identical loads is one nobody trusts.
 */
export function rankLeads(rows, weights = {}) {
  return rows
    .map((row) => ({ ...row, ...scoreLead(row.lead, row.edges, weights) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.uniqueSources.length !== a.uniqueSources.length) return b.uniqueSources.length - a.uniqueSources.length;
      return String(a.lead?.username ?? '').localeCompare(String(b.lead?.username ?? ''));
    });
}
