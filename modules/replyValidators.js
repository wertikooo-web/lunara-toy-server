'use strict';

// Post-generation checks run on an LLM reply before it goes to TTS. These are
// monitoring/escalation signals, not hard truncators — cutting a reply mid-word
// for TTS is worse than a slightly-too-long one, so length violations are logged
// (see [ReplyValidation] in llm.js) rather than silently trimmed.

function normalizeForLetterCheck(text) {
    return String(text || '').normalize('NFC');
}

function extractWords(text) {
    return normalizeForLetterCheck(text).match(/\p{L}+/gu) || [];
}

function firstLetterUpper(word) {
    return String(word || '').charAt(0).toLocaleUpperCase();
}

// Normal chat replies should read as 1-3 short sentences with at most one question.
function checkReplyLength(text, { isStory = false, maxSentences = 3 } = {}) {
    if (isStory) return { ok: true, sentenceCount: null, questionCount: null, reason: null };
    const sentences = String(text || '').split(/(?<=[.!?…])\s+/).filter(Boolean);
    const questionCount = (String(text || '').match(/\?/g) || []).length;
    const tooLong = sentences.length > maxSentences;
    const tooManyQuestions = questionCount > 1;
    return {
        ok: !tooLong && !tooManyQuestions,
        sentenceCount: sentences.length,
        questionCount,
        reason: tooLong ? 'too_many_sentences' : (tooManyQuestions ? 'too_many_questions' : null),
    };
}

// Detects confident claims about the child's personal facts (favorite things, pet
// name, home, today's activities) that were not backed by memoryContext — the
// model likely invented them rather than recalling something real.
const UNCONFIRMED_FACT_PATTERNS = [
    /тво(?:[её]|я|и|й) любим(?:ый|ая|ое|ые)\s+\S+\s+(?:это|—|-)?\s*\S+/i,
    /твоего питомца зовут/i,
    /твою кошку зовут|твою собаку зовут|твоего кота зовут|твоего пса зовут/i,
    /ты жив[её]шь (?:в|на)\s+\S+/i,
    /сегодня ты (?:уже\s+)?(?:рисовал|играл|ходил|гулял)/i,
    /your favorite \w+ is/i,
    /your pet(?:'s name)? is/i,
    /you live in/i,
];

function checkUnconfirmedFacts(text, { hasMemoryContext = false } = {}) {
    if (hasMemoryContext) return { ok: true, reason: null };
    const hit = UNCONFIRMED_FACT_PATTERNS.some(pattern => pattern.test(String(text || '')));
    return { ok: !hit, reason: hit ? 'unconfirmed_personal_fact' : null };
}

// Generic "every word starts with letter X" constraint check for tongue twisters.
// Unicode-aware (\p{L}) so it works for Cyrillic, ăâîșț, ñ, accented letters, etc.
// Short connector words (below minWordLength) are excluded — they're usually
// prepositions/particles that don't meaningfully break the rule for a child.
function checkFirstLetterConstraint(text, targetLetter, { minWordLength = 3 } = {}) {
    const words = extractWords(text).filter(w => w.length >= minWordLength);
    if (words.length === 0) return { ok: false, checkedWords: 0, violations: [], reason: 'no_words' };
    const target = firstLetterUpper(targetLetter);
    const violations = words.filter(w => firstLetterUpper(w) !== target);
    return {
        ok: violations.length === 0,
        checkedWords: words.length,
        violations,
        reason: violations.length ? 'letter_mismatch' : null,
    };
}

// Structured riddle output: {riddle, answer, hint}. Rejects riddles that leak the
// answer inside their own text, are missing pieces, or are unreasonably long.
function checkRiddlePayload(payload) {
    if (!payload || typeof payload !== 'object') return { ok: false, reason: 'not_an_object' };
    const riddle = String(payload.riddle || '').trim();
    const answer = String(payload.answer || '').trim();
    if (!riddle) return { ok: false, reason: 'missing_riddle' };
    if (!answer) return { ok: false, reason: 'missing_answer' };
    if (riddle.length > 400) return { ok: false, reason: 'riddle_too_long' };
    if (answer.length > 60) return { ok: false, reason: 'answer_too_long' };
    const riddleLower = riddle.toLocaleLowerCase();
    const answerLower = answer.toLocaleLowerCase();
    if (answerLower.length >= 3 && riddleLower.includes(answerLower)) {
        return { ok: false, reason: 'answer_leaked_in_riddle' };
    }
    return { ok: true, reason: null };
}

module.exports = {
    extractWords,
    firstLetterUpper,
    checkReplyLength,
    checkUnconfirmedFacts,
    checkFirstLetterConstraint,
    checkRiddlePayload,
};
