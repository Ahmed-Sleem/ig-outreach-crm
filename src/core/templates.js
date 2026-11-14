/**
 * Message templates: nested spintax plus {{variable|fallback}} personalisation.
 *
 * The spintax parser is adapted from node-spintax (MIT) with three changes:
 *  - lodash is gone; every helper is native, and the branch draw goes through
 *    the injected EntropyPoolRNG instead of Math.random;
 *  - it is an ES module returning plain data, not a class with hidden state;
 *  - {{double-brace}} variables are resolved BEFORE the spintax tree is built.
 *
 * That last point is a real collision, not a style choice: "{{first_name|there}}"
 * is a variable with a fallback, but a spintax parser reading the same string
 * sees "{ {first_name|there} }" — a nested spin with two branches — and would
 * greet half the audience with the literal text "{first_name" or "there}".
 * Resolving variables first makes the two syntaxes compose.
 *
 * Pure: no browser, no clock. Randomness is injected.
 */

const START = '{';
const END = '}';
const DELIM = '|';

/** Marker left behind while counting, so {{var}} reads as one slot. */
const VARIABLE_MASK = String.fromCharCode(1);

const VARIABLE_RE = /\{\{([^{}]*)\}\}/g;

/* ------------------------------------------------------------------ parsing */

function parseSequence(string) {
  const sequence = [];
  let isParsingSpin = false;
  let fragment = '';
  let level = 0;

  const closeFragment = () => {
    if (fragment.length > 0) {
      sequence.push(fragment);
      fragment = '';
    }
  };

  for (let i = 0; i < string.length; i += 1) {
    const char = string[i];
    if (char === START) {
      if (!isParsingSpin) {
        closeFragment();
        isParsingSpin = true;
      }
      level += 1;
      fragment += char;
    } else if (char === END) {
      fragment += char;
      if (isParsingSpin) {
        level -= 1;
        if (level === 0) {
          isParsingSpin = false;
          sequence.push(parseSpin(fragment));
          fragment = '';
        }
      }
    } else {
      fragment += char;
    }
  }
  closeFragment();
  return sequence;
}

function parseSpin(string) {
  const spin = [];
  let level = 0;
  let fragment = '';
  let isComplexFragment = false;

  const closeFragment = () => {
    spin.push(isComplexFragment ? parseSequence(fragment) : fragment);
    fragment = '';
    isComplexFragment = false;
  };

  // The outer braces are syntax, not content.
  for (let i = 1; i < string.length - 1; i += 1) {
    const char = string[i];
    if (char === START) {
      level += 1;
      fragment += char;
      isComplexFragment = true;
    } else if (char === END) {
      level -= 1;
      fragment += char;
    } else if (char === DELIM && level === 0) {
      closeFragment();
    } else {
      fragment += char;
    }
  }
  closeFragment();
  return spin;
}

/* ----------------------------------------------------------------- counting */

function countVariationsInSequence(sequence) {
  let count = 1;
  for (const element of sequence) {
    if (Array.isArray(element)) count *= countVariationsInSpin(element);
  }
  return count;
}

function countVariationsInSpin(spin) {
  let count = 0;
  for (const element of spin) {
    count += Array.isArray(element) ? countVariationsInSequence(element) : 1;
  }
  return count;
}

/* ---------------------------------------------------------------- rendering */

function renderSequence(sequence, rng) {
  let out = '';
  for (const element of sequence) {
    out += Array.isArray(element) ? renderSpin(element, rng) : element;
  }
  return out;
}

function renderSpin(spin, rng) {
  if (spin.length === 0) return '';
  const chosen = spin[rng.nextInt(spin.length)];
  return Array.isArray(chosen) ? renderSequence(chosen, rng) : chosen;
}

/**
 * Compile a spintax source once and reuse the tree for counting and rendering.
 */
export function compileSpintax(source) {
  const tree = parseSequence(String(source ?? ''));
  return {
    tree,
    countVariations: () => countVariationsInSequence(tree),
    render: (rng) => renderSequence(tree, rng),
  };
}

/* ---------------------------------------------------------------- variables */

/**
 * Replace every {{name|fallback}} with its value.
 *
 * Unknown or empty context values fall back to the text after the first pipe,
 * and to the empty string when there is none — a template must never print
 * "{{first_name}}" at a person. Context lookups are exact and case-sensitive;
 * the UI documents the variable names.
 */
export function resolveVariables(body, context = {}) {
  return String(body ?? '').replace(VARIABLE_RE, (match, inner) => {
    const pipe = inner.indexOf(DELIM);
    const name = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    const fallback = pipe === -1 ? '' : inner.slice(pipe + 1).trim();
    const value = context[name];
    if (value === undefined || value === null || value === '') return fallback;
    return String(value);
  });
}

/** The variable names a body references, in first-use order, deduplicated. */
export function variableNames(body) {
  const names = [];
  const re = new RegExp(VARIABLE_RE.source, 'g');
  let m;
  while ((m = re.exec(String(body ?? ''))) !== null) {
    const pipe = m[1].indexOf(DELIM);
    const name = (pipe === -1 ? m[1] : m[1].slice(0, pipe)).trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/* --------------------------------------------------------------- public API */

/**
 * Render one message: variables first, then spintax branches through the
 * caller's random engine.
 */
export function renderMessageTemplate(body, context = {}, rng) {
  if (!rng || typeof rng.nextInt !== 'function') {
    throw new Error('renderMessageTemplate needs an EntropyPoolRNG');
  }
  return compileSpintax(resolveVariables(body, context)).render(rng).trim();
}

/**
 * How many distinct messages this body can produce.
 *
 * Variables are masked to a single placeholder first: "{{first_name|there}}" is
 * one slot supplied by the lead, not two spintax branches, and counting it as
 * spintax would inflate the diversity figure the linter relies on.
 */
export function countMessageVariations(body) {
  const masked = String(body ?? '').replace(VARIABLE_RE, VARIABLE_MASK);
  return compileSpintax(masked).countVariations();
}

/**
 * n distinct renders for the studio's live preview. Bounded attempts: a body
 * with fewer variations than requested simply returns what exists.
 */
export function sampleRenders(body, context, rng, count = 5) {
  const out = [];
  const attempts = count * 40;
  for (let i = 0; i < attempts && out.length < count; i += 1) {
    const rendered = renderMessageTemplate(body, context, rng);
    if (!out.includes(rendered)) out.push(rendered);
  }
  return out;
}
