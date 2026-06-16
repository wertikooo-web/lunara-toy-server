'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const logger = require('./logger');
const tts = require('./tts');

const DATABASE_URL = process.env.DATABASE_URL;
const PGSSL = process.env.PGSSL === 'true';
const CONTENT_VOICE = process.env.CONTENT_VOICE || 'default';
const SAMPLE_RATE = 16000;

let pool = null;
let ready = false;
let audioDir = null;

const pendingAudio = new Map();

const SEED_ITEMS = [
    {
        id: 'riddle_seed_001',
        type: 'riddle',
        title: 'Кто мурлычет',
        text: 'Загадка. Мягкие лапки, пушистый хвост. Любит молоко и мурлычет. Кто это?',
        answers: ['кошка', 'кот', 'котёнок', 'котик'],
        tags: ['short', 'animal', 'age_3_8'],
    },
    {
        id: 'riddle_seed_002',
        type: 'riddle',
        title: 'Что светит ночью',
        text: 'Загадка. Ночью я свечу в небе. Я круглая и тихая. Кто я?',
        answers: ['луна', 'месяц'],
        tags: ['short', 'sky', 'age_3_8'],
    },
    {
        id: 'riddle_seed_003',
        type: 'riddle',
        title: 'Что греет',
        text: 'Загадка. Я светлое и тёплое. Утром просыпаюсь, а вечером прячусь. Кто я?',
        answers: ['солнце', 'солнышко'],
        tags: ['short', 'nature', 'age_3_8'],
    },
    {
        id: 'tongue_twister_seed_001',
        type: 'tongue_twister',
        title: 'Саша и шишки',
        text: 'Скороговорка. Шла Саша по шоссе и сосала сушку. Давай медленно. Потом быстрее.',
        tags: ['short', 'speech', 'age_4_8'],
    },
    {
        id: 'tongue_twister_seed_002',
        type: 'tongue_twister',
        title: 'Карл и Клара',
        text: 'Скороговорка. Карл у Клары украл кораллы, а Клара у Карла украла кларнет.',
        tags: ['short', 'speech', 'age_5_8'],
    },
    {
        id: 'mini_game_seed_001',
        type: 'mini_game',
        title: 'Назови три',
        text: 'Игра. Назови три круглых предмета. Я подожду, а потом мы проверим вместе.',
        tags: ['short', 'thinking', 'age_3_8'],
    },
    {
        id: 'mini_game_seed_002',
        type: 'mini_game',
        title: 'Животное по звуку',
        text: 'Игра. Я скажу звук, а ты угадай животное. Мяу-мяу. Кто это?',
        tags: ['short', 'animal', 'age_3_8'],
    },
    {
        id: 'reaction_seed_001',
        type: 'reaction',
        title: 'Молодец',
        text: 'Здорово получилось. Мне нравится, как ты думаешь.',
        tags: ['short', 'positive', 'age_3_8'],
    },
];

const REQUEST_PATTERNS = [
    {
        type: 'riddle',
        re: /(загадай|дай|хочу|давай|можно)\s+(мне\s+)?(загадк|загадку|загадки)|\bзагадк[аиу]\b/i,
    },
    {
        type: 'tongue_twister',
        re: /(скажи|дай|хочу|давай|можно)\s+(мне\s+)?(скороговорк|скороговорку)|\bскороговорк[аиу]\b/i,
    },
    {
        type: 'mini_game',
        re: /(давай|хочу|можно|будем)\s+(поигра|играть|игру)|\bпоиграем\b|\bмини-?игр/i,
    },
];

function safeFilePart(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 90) || 'content';
}

function durationFromPcm(filePath) {
    const bytes = fs.statSync(filePath).size;
    return Math.ceil((bytes / (SAMPLE_RATE * 2)) * 1000);
}

function publicUrl(baseUrl, fileName) {
    return `${baseUrl}/audio/content/${fileName.replace(/\.pcm$/, '.wav')}`;
}

function matchRequest(text) {
    const value = String(text || '').trim();
    if (!value) return null;
    const match = REQUEST_PATTERNS.find((pattern) => pattern.re.test(value));
    return match ? match.type : null;
}

async function init(options = {}) {
    audioDir = options.audioDir;
    if (!audioDir) throw new Error('content.init requires audioDir');
    fs.mkdirSync(audioDir, { recursive: true });

    if (!DATABASE_URL) {
        logger.warn('[Content] DATABASE_URL is not set; short content DB is disabled');
        return;
    }

    pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: PGSSL ? { rejectUnauthorized: false } : undefined,
    });

    await pool.query(`
        CREATE TABLE IF NOT EXISTS content_items (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL,
            lang TEXT NOT NULL DEFAULT 'ru-RU',
            answers JSONB NOT NULL DEFAULT '[]'::jsonb,
            tags JSONB NOT NULL DEFAULT '[]'::jsonb,
            source TEXT NOT NULL DEFAULT 'seed',
            enabled BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    await pool.query(`
        ALTER TABLE content_items
        ADD COLUMN IF NOT EXISTS answers JSONB NOT NULL DEFAULT '[]'::jsonb
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS content_audio_cache (
            content_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
            voice TEXT NOT NULL,
            format TEXT NOT NULL DEFAULT 'wav',
            sample_rate INTEGER NOT NULL DEFAULT 16000,
            audio_path TEXT NOT NULL,
            audio_url_path TEXT NOT NULL,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (content_id, voice, format)
        )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_content_items_type_enabled ON content_items(type, enabled)');

    for (const item of SEED_ITEMS) {
        await pool.query(
            `INSERT INTO content_items (id, type, title, text, lang, answers, tags, source)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
             ON CONFLICT (id) DO UPDATE SET
                answers = EXCLUDED.answers,
                tags = EXCLUDED.tags,
                updated_at = now()`,
            [
                item.id,
                item.type,
                item.title,
                item.text,
                'ru-RU',
                JSON.stringify(item.answers || []),
                JSON.stringify(item.tags || []),
                'seed',
            ]
        );
    }

    ready = true;
    logger.info(`[Content] short content ready; seeded ${SEED_ITEMS.length} item(s)`);
}

async function pickItem(type) {
    if (ready && pool) {
        const result = await pool.query(
            `SELECT id, type, title, text, lang, answers, tags
             FROM content_items
             WHERE type = $1 AND enabled = true
             ORDER BY random()
             LIMIT 1`,
            [type]
        );
        return result.rows[0] || null;
    }

    const items = SEED_ITEMS.filter((item) => item.type === type);
    return items[Math.floor(Math.random() * items.length)] || null;
}

async function upsertAudioCache(item, fileName, durationMs) {
    if (!ready || !pool) return;
    await pool.query(
        `INSERT INTO content_audio_cache
            (content_id, voice, format, sample_rate, audio_path, audio_url_path, duration_ms)
         VALUES ($1, $2, 'wav', $3, $4, $5, $6)
         ON CONFLICT (content_id, voice, format)
         DO UPDATE SET
            audio_path = EXCLUDED.audio_path,
            audio_url_path = EXCLUDED.audio_url_path,
            duration_ms = EXCLUDED.duration_ms,
            updated_at = now()`,
        [
            item.id,
            CONTENT_VOICE,
            SAMPLE_RATE,
            `audio/content/${fileName.replace(/\.pcm$/, '.wav')}`,
            `/audio/content/${fileName.replace(/\.pcm$/, '.wav')}`,
            durationMs,
        ]
    );
}

async function ensureAudio(item, baseUrl) {
    if (!audioDir) throw new Error('content audioDir is not initialized');

    const fileName = `${safeFilePart(item.id)}_${safeFilePart(CONTENT_VOICE)}.pcm`;
    const pcmPath = path.join(audioDir, fileName);
    const wavPath = pcmPath.replace(/\.pcm$/, '.wav');

    if (fs.existsSync(pcmPath) && fs.existsSync(wavPath)) {
        const durationMs = durationFromPcm(pcmPath);
        await upsertAudioCache(item, fileName, durationMs);
        return { url: publicUrl(baseUrl, fileName), durationMs, cached: true };
    }

    const pendingKey = `${item.id}:${CONTENT_VOICE}`;
    if (pendingAudio.has(pendingKey)) {
        return pendingAudio.get(pendingKey);
    }

    const task = (async () => {
        logger.info(`[Content] Generating cached audio for ${item.id}`);
        const durationMs = await tts.synthesize(item.text, pcmPath, item.lang || 'ru-RU');
        await upsertAudioCache(item, fileName, durationMs);
        logger.info(`[Content] Cached audio ready for ${item.id}`);
        return { url: publicUrl(baseUrl, fileName), durationMs, cached: false };
    })().finally(() => {
        pendingAudio.delete(pendingKey);
    });

    pendingAudio.set(pendingKey, task);
    return task;
}

async function tryHandleShortRequest(text, options = {}) {
    const type = matchRequest(text);
    if (!type) return null;

    const baseUrl = options.baseUrl;
    if (!baseUrl) throw new Error('tryHandleShortRequest requires baseUrl');

    const item = await pickItem(type);
    if (!item) return null;

    const audio = await ensureAudio(item, baseUrl);
    return {
        item,
        reply: item.text,
        audioUrl: audio.url,
        durationMs: audio.durationMs,
        cached: audio.cached,
    };
}

function normalizeAnswer(value) {
    return String(value || '')
        .toLocaleLowerCase('ru-RU')
        .replace(/[ё]/g, 'е')
        .replace(/[^a-zа-я0-9\s-]+/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function answerList(item) {
    const raw = item?.answers;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return [];
        }
    }
    return [];
}

function pendingFromItem(item) {
    if (!item || item.type !== 'riddle') return null;
    const answers = answerList(item);
    if (answers.length === 0) return null;
    return {
        type: item.type,
        id: item.id,
        title: item.title || '',
        answers,
    };
}

function checkPendingAnswer(pending, userText) {
    if (!pending || pending.type !== 'riddle') return null;

    const answer = normalizeAnswer(userText);
    if (!answer) return null;

    const answers = answerList(pending);
    const normalizedAnswers = answers.map(normalizeAnswer).filter(Boolean);
    const correct = normalizedAnswers.some((value) => (
        answer === value ||
        answer.includes(value) ||
        value.includes(answer)
    ));
    const correctAnswer = answers[0] || 'не знаю';

    if (/(не знаю|сдаюсь|подскажи|скажи ответ)/i.test(answer)) {
        return {
            correct: false,
            reply: `Хорошо, подсказываю. Это ${correctAnswer}. Хочешь ещё одну загадку?`,
        };
    }

    if (correct) {
        return {
            correct: true,
            reply: 'Да, правильно! Ты здорово отгадал. Хочешь ещё одну загадку?',
        };
    }

    return {
        correct: false,
        reply: `Почти, но нет. Правильный ответ: ${correctAnswer}. Давай попробуем ещё одну?`,
    };
}

async function stats() {
    if (!ready || !pool) {
        const byType = {};
        for (const item of SEED_ITEMS) {
            byType[item.type] = (byType[item.type] || 0) + 1;
        }
        return {
            db_ready: false,
            seeded_items: SEED_ITEMS.length,
            by_type: byType,
            cached_audio: null,
        };
    }

    const items = await pool.query(`
        SELECT type, count(*)::int AS count
        FROM content_items
        WHERE enabled = true
        GROUP BY type
        ORDER BY type
    `);
    const audio = await pool.query(`
        SELECT count(*)::int AS count
        FROM content_audio_cache
    `);

    return {
        db_ready: true,
        by_type: Object.fromEntries(items.rows.map((row) => [row.type, row.count])),
        cached_audio: audio.rows[0]?.count || 0,
    };
}

module.exports = {
    init,
    tryHandleShortRequest,
    pendingFromItem,
    checkPendingAnswer,
    stats,
};
