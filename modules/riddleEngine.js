'use strict';

const fs = require('fs');
const path = require('path');

let audioDir = null;
let ttsModule = null;
let log = console;

let riddles = [];

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

// Для MVP не активируем сразу все 100 загадок.
// Иначе первый деплой может долго генерировать аудио.
// Потом можно поставить RIDDLE_ACTIVE_LIMIT=100 в Railway env.
const DEFAULT_ACTIVE_LIMIT = 20;

const REPLIES = {
    correct: [
        'Правильно! Вот это да!',
        'Да! Ты угадал!',
        'Точно! Молодец!',
        'Верно! У тебя получилось!',
    ],

    wrong: [
        'Почти! Попробуй ещё раз.',
        'Интересная версия! Давай ещё попытку.',
        'Не совсем. Подумай ещё чуть-чуть.',
        'Хорошая попытка! Попробуй ещё.',
    ],

    noActive: [
        'Сначала я загадаю загадку, хорошо?',
        'Давай сначала выберем загадку.',
    ],
};

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

function riddlePcmPath(riddleId) {
    return path.join(riddleDir(), `${riddleId}.pcm`);
}

function replyPcmPath(key) {
    return path.join(repliesDir(), `${key}.pcm`);
}

async function ensureAudio(text, pcmPath, lang = 'ru-RU') {
    if (fs.existsSync(pcmPath)) {
        return;
    }

    await ttsModule.synthesize(text, pcmPath, lang);
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

    const filePath = path.join(__dirname, '..', 'data', 'riddles_ru.json');
    const raw = fs.readFileSync(filePath, 'utf8');

    riddles = JSON.parse(raw);

    if (!Array.isArray(riddles) || riddles.length === 0) {
        throw new Error('[Riddle] riddles_ru.json is empty or invalid');
    }

    log.info(`[Riddle] loaded ${riddles.length} riddle(s), active limit=${activeLimit()}`);
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
        t.includes('давай загадку')
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
        t.includes('подскажи')
    );
}

function pickRiddle() {
    const limit = activeLimit();
    const pool = riddles.slice(0, limit);

    const totalWeight = pool.reduce((sum, item) => sum + (item.weight || 1), 0);
    let roll = Math.random() * totalWeight;

    for (const item of pool) {
        roll -= item.weight || 1;
        if (roll <= 0) return item;
    }

    return pool[0];
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

        // Для коротких детских ответов достаточно:
        // "это мороз" содержит "мороз"
        return cleaned === answer || cleaned.includes(answer);
    });
}

async function buildRiddleAudioCommand(riddle, baseUrl) {
    const pcmPath = riddlePcmPath(riddle.id);

    const spokenText = `Загадка. ${riddle.question}`;

    await ensureAudio(spokenText, pcmPath, 'ru-RU');

    return {
        url: audioUrl(baseUrl, `riddles/${riddle.id}.wav`),
        durationMs: durationFromPcm(pcmPath, 2500),
    };
}

async function buildReplyAudioCommand(key, text, baseUrl) {
    const pcmPath = replyPcmPath(key);

    await ensureAudio(text, pcmPath, 'ru-RU');

    return {
        url: audioUrl(baseUrl, `riddles/replies/${key}.wav`),
        durationMs: durationFromPcm(pcmPath, 1800),
    };
}

async function startRiddle(baseUrl) {
    const riddle = pickRiddle();
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

async function handleActiveRiddleAnswer(text, activeRiddle, baseUrl) {
    if (!activeRiddle) {
        const phrase = REPLIES.noActive[0];
        const audio = await buildReplyAudioCommand('no_active_1', phrase, baseUrl);

        return {
            handled: true,
            clearRiddle: false,
            activeRiddle,
            audio,
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
        const phrase = REPLIES.correct[Math.floor(Math.random() * REPLIES.correct.length)];
        const audio = await buildReplyAudioCommand(`correct_${Math.floor(Math.random() * 4) + 1}`, phrase, baseUrl);

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

    const phrase = REPLIES.wrong[Math.floor(Math.random() * REPLIES.wrong.length)];
    const audio = await buildReplyAudioCommand(`wrong_${Math.floor(Math.random() * 4) + 1}`, phrase, baseUrl);

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
    isRevealRequest,
    startRiddle,
    handleActiveRiddleAnswer,
};
