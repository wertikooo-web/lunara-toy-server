'use strict';

const dialogState = require('./dialogState');

const OFFER_TTL_MS = 2 * 60 * 1000;

function nowMs() {
    return Date.now();
}

function createState() {
    return {
        pendingOffer: null,
        lastIntent: '',
        lastBotReply: '',
        lastUserText: '',
        lastDecision: null,
    };
}

function ensureState(state) {
    if (!state || typeof state !== 'object') return createState();
    if (!Object.prototype.hasOwnProperty.call(state, 'pendingOffer')) state.pendingOffer = null;
    if (typeof state.lastIntent !== 'string') state.lastIntent = '';
    if (typeof state.lastBotReply !== 'string') state.lastBotReply = '';
    if (typeof state.lastUserText !== 'string') state.lastUserText = '';
    if (!Object.prototype.hasOwnProperty.call(state, 'lastDecision')) state.lastDecision = null;
    return state;
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
        || dialogState.isContinueRequest(t)
        || t === 'no'
        || t === 'nope';
}

function replyForRejectedOffer(type) {
    if (type === 'riddle') return 'Хорошо, не буду загадывать. Можем просто поболтать или выбрать что-то другое.';
    if (type === 'story') return 'Хорошо, сказку оставим на потом. Можем просто поговорить.';
    if (type === 'game') return 'Хорошо, играть сейчас не будем. Можем спокойно поболтать.';
    return 'Хорошо, не буду. Можем просто поболтать или выбрать что-то другое.';
}

function clarifyForOffer(type) {
    if (type === 'riddle') return 'Я не совсем расслышала. Ты хочешь ещё загадку?';
    if (type === 'story') return 'Я не совсем расслышала. Ты хочешь сказку?';
    if (type === 'game') return 'Я не совсем расслышала. Ты хочешь поиграть?';
    return 'Я не совсем расслышала. Ты хочешь продолжить?';
}

function offerToText(type) {
    return dialogState.rewriteForOffer(type) || '';
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

function forgetPendingOffer(state) {
    const s = ensureState(state);
    s.pendingOffer = null;
    return s;
}

module.exports = {
    OFFER_TTL_MS,
    createState,
    ensureState,
    detectDecision,
    rememberBotReply,
    forgetPendingOffer,
    inferIntentFromText,
};
