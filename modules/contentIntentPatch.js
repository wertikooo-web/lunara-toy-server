'use strict';

const content = require('./content');
const logger = require('./logger');

function normalizeRequest(value) {
    return String(value || '')
        .toLocaleLowerCase('ru-RU')
        .replace(/ё/g, 'е')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeContentLang(lang, text = '') {
    const value = String(lang || '').trim();
    if (value.startsWith('ru')) return 'ru-RU';
    if (value.startsWith('ro')) return 'ro-RO';
    if (value.startsWith('en')) return 'en-US';

    const sample = normalizeRequest(text);
    const letters = (sample.match(/\p{L}/gu) || []).length;
    const cyrillic = (sample.match(/[\u0400-\u04FF]/g) || []).length;
    if (letters > 0 && cyrillic / letters > 0.3) return 'ru-RU';
    if (/[ăâîșț]/i.test(sample)) return 'ro-RO';
    if (/[a-z]/i.test(sample)) return 'en-US';
    return 'ru-RU';
}

function cleanSpokenText(text, type) {
    let value = String(text || '').trim();

    if (type === 'joke') {
        value = value.replace(/^\s*(?:шутка|анекдот|joke)(?:\s*№?\s*\d+)?\s*[.:—–-]\s*/iu, '');
    }

    if (type === 'fact') {
        value = value.replace(/^\s*(?:факт|интересный\s+факт|fact|interesting\s+fact)(?:\s*№?\s*\d+)?\s*[.:—–-]\s*/iu, '');
    }

    return value.trim();
}

function extraContentIntent(text) {
    const t = normalizeRequest(text);
    if (!t) return null;

    if (/(сказк|истори|story|povest)/iu.test(t)) {
        return null;
    }

    if (/(шутк|шуточк|анекдот|рассмеши|пошути|смешн|скажи.{0,25}смешн|расскажи.{0,25}смешн|что(?:-нибудь| нибудь)?.{0,25}смешн|развесели|прикол|хочу.{0,20}смеяться)/iu.test(t)) {
        return 'joke';
    }

    if (/(факт|фактик|интересн.{0,20}факт|расскажи.{0,35}(?:интересн|необычн|любопытн)|что(?:-нибудь| нибудь)?.{0,25}(?:интересн|необычн|любопытн)|удиви|удивительн|любопытн|необычн|а ты знаешь|знаешь что|знаешь.{0,20}интересн|хочу.{0,25}узнать)/iu.test(t)) {
        return 'fact';
    }

    if (/(мне скучно|скучно|нечего делать|что делать|развлеки|займи меня|давай что(?:-нибудь| нибудь)|хочу что(?:-нибудь| нибудь)|давай повеселимся|поиграй со мной|давай играть|сыграем|во что играть|играть хочу|хочу игру)/iu.test(t)) {
        return 'mini_game';
    }

    return null;
}

const originalClassifyRequest = typeof content.classifyRequest === 'function'
    ? content.classifyRequest.bind(content)
    : null;

const originalTryHandleShortRequest = typeof content.tryHandleShortRequest === 'function'
    ? content.tryHandleShortRequest.bind(content)
    : null;

content.classifyRequest = function patchedClassifyRequest(text) {
    return extraContentIntent(text) || (originalClassifyRequest ? originalClassifyRequest(text) : null);
};

async function handleJokeOrFact(type, text, options = {}) {
    const baseUrl = options.baseUrl;
    if (!baseUrl) throw new Error('contentIntentPatch requires baseUrl');

    const requestedLang = normalizeContentLang(options.lang, text);
    // Точное совпадение по языку и только оно. Раньше падение на 'ru-RU' или на
    // первый попавшийся элемент означало, что румынский/английский ребёнок мог
    // получить русскую шутку. Теперь при отсутствии контента на нужном языке
    // возвращаем null — пайплайн уйдёт в LLM и сгенерирует ответ на лету.
    const items = await content.pickItems(type, 10);
    const item = (items || []).find((candidate) => normalizeContentLang(candidate.lang || 'ru-RU') === requestedLang);

    if (!item) {
        if (requestedLang !== 'ru-RU') {
            logger.info(`[ContentIntentPatch] no cached ${type} for lang=${requestedLang}; falling through to LLM`);
        }
        return null;
    }

    const reply = cleanSpokenText(item.text, type);
    if (!reply) return null;

    const audio = await content.ensureCachedReply(reply, {
        baseUrl,
        lang: item.lang || requestedLang,
        key: `${type}_${item.id || 'item'}_${process.env.AUDIO_CACHE_VERSION || 'v3'}`,
        title: item.title || type,
    });

    return {
        item: {
            ...item,
            type,
            text: reply,
        },
        reply,
        audioUrl: audio.audioUrl,
        durationMs: audio.durationMs,
        cached: audio.cached,
        lang: item.lang || requestedLang,
    };
}

content.tryHandleShortRequest = async function patchedTryHandleShortRequest(text, options = {}) {
    const type = extraContentIntent(text);

    if (type === 'joke' || type === 'fact') {
        return handleJokeOrFact(type, text, options);
    }

    if (type === 'mini_game' && originalTryHandleShortRequest) {
        return originalTryHandleShortRequest('давай поиграем', options);
    }

    return originalTryHandleShortRequest ? originalTryHandleShortRequest(text, options) : null;
};

logger.info('[ContentIntentPatch] natural joke/fact/boredom intents enabled');
