'use strict';

// Routes creative riddle requests to the normal LLM pipeline without changing server.js.
// Cached riddles are still used for simple requests like "загадай загадку".

const Module = require('module');
const originalLoad = Module._load;

function normalizeText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[.,!?;:()[\]{}"«»]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isRiddleLike(text) {
    const t = normalizeText(text);

    return (
        t.includes('загадк') ||
        t.includes('загадай') ||
        t.includes('отгадай') ||
        t.includes('riddle') ||
        t.includes('ghicitoare')
    );
}

function isCreativeRiddle(text) {
    const t = normalizeText(text);

    if (!isRiddleLike(t)) return false;

    return (
        t.includes('придумай') ||
        t.includes('сочини') ||
        t.includes('выдумай') ||
        t.includes('сам придумай') ||
        t.includes('сама придумай') ||
        t.includes('новую') ||
        t.includes('необычную') ||
        t.includes('сложную') ||
        t.includes('очень сложную') ||
        t.includes('хитрую') ||
        t.includes('которой не существует') ||
        t.includes('которой нет') ||
        t.includes('не из списка') ||
        t.includes('фантастическую') ||
        t.includes('волшебную загадку') ||
        t.includes('original riddle') ||
        t.includes('new riddle') ||
        t.includes('hard riddle')
    );
}

function creativeRiddleContext() {
    return [
        'CREATIVE RIDDLE MODE:',
        '- The child asks for a new original riddle, not a cached riddle.',
        '- Create ONE short original riddle suitable for a child aged 3-8.',
        '- Do not reveal the answer immediately.',
        '- Keep it playful, kind, simple, and not scary.',
        '- End with a short question like: "Как думаешь, что это?"',
        '- Remember the answer in conversation context so you can check the child’s next reply.',
        '- If the child answers next, say whether it is close or correct, then gently explain.',
    ].join('\n');
}

function patchRiddleEngine(exported) {
    if (!exported || exported.__creativeRiddlePatched) return exported;

    const originalIsRiddleRequest = exported.isRiddleRequest;

    if (typeof originalIsRiddleRequest === 'function') {
        exported.isRiddleRequest = function patchedIsRiddleRequest(text) {
            if (isCreativeRiddle(text)) return false;
            return originalIsRiddleRequest.call(this, text);
        };
    }

    exported.shouldUseLlmRiddle = isCreativeRiddle;
    exported.__creativeRiddlePatched = true;
    return exported;
}

function patchContent(exported) {
    if (!exported || exported.__creativeRiddlePatched) return exported;

    const originalTryHandleShortRequest = exported.tryHandleShortRequest;
    const originalCheckPendingAnswer = exported.checkPendingAnswer;
    const originalClassifyRequest = exported.classifyRequest;

    if (typeof originalTryHandleShortRequest === 'function') {
        exported.tryHandleShortRequest = async function patchedTryHandleShortRequest(text, options) {
            if (isCreativeRiddle(text)) return null;
            return originalTryHandleShortRequest.call(this, text, options);
        };
    }

    if (typeof originalCheckPendingAnswer === 'function') {
        exported.checkPendingAnswer = function patchedCheckPendingAnswer(pendingContent, text) {
            if (isCreativeRiddle(text)) return null;
            return originalCheckPendingAnswer.call(this, pendingContent, text);
        };
    }

    if (typeof originalClassifyRequest === 'function') {
        exported.classifyRequest = function patchedClassifyRequest(text) {
            if (isCreativeRiddle(text)) return 'riddle';
            return originalClassifyRequest.call(this, text);
        };
    }

    exported.__creativeRiddlePatched = true;
    return exported;
}

function patchLlm(exported) {
    if (!exported || exported.__creativeRiddlePatched) return exported;

    const originalChat = exported.chat;

    if (typeof originalChat === 'function') {
        exported.chat = async function patchedChat(sessionRef, text, lang, options = {}) {
            const routingText = options?.routingText || text;

            if (isCreativeRiddle(routingText)) {
                const nextOptions = {
                    ...options,
                    contentContext: [options.contentContext, creativeRiddleContext()].filter(Boolean).join('\n\n'),
                };

                return originalChat.call(this, sessionRef, text, lang, nextOptions);
            }

            return originalChat.call(this, sessionRef, text, lang, options);
        };
    }

    exported.__creativeRiddlePatched = true;
    return exported;
}

Module._load = function patchedLoad(request, parent, isMain) {
    const exported = originalLoad.apply(this, arguments);
    const parentFile = parent?.filename || '';

    if (request === './modules/riddleEngine' || request.endsWith('/riddleEngine')) {
        return patchRiddleEngine(exported);
    }

    if ((request === './modules/content' || request.endsWith('/content')) && parentFile.endsWith('server.js')) {
        return patchContent(exported);
    }

    if ((request === './modules/llm' || request.endsWith('/llm')) && parentFile.endsWith('server.js')) {
        return patchLlm(exported);
    }

    return exported;
};
