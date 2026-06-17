'use strict';

const ACTION_WORDS = [
    'улыб', 'сме', 'смотр', 'маш', 'подмиг', 'вздых', 'шепч', 'шепот', 'шёпот', 'шепотом', 'шёпотом', 'говорит',
    'приподнима', 'наклон', 'кива', 'хлоп', 'радост', 'удивл', 'задум',
    'smile', 'laugh', 'look', 'wink', 'whisper', 'sigh', 'nod',
    'zamb', 'zâmb', 'rade', 'râde', 'priv', 'sopteste', 'șoptește',
];

function stripWrappingQuotes(text) {
    let value = String(text || '').trim();
    const quotes = ['"', "'", '“', '”', '„', '«', '»', '`'];
    while (value.length > 1 && quotes.includes(value[0])) {
        value = value.slice(1).trim();
    }
    while (value.length > 1 && quotes.includes(value[value.length - 1])) {
        value = value.slice(0, -1).trim();
    }
    return value;
}

function isLikelyAction(text) {
    const value = String(text || '').toLocaleLowerCase('ru-RU');
    if (!value) return false;
    return ACTION_WORDS.some((word) => value.includes(word));
}

function removeStageDirections(text) {
    let value = String(text || '');

    value = value.replace(/\*([^*\n]{1,180})\*/g, (_match, inner) => (
        isLikelyAction(inner) ? ' ' : ` ${inner} `
    ));
    value = value.replace(/_([^_\n]{1,180})_/g, (_match, inner) => (
        isLikelyAction(inner) ? ' ' : ` ${inner} `
    ));
    value = value.replace(/\[([^\]\n]{1,180})\]/g, (_match, inner) => (
        isLikelyAction(inner) ? ' ' : ` ${inner} `
    ));
    value = value.replace(/\(([^)\n]{1,180})\)/g, (_match, inner) => (
        isLikelyAction(inner) ? ' ' : ` (${inner}) `
    ));

    // Handles malformed model output like: "Удивлённо приподнимает уши* Ой, ...
    value = value.replace(/^["'“”„«»`\s]*([^.!?…\n]{1,160})\*+\s*/u, (_match, inner) => (
        isLikelyAction(inner) ? '' : `${inner} `
    ));

    return value;
}

function cleanLine(line) {
    let value = String(line || '').trim();
    value = value.replace(/^[-*•]+\s*/, '');
    value = value.replace(/^(?:lumi|люми|луми|ответ|реакция|фраза|speech|reply|reaction)\s*[:—-]\s*/i, '');
    value = stripWrappingQuotes(value);
    if (isLikelyAction(value) && !/[.!?…]/.test(value)) return '';
    return value;
}

function sanitizeVoiceReply(raw) {
    let text = String(raw || '').replace(/\r\n?/g, '\n').trim();
    if (!text) return '';

    text = text.replace(/```[\s\S]*?```/g, ' ');
    text = text.replace(/`([^`]+)`/g, '$1');
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');
    text = text.replace(/__([^_\n]+)__/g, '$1');
    text = removeStageDirections(text);
    text = text
        .split('\n')
        .map(cleanLine)
        .filter(Boolean)
        .join('\n');

    text = text.replace(/["“”„«»]+/g, '');
    text = text.replace(/\*\*/g, '');
    text = text.replace(/\s+([,.!?…])/g, '$1');
    text = text.replace(/[ \t]{2,}/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n');
    return stripWrappingQuotes(text).trim();
}

module.exports = {
    sanitizeVoiceReply,
};
