import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileSpintax,
  countMessageVariations,
  renderMessageTemplate,
  resolveVariables,
  sampleRenders,
  variableNames,
} from '../src/core/templates.js';
import { EntropyPoolRNG } from '../src/core/random.js';

const rng = () => new EntropyPoolRNG({ seed: [4, 4, 4, 4], clock: () => 999, microClock: () => 0.5 });

describe('spintax', () => {
  test('counts nested variations multiplicatively', () => {
    assert.equal(countMessageVariations('{a|b}'), 2);
    assert.equal(countMessageVariations('{a|{b|c|d}}'), 4);
    assert.equal(countMessageVariations('{a|b} x {c|d|e}'), 6);
    assert.equal(countMessageVariations('plain text'), 1);
  });

  test('renders only branches that exist', () => {
    const r = rng();
    for (let i = 0; i < 300; i += 1) {
      const out = renderMessageTemplate('{Hi|Hello}', {}, r);
      assert.ok(['Hi', 'Hello'].includes(out), out);
    }
  });

  test('unbalanced braces degrade to text instead of throwing', () => {
    assert.equal(renderMessageTemplate('oops {a|b', {}, rng()), 'oops {a|b');
    assert.equal(renderMessageTemplate('a} b', {}, rng()), 'a} b');
  });
});

describe('variables vs spintax collision', () => {
  test('{{var|fallback}} resolves before spintax sees it', () => {
    // The failure this guards: a naive parser reads "{{first_name|there}}" as a
    // spin with two branches and greets half the audience with "{first_name".
    const body = '{{first_name|there}}, {Hi|Hello}!';
    const out = renderMessageTemplate(body, { first_name: 'Sara' }, rng());
    assert.match(out, /^Sara, (Hi|Hello)!$/);
    const fallback = renderMessageTemplate(body, {}, rng());
    assert.match(fallback, /^there, (Hi|Hello)!$/);
  });

  test('a variable counts as one slot, not two branches', () => {
    assert.equal(countMessageVariations('{{first_name|there}} {a|b}'), 2);
    assert.equal(countMessageVariations('{{first_name|there}}'), 1);
  });

  test('variable names are listed in first-use order, deduplicated', () => {
    assert.deepEqual(
      variableNames('{{a|x}} {{b}} {{a|y}}'),
      ['a', 'b'],
    );
  });

  test('empty and missing context values fall back', () => {
    assert.equal(resolveVariables('[{{name|friend}}]', { name: '' }), '[friend]');
    assert.equal(resolveVariables('[{{name}}]', {}), '[]');
    assert.equal(resolveVariables('[{{name|friend}}]', { name: 'Nour' }), '[Nour]');
  });
});

describe('studio preview', () => {
  test('sampleRenders returns distinct messages and stops at what exists', () => {
    const samples = sampleRenders('{a|b|c}', {}, rng(), 5);
    assert.deepEqual([...samples].sort(), ['a', 'b', 'c']);
    assert.equal(new Set(samples).size, samples.length);
  });

  test('rendering without a random engine is a loud error', () => {
    assert.throws(() => renderMessageTemplate('hi', {}, null), /EntropyPoolRNG/);
  });

  test('compileSpintax reuses one tree for counting and rendering', () => {
    const compiled = compileSpintax('{a|b} {c|d}');
    assert.equal(compiled.countVariations(), 4);
    const r = rng();
    assert.match(compiled.render(r), /^[ab] [cd]$/);
  });
});
