'use strict';

const voiceUx = require('./voiceUxPhrases');

function normalizeText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[.,!?;:()[\]{}"«»]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isShortText(text) {
    const words = normalizeText(text).split(' ').filter(Boolean);
    return words.length > 0 && words.length <= 4;
}

function isAffirmative(text) {
    const t = normalizeText(text);
    if (!isShortText(t)) return false;
    return /^(да|да да|ага|угу|угу да|ага да|ну да|хорошо|ладно|ок|окей|конечно|давай|хочу|можно|согласен|согласна|точно|верно|правильно|yes|yeah|yep|sure|ok|okay)$/.test(t);
}

function isNegative(text) {
    const t = normalizeText(text);
    if (!isShortText(t)) return false;
    return /^((нет|неа)(\s+спасибо)?|(нет\s+)?не\s+(хочу|надо)|(не\s+хочу\s+больше)|не сейчас|хватит|стоп|потом|no|nope|no\s+thanks|don'?t\s+want)$/.test(t);
}

function isUncertain(text) {
    const t = normalizeText(text);
    if (!isShortText(t)) return false;
    return /^(не знаю|я не знаю|не понял|не поняла|не понимаю|не уверен|не уверена|может быть|наверное|ну|ээ|эм|мм|dont know|i dont know|i don t know|maybe)$/.test(t);
}

function isHesitation(text) {
    const t = normalizeText(text);
    if (!isShortText(t)) return false;
    return /^(ну|ээ|эм|мм|м|а|и)$/.test(t);
}

function isAmbiguousNo(text) {
    const t = normalizeText(text);
    return t === 'no' || t === 'nope';
}

function isContinueRequest(text) {
    const t = normalizeText(text);
    if (!isShortText(t)) return false;
    return /^(еще|ещё|дальше|продолжай|давай дальше|следующую|еще одну|ещё одну|more|next)$/.test(t);
}

function hasTopicRequest(text) {
    const t = normalizeText(text);
    return /\bпро\s+\S+/.test(t) || /\bо\s+\S+/.test(t) || /\bоб\s+\S+/.test(t) || /\bна\s+тему\s+\S+/.test(t);
}

function hasCreativeWords(text) {
    const t = normalizeText(text);
    return /придумай|сочини|выдумай|новую|свою|сложн|хитр|необычн|странн|несуществ|воображ|фантаст|мифическ|невидан|которого нет|которой нет|не из списка/.test(t);
}

function isRiddleLike(text) {
    const t = normalizeText(text);
    return /загадк|загадай|отгадай|riddle|riddles|ghicitoare|ghicitori|ghiceste|ghicește/.test(t);
}

function isSimpleCachedRiddleRequest(text) {
    const t = normalizeText(text);
    if (!t) return false;

    const simple = [
        'загадай загадку',
        'дай загадку',
        'хочу загадку',
        'давай загадку',
        'расскажи загадку',
        'другую загадку',
        'еще загадку',
        'ещё загадку',
        'знаешь загадки',
        'ты знаешь загадки',
        'а загадки знаешь',
        'какие загадки знаешь',
        'какие нибудь загадки знаешь',
        'какие-нибудь загадки знаешь',
        'у тебя есть загадки',
        'есть загадки',
        'поиграем в загадки',
        'давай поиграем в загадки',
        'tell me a riddle',
        'give me a riddle',
        'do you know riddles',
        'do you know any riddles',
        'riddle please',
        'lets do a riddle',
        'let us do a riddle',
        'spune o ghicitoare',
        'dă-mi o ghicitoare',
        'da-mi o ghicitoare',
        'știi ghicitori',
        'stii ghicitori',
        'știi vreo ghicitoare',
        'stii vreo ghicitoare',
        'hai o ghicitoare',
    ];

    const looseSimplePattern = /(?:знаешь|есть|умеешь|можешь|расскажешь).{0,30}загадк|загадк.{0,20}(?:знаешь|есть|давай|расскажи)|(?:do you know|tell me|give me).{0,25}riddles?|riddles?.{0,20}(?:please|now)|(?:știi|stii|spune|dă-mi|da-mi).{0,25}ghicitori?|ghicitori?.{0,20}(?:te rog|acum)/u;

    const matchesSimple = simple.some((phrase) => t === phrase || t.includes(phrase)) || looseSimplePattern.test(t);
    if (!matchesSimple) return false;
    if (hasTopicRequest(t)) return false;
    if (hasCreativeWords(t)) return false;
    return true;
}

function shouldRouteRiddleToLlm(text) {
    const t = normalizeText(text);
    if (!isRiddleLike(t)) return false;
    return !isSimpleCachedRiddleRequest(t);
}

function detectOffer(reply, fallbackType = '') {
    const t = normalizeText(reply);
    const type = String(fallbackType || '').trim();
    if (!t) return null;

    if (/хочешь|давай|можем|будем/.test(t)) {
        if (/загадк/.test(t)) return { type: 'riddle', source: 'bot_offer' };
        if (/сказк|истори/.test(t)) return { type: 'story', source: 'bot_offer' };
        if (/поигр|игр/.test(t)) return { type: 'game', source: 'bot_offer' };
        if (/шутк|анекдот|смешн|пошут/.test(t)) return { type: 'joke', source: 'bot_offer' };
        if (/интересн|факт|расскажу|узна/.test(t)) return { type: 'fact', source: 'bot_offer' };
    }

    // Do not create generic pendingOffer=chat for ordinary questions like
    // "Что ты хочешь нарисовать?". Short replies to normal chat are handled
    // through lastBotReply context instead of sending bare "да" to the model.
    if (type && type !== 'chat' && /хочешь|еще|ещё|дальше|продолж/.test(t)) {
        return { type, source: 'fallback_type' };
    }

    return null;
}

function markBotReply(state, reply, meta = {}) {
    if (!state) return null;
    const offer = detectOffer(reply, meta.type || state.lastIntent || '');
    state.lastBotReply = String(reply || '').slice(0, 500);
    state.lastIntent = meta.type || state.lastIntent || 'chat';
    if (offer) {
        state.pendingOffer = {
            type: offer.type,
            createdAt: Date.now(),
            source: offer.source,
        };
        return state.pendingOffer;
    }
    return null;
}

function clearPendingOffer(state) {
    if (state) state.pendingOffer = null;
}

function resolveFollowup(state, text) {
    const pending = state?.pendingOffer;
    const lastIntent = state?.lastIntent || '';

    if (!normalizeText(text)) {
        return {
            action: 'clarify',
            type: 'chat',
            reply: voiceUx.pick('empty_text'),
            reason: 'empty_text',
        };
    }

    if (pending) {
        if (isAmbiguousNo(text)) {
            return {
                action: 'clarify',
                keepPending: true,
                reply: pending.type === 'riddle'
                    ? 'Я не совсем расслышала. Ты хочешь ещё загадку?'
                    : 'Я не совсем расслышала. Ты хочешь продолжить?',
            };
        }

        if (isAffirmative(text) || isContinueRequest(text)) {
            return { action: 'accept_offer', type: pending.type };
        }

        if (isNegative(text)) {
            let rejectKey = 'rejected_default';
            if (pending.type === 'story') rejectKey = 'rejected_story';
            if (pending.type === 'riddle') rejectKey = 'rejected_riddle';
            return {
                action: 'reject_offer',
                type: pending.type,
                reply: voiceUx.pick(rejectKey),
            };
        }

        if (isUncertain(text)) {
            return {
                action: 'clarify',
                keepPending: true,
                reply: pending.type === 'riddle'
                    ? 'Не страшно. Хочешь ещё загадку или закончим?'
                    : 'Не страшно. Продолжаем или выберем что-то другое?',
            };
        }
    }

    if (isContinueRequest(text) && lastIntent) {
        return { action: 'continue_last', type: lastIntent };
    }

    return null;
}

function rewriteForOffer(type) {
    if (type === 'riddle') return 'Загадай загадку';
    if (type === 'story') return 'Расскажи короткую сказку';
    if (type === 'game') return 'Давай поиграем';
    if (type === 'joke') return 'Расскажи короткую шутку';
    if (type === 'fact') return 'Расскажи интересный факт для ребенка';
    return '';
}

module.exports = {
    normalizeText,
    isAffirmative,
    isNegative,
    isUncertain,
    isHesitation,
    isContinueRequest,
    isSimpleCachedRiddleRequest,
    shouldRouteRiddleToLlm,
    detectOffer,
    markBotReply,
    clearPendingOffer,
    resolveFollowup,
    rewriteForOffer,
};
