'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const voiceUx = require('./voiceUxPhrases');
const content = require('./content');

let audioDir = null;
let ttsModule = null;
let log = console;

let riddles = [];
let topicAliases = {};

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

// По умолчанию используем всю базу загадок.
// Можно переопределить в Railway через RIDDLE_ACTIVE_LIMIT.
const DEFAULT_ACTIVE_LIMIT = 200;

function activeLimit() {
    const raw = Number(process.env.RIDDLE_ACTIVE_LIMIT || DEFAULT_ACTIVE_LIMIT);
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ACTIVE_LIMIT;
    return Math.min(raw, riddles.length);
}

function normalizeText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[.,!?;:()[\]{}"«»]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function shortHash(text) {
    return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 8);
}

function stripAnswerNoise(text) {
    return normalizeText(text)
        .replace(/\bэто\b/g, ' ')
        .replace(/\bнаверное\b/g, ' ')
        .replace(/\bкажется\b/g, ' ')
        .replace(/\bя думаю\b/g, ' ')
        .replace(/\bдумаю\b/g, ' ')
        .replace(/\bможет\b/g, ' ')
        .replace(/\bну\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isLikelyRiddleAnswer(text) {
    const raw = normalizeText(text);
    const cleaned = stripAnswerNoise(text);

    if (!cleaned) return false;

    // Явные просьбы, вопросы и продолжение разговора не считаем ответом.
    // Иначе "дай другую загадку" ошибочно станет неправильной попыткой.
    if (/(загадк|загадай|дай еще|дай ещё|другую|новую|следующую|расскажи|поговорим|почему|зачем|как|что такое|про )/.test(raw)) {
        return false;
    }

    const words = cleaned.split(' ').filter(Boolean);

    // Детский ответ обычно короткий:
    // "медведь", "это медведь", "наверное лиса"
    return words.length <= 3;
}

function durationFromPcm(pcmPath, fallbackMs = 1500) {
    try {
        const bytes = fs.statSync(pcmPath).size;
        return Math.ceil((bytes / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000);
    } catch (_) {
        return fallbackMs;
    }
}

function audioUrl(baseUrl, relativePath) {
    return `${baseUrl}/audio/${relativePath.replace(/\\/g, '/')}`;
}

function riddleDir() {
    return path.join(audioDir, 'riddles');
}

function repliesDir() {
    return path.join(audioDir, 'riddles', 'replies');
}

function ensureDirs() {
    fs.mkdirSync(riddleDir(), { recursive: true });
    fs.mkdirSync(repliesDir(), { recursive: true });
}

function riddlePcmPath(riddleId, voiceLabel) {
    return path.join(riddleDir(), `${riddleId}_${voiceLabel}.pcm`);
}

function replyPcmPath(key, voiceLabel) {
    return path.join(repliesDir(), `${key}_${voiceLabel}.pcm`);
}

async function ensureAudio(text, pcmPath, lang = 'ru-RU', voiceConfig = null) {
    if (fs.existsSync(pcmPath)) {
        return;
    }

    await ttsModule.synthesize(text, pcmPath, lang, { voiceConfig });
}

async function init(options) {
    audioDir = options.audioDir;
    ttsModule = options.tts;
    log = options.logger || console;

    if (!audioDir) {
        throw new Error('[Riddle] audioDir is required');
    }

    if (!ttsModule || typeof ttsModule.synthesize !== 'function') {
        throw new Error('[Riddle] tts.synthesize is required');
    }

    ensureDirs();

    const riddlesPath = path.join(__dirname, '..', 'data', 'riddles_ru.json');
    const riddlesRaw = fs.readFileSync(riddlesPath, 'utf8');
    riddles = JSON.parse(riddlesRaw);

    if (!Array.isArray(riddles) || riddles.length === 0) {
        throw new Error('[Riddle] riddles_ru.json is empty or invalid');
    }

    const topicsPath = path.join(__dirname, '..', 'data', 'riddle_topics_ru.json');

    if (fs.existsSync(topicsPath)) {
        const topicsRaw = fs.readFileSync(topicsPath, 'utf8');
        topicAliases = JSON.parse(topicsRaw);
    } else {
        topicAliases = {};
        log.warn('[Riddle] riddle_topics_ru.json not found; topic matching disabled');
    }

    log.info(`[Riddle] loaded ${riddles.length} riddle(s), active limit=${activeLimit()}, topics=${Object.keys(topicAliases).length}`);
}

function isRiddleRequest(text) {
    const t = normalizeText(text);

    return (
        t.includes('загадай загадку') ||
        t.includes('дай загадку') ||
        t.includes('хочу загадку') ||
        t.includes('расскажи загадку') ||
        t.includes('загадку') ||
        t.includes('поиграем в загадки') ||
        t.includes('давай загадку') ||
        t.includes('придумай загадку') ||
        t.includes('сочини загадку') ||
        t.includes('выдумай загадку')
    );
}

function shouldUseLlmRiddle(text) {
    const t = normalizeText(text);

    if (!isRiddleRequest(t)) return false;

    return (
        t.includes('придумай') ||
        t.includes('сочини') ||
        t.includes('выдумай') ||
        t.includes('сам придумай') ||
        t.includes('сама придумай') ||
        t.includes('новую') ||
        t.includes('новую загадку') ||
        t.includes('необычную') ||
        t.includes('сложную') ||
        t.includes('очень сложную') ||
        t.includes('хитрую') ||
        t.includes('которой не существует') ||
        t.includes('которой нет') ||
        t.includes('не из списка') ||
        t.includes('фантастическую') ||
        t.includes('волшебную загадку')
    );
}

function isRevealRequest(text) {
    const t = normalizeText(text);

    return (
        t.includes('скажи ответ') ||
        t.includes('какой ответ') ||
        t.includes('дай ответ') ||
        t.includes('не знаю') ||
        t.includes('не понял') ||
        t.includes('не поняла') ||
        t.includes('подскажи')
    );
}

function pickWeighted(list) {
    if (!Array.isArray(list) || list.length === 0) return null;

    const totalWeight = list.reduce((sum, item) => sum + (item.weight || 1), 0);
    let roll = Math.random() * totalWeight;

    for (const item of list) {
        roll -= item.weight || 1;
        if (roll <= 0) return item;
    }

    return list[0];
}

function requestContainsAny(text, words = []) {
    const t = normalizeText(text);

    return words.some(word => {
        const w = normalizeText(word);
        if (!w || w.length < 3) return false;
        return t.includes(w);
    });
}

function getAvoidedRiddleIds(requestText) {
    const avoided = new Set();

    for (const item of riddles) {
        const avoidWords = Array.isArray(item.avoid_if_requested)
            ? item.avoid_if_requested
            : [item.answer, ...(item.aliases || [])];

        if (requestContainsAny(requestText, avoidWords)) {
            avoided.add(item.id);
        }
    }

    return avoided;
}

function getRequestedTags(requestText) {
    const tags = new Set();
    const t = normalizeText(requestText);

    if (!t) return tags;

    // 1. Сначала читаем отдельный словарь тем.
    // Например: "жирафа" -> zoo / animals / africa.
    for (const [tag, aliases] of Object.entries(topicAliases || {})) {
        if (requestContainsAny(t, aliases)) {
            tags.add(tag);
        }
    }

    // 2. Потом, если ребёнок назвал конкретный ответ,
    // берём теги этой загадки, но саму эту загадку потом исключим.
    for (const item of riddles) {
        const answerWords = [
            item.answer,
            ...(item.aliases || []),
            ...(item.avoid_if_requested || []),
        ];

        if (requestContainsAny(t, answerWords)) {
            for (const tag of item.tags || []) {
                tags.add(tag);
            }
        }
    }

    return tags;
}

function hasAnyTag(item, tags) {
    const itemTags = Array.isArray(item.tags) ? item.tags : [];
    return itemTags.some(tag => tags.has(tag));
}

function findTopicRiddle(requestText) {
    const requestedTags = getRequestedTags(requestText);

    if (requestedTags.size === 0) {
        return null;
    }

    const avoidedIds = getAvoidedRiddleIds(requestText);

    // Для тематического запроса используем всю базу, а не только activeLimit.
    // Иначе "про жирафа" может не найти нормальную замену внутри первых 20.
    const candidates = riddles.filter(item => {
        if (avoidedIds.has(item.id)) return false;
        return hasAnyTag(item, requestedTags);
    });

    if (candidates.length === 0) {
        log.info(`[Riddle] topic requested but no safe candidate found; tags=${Array.from(requestedTags).join(',')}`);
        return null;
    }

    const picked = pickWeighted(candidates);

    if (picked) {
        log.info(`[Riddle] matched topic tags=${Array.from(requestedTags).join(',')} selected=${picked.id}, answer="${picked.answer}"`);
    }

    return picked;
}

function pickRiddle(requestText = '') {
    const topicRiddle = findTopicRiddle(requestText);

    if (topicRiddle) {
        return topicRiddle;
    }

    const limit = activeLimit();
    const pool = riddles.slice(0, limit);

    return pickWeighted(pool) || pool[0] || riddles[0];
}

function isCorrectAnswer(text, activeRiddle) {
    const cleaned = stripAnswerNoise(text);

    const answers = [
        activeRiddle.answer,
        ...(activeRiddle.aliases || []),
    ]
        .filter(Boolean)
        .map(normalizeText);

    return answers.some(answer => {
        if (!answer) return false;

        return cleaned === answer || cleaned.includes(answer);
    });
}

async function buildRiddleAudioCommand(riddle, baseUrl) {
    const voiceConfig = content.getVoiceConfig();
    const label = content.voiceCacheLabel(voiceConfig);
    const pcmPath = riddlePcmPath(riddle.id, label);

    // Не говорим "загадка про жирафа", даже если ребёнок просил тему.
    // Просто даём загадку.
    const spokenText = riddle.question;

    await ensureAudio(spokenText, pcmPath, 'ru-RU', voiceConfig);

    return {
        url: audioUrl(baseUrl, `riddles/${riddle.id}_${label}.wav`),
        durationMs: durationFromPcm(pcmPath, 2500),
    };
}

async function buildReplyAudioCommand(key, text, baseUrl) {
    const voiceConfig = content.getVoiceConfig();
    const label = content.voiceCacheLabel(voiceConfig);
    const pcmPath = replyPcmPath(key, label);

    await ensureAudio(text, pcmPath, 'ru-RU', voiceConfig);

    return {
        url: audioUrl(baseUrl, `riddles/replies/${key}_${label}.wav`),
        durationMs: durationFromPcm(pcmPath, 1800),
    };
}

async function startRiddle(baseUrl, requestText = '') {
    const riddle = pickRiddle(requestText);
    const audio = await buildRiddleAudioCommand(riddle, baseUrl);

    log.info(`[Riddle] selected ${riddle.id}, answer="${riddle.answer}"`);

    return {
        riddle: {
            id: riddle.id,
            answer: riddle.answer,
            aliases: riddle.aliases || [],
            attempts: 0,
        },
        audio,
    };
}

async function handleActiveRiddleAnswer(text, activeRiddle, baseUrl, options = {}) {
    const childGender = options.childGender || options.gender || 'M';

    if (!activeRiddle) {
        const phrase = voiceUx.pick('riddle_no_active');
        const audio = await buildReplyAudioCommand(`no_active_${shortHash(phrase)}`, phrase, baseUrl);

        return {
            handled: true,
            clearRiddle: false,
            activeRiddle,
            audio,
        };
    }

    if (!isRevealRequest(text) && !isLikelyRiddleAnswer(text)) {
        log.info(`[Riddle] phrase is not a likely answer: "${text}"`);

        return {
            handled: false,
            clearRiddle: false,
            activeRiddle,
            audio: null,
        };
    }

    if (isRevealRequest(text)) {
        const phrase = `Ответ: ${activeRiddle.answer}. Хочешь ещё одну загадку?`;
        const audio = await buildReplyAudioCommand(`answer_${activeRiddle.id}`, phrase, baseUrl);

        log.info(`[Riddle] reveal answer ${activeRiddle.id}: ${activeRiddle.answer}`);

        return {
            handled: true,
            clearRiddle: true,
            activeRiddle: null,
            audio,
        };
    }

    if (isCorrectAnswer(text, activeRiddle)) {
        const phrase = voiceUx.pick('riddle_correct', { gender: childGender });
        const audio = await buildReplyAudioCommand(`correct_${childGender}_${shortHash(phrase)}`, phrase, baseUrl);

        log.info(`[Riddle] correct answer for ${activeRiddle.id}`);

        return {
            handled: true,
            clearRiddle: true,
            activeRiddle: null,
            audio,
        };
    }

    const attempts = (activeRiddle.attempts || 0) + 1;

    if (attempts >= 2) {
        const phrase = `Хорошая попытка! Ответ: ${activeRiddle.answer}.`;
        const audio = await buildReplyAudioCommand(`answer_after_wrong_${activeRiddle.id}`, phrase, baseUrl);

        log.info(`[Riddle] wrong attempt ${attempts}; revealing ${activeRiddle.id}`);

        return {
            handled: true,
            clearRiddle: true,
            activeRiddle: null,
            audio,
        };
    }

    const updatedRiddle = {
        ...activeRiddle,
        attempts,
    };

    const phrase = voiceUx.pick('riddle_wrong', { gender: childGender });
    const audio = await buildReplyAudioCommand(`wrong_${childGender}_${shortHash(phrase)}`, phrase, baseUrl);

    log.info(`[Riddle] wrong attempt ${attempts} for ${activeRiddle.id}`);

    return {
        handled: true,
        clearRiddle: false,
        activeRiddle: updatedRiddle,
        audio,
    };
}

module.exports = {
    init,
    isRiddleRequest,
    shouldUseLlmRiddle,
    isRevealRequest,
    startRiddle,
    handleActiveRiddleAnswer,
};
