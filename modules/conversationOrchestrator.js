'use strict';

const dialogState = require('./dialogState');
const voiceUx = require('./voiceUxPhrases');

const OFFER_TTL_MS = 2 * 60 * 1000;
const RIDDLE_HISTORY_LIMIT = 10;

function nowMs() {
    return Date.now();
}

function createActiveTask() {
    return {
        type: null,
        status: null,
        originalRequest: '',
        constraints: {},
        expectedAnswer: null,
        userHasAnswered: false,
        answerWasRevealed: false,
        lastGeneratedText: '',
        createdAt: 0,
        updatedAt: 0,
    };
}

function createState() {
    return {
        pendingOffer: null,
        lastIntent: '',
        lastBotReply: '',
        lastUserText: '',
        lastDecision: null,
        riddleHistory: [],
        currentRiddle: null,
        activeTask: createActiveTask(),
    };
}

function ensureState(state) {
    if (!state || typeof state !== 'object') return createState();
    if (!Object.prototype.hasOwnProperty.call(state, 'pendingOffer')) state.pendingOffer = null;
    if (typeof state.lastIntent !== 'string') state.lastIntent = '';
    if (typeof state.lastBotReply !== 'string') state.lastBotReply = '';
    if (typeof state.lastUserText !== 'string') state.lastUserText = '';
    if (!Object.prototype.hasOwnProperty.call(state, 'lastDecision')) state.lastDecision = null;
    if (!Array.isArray(state.riddleHistory)) state.riddleHistory = [];
    if (!Object.prototype.hasOwnProperty.call(state, 'currentRiddle')) state.currentRiddle = null;
    if (!state.activeTask || typeof state.activeTask !== 'object') state.activeTask = createActiveTask();
    return state;
}

function setActiveTask(state, type, patch = {}) {
    const s = ensureState(state);
    const now = nowMs();
    s.activeTask = {
        ...createActiveTask(),
        ...patch,
        type,
        createdAt: now,
        updatedAt: now,
    };
    return s.activeTask;
}

function updateActiveTask(state, patch = {}) {
    const s = ensureState(state);
    if (!s.activeTask?.type) return null;
    s.activeTask = { ...s.activeTask, ...patch, updatedAt: nowMs() };
    return s.activeTask;
}

function clearActiveTask(state) {
    const s = ensureState(state);
    s.activeTask = createActiveTask();
    return s.activeTask;
}

function isExpiredOffer(offer, now = nowMs()) {
    if (!offer?.createdAt) return false;
    return now - Number(offer.createdAt) > OFFER_TTL_MS;
}

function clearExpiredOffer(state, now = nowMs()) {
    const s = ensureState(state);
    if (isExpiredOffer(s.pendingOffer, now)) {
        s.pendingOffer = null;
    }
    return s;
}

function inferIntentFromText(text) {
    const t = dialogState.normalizeText(text);
    if (/загадк|загадай|отгадай|riddle|ghicitoare/.test(t)) return 'riddle';
    if (/сказк|истори|story|povest/.test(t)) return 'story';
    if (/поигр|игр|game|play|joc/.test(t)) return 'game';
    if (/скороговорк|tongue\s+twister|framantare|frământare/.test(t)) return 'tongue_twister';
    if (/факт|интересн|объясни|почему|как|зачем/.test(t)) return 'fact';
    return 'chat';
}

function isShortFollowup(text) {
    const t = dialogState.normalizeText(text);
    if (!t) return false;
    return dialogState.isAffirmative(t)
        || dialogState.isNegative(t)
        || dialogState.isUncertain(t)
        || dialogState.isContinueRequest(t)
        || t === 'no'
        || t === 'nope';
}

function replyForRejectedOffer(type) {
    return voiceUx.pick(type === 'story' ? 'rejected_story' : type === 'riddle' ? 'rejected_riddle' : 'rejected_default');
}

function clarifyForOffer(type) {
    return voiceUx.pick(type === 'riddle' ? 'clarify_riddle' : 'clarify_default');
}

function replyForUncertainOffer(type) {
    return voiceUx.pick(type === 'riddle' ? 'uncertain_riddle' : 'uncertain_default');
}

function offerToText(type) {
    return dialogState.rewriteForOffer(type) || '';
}

// Requires BOTH an explicit repeat verb AND an explicit riddle reference.
// Bare ordinal words ("первую"/"прошлую"/"предыдущую") or pronouns ("её"/"эту")
// are too ambiguous on their own — e.g. "первая буква в слове зебра" must NOT
// trigger this (it has no repeat verb and no "загадк" root).
function isRepeatRiddleRequest(text) {
    const t = dialogState.normalizeText(text);
    if (!t) return false;

    const hasRepeatVerb = /(повтори|повторить|скажи еще раз|еще раз|заново)/.test(t);
    if (!hasRepeatVerb) return false;

    return /загадк/.test(t);
}

function riddleRepeatRef(text) {
    const t = dialogState.normalizeText(text);
    if (/перв/.test(t)) return 'first';
    if (/прошл|предыдущ/.test(t)) return 'previous';
    if (/эту|текущ|последн|её|ее|еще раз|ещё раз/.test(t)) return 'current';
    return 'current';
}

function getRiddleFromHistory(state, ref = 'current') {
    const s = ensureState(state);
    const history = s.riddleHistory || [];
    if (history.length === 0) return null;
    if (ref === 'first') return history[0] || null;
    if (ref === 'previous') return history.length >= 2 ? history[history.length - 2] : history[history.length - 1];
    return s.currentRiddle || history[history.length - 1] || null;
}

function repeatRiddleDecision(state, text) {
    const s = ensureState(state);
    const ref = riddleRepeatRef(text);
    const item = getRiddleFromHistory(s, ref);
    s.pendingOffer = null;

    if (!item?.audioUrl) {
        return {
            action: 'reply',
            type: 'riddle',
            reply: 'Я пока не могу повторить прошлую загадку. Давай загадаю новую?',
            reason: 'repeat_riddle_missing_history',
        };
    }

    return {
        action: 'repeat_riddle',
        type: 'riddle',
        reason: `repeat_${ref}_riddle`,
        ref,
        riddleId: item.id || null,
        audioUrl: item.audioUrl,
        durationMs: item.durationMs || 2500,
        activeRiddle: item.activeRiddle || null,
        reply: ref === 'first' ? 'Повторяю первую загадку.' : 'Повторяю загадку.',
    };
}

function shortReplyContext(text, state) {
    const s = ensureState(state);
    const t = dialogState.normalizeText(text);
    const lastBot = s.lastBotReply ? ` Последняя реплика Lumi: "${s.lastBotReply}".` : '';

    if (dialogState.isAffirmative(t)) {
        return `Ребёнок ответил коротко: "${text}". Это согласие/подтверждение к предыдущей реплике.${lastBot} Продолжи естественно, без фразы "я не поняла". Если предыдущая реплика была вопросом с выбором, а ответ "да" не выбирает вариант, коротко уточни выбор.`;
    }
    if (dialogState.isNegative(t)) {
        return `Ребёнок ответил коротко: "${text}". Это отказ или несогласие с предыдущей репликой.${lastBot} Прими отказ спокойно и предложи мягкую альтернативу.`;
    }
    if (dialogState.isUncertain(t)) {
        return `Ребёнок ответил коротко: "${text}". Это неуверенность или "не знаю" к предыдущему вопросу.${lastBot} Поддержи и предложи простой следующий шаг.`;
    }
    if (dialogState.isHesitation(t)) {
        return `Ребёнок сказал короткое "${text}". Это пауза/заминка.${lastBot} Мягко помоги продолжить.`;
    }
    return '';
}

function detectDecision(text, state, options = {}) {
    const s = clearExpiredOffer(ensureState(state), options.now || nowMs());
    const normalized = dialogState.normalizeText(text);
    const intent = inferIntentFromText(text);

    s.lastUserText = String(text || '').slice(0, 500);

    if (!normalized) {
        const decision = {
            action: 'clarify',
            type: 'chat',
            reply: 'Ой, я не расслышала. Скажи ещё раз, пожалуйста.',
            reason: 'empty_text',
        };
        s.lastDecision = decision;
        return decision;
    }

    if (isRepeatRiddleRequest(text)) {
        const decision = repeatRiddleDecision(s, text);
        s.lastDecision = decision;
        return decision;
    }

    if (s.pendingOffer && isShortFollowup(text)) {
        const pendingType = s.pendingOffer.type || 'chat';

        if (normalized === 'no' || normalized === 'nope') {
            const decision = {
                action: 'clarify',
                type: pendingType,
                reply: clarifyForOffer(pendingType),
                keepPendingOffer: true,
                reason: 'ambiguous_short_no',
            };
            s.lastDecision = decision;
            return decision;
        }

        if (dialogState.isAffirmative(text) || dialogState.isContinueRequest(text)) {
            if (pendingType === 'chat') {
                s.pendingOffer = null;
                const decision = {
                    action: 'llm',
                    type: 'chat',
                    rewrittenText: shortReplyContext(text, s) || String(text || ''),
                    reason: 'short_reply_with_context',
                };
                s.lastDecision = decision;
                return decision;
            }

            const rewrittenText = offerToText(pendingType);
            s.pendingOffer = null;
            const decision = {
                action: rewrittenText ? 'rewrite_to_llm' : 'llm',
                type: pendingType,
                rewrittenText: rewrittenText || String(text || ''),
                reason: 'accepted_pending_offer',
            };
            s.lastDecision = decision;
            return decision;
        }

        if (dialogState.isNegative(text)) {
            s.pendingOffer = null;
            const decision = {
                action: 'reply',
                type: pendingType,
                reply: replyForRejectedOffer(pendingType),
                reason: 'rejected_pending_offer',
            };
            s.lastDecision = decision;
            return decision;
        }

        if (dialogState.isUncertain(text)) {
            const decision = {
                action: 'reply',
                type: pendingType,
                reply: replyForUncertainOffer(pendingType),
                keepPendingOffer: true,
                reason: 'uncertain_pending_offer',
            };
            s.lastDecision = decision;
            return decision;
        }
    }

    if (!s.pendingOffer && dialogState.isContinueRequest(text) && s.lastIntent && s.lastIntent !== 'chat') {
        const rewrittenText = offerToText(s.lastIntent);
        const decision = {
            action: rewrittenText ? 'rewrite_to_llm' : 'llm',
            type: s.lastIntent,
            rewrittenText: rewrittenText || String(text || ''),
            reason: 'continue_last_intent',
        };
        s.lastDecision = decision;
        return decision;
    }

    if (!s.pendingOffer && isShortFollowup(text)) {
        const context = shortReplyContext(text, s);
        const decision = {
            action: 'llm',
            type: s.lastIntent || 'chat',
            rewrittenText: context || String(text || ''),
            reason: 'short_reply_with_context',
        };
        s.lastDecision = decision;
        return decision;
    }

    if (dialogState.shouldRouteRiddleToLlm(text)) {
        const decision = {
            action: 'llm',
            type: 'riddle',
            reason: 'riddle_needs_llm',
        };
        s.lastDecision = decision;
        return decision;
    }

    if (dialogState.isSimpleCachedRiddleRequest(text)) {
        const decision = {
            action: 'cache',
            type: 'riddle',
            reason: 'simple_cached_riddle',
        };
        s.lastDecision = decision;
        return decision;
    }

    const decision = {
        action: 'llm',
        type: intent,
        reason: 'normal_conversation',
    };
    s.lastDecision = decision;
    return decision;
}

function rememberBotReply(state, reply, meta = {}) {
    const s = ensureState(state);
    const text = String(reply || '').trim();
    const type = meta.type || s.lastDecision?.type || s.lastIntent || 'chat';
    s.lastBotReply = text.slice(0, 500);
    s.lastIntent = type || 'chat';

    const offer = dialogState.detectOffer(text, type);
    if (offer) {
        s.pendingOffer = {
            type: offer.type,
            createdAt: nowMs(),
            source: offer.source,
        };
        return s.pendingOffer;
    }

    return null;
}

function rememberRiddle(state, riddle, audio, meta = {}) {
    const s = ensureState(state);
    if (!audio?.url && !audio?.audioUrl) return null;

    const item = {
        id: riddle?.id || `riddle_${nowMs()}`,
        answer: riddle?.answer || null,
        audioUrl: audio.url || audio.audioUrl,
        durationMs: audio.durationMs || 2500,
        activeRiddle: riddle || null,
        source: meta.source || 'riddle_engine',
        requestText: String(meta.requestText || '').slice(0, 500),
        createdAt: nowMs(),
    };

    s.riddleHistory.push(item);
    if (s.riddleHistory.length > RIDDLE_HISTORY_LIMIT) {
        s.riddleHistory.splice(0, s.riddleHistory.length - RIDDLE_HISTORY_LIMIT);
    }
    s.currentRiddle = item;
    s.lastIntent = 'riddle';
    return item;
}

function rememberGeneratedRiddle(state, reply, audio, meta = {}) {
    const text = String(reply || '').trim();
    if (!text || !audio?.audioUrl) return null;
    return rememberRiddle(state, null, {
        url: audio.audioUrl,
        durationMs: audio.durationMs,
    }, {
        source: meta.source || 'llm',
        requestText: meta.requestText || '',
    });
}

function forgetPendingOffer(state) {
    const s = ensureState(state);
    s.pendingOffer = null;
    return s;
}

module.exports = {
    OFFER_TTL_MS,
    RIDDLE_HISTORY_LIMIT,
    createState,
    ensureState,
    detectDecision,
    rememberBotReply,
    rememberRiddle,
    rememberGeneratedRiddle,
    forgetPendingOffer,
    inferIntentFromText,
    getRiddleFromHistory,
    createActiveTask,
    setActiveTask,
    updateActiveTask,
    clearActiveTask,
    isRepeatRiddleRequest,
};
