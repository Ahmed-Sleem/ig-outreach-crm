import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectScripts,
  extractSalutationName,
  isRtl,
  jaccard,
  looksLikeBusinessName,
  normaliseDigits,
  normaliseText,
  similarity,
  stripInvisible,
  tokenSet,
  trigramSet,
} from '../src/core/text.js';

describe('normalisation', () => {
  test('Arabic-Indic and Extended Arabic-Indic digits become ASCII', () => {
    assert.equal(normaliseDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
    assert.equal(normaliseDigits('۴۲'), '42');
    assert.equal(normaliseDigits('42'), '42');
  });

  test('invisible characters are stripped, visible ones are not', () => {
    const zwj = String.fromCharCode(0x200d);
    const bom = String.fromCharCode(0xfeff);
    assert.equal(stripInvisible(`a${zwj}b${bom}c`), 'abc');
    assert.equal(stripInvisible('a b'), 'a b');
  });

  test('normaliseText collapses whitespace after cleaning', () => {
    assert.equal(normaliseText('  a‍  b  '), 'a b');
  });

  test('script detection drives RTL', () => {
    assert.deepEqual(detectScripts('hello'), ['latin']);
    assert.ok(isRtl(detectScripts('مرحبا')));
    assert.ok(!isRtl(detectScripts('hello')));
    assert.ok(isRtl(detectScripts('שלום')));
  });
});

describe('similarity primitives', () => {
  test('trigrams rescue near-miss phrasing that word overlap misses', () => {
    const a = 'is this waterproof or not';
    const b = 'is it waterproof or no';
    assert.ok(jaccard(tokenSet(a), tokenSet(b)) < 0.5);
    assert.ok(similarity(a, b) >= 0.5);
  });

  test('unrelated texts stay far apart', () => {
    assert.ok(similarity('shipping cost to cairo', 'my cousin wedding dress') < 0.3);
  });

  test('empty inputs are zero, not NaN', () => {
    assert.equal(similarity('', ''), 0);
    assert.equal(jaccard(new Set(), new Set()), 0);
    assert.equal(trigramSet('').size, 0);
  });
});

describe('salutation names', () => {
  test('a person keeps their first name', () => {
    assert.equal(extractSalutationName('Sara Hassan', 'there'), 'Sara');
    assert.equal(extractSalutationName('أحمد محمد', 'there'), 'أحمد');
    assert.equal(extractSalutationName('سارة', 'there'), 'سارة');
  });

  test('a leading title is skipped, not greeted', () => {
    assert.equal(extractSalutationName('Dr. Sara', 'there'), 'Sara');
    assert.equal(extractSalutationName('د. أحمد', 'there'), 'أحمد');
  });

  test('business names fall back in both scripts', () => {
    assert.equal(extractSalutationName('Cairo Store 🛍️', 'there'), 'there');
    assert.equal(extractSalutationName('متجر الزهور', 'there'), 'there');
    assert.equal(extractSalutationName('Nour Beauty Salon', 'there'), 'there');
    assert.equal(looksLikeBusinessName('Nour Beauty Salon').keyword, 'salon');
  });

  test('emoji-only, numeric and empty names fall back', () => {
    assert.equal(extractSalutationName('👑👑', 'there'), 'there');
    assert.equal(extractSalutationName('123shop', 'there'), 'there');
    assert.equal(extractSalutationName('', 'there'), 'there');
    assert.equal(extractSalutationName(null, 'there'), 'there');
  });

  test('template artefacts never reach a greeting', () => {
    assert.equal(extractSalutationName('{{first_name|there}}', 'x'), 'x');
    assert.equal(extractSalutationName('a|b', 'x'), 'x');
  });
});
