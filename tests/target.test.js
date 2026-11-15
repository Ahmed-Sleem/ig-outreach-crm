import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget, describeTarget, SOURCE_FIELDS, SOURCE_GROUPS } from '../src/app/lib/target.js';

describe('parseTarget - profile sources', () => {
  test('bare username', () => {
    const r = parseTarget('followers', 'musicdrrugs');
    assert.equal(r.ok, true);
    assert.equal(r.username, 'musicdrrugs');
  });
  test('@name with surrounding spaces keeps the owner case', () => {
    const r = parseTarget('followers', '  @MusicDrrugs ');
    assert.equal(r.ok, true);
    assert.equal(r.username, 'MusicDrrugs');
  });
  test('full profile URL with query drops the query', () => {
    const r = parseTarget('followers', 'https://www.instagram.com/musicdrrugs/?igsh=abc');
    assert.equal(r.ok, true);
    assert.equal(r.username, 'musicdrrugs');
  });
  test('scheme-less instagram.com link', () => {
    const r = parseTarget('followers', 'instagram.com/musicdrrugs');
    assert.equal(r.ok, true);
    assert.equal(r.username, 'musicdrrugs');
  });
  test('a post link into a profile source is a post_link error', () => {
    const r = parseTarget('followers', 'https://www.instagram.com/p/CxY12ab/');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'post_link');
    assert.match(r.error, /post link/i);
  });
  test('a hashtag into a profile source errors', () => {
    const r = parseTarget('followers', '#linen');
    assert.equal(r.ok, false);
  });
  test('a space in the name errors', () => {
    const r = parseTarget('followers', 'a b');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'invalid_username');
  });
  test('following and profile_recent_likers behave like followers', () => {
    assert.equal(parseTarget('following', '@nike').username, 'nike');
    assert.equal(parseTarget('profile_recent_likers', 'nike').username, 'nike');
  });
  test('a non-instagram host is rejected', () => {
    const r = parseTarget('followers', 'https://twitter.com/nike');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not_instagram');
    assert.match(r.error, /not from instagram\.com/i);
  });
  test('a reserved route segment that is not a post is not_profile', () => {
    const r = parseTarget('followers', 'https://www.instagram.com/explore/');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not_profile');
  });
  test('zero-width and bidi characters are stripped before validating', () => {
    const r = parseTarget('followers', '\u200enike\u202c');
    assert.equal(r.ok, true);
    assert.equal(r.username, 'nike');
  });
});

describe('parseTarget — post sources', () => {
  test('reel URL yields the shortcode', () => {
    const r = parseTarget('post_likers', 'https://www.instagram.com/reel/CxY12ab/');
    assert.equal(r.ok, true);
    assert.equal(r.shortcode, 'CxY12ab');
  });
  test('/name/p/CODE/ yields the shortcode', () => {
    const r = parseTarget('post_likers', 'https://www.instagram.com/someone/p/CxY12ab/');
    assert.equal(r.ok, true);
    assert.equal(r.shortcode, 'CxY12ab');
  });
  test('bare /p/CODE/ yields the shortcode', () => {
    const r = parseTarget('post_comments', 'https://www.instagram.com/p/CxY12ab/');
    assert.equal(r.ok, true);
    assert.equal(r.shortcode, 'CxY12ab');
  });
  test('a bare shortcode is accepted', () => {
    const r = parseTarget('post_likers', 'CxY12ab');
    assert.equal(r.ok, true);
    assert.equal(r.shortcode, 'CxY12ab');
  });
  test('@account into a post source is account_link', () => {
    const r = parseTarget('post_likers', '@someone');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'account_link');
    assert.match(r.error, /That is an account/i);
  });
  test('a profile link into a post source is account_link', () => {
    const r = parseTarget('post_likers', 'https://www.instagram.com/someone/');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'account_link');
  });
  test('tv URL yields the shortcode', () => {
    const r = parseTarget('post_likers', 'https://www.instagram.com/tv/CxY12ab/');
    assert.equal(r.ok, true);
    assert.equal(r.shortcode, 'CxY12ab');
  });
});

describe('parseTarget — hashtag source', () => {
  test('#tag strips the hash', () => {
    const r = parseTarget('hashtag_grid', '#linen');
    assert.equal(r.ok, true);
    assert.equal(r.tag, 'linen');
  });
  test('bare tag', () => {
    const r = parseTarget('hashtag_grid', 'linen');
    assert.equal(r.ok, true);
    assert.equal(r.tag, 'linen');
  });
  test('explore/tags URL yields the tag', () => {
    const r = parseTarget('hashtag_grid', 'https://www.instagram.com/explore/tags/linen/');
    assert.equal(r.ok, true);
    assert.equal(r.tag, 'linen');
  });
  test('Arabic tag is accepted', () => {
    const r = parseTarget('hashtag_grid', 'لينن');
    assert.equal(r.ok, true);
    assert.equal(r.tag, 'لينن');
  });
  test('a tag with a space errors', () => {
    const r = parseTarget('hashtag_grid', 'home linen');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'invalid_tag');
  });
});

describe('parseTarget — no-field sources', () => {
  for (const src of ['saved_grid', 'open_list_dialog', 'current_page']) {
    test(`${src} returns ok with no field`, () => {
      const r = parseTarget(src, 'anything at all');
      assert.equal(r.ok, true);
      assert.equal(r.label, 'this page');
    });
  }
});

describe('parseTarget — misc', () => {
  test('an unknown source is rejected', () => {
    const r = parseTarget('nonsense', 'x');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unknown_source');
  });
  test('empty input for a field source is an empty error', () => {
    assert.equal(parseTarget('followers', '   ').code, 'empty');
    assert.equal(parseTarget('post_likers', '').code, 'empty');
    assert.equal(parseTarget('hashtag_grid', '').code, 'empty');
  });
});

describe('describeTarget', () => {
  test('account', () => assert.equal(describeTarget(parseTarget('followers', 'musicdrrugs')), 'Account: @musicdrrugs'));
  test('post', () => assert.equal(describeTarget(parseTarget('post_likers', 'CxY12ab')), 'Post: p/CxY12ab'));
  test('hashtag', () => assert.equal(describeTarget(parseTarget('hashtag_grid', '#linen')), 'Hashtag: #linen'));
  test('no-field', () => assert.equal(describeTarget(parseTarget('current_page', '')), 'This page'));
  test('a failed parse describes as empty', () => assert.equal(describeTarget(parseTarget('followers', 'a b')), ''));
});

describe('the field descriptors cover every source and group', () => {
  test('SOURCE_FIELDS has an entry for all nine sources', () => {
    const all = ['followers', 'following', 'profile_recent_likers', 'post_likers', 'post_comments', 'hashtag_grid', 'saved_grid', 'open_list_dialog', 'current_page'];
    for (const s of all) assert.ok(SOURCE_FIELDS[s], `missing field descriptor for ${s}`);
  });
  test('every grouped option has a field descriptor', () => {
    for (const group of SOURCE_GROUPS) {
      for (const option of group.options) assert.ok(SOURCE_FIELDS[option.value], `group option ${option.value} has no descriptor`);
    }
  });
  test('no-field sources are flagged needsField:false', () => {
    for (const s of ['saved_grid', 'open_list_dialog', 'current_page']) assert.equal(SOURCE_FIELDS[s].needsField, false);
  });
});
