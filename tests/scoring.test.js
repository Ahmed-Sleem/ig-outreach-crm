import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  EdgeType,
  MEGA_ACCOUNT_FOLLOWERS,
  scoreLead,
  rankLeads,
  warmthTier,
} from '../src/core/scoring.js';

const lead = (extra = {}) => ({ username: 'u', avatarUrl: 'https://cdn/x.jpg', followersCount: 900, ...extra });

describe('per-post deduplication', () => {
  test('fifteen comments under one post count as one commented post', () => {
    const edges = Array.from({ length: 15 }, (_, i) => ({
      edgeType: EdgeType.COMMENTED_POST,
      sourceAccount: 'compA',
      refId: 'p1',
      edgeKey: `k${i}`,
    }));
    const result = scoreLead(lead(), edges);
    assert.equal(result.postsCommented, 1);
    assert.equal(result.totalComments, 15);
  });

  test('the same person across two posts counts twice', () => {
    const edges = [
      { edgeType: EdgeType.LIKED_POST, sourceAccount: 'compA', refId: 'p1' },
      { edgeType: EdgeType.LIKED_POST, sourceAccount: 'compA', refId: 'p2' },
    ];
    assert.equal(scoreLead(lead(), edges).postsLiked, 2);
  });
});

describe('cross-account overlap', () => {
  test('overlap carries the highest multiplier and is listed in the breakdown', () => {
    const edges = [
      { edgeType: EdgeType.LIKED_POST, sourceAccount: 'compA', refId: 'p1' },
      { edgeType: EdgeType.COMMENTED_POST, sourceAccount: 'compB', refId: 'p2' },
      { edgeType: EdgeType.STORY_VIEW, sourceAccount: 'compC', refId: 's1' },
    ];
    const result = scoreLead(lead(), edges);
    assert.deepEqual(result.uniqueSources, ['compA', 'compB', 'compC']);
    const overlap = result.breakdown.find((b) => b.label.includes('3 source accounts'));
    assert.equal(overlap.points, 60);
  });

  test('one source account earns no overlap bonus', () => {
    const edges = [{ edgeType: EdgeType.LIKED_POST, sourceAccount: 'compA', refId: 'p1' }];
    assert.equal(scoreLead(lead(), edges).breakdown.some((b) => b.label.includes('source accounts')), false);
  });
});

describe('penalties', () => {
  test('a blank default avatar ranks below an identical lead with a face', () => {
    const edges = [{ edgeType: EdgeType.LIKED_POST, sourceAccount: 'compA', refId: 'p1' }];
    const withFace = scoreLead(lead(), edges);
    const blank = scoreLead(lead({ avatarUrl: 'https://cdn/44884218_345707102882519_2446069589734326272_n.jpg' }), edges);
    assert.ok(blank.score < withFace.score);
  });

  test('broadcast-scale accounts are deprioritised, and say so', () => {
    const edges = Array.from({ length: 4 }, (_, i) => ({ edgeType: EdgeType.COMMENTED_POST, sourceAccount: 'compA', refId: `p${i}` }));
    const mega = scoreLead(lead({ followersCount: MEGA_ACCOUNT_FOLLOWERS }), edges);
    const peer = scoreLead(lead(), edges);
    assert.equal(mega.mega, true);
    assert.ok(mega.score < peer.score);
    assert.ok(mega.breakdown.some((b) => b.label.includes('deprioritised')));
  });
});

describe('ranking', () => {
  test('orders by score, ties by source breadth then username', () => {
    const rows = [
      { lead: lead({ username: 'zeta' }), edges: [{ edgeType: EdgeType.LIKED_POST, sourceAccount: 'a', refId: 'p1' }] },
      { lead: lead({ username: 'anna' }), edges: [{ edgeType: EdgeType.LIKED_POST, sourceAccount: 'a', refId: 'p1' }] },
      {
        lead: lead({ username: 'mid' }),
        edges: [
          { edgeType: EdgeType.LIKED_POST, sourceAccount: 'a', refId: 'p1' },
          { edgeType: EdgeType.COMMENTED_POST, sourceAccount: 'b', refId: 'p2' },
        ],
      },
    ];
    const ranked = rankLeads(rows);
    assert.deepEqual(ranked.map((r) => r.lead.username), ['mid', 'anna', 'zeta']);
  });

  test('the same input always produces the same order', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      lead: lead({ username: `u${i % 7}` }),
      edges: [{ edgeType: EdgeType.LIKED_POST, sourceAccount: `s${i % 3}`, refId: `p${i % 5}` }],
    }));
    assert.deepEqual(
      rankLeads(rows).map((r) => `${r.lead.username}:${r.score}`),
      rankLeads(rows).map((r) => `${r.lead.username}:${r.score}`),
    );
  });

  test('warmth tiers follow the score', () => {
    assert.equal(warmthTier(90), 'hot');
    assert.equal(warmthTier(50), 'warm');
    assert.equal(warmthTier(20), 'lukewarm');
    assert.equal(warmthTier(3), 'cold');
  });
});
