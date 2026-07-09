'use strict';

// Routes creative/unknown-topic riddle requests to the normal LLM pipeline.
// Cached riddles are still used for simple requests like "загадай загадку"
// and for known topics like animals, forest, farm, zoo, etc.

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

const KNOWN_CACHED_TOPIC_WORDS = [
    // broad cached categories
    'животн', 'звер', 'птиц', 'насеком', 'рыб', 'лес', 'ферм', 'домашн',
    'зоопарк', 'африк', 'природ', 'вод', 'речк', 'море', 'город', 'ноч',
    'еда', 'фрукт', 'овощ', 'предмет', 'игруш', 'одежд', 'обув', 'школ',
    'зим', 'лет', 'осен', 'весн', 'погод', 'цвет', 'транспорт',

    // common animal/topic words that are represented in the JSON set
    'лягуш', 'лис', 'медвед', 'мишк', 'белк', 'зая', 'зайц', 'собак', 'пес', 'пёс',
    'кош', 'кот', 'еж', 'ёж', 'свин', 'коров', 'лошад', 'утк', 'сова', 'голуб',
    'петух', 'петуш', 'бабоч', 'пчел', 'паук', 'жираф', 'слон', 'зебр', 'лев',
    'тигр', 'обезьян', 'крокодил', 'пингвин', 'дельфин', 'кит', 'акул',

    // common sky/nature words that are represented enough for cache
    'солнц', 'луна', 'месяц', 'звезд', 'звёзд', 'облак', 'дожд', 'снег', 'мороз',

    // Romanian/English common cached topic hints
    'animal', 'bird', 'insect', 'forest', 'farm', 'zoo', 'africa', 'nature', 'water',
    'food', 'fruit', 'object', 'toy', 'weather', 'sky', 'soare', 'stele', 'animale',
];

function hasKnownCachedTopic(text) {
    const t = normalizeText(text);
    return KNOWN_CACHED_TOPIC_WORDS.some(word => t.includes(normalizeText(word)));
}

function hasExplicitTopicPhrase(text) {
    const t = normalizeText(text);

    return (
        /\bпро\s+\S+/.test(t) ||
        /\bо\s+\S+/.test(t) ||
        /\bоб\s+\S+/.test(t) ||
        /\bна\s+тему\s+\S+/.test(t) ||
        /\babout\s+\S+/.test(t) ||
        /\bdespre\s+\S+/.test(t)
    );
}

function isUnknownTopicRiddle(text) {
    const t = normalizeText(text);

    if (!isRiddleLike(t)) return false;
    if (!hasExplicitTopicPhrase(t)) return false;

    // If the topic is not clearly supported by the local JSON database,
    // let the LLM invent a suitable riddle instead of returning a random cached one.
    return !hasKnownCachedTopic(t);
}

function isCreativeRiddle(text) {
    const t = normalizeText(text);

    if (!isRiddleLike(t)) return false;

    return (
        isUnknownTopicRiddle(t) ||
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
        '- The child asks for a new original riddle or a riddle on a topic not covered by the local cache.',
        '- Create ONE short original riddle suitable for a child aged 3-8.',
        '- Respect the requested topic if one is provided.',
        '- Do not reveal the answer immediately.',
        '- Keep it playful, kind, simple, and not scary.',
        '- End with a short, playful, language-appropriate question inviting the child to guess (e.g., "Как думаешь, кто это?" for Russian, "Ce crezi că este?" for Romanian, or "What do you think it is?" for English).',
        '- Remember the answer in conversation context so you can check the child’s next reply.',
        '- If the child answers next, say whether it is close or correct, then gently explain.',
    ].join('\n');
}

function patchRiddleEngine(exported) {
    if (!exported || exported.__creativeRiddlePatched) return exported;

    const originalIsRiddleRequest = exported.isRiddleRequest;

    if (typeof originalIsRiddleRequest === 'function') {
        exported.isRiddleRequest = function patchedIsRiddleRequest(text) {
            if (isCreativeRiddle(text)) {
                console.log(`[CreativeRiddle] routing to LLM: ${JSON.stringify(String(text || '').slice(0, 120))}`);
                return false;
            }
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
            if (isCreativeRiddle(text)) {
                console.log(`[CreativeRiddle] skipping content cache: ${JSON.stringify(String(text || '').slice(0, 120))}`);
                return null;
            }
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
                console.log(`[CreativeRiddle] LLM context attached: ${JSON.stringify(String(routingText || '').slice(0, 120))}`);
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
