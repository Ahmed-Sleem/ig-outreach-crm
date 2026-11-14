/**
 * Text normalisation and similarity — the one place language rules live.
 *
 * Everything here is deterministic and pure: no browser, no clock, no network.
 * The normalisation helpers and the script detection come from the author's
 * earlier extension (IG Competitor Intel, MIT); the similarity primitives
 * (token set, character trigrams, Jaccard) are lifted from its comment
 * clustering and promoted here, so a message linter and a comment classifier
 * cannot drift into two definitions of "similar".
 *
 * Design constraint: works with any language. Consequences:
 *  - Unicode property escapes throughout, never [a-z].
 *  - Arabic-Indic (U+0660..U+0669) and Extended Arabic-Indic (U+06F0..U+06F9)
 *    digits are transliterated before anything parses them.
 *  - Invisible and control characters are built from code points at runtime,
 *    because a literal zero-width joiner in source is invisible in review too.
 */

/** Characters invisible to a human but meaningful to a parser. */
const INVISIBLE = String.fromCharCode(
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, // zero-width marks and bidi marks
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // bidi embeddings and overrides
  0x2066, 0x2067, 0x2068, 0x2069, // bidi isolates
  0xfeff, 0x00ad, // byte-order mark, soft hyphen
);

/** C0 controls except tab, LF and CR, which are legitimate whitespace. */
const CONTROLS = String.fromCharCode(
  0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 16,
  17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
);

const INVISIBLE_RE = new RegExp(`[${INVISIBLE}]`, 'g');
const CONTROLS_RE = new RegExp(`[${CONTROLS}]`, 'g');
const ARABIC_DIGITS_RE = new RegExp(
  `[${String.fromCharCode(0x0660)}-${String.fromCharCode(0x0669)}${String.fromCharCode(0x06f0)}-${String.fromCharCode(0x06f9)}]`,
  'g',
);

/** Arabic-Indic and Extended Arabic-Indic digits -> ASCII. */
export function normaliseDigits(text) {
  if (typeof text !== 'string') return '';
  return text.replace(ARABIC_DIGITS_RE, (d) => {
    const code = d.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/**
 * Strip characters that are invisible to a human but meaningful to a parser:
 * zero-width joiners and spaces, bidi overrides, the byte-order mark, the soft
 * hyphen, and stray C0 controls.
 */
export function stripInvisible(text) {
  if (typeof text !== 'string') return '';
  return text.replace(INVISIBLE_RE, '').replace(CONTROLS_RE, '');
}

export function normaliseText(text) {
  return normaliseDigits(stripInvisible(text)).replace(/\s+/g, ' ').trim();
}

/** Which writing systems appear. Drives RTL rendering and per-language handling. */
export function detectScripts(text) {
  const out = [];
  const s = String(text ?? '');
  if (/\p{Script=Latin}/u.test(s)) out.push('latin');
  if (/\p{Script=Arabic}/u.test(s)) out.push('arabic');
  if (/\p{Script=Cyrillic}/u.test(s)) out.push('cyrillic');
  if (/\p{Script=Han}/u.test(s)) out.push('han');
  if (/\p{Script=Hiragana}/u.test(s) || /\p{Script=Katakana}/u.test(s)) out.push('japanese');
  if (/\p{Script=Hangul}/u.test(s)) out.push('hangul');
  if (/\p{Script=Devanagari}/u.test(s)) out.push('devanagari');
  if (/\p{Script=Hebrew}/u.test(s)) out.push('hebrew');
  return out;
}

export function isRtl(scripts) {
  return scripts.includes('arabic') || scripts.includes('hebrew');
}

/* --------------------------------------------------------------- similarity */

/** Normalised token set: lowercase, strip punctuation, drop 1-character noise. */
export function tokenSet(text) {
  const norm = normaliseDigits(String(text ?? '').toLowerCase())
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return new Set(norm.split(' ').filter((w) => w.length > 1));
}

/** Character trigrams over a normalised string, padded so short texts match. */
export function trigramSet(text) {
  const norm = ` ${normaliseDigits(String(text ?? '').toLowerCase()).replace(/[\p{P}\p{S}\s]+/gu, ' ').trim()} `;
  const grams = new Set();
  for (let i = 0; i < norm.length - 2; i += 1) grams.add(norm.slice(i, i + 3));
  return grams;
}

export function jaccard(a, b) {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Similarity = the better of whole-word overlap and character-trigram overlap.
 *
 * Word overlap alone is brittle: "is this waterproof or not" against "is it
 * waterproof or no" scores 0.43, because short filler words weigh as much as
 * the word that matters. Trigrams rescue that case (0.59) and also absorb
 * typos, plurals and scripts where words are not space-separated.
 */
export function similarity(a, b) {
  return Math.max(
    jaccard(tokenSet(a), tokenSet(b)),
    jaccard(trigramSet(a), trigramSet(b)),
  );
}

/* -------------------------------------------------------- salutation names */

/**
 * Nouns that mark a display name as a business rather than a person. Greeting
 * "Hi Cairo Store" is the robotic failure this list prevents: when a name hits
 * one of these, the template falls back to its default greeting instead.
 *
 * One list, both scripts. Extending coverage means adding a word here.
 */
export const BUSINESS_NAME_KEYWORDS = Object.freeze([
  // English
  'shop', 'store', 'boutique', 'clinic', 'salon', 'spa', 'restaurant', 'cafe',
  'coffee', 'bakery', 'dental', 'derma', 'dermatology', 'aesthetic', 'aesthetics',
  'medical', 'medicine', 'fashion', 'clothing', 'jewelry', 'jewellery', 'realtor',
  'realty', 'agency', 'studio', 'gym', 'fitness', 'hotel', 'travel', 'tour',
  'automotive', 'electronics', 'furniture', 'interiors', 'photography', 'academy',
  'school', 'university', 'lawyer', 'attorney', 'accounting', 'consulting',
  'marketing', 'construction', 'architect', 'architects', 'beauty', 'makeup',
  'nails', 'barber', 'lashes', 'skincare', 'cosmetics', 'hair', 'dentist',
  'physio', 'therapy', 'pharmacy', 'optics', 'optical', 'eyewear', 'hardware',
  'catering', 'events', 'wedding', 'florist', 'printing', 'textile', 'garments',
  'wholesale', 'supplier', 'distributor', 'importer', 'exporter', 'supplements',
  'nutrition', 'wellness', 'yoga', 'pilates', 'boxing', 'sports', 'institute',
  'tutors', 'coaching', 'training', 'courses', 'kindergarten', 'veterinary',
  'pets', 'grooming', 'logistics', 'courier', 'transport', 'taxi', 'insurance',
  'finance', 'bank', 'tailor', 'embroidery', 'handmade', 'gifts', 'toys',
  'maternity', 'uniforms', 'shoes', 'footwear', 'bags', 'watches', 'perfume',
  'fragrance', 'tattoo', 'piercing', 'landscaping', 'gardening', 'painting',
  'tiles', 'marble', 'granite', 'steel', 'glass', 'solar', 'appliances',
  'cameras', 'security', 'networking', 'computers', 'software', 'website',
  'tech', 'cloud', 'official', 'brand', 'online', 'outlet', 'gallery',
  'galerie', 'atelier', 'lab', 'labs', 'center', 'centre', 'group', 'company',
  'co.', 'llc', 'ltd', 'inc', 'eg', 'egypt', 'cairo', 'vip', 'team',
  // Arabic
  'متجر', 'بوتيك', 'شركة', 'عيادة', 'مركز', 'صالون', 'مطعم', 'كافيه', 'أكاديمية',
  'اكاديمية', 'صفحة', 'رسمي', 'رسمية', 'جملة', 'استوديو', 'ستوديو', 'مكتب',
  'معرض', 'براند', 'محل', 'سوق', 'تجارة', 'للبيع', 'اونلاين', 'أونلاين', 'مؤسسة',
  'مجموعة', 'وكالة', 'فندق', 'معمل', 'مختبر', 'صيدلية', 'مطابخ', 'أزياء', 'ازياء',
]);

/**
 * Titles that belong to a person, not a business. "Dr. Sara" must greet as
 * "Sara", so a title at the front is skipped rather than treated as the name
 * or as a business noun.
 */
export const PERSON_TITLES = Object.freeze([
  'dr', 'doctor', 'prof', 'professor', 'eng', 'engineer', 'captain', 'coach',
  'mr', 'mrs', 'ms', 'miss', 'sheikh', 'sheikha', 'sayed', 'sayeda',
  'دكتور', 'د', 'مهندس', 'م', 'أستاذ', 'استاذ', 'أ', 'كابتن', 'ك', 'شيخ', 'الشيخ',
]);

const BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}])';
const BOUNDARY_AFTER = '(?![\\p{L}\\p{N}])';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BUSINESS_RES = BUSINESS_NAME_KEYWORDS.map(
  (kw) => [kw, new RegExp(`${BOUNDARY_BEFORE}${escapeRegExp(kw)}${BOUNDARY_AFTER}`, 'iu')],
);

/**
 * Does this display name read as a business? Returns the keyword that decided
 * it, so the UI can say why a greeting fell back.
 */
export function looksLikeBusinessName(name) {
  const norm = normaliseDigits(String(name ?? '').toLowerCase())
    .replace(/[|_./-]/g, ' ')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!norm) return { business: false, keyword: null };
  for (const [kw, re] of BUSINESS_RES) {
    if (re.test(norm)) return { business: true, keyword: kw };
  }
  return { business: false, keyword: null };
}

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const SYMBOL_RE = /\p{Symbol}/gu;

/**
 * The name a message should open with, or the fallback when there is no
 * person-like name to use.
 *
 * Refuses, in order: empty input; template artefacts (pipes and braces);
 * business nouns in either script; emoji-only or symbol-only names; a first
 * token that is all digits or absurdly long (a handle, not a name). A leading
 * person title is skipped so "Dr. Sara" greets as "Sara".
 */
export function extractSalutationName(fullName, fallback = '') {
  const raw = stripInvisible(typeof fullName === 'string' ? fullName : '');
  const preClean = normaliseDigits(raw).replace(/\s+/g, ' ').trim();

  // Artefact check BEFORE symbol stripping: "|" is a symbol character, so
  // stripping first would erase the very pipe that marks a broken template.
  if (!preClean) return fallback;
  if (/[|{}<>]/.test(preClean)) return fallback;

  const cleaned = preClean
    .replace(EMOJI_RE, ' ')
    .replace(SYMBOL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return fallback;
  if (looksLikeBusinessName(cleaned).business) return fallback;

  const tokens = cleaned.split(' ').filter(Boolean);
  if (tokens.length === 0) return fallback;

  const stripPunct = (t) => t.replace(/^[\p{P}]+/u, '').replace(/[\p{P}]+$/u, '');
  let index = 0;
  if (tokens.length > 1 && PERSON_TITLES.includes(stripPunct(tokens[0]).toLowerCase())) index = 1;

  let first = stripPunct(tokens[index]).replace(/^@/, '');
  if (!first) return fallback;
  if (first.length > 24) return fallback;
  if (/^\p{N}/u.test(first)) return fallback; // starts with a digit: a handle, not a name
  if (/^\p{N}+$/u.test(first)) return fallback;
  return first;
}
