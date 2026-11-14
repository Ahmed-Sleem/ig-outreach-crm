import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  RELATIONSHIP_ORDER,
  RelationshipKind,
  SyncStrategy,
  buildFollowerIndex,
  friendshipFlags,
  nameKey,
  normaliseUser,
  planSync,
  relStateFor,
  relationshipKind,
} from '../src/core/relationship.js';
import { RelState } from '../src/core/lifecycle.js';

const user = (username, extra = {}) => ({ pk: username.length, username, full_name: username.toUpperCase(), ...extra });

describe('relationshipKind', () => {
  test('the four combinations map to four kinds', () => {
    assert.equal(relationshipKind({ theyFollowMe: true, iFollowThem: true }), RelationshipKind.MUTUAL);
    assert.equal(relationshipKind({ theyFollowMe: true, iFollowThem: false }), RelationshipKind.THEY_FOLLOW_ME);
    assert.equal(relationshipKind({ theyFollowMe: false, iFollowThem: true }), RelationshipKind.I_FOLLOW_THEM);
    assert.equal(relationshipKind({}), RelationshipKind.NONE);
  });

  test('the order puts mutual first', () => {
    assert.equal(RELATIONSHIP_ORDER[0], RelationshipKind.MUTUAL);
    assert.equal(RELATIONSHIP_ORDER[RELATIONSHIP_ORDER.length - 1], RelationshipKind.NONE);
  });
});

describe('nameKey', () => {
  test('case and legacy dots collapse to one identity', () => {
    assert.equal(nameKey('Ali.Dev'), nameKey('ali.dev'));
    assert.equal(nameKey('ali.dev'), nameKey('ALIDEV'));
    assert.equal(nameKey(null), '');
    assert.equal(nameKey(42), '42');
  });
});

describe('normaliseUser', () => {
  test('v1, web and graphql shapes all land on one record', () => {
    const fromV1 = normaliseUser({ pk: 7, username: 'a', full_name: 'A', is_private: true, follower_count: 12, friendship_status: { following: true } });
    const fromWeb = normaliseUser({ id: '7', username: 'a', fullName: 'A', isPrivate: true, followers: 12 });
    assert.equal(fromV1.id, '7');
    assert.equal(fromV1.username, 'a');
    assert.equal(fromV1.isPrivate, true);
    assert.equal(fromV1.followers, 12);
    assert.equal(fromWeb.id, '7');
    assert.equal(fromWeb.followers, 12);
    assert.equal(fromV1.friendship.following, true);
  });

  test('absent counts stay null rather than becoming 0', () => {
    const row = normaliseUser({ username: 'a' });
    assert.equal(row.followers, null);
    assert.equal(row.following, null);
    assert.equal(row.id, '');
  });

  test('friendship_status is read in both snake and camel case', () => {
    assert.deepEqual(friendshipFlags({ following: true, followed_by: true, outgoing_request: false }), {
      following: true, followedBy: true, outgoingRequest: false, incomingRequest: false, blocking: false, isPrivate: false,
    });
    assert.deepEqual(friendshipFlags({ followedBy: true, outgoingRequest: true }), {
      following: false, followedBy: true, outgoingRequest: true, incomingRequest: false, blocking: false, isPrivate: false,
    });
    assert.deepEqual(friendshipFlags(null), {
      following: false, followedBy: false, outgoingRequest: false, incomingRequest: false, blocking: false, isPrivate: false,
    });
  });
});

describe('buildFollowerIndex', () => {
  test('mutual is the intersection of their following and my followers', () => {
    const index = buildFollowerIndex({
      following: [user('ali'), user('sara'), user('omar')],
      myFollowers: [user('ALI'), user('Sara'), user('nada')],
      iFollow: [user('sara')],
    });
    const kinds = Object.fromEntries(index.rows.map((row) => [row.user.username.toLowerCase(), row.kind]));
    assert.equal(kinds.ali, RelationshipKind.THEY_FOLLOW_ME);
    assert.equal(kinds.sara, RelationshipKind.MUTUAL);
    assert.equal(kinds.omar, RelationshipKind.NONE);
    assert.equal(index.mutualCount, 1);
    assert.equal(index.followingCount, 3);
    assert.equal(index.myFollowerCount, 3);
  });

  test('accounts I already follow are present even when the target does not follow them', () => {
    const index = buildFollowerIndex({ following: [], myFollowers: [], iFollow: [user('omar')] });
    assert.equal(index.rows.length, 1);
    assert.equal(index.rows[0].kind, RelationshipKind.I_FOLLOW_THEM);
    assert.equal(index.rows[0].iFollowThem, true);
  });

  test('one account can never occupy two rows', () => {
    const index = buildFollowerIndex({ following: [user('ali.dev')], iFollow: [user('ALIDEV')] });
    assert.equal(index.rows.length, 1);
    assert.equal(index.rows[0].kind, RelationshipKind.I_FOLLOW_THEM);
    assert.equal(index.rows[0].user.fullName, 'ALI.DEV');
  });

  test('rows without a username are dropped', () => {
    const index = buildFollowerIndex({ following: [{ pk: 1 }, null, user('ali')] });
    assert.equal(index.rows.length, 1);
  });

  test('lookups are case-insensitive', () => {
    const index = buildFollowerIndex({ following: [user('ali')], myFollowers: [user('ali')] });
    assert.equal(index.followsMe('ALI'), true);
    assert.equal(index.targetFollows('ali'), true);
    assert.equal(index.followsMe('sara'), false);
  });

  test('an empty sync produces an empty index, not an error', () => {
    const index = buildFollowerIndex({});
    assert.deepEqual(index.rows, []);
    assert.equal(index.mutualCount, 0);
  });
});

describe('relStateFor', () => {
  test('index kinds map onto the authoritative lifecycle states', () => {
    assert.equal(relStateFor({ kind: RelationshipKind.MUTUAL, mutual: true }), RelState.MUTUAL);
    assert.equal(relStateFor({ kind: RelationshipKind.I_FOLLOW_THEM }), RelState.FOLLOWING);
    assert.equal(relStateFor({ kind: RelationshipKind.THEY_FOLLOW_ME }), RelState.FOLLOWED_BY_ONLY);
    assert.equal(relStateFor({ kind: RelationshipKind.NONE }), RelState.NONE);
    assert.equal(relStateFor(null), RelState.NONE);
  });
});

describe('planSync', () => {
  test('nothing queued means no reads at all', () => {
    const plan = planSync({ suspectCount: 0 });
    assert.equal(plan.strategy, SyncStrategy.INCREMENTAL);
    assert.equal(plan.pages, 0);
  });

  test('a handful of suspects is targeted, not a full re-read', () => {
    const plan = planSync({ suspectCount: 5, myFollowerCount: 20000 });
    assert.equal(plan.strategy, SyncStrategy.TARGETED);
    assert.equal(plan.pages, 5);
  });

  test('many suspects on a small follower list is one full read', () => {
    const plan = planSync({ suspectCount: 30, myFollowerCount: 200 });
    assert.equal(plan.strategy, SyncStrategy.FULL);
    assert.equal(plan.pages, 4);
  });

  test('many suspects on a huge follower list is still targeted', () => {
    const plan = planSync({ suspectCount: 12, myFollowerCount: 50000 });
    assert.equal(plan.strategy, SyncStrategy.TARGETED);
  });

  test('bad input degrades to the cheapest plan', () => {
    assert.equal(planSync({}).strategy, SyncStrategy.INCREMENTAL);
    assert.equal(planSync({ suspectCount: NaN }).strategy, SyncStrategy.INCREMENTAL);
    assert.equal(planSync({ suspectCount: -3 }).strategy, SyncStrategy.INCREMENTAL);
  });
});
