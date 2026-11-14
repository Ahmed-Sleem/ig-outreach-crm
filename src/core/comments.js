/**
 * Comment intelligence: buyer intent, objections, voice-of-customer.
 *
 * Why this module exists: the comment corpus is the only voice-of-customer dataset
 * available about a competitor. For the owner's stated use case — learn
 * the market and how rivals sell — it carries more signal than any count.
 *
 * Privacy posture: classification works on TEXT ONLY. Usernames are
 * accepted for owner-reply detection and then discarded by `aggregate()`. Nothing
 * in this module's output identifies a natural person unless the caller explicitly
 * asks for `keepAuthors`.
 *
 * Language: keyword sets are multi-language and live in ONE place per intent so a
 * new language is one edit, not a sweep.
 */

import { jaccard, normaliseDigits, stripInvisible, tokenSet, trigramSet } from './text.js';

export const Intent = {
  PRICE: 'price_question',
  AVAILABILITY: 'availability',
  SHIPPING: 'shipping_location',
  SIZING: 'sizing_spec',
  OBJECTION: 'objection',
  COMPLAINT: 'complaint',
  PRAISE_SPECIFIC: 'praise_specific',
  PRAISE_GENERIC: 'praise_generic',
  PURCHASE_INTENT: 'purchase_intent',
  QUESTION_OTHER: 'question_other',
  TAG_FRIEND: 'tag_friend',
  SPAM: 'spam',
  OTHER: 'other',
};

const RULES = [
  {
    intent: Intent.PRICE,
    patterns: [
      /\bhow much\b/iu, /\bpricing\b/iu, /\bhow many\s*\$/iu,
      // Buyers almost never type "how much" in full. These shorthands are the most
      // common real-world form of a price question and were missing entirely:
      //   hm / h.m / h m / howmuch / how mch / hw much
      // Anchored to the whole comment so "hm" as hesitation inside a sentence
      // ("hm, nice") does not count, but a bare "hm" or "HM?" does.
      /^\s*h\s*[.\-]?\s*m\s*[?؟!.]*\s*$/iu,
      /\bhow\s*mu?ch\b/iu, /\bhw\s*much\b/iu, /\bhowmuch\b/iu,
      /بكام|كام|السعر|بكم|الثمن|كم سعر|بقديش|قديش/u,
      // Arabic price words with the question mark written separately ("السعر ؟"),
      // plus common variants and misspellings seen in Gulf/Levant/Egyptian comments.
      /\bالسعر\s*[؟?]/u, /\bالسعرررر*/u, /سعره|سعرها|سعرهم|بكمم*|كم\s*السعر|ايش\s*السعر|شو\s*السعر|وش\s*السعر/u,
      /\bcuánto\b|\bprecio\b/iu, /\bcombien\b|\bprix\b/iu, /\bpreis\b/iu, /\bfiyat\b|\bkaç para\b/iu,
      /\bharga\b/iu, /\bцена\b|\bсколько\b/iu, /\bquanto custa\b/iu, /\bprezzo\b/iu,
    ],
    // Fire only when the comment is a question. A bare "price" is often part of
    // "great price!", which is praise, not an enquiry.
    weak: [/\bprices?\b/iu, /\bcost\b/iu, /\bpricee+\b/iu, /\brate\b/iu, /\b\$\?/u],
  },
  {
    intent: Intent.AVAILABILITY,
    patterns: [
      /\b(?:is|are)\s+(?:it|they|this)\s+available\b/iu, /\bin stock\b/iu, /\bsold out\b/iu,
      /\bstill available\b/iu, /\bdo you have\b/iu,
      /متاح|متوفر|خلص|نفد|لسه موجود/u,
      /\bdisponible\b/iu, /\bverfügbar\b/iu, /\bstokta\b/iu, /\btersedia\b/iu,
    ],
  },
  {
    intent: Intent.SHIPPING,
    patterns: [
      /\b(?:do you )?(?:ship|deliver)\b/iu, /\bshipping to\b/iu,
      /\bhow long.*(?:ship|deliver|arrive)\b/iu, /\bwhere are you\b/iu,
      /بتشحن|بتوصلوا|فين المكان|الفرع/u,
      /\benvío\b|\bentrega\b/iu, /\blivraison\b/iu, /\bversand\b/iu, /\bkargo\b/iu, /\bpengiriman\b/iu,
    ],
    weak: [/\bdelivery\b/iu, /\blocation\b/iu, /\baddress\b/iu, /توصيل|شحن|العنوان/u],
  },
  {
    intent: Intent.SIZING,
    patterns: [
      /\bwhat size\b/iu, /\bwhich size\b/iu, /\bcolou?rs?\s+available\b/iu, /\bhow big\b/iu,
      /المقاس|مقاسات/u,
      /\btalla\b/iu, /\btaille\b/iu, /\bgröße\b/iu, /\bbeden\b/iu, /\bukuran\b/iu,
    ],
    weak: [/\bsize\b/iu, /\bdimensions?\b/iu, /\bmaterial\b/iu, /\bweight\b/iu, /الخامة|الالوان|اللون|الوزن|الحجم/u],
  },
  {
    intent: Intent.OBJECTION,
    patterns: [
      /\btoo expensive\b/iu, /\boverpriced\b/iu, /\bcheaper\b/iu, /\bnot worth\b/iu, /\brip ?off\b/iu,
      /\bis (?:it|this) (?:real|original|authentic|fake)\b/iu, /\bcopy\b/iu, /\bwhy so\b/iu,
      /غالي|غالية|مبالغ|مش مستاهل|اصلي|أصلي|تقليد|مضروب|ليه كده/u,
      /\bcaro\b/iu, /\btrop cher\b/iu, /\bzu teuer\b/iu, /\bpahalı\b/iu, /\bmahal\b/iu,
    ],
  },
  {
    intent: Intent.COMPLAINT,
    patterns: [
      /\bno (?:reply|response|answer)\b/iu, /\bnever (?:replied|responded|received)\b/iu,
      /\bstill waiting\b/iu, /\blate\b/iu, /\bwrong (?:item|order|size)\b/iu, /\bbroken\b/iu,
      /\bdamaged\b/iu, /\brefund\b/iu, /\bscam\b/iu, /\bworst\b/iu, /\bterrible\b/iu, /\bawful\b/iu,
      /مردتوش|محدش رد|لسه مستني|اتأخر|متأخر|وحش|زبالة|نصب|مرجعتش|تالف|مكسور/u,
      /\bestafa\b/iu, /\barnaque\b/iu, /\bbetrug\b/iu, /\bdolandırıcı\b/iu,
    ],
  },
  {
    intent: Intent.PURCHASE_INTENT,
    patterns: [
      /\bi(?:'| a)?m? (?:buying|getting|ordering)\b/iu, /\bi want (?:this|it|one)\b/iu,
      /\bi need (?:this|it|one)\b/iu, /\bjust ordered\b/iu, /\bdm(?:'?d| sent)\b/iu,
      /\bsent you a (?:dm|message)\b/iu, /\bhow (?:do i|can i) (?:order|buy)\b/iu, /\btake my money\b/iu,
      /عايز|عايزة|أريد|اريد|هاخد|هشتري|بعتلك|كلمتك|ازاي اطلب|عاوز اشتري/u,
      /\blo quiero\b/iu, /\bje veux\b/iu, /\bich will\b/iu, /\bistiyorum\b/iu, /\bmau beli\b/iu,
    ],
  },
  {
    intent: Intent.TAG_FRIEND,
    patterns: [/^\s*@[\p{L}\p{N}_.]+\s*$/u, /^\s*(?:@[\p{L}\p{N}_.]+[\s,]*){1,5}$/u],
  },
  {
    intent: Intent.SPAM,
    patterns: [
      /\bfollow me\b/iu, /\bcheck my (?:page|profile|bio)\b/iu, /\bfree followers\b/iu,
      /\bdm for promo(?:tion)?\b/iu, /\bgrow your (?:account|page)\b/iu, /\bclick (?:my|the) link\b/iu,
      /\bwhatsapp \+?\d{6,}/iu, /\binvest\b.*\bprofit\b/iu, /\bbitcoin\b|\bforex\b/iu,
    ],
  },
];

const GENERIC_PRAISE = [
  /^\s*(?:nice|great|good|love it|lovely|beautiful|amazing|awesome|perfect|wow|cool|super|best|fire|clean|dope)[\s!.😍🔥❤️👍👏💯]*$/iu,
  /^\s*(?:جميل|حلو|رائع|تحفة|ممتاز|جامد|روعة|حبيت|تمام)[\s!.😍🔥❤️👍👏💯]*$/u,
  /^[\s\p{Extended_Pictographic}]+$/u,
];

const PRAISE_MARKERS = [
  /\b(?:love|great|amazing|excellent|perfect|beautiful|best|impressed|recommend)\b/iu,
  /حبيت|جميل|ممتاز|رائع|احسن|أفضل|بنصح/u,
];

/** Heuristic: a "specific" compliment names something. */
function isSpecificPraise(text) {
  if (!PRAISE_MARKERS.some((re) => re.test(text))) return false;
  const words = text.split(/\s+/).filter(Boolean).length;
  return words >= 5;
}

function hasQuestion(text) {
  return /[?？؟]/u.test(text);
}

/**
 * Classify one comment. Returns ALL matching intents (a comment can ask about
 * price AND shipping) plus a primary for grouping.
 */
export function classifyComment(text) {
  const t = stripInvisible(normaliseDigits(text ?? '')).trim();
  if (!t) return { intents: [Intent.OTHER], primary: Intent.OTHER, isQuestion: false, length: 0 };

  const question = hasQuestion(t);
  const intents = [];
  for (const rule of RULES) {
    if (rule.patterns.some((re) => re.test(t))) {
      intents.push(rule.intent);
      continue;
    }
    // Weak patterns are bare nouns ("delivery", "size", "price"). They indicate an
    // inquiry only inside a question; in a statement they are usually a testimonial
    // ("delivery was fast"), which must be counted as praise, not as a buyer question.
    if (question && rule.weak?.some((re) => re.test(t))) intents.push(rule.intent);
  }

  if (intents.length === 0) {
    if (GENERIC_PRAISE.some((re) => re.test(t))) intents.push(Intent.PRAISE_GENERIC);
    else if (isSpecificPraise(t)) intents.push(Intent.PRAISE_SPECIFIC);
    else if (question) intents.push(Intent.QUESTION_OTHER);
    else intents.push(Intent.OTHER);
  }

  // Priority order for the primary label: commercial signals outrank pleasantries.
  const priority = [
    Intent.COMPLAINT, Intent.OBJECTION, Intent.PRICE, Intent.PURCHASE_INTENT,
    Intent.SHIPPING, Intent.AVAILABILITY, Intent.SIZING, Intent.SPAM,
    Intent.QUESTION_OTHER, Intent.PRAISE_SPECIFIC, Intent.TAG_FRIEND,
    Intent.PRAISE_GENERIC, Intent.OTHER,
  ];
  const primary = priority.find((p) => intents.includes(p)) ?? Intent.OTHER;

  return { intents, primary, isQuestion: hasQuestion(t), length: t.length };
}

/** Mentions of other accounts that are not the profile owner — discovery leads. */
export function extractAccountMentions(text, excludeUsername) {
  const t = stripInvisible(text ?? '');
  const found = t.match(/@([\p{L}\p{N}_.]{2,30})/gu) ?? [];
  return [...new Set(found.map((m) => m.slice(1).toLowerCase()))].filter(
    (u) => u !== (excludeUsername ?? '').toLowerCase(),
  );
}

/** Stopwords for the VoC lexicon. Multi-language; extend here only. */
const STOPWORDS = new Set([
  'the','a','an','and','or','but','is','are','was','were','be','been','to','of','in','on','at','for','with','this','that','it','its','i','you','he','she','we','they','my','your','so','do','does','did','can','will','just','not','no','yes','if','as','from','by','me','us','them','have','has','had','what','when','where','how','why','who','all','any','more','very','too','also','there','here','get','got','one','out','up','about','like','than','then','now','new',
  'في','من','على','الى','إلى','عن','مع','هذا','هذه','ذلك','التي','الذي','ما','لا','نعم','هو','هي','انا','أنا','انت','أنت','نحن','هم','كان','كانت','يكون','بس','كده','ده','دي','اللي','علي','عند','كل','بعد','قبل','يا','ان','أن','إن','لو','هل','ايه','إيه',
]);

/** Frequent terms in the customer's own words — ad-copy goldmine. */
export function vocLexicon(texts, { minLength = 3, top = 40 } = {}) {
  const counts = new Map();
  texts.forEach((raw) => {
    const t = stripInvisible(raw ?? '').toLowerCase();
    const words = t.match(/[\p{L}\p{N}']{2,}/gu) ?? [];
    const seen = new Set();
    words.forEach((w) => {
      if (w.length < minLength || STOPWORDS.has(w)) return;
      if (seen.has(w)) return;
      seen.add(w);
      counts.set(w, (counts.get(w) ?? 0) + 1);
    });
  });
  return [...counts.entries()]
    .map(([term, docFreq]) => ({ term, docFreq }))
    .sort((a, b) => b.docFreq - a.docFreq)
    .slice(0, top);
}

/**
 * Aggregate a comment corpus into an analysis.
 *
 * `ownerUsername` enables reply-rate measurement: whether the business
 * answers its customers publicly is a direct measure of service posture.
 *
 * PRIVACY: usernames are used for owner detection and mention extraction, then
 * dropped. Set `keepAuthors: true` only on explicit user opt-in.
 */
/**
 * Group near-identical comments together.
 *
 * Why this exists: the intent rules are a fixed vocabulary, and real buyers write
 * things the rules were never taught — in dialect, in transliteration, with typos,
 * or in a language nobody anticipated. Those all land in "other", which is a
 * dead end for the user.
 *
 * Clustering the unclassified remainder turns that dead end into a finding: if
 * forty people all wrote some variant of the same sentence, that is a repeated
 * question worth answering even though no rule matched it. It is deliberately
 * dumb — a normalised-token Jaccard similarity, no model, no embedding — because
 * it must run locally, deterministically, and in any script.
 *
 * @param {string[]} texts
 * @param {{threshold?: number, minClusterSize?: number, maxClusters?: number}} opts
 */
export function clusterSimilar(texts, { threshold = 0.5, minClusterSize = 2, maxClusters = 20 } = {}) {
  const items = (texts ?? [])
    .map((t) => String(t ?? '').trim())
    .filter(Boolean)
    .map((t) => ({ text: t, tokens: tokenSet(t), grams: trigramSet(t) }))
    .filter((it) => it.tokens.size > 0);

  const clusters = [];
  const used = new Array(items.length).fill(false);

  for (let i = 0; i < items.length; i += 1) {
    if (used[i]) continue;
    const members = [items[i].text];
    used[i] = true;

    for (let j = i + 1; j < items.length; j += 1) {
      if (used[j]) continue;
      // Same rule as text.js similarity(), on the sets already computed above.
      if (
        Math.max(
          jaccard(items[i].tokens, items[j].tokens),
          jaccard(items[i].grams, items[j].grams),
        ) >= threshold
      ) {
        members.push(items[j].text);
        used[j] = true;
      }
    }

    if (members.length >= minClusterSize) {
      clusters.push({
        // The shortest member is usually the clearest phrasing of the shared idea.
        representative: [...members].sort((a, b) => a.length - b.length)[0],
        count: members.length,
        examples: members.slice(0, 5),
      });
    }
  }

  return clusters.sort((a, b) => b.count - a.count).slice(0, maxClusters);
}

export function analyseComments(comments, { ownerUsername = null, keepAuthors = false, examplesPerIntent = 5 } = {}) {
  const total = comments.length;
  if (total === 0) {
    return { total: 0, note: 'No comments collected.', byIntent: {}, ownerReplyRate: null, lexicon: [], mentionedAccounts: [] };
  }

  const owner = (ownerUsername ?? '').toLowerCase();
  const byIntent = {};
  const mentions = new Map();
  let ownerReplies = 0;
  let questions = 0;

  const nonOwner = [];

  comments.forEach((c) => {
    const isOwner = owner && (c.username ?? '').toLowerCase() === owner;
    if (isOwner) { ownerReplies += 1; return; }
    nonOwner.push(c);

    const cls = classifyComment(c.text);
    if (cls.isQuestion) questions += 1;

    cls.intents.forEach((intent) => {
      if (!byIntent[intent]) byIntent[intent] = { count: 0, examples: [] };
      byIntent[intent].count += 1;
      if (byIntent[intent].examples.length < examplesPerIntent) {
        byIntent[intent].examples.push({
          text: stripInvisible(c.text).slice(0, 220),
          ...(keepAuthors && c.username ? { username: c.username } : {}),
        });
      }
    });

    extractAccountMentions(c.text, ownerUsername).forEach((u) => {
      mentions.set(u, (mentions.get(u) ?? 0) + 1);
    });
  });

  const commercialIntents = [Intent.PRICE, Intent.AVAILABILITY, Intent.SHIPPING, Intent.SIZING, Intent.PURCHASE_INTENT];
  const commercialCount = commercialIntents.reduce((a, i) => a + (byIntent[i]?.count ?? 0), 0);
  const genericShare = (byIntent[Intent.PRAISE_GENERIC]?.count ?? 0) / Math.max(nonOwner.length, 1);

  return {
    total,
    fromOwner: ownerReplies,
    fromOthers: nonOwner.length,
    /** Direct measure of service posture. */
    ownerReplyRate: nonOwner.length ? Number((ownerReplies / nonOwner.length).toFixed(3)) : null,
    questionRate: nonOwner.length ? Number((questions / nonOwner.length).toFixed(3)) : null,
    byIntent,
    commercialSignalCount: commercialCount,
    commercialSignalRate: nonOwner.length ? Number((commercialCount / nonOwner.length).toFixed(3)) : null,
    /** High generic-praise share is a comment-quality fraud signal. */
    genericPraiseShare: Number(genericShare.toFixed(3)),
    qualityNote:
      genericShare > 0.6
        ? 'Over 60% of comments are generic praise or emoji only. This pattern is common with engagement pods or bought engagement — interpret the counts with caution.'
        : null,
    mentionedAccounts: [...mentions.entries()]
      .map(([username, count]) => ({ username, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30),
    lexicon: vocLexicon(nonOwner.map((c) => c.text)),
    /**
     * Repeated phrasings among comments no rule could classify. This is the
     * fallback the intent taxonomy cannot provide: it surfaces questions asked in
     * words, dialects or languages the rules do not know.
     */
    unclassifiedClusters: clusterSimilar(
      nonOwner.filter((c) => classifyComment(c.text).primary === Intent.OTHER).map((c) => c.text),
    ),
    privacyNote: keepAuthors
      ? 'Commenter usernames retained by explicit opt-in.'
      : 'Commenter usernames were used for reply detection then discarded.',
  };
}
