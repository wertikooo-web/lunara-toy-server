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
    /ты сказал|ты говорил|ты только что сказал|как ты сказал/i,
    /you said|as you said|like you said/i,
    /ai spus|cum ai spus/i,
    /has dicho|como dijiste/i,
    /tu as dit|comme tu as dit/i,
    /hai detto|come hai detto/i,
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

module.exports = {
    isCorrection,
    isComplaintAboutUnderstanding,
    hasMultipleConstraints,
    referencesPreviousReply,
};
