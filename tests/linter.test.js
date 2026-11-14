import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MESSAGE_BYTE_LIMIT,
  lintPool,
  lintTemplate,
} from '../src/core/linter.js';

describe('single template', () => {
  test('enforces the 1000-byte UTF-8 message limit', () => {
    // Arabic costs two bytes per character: 600 of them is over the cap even
    // though the character count is not.
    const arabic = 'م'.repeat(600);
    const result = lintTemplate({ title: 'long', body: arabic });
    assert.equal(result.bytes, 1200);
    assert.ok(result.errors.some((e) => e.includes('1000-byte')));

    const ascii = lintTemplate({ body: 'x'.repeat(MESSAGE_BYTE_LIMIT) });
    assert.deepEqual(ascii.errors, []);
    assert.equal(ascii.bytes, MESSAGE_BYTE_LIMIT);
  });

  test('link shorteners are an error in any context', () => {
    const cold = lintTemplate({ body: 'see bit.ly/deal now' });
    const warm = lintTemplate({ body: 'see bit.ly/deal now' }, { cold: false });
    assert.ok(cold.errors.some((e) => e.includes('shortener')));
    assert.ok(warm.errors.some((e) => e.includes('shortener')));
  });

  test('plain links are an error cold, a warning warm', () => {
    const body = 'more at https://example.com/{menu|page}';
    assert.equal(lintTemplate({ body }).errors.length, 1);
    assert.equal(lintTemplate({ body }, { cold: false }).errors.length, 0);
    assert.equal(lintTemplate({ body }, { cold: false }).warnings.length, 1);
  });

  test('promotional phrasing warns with the matched phrases', () => {
    const { warnings } = lintTemplate({ body: 'Click here — a giveaway for you' });
    assert.ok(warnings.some((w) => w.includes('giveaway') && w.includes('click here')));
  });

  test('a fixed sentence with no variation warns', () => {
    const { warnings } = lintTemplate({ body: 'Hello, how are you today?' });
    assert.ok(warnings.some((w) => w.includes('single fixed sentence')));
  });

  test('an empty template is an error', () => {
    assert.ok(lintTemplate({ body: '   ' }).errors.length > 0);
  });
});

describe('pool', () => {
  const diverse = [
    { title: 'one', body: 'Hi {{first_name|there}} — loved your {reel|post} about {pottery|ceramics}.' },
    { title: 'two', body: 'Salam! Your {comment|question} on the {glaze|kiln} post made my day.' },
    { title: 'three', body: 'Hey {{first_name|friend}}, the {studio|workshop} shots are {great|lovely}. Would you share how you {fire|glaze}?' },
    { title: 'four', body: '{Hi|Hello} {{first_name|there}}, I keep coming back to your {pieces|work}. {What|Tell me what} is next for the {shop|studio}?' },
    { title: 'five', body: 'Your last {reel|post} answered a question I had about {clay|glaze}. Thank you for that.' },
  ];

  test('a healthy pool passes', () => {
    const result = lintPool(diverse);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  test('too few active templates warns', () => {
    const { warnings } = lintPool(diverse.slice(0, 3));
    assert.ok(warnings.some((w) => w.includes('active template')));
  });

  test('duplicate templates are flagged by similarity', () => {
    const { warnings } = lintPool([
      { title: 'a', body: 'Hi there, loved your reel about pottery so much!' },
      { title: 'b', body: 'Hi there, loved your reel about pottery so much!' },
      ...diverse.slice(0, 4),
    ]);
    assert.ok(warnings.some((w) => w.includes('"a" and "b"')));
  });

  test('thin combined variation warns', () => {
    const { warnings } = lintPool([
      { title: 'a', body: 'Hi {there|friend}!' },
      { title: 'b', body: 'Hello {there|friend}!' },
      { title: 'c', body: 'Salam {there|friend}!' },
      { title: 'd', body: 'Hey {there|friend}!' },
      { title: 'e', body: 'Marhaba {there|friend}!' },
    ]);
    assert.ok(warnings.some((w) => w.includes('distinct renders')));
  });

  test('errors from members surface at pool level', () => {
    const { errors } = lintPool([{ title: 'bad', body: 'go to tinyurl.com/x' }, ...diverse]);
    assert.ok(errors.some((e) => e.includes('shortener')));
  });
});
