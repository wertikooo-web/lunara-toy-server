'use strict';

// Structural conversational signals for llmRouter's signal-based routing
// (see routeAutoModel in modules/llmRouter.js). Patterns are the exact
// per-language examples supplied in the routing-quality spec for this feature.

const CORRECTION_PATTERNS = [
    /не это|я сказал другое|я сказала другое|ты перепутал|ты перепутала|ты меня не понял|ты меня не поняла|не g,? а z|нет,? первая буква|я ответы не давал|я ответ не давал/i,
    /you misunderstood me|not that\b|i said something else/i,
    /nu m-ai [îi]n[țt]eles|nu asta|am spus altceva/i,
    /no me entendiste|no eso\b|dije otra cosa/i,
    /tu ne m'as pas compris|pas [çc]a\b|j'ai dit autre chose/i,
    /non mi hai capito|non quello\b|ho detto un'?altra cosa/i,
];

const UNDERSTANDING_COMPLAINT_PATTERNS = [
    /ты меня не понял|ты меня не поняла|ты не понял|ты не поняла/i,
    /you (?:did ?not|didn'?t) understand me|you misunderstood/i,
    /nu m-ai [îi]n[țt]eles/i,
    /no me entendiste/i,
    /tu ne m'as pas compris/i,
    /non mi hai capito/i,
];

const MULTIPLE_CONSTRAINT_PATTERNS = [
    /все слова|каждое слово|только на букву|ровно \d+|не используй|сначала.+потом|сравни|проверь|объясни разниц/i,
    /all words|each word|only.+letter|exactly \d+|don'?t use|first.+then|compare|explain the difference/i,
];

const REFERENCES_PREVIOUS_REPLY_PATTERNS = [
    /ты\s+сказал|ты\s+говорил|ты\s+только\s*что\s+сказа|как\s+ты\s+сказал/iu,
    /you said|as you said|like you said/i,
    /ai spus|cum ai spus/i,
    /has dicho|como dijiste/i,
    /tu as dit|comme tu as dit/i,
    /hai detto|come hai detto/i,
];

// "conversation_inconsistency": the child is pointing out that the toy said one
// thing (a character/topic/offer) and is now doing another — e.g. "ты вначале
// сказала про зайчика, а начинаешь про кошку рассказывать". Caught real examples
// in production logs where isCorrection/isComplaintAboutUnderstanding both missed
// this phrasing (it doesn't contain "не это"/"ты меня не понял" etc, and
// REFERENCES_PREVIOUS_REPLY's rigid "ты сказал" didn't match "ты вначале сказала"
// with a word in between and a different verb suffix). Deliberately broad — a
// false positive here just means one extra escalation to the strong model, not
// a safety issue, whereas a miss lets prepared-content patches (see
// storyContentPatch.js) hijack a complaint into launching an unrelated story.
const CONVERSATION_INCONSISTENCY_PATTERNS = [
    /ты\s+(?:сначала|вначале|сперва|в\s*начале)/iu,
    /ты\s+начал[аи]?\s+(?:говорить|рассказывать)/iu,
    /ты\s+поменял[а]?\s+героя|ты\s+перепутал[а]?/iu,
    /почему\s+ты\s+(?:сейчас\s+)?говоришь\s+(?:другое|не\s+то)/iu,
    /you (?:first|initially) said|why are you (?:now )?(?:saying|talking about) something else/i,
    /ai spus (?:mai )?intai|ai spus (?:mai )?întâi/i,
    /dijiste primero|antes dijiste/i,
    /tu as dit (?:d'abord|au début)/i,
    /prima hai detto/i,
];

function matchesAny(text, patterns) {
    const t = String(text || '');
    return patterns.some(pattern => pattern.test(t));
}

function isCorrection(text) {
    return matchesAny(text, CORRECTION_PATTERNS);
}

function isComplaintAboutUnderstanding(text) {
    return matchesAny(text, UNDERSTANDING_COMPLAINT_PATTERNS);
}

function hasMultipleConstraints(text) {
    return matchesAny(text, MULTIPLE_CONSTRAINT_PATTERNS);
}

function referencesPreviousReply(text) {
    return matchesAny(text, REFERENCES_PREVIOUS_REPLY_PATTERNS);
}

function isConversationInconsistency(text) {
    return matchesAny(text, CONVERSATION_INCONSISTENCY_PATTERNS);
}

module.exports = {
    isCorrection,
    isComplaintAboutUnderstanding,
    hasMultipleConstraints,
    referencesPreviousReply,
    isConversationInconsistency,
};
