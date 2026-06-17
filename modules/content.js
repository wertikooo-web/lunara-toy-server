'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const OpenAI = require('openai');
const logger = require('./logger');
const tts = require('./tts');

let docSeed = { items: [] };
try {
    docSeed = require('../data/content_seed.json');
} catch (_) {
    docSeed = { items: [] };
}

const DATABASE_URL = process.env.DATABASE_URL;
const PGSSL = process.env.PGSSL === 'true';
const CONTENT_VOICE = process.env.CONTENT_VOICE || 'default';
const SAMPLE_RATE = 16000;
const LOCALIZATION_MODEL = process.env.CONTENT_LOCALIZATION_MODEL || 'gpt-4o-mini';

let pool = null;
let ready = false;
let audioDir = null;
let openai = null;

const pendingAudio = new Map();
const lastPhraseByKey = new Map();

const BUILTIN_SHORT_ITEMS = [
    {
        id: 'riddle_seed_001',
        type: 'riddle',
        title: 'Пушистый охотник',
        text: 'Загадка. Днём он дремлет на окошке. Ночью тихо ходит по дому. Если доволен, мурлычет. Кто это?',
        answers: ['кошка', 'кот', 'котёнок', 'котик'],
        tags: ['short', 'animal', 'age_3_8'],
    },
    {
        id: 'riddle_seed_002',
        type: 'riddle',
        title: 'Ночной фонарик',
        text: 'Загадка. Когда становится темно, я появляюсь высоко-высоко. Не грею, как печка, но светить умею. Кто я?',
        answers: ['луна', 'месяц'],
        tags: ['short', 'sky', 'age_3_8'],
    },
    {
        id: 'riddle_seed_003',
        type: 'riddle',
        title: 'Тёплый будильник',
        text: 'Загадка. Я встаю раньше всех. Бужу окна, грею щёки и к вечеру ухожу за горизонт. Кто я?',
        answers: ['солнце', 'солнышко'],
        tags: ['short', 'nature', 'age_3_8'],
    },
    {
        id: 'riddle_seed_004',
        type: 'riddle',
        title: 'Карманная крыша',
        text: 'Загадка. В сухую погоду я сплю. А под дождём раскрываюсь над головой, как маленькая крыша. Что это?',
        answers: ['зонт', 'зонтик'],
        tags: ['short', 'object', 'age_3_8'],
    },
    {
        id: 'riddle_seed_005',
        type: 'riddle',
        title: 'Дом для историй',
        text: 'Загадка. Во мне живут принцессы, драконы, космос и смешные звери. Откроешь меня — начнётся история. Что это?',
        answers: ['книга', 'книжка'],
        tags: ['short', 'object', 'story', 'age_3_8'],
    },
    {
        id: 'riddle_seed_006',
        type: 'riddle',
        title: 'Белая путешественница',
        text: 'Загадка. Я лёгкая, белая и плыву по небу. Иногда похожа на корабль, иногда на барашка. Кто я?',
        answers: ['облако', 'облачко'],
        tags: ['short', 'sky', 'age_3_8'],
    },
    {
        id: 'riddle_seed_007',
        type: 'riddle',
        title: 'Зимний художник',
        text: 'Загадка. Без кисточки рисует узоры на окне. Щиплет нос и любит снежинки. Кто это?',
        answers: ['мороз'],
        tags: ['short', 'winter', 'age_4_8'],
    },
    {
        id: 'riddle_seed_008',
        type: 'riddle',
        title: 'Хранитель времени',
        text: 'Загадка. Я не бегаю, но у меня есть стрелки. Я молчу, но показываю, когда пора гулять или спать. Что это?',
        answers: ['часы', 'часики'],
        tags: ['short', 'object', 'age_4_8'],
    },
    {
        id: 'riddle_seed_009',
        type: 'riddle',
        title: 'Зубастая помощница',
        text: 'Загадка. У меня много зубчиков, но я никого не кусаю. Я делаю волосы аккуратными. Что это?',
        answers: ['расчёска', 'расческа', 'гребешок'],
        tags: ['short', 'object', 'age_3_8'],
    },
    {
        id: 'riddle_seed_010',
        type: 'riddle',
        title: 'Пара для прогулки',
        text: 'Загадка. Их всегда двое. Они ждут у двери и помогают ногам идти гулять. Что это?',
        answers: ['ботинки', 'обувь', 'сапоги'],
        tags: ['short', 'object', 'age_3_8'],
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

const MULTILINGUAL_SHORT_ITEMS = [
    {
        id: 'riddle_ro_seed_001',
        type: 'riddle',
        title: 'Lumina diminetii',
        text: 'Ghicitoare. Sunt cald si luminos. Dimineata trezesc lumea, iar seara ma ascund dupa deal. Cine sunt?',
        answers: ['soare', 'soarele'],
        tags: ['short', 'nature', 'age_3_8'],
        lang: 'ro-RO',
    },
    {
        id: 'riddle_ro_seed_002',
        type: 'riddle',
        title: 'Paznicul noptii',
        text: 'Ghicitoare. Apar pe cer cand se face intuneric. Nu incalzesc, dar stralucesc bland. Cine sunt?',
        answers: ['stele', 'stelele'],
        tags: ['short', 'sky', 'age_3_8'],
        lang: 'ro-RO',
    },
    {
        id: 'riddle_ro_seed_003',
        type: 'riddle',
        title: 'Perechea de plimbare',
        text: 'Ghicitoare. Suntem mereu doi si stam langa usa. Ajutam picioarele sa mearga la plimbare. Ce suntem?',
        answers: ['pantofi', 'incaltari', 'încălțări', 'ghete'],
        tags: ['short', 'object', 'age_3_8'],
        lang: 'ro-RO',
    },
    {
        id: 'tongue_twister_ro_seed_001',
        type: 'tongue_twister',
        title: 'Capra si piatra',
        text: 'Framantare de limba. Capra calca piatra, piatra crapa-n patru. Spune rar, apoi mai repede.',
        tags: ['short', 'speech', 'age_4_8'],
        lang: 'ro-RO',
    },
    {
        id: 'tongue_twister_ro_seed_002',
        type: 'tongue_twister',
        title: 'Sase sasi',
        text: 'Framantare de limba. Sase sasi in sase saci. Hai incet, cu zambet.',
        tags: ['short', 'speech', 'age_5_8'],
        lang: 'ro-RO',
    },
    {
        id: 'mini_game_ro_seed_001',
        type: 'mini_game',
        title: 'Numeste trei',
        text: 'Joc. Numeste trei lucruri rotunde. Eu astept, apoi le verificam impreuna.',
        tags: ['short', 'thinking', 'age_3_8'],
        lang: 'ro-RO',
    },
    {
        id: 'mini_game_ro_seed_002',
        type: 'mini_game',
        title: 'Animalul dupa sunet',
        text: 'Joc. Eu spun un sunet, iar tu ghicesti animalul. Miau-miau. Cine este?',
        tags: ['short', 'animal', 'age_3_8'],
        lang: 'ro-RO',
    },
    {
        id: 'riddle_en_seed_001',
        type: 'riddle',
        title: 'Morning light',
        text: 'Riddle. I am warm and bright. In the morning I wake the world, and in the evening I hide away. What am I?',
        answers: ['sun', 'the sun'],
        tags: ['short', 'nature', 'age_3_8'],
        lang: 'en-US',
    },
    {
        id: 'riddle_en_seed_002',
        type: 'riddle',
        title: 'Night lights',
        text: 'Riddle. I come out when the sky gets dark. I do not warm you, but I sparkle softly. What am I?',
        answers: ['star', 'stars', 'a star'],
        tags: ['short', 'sky', 'age_3_8'],
        lang: 'en-US',
    },
    {
        id: 'riddle_en_seed_003',
        type: 'riddle',
        title: 'Walking pair',
        text: 'Riddle. We are always two. We wait by the door and help your feet go outside. What are we?',
        answers: ['shoes', 'boots'],
        tags: ['short', 'object', 'age_3_8'],
        lang: 'en-US',
    },
    {
        id: 'tongue_twister_en_seed_001',
        type: 'tongue_twister',
        title: 'Tiny turtle',
        text: 'Tongue twister. Tiny turtle tiptoes to the tall tree. Say it slowly, then a little faster.',
        tags: ['short', 'speech', 'age_4_8'],
        lang: 'en-US',
    },
    {
        id: 'tongue_twister_en_seed_002',
        type: 'tongue_twister',
        title: 'Blue balloon',
        text: 'Tongue twister. Blue balloon bounces by the big bed. Try it with a smile.',
        tags: ['short', 'speech', 'age_4_8'],
        lang: 'en-US',
    },
    {
        id: 'mini_game_en_seed_001',
        type: 'mini_game',
        title: 'Name three',
        text: 'Game. Name three round things. I will wait, then we will check them together.',
        tags: ['short', 'thinking', 'age_3_8'],
        lang: 'en-US',
    },
    {
        id: 'mini_game_en_seed_002',
        type: 'mini_game',
        title: 'Animal sound',
        text: 'Game. I will make a sound, and you guess the animal. Meow-meow. Who is it?',
        tags: ['short', 'animal', 'age_3_8'],
        lang: 'en-US',
    },
];

const SEED_ITEMS = [
    ...BUILTIN_SHORT_ITEMS,
    ...MULTILINGUAL_SHORT_ITEMS,
    ...(Array.isArray(docSeed.items) ? docSeed.items : []),
];

const REQUEST_PATTERNS = [
    {
        type: 'riddle',
        re: /(?:(?:загадай|дай|хочу|давай|можно|придумай|расскажи).{0,30}загадк|(?:ещ[её]|другую|следующую|новую).{0,20}загадк|игр[ауеы]?\s+в\s+загадк|(?:tell|give|ask|say|want|another|new).{0,30}riddle|play.{0,20}riddles?|(?:spune|zi|vreau|hai|da|dă|ghiceste|ghicește).{0,35}ghicitoare|(?:alta|altă|noua|nouă).{0,20}ghicitoare|joc.{0,20}ghicitori)/i,
    },
    {
        type: 'tongue_twister',
        re: /(?:скажи|дай|хочу|давай|можно|придумай|повтори).{0,30}скороговорк|(?:say|tell|give|want|try).{0,30}tongue\s+twister|(?:spune|zi|vreau|hai).{0,35}(?:framantare|frământare|limba|limbă|dictie|dicție)/i,
    },
    {
        type: 'mini_game',
        re: /(?:давай\s+поиграем|^поиграем$|^сыграем$|(?:хочу|можно|давай|будем).{0,30}(?:поиграть|играть|игру(?:[^\p{L}0-9]|$)|мини-?игру)|(?:let'?s|lets|can we|want to|play).{0,30}(?:play|game)|^(?:play|game)$|(?:hai|vreau|putem|sa|să).{0,30}(?:jucam|jucăm|joc|joaca|joacă))/iu,
    },
];

function normalizeRequest(value) {
    return String(value || '')
        .toLocaleLowerCase('ru-RU')
        .replace(/ё/g, 'е')
        .trim();
}

function detectRequestLang(text) {
    const value = normalizeRequest(text);
    if (!value) return 'ru-RU';
    const letters = (value.match(/\p{L}/gu) || []).length;
    const cyrillic = (value.match(/[\u0400-\u04FF]/g) || []).length;
    if (letters > 0 && cyrillic / letters > 0.3) return 'ru-RU';
    if (/[ăâîșțĂÂÎȘȚ]/.test(text) || /\b(ghicitoare|ghicitori|spune|joc|jucam|jucăm|limba|limbă|framantare|frământare)\b/i.test(value)) {
        return 'ro-RO';
    }
    if (/[a-z]/i.test(value)) return 'en-US';
    return 'ru-RU';
}

function normalizeContentLang(lang, text = '') {
    if (lang && lang !== 'auto') {
        if (lang.startsWith('ru')) return 'ru-RU';
        if (lang.startsWith('ro')) return 'ro-RO';
        if (lang.startsWith('en')) return 'en-US';
    }
    return detectRequestLang(text);
}

function langKey(lang) {
    const normalized = normalizeContentLang(lang);
    if (normalized.startsWith('ro')) return 'ro';
    if (normalized.startsWith('en')) return 'en';
    return 'ru';
}

function safeFilePart(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 90) || 'content';
}

function textHash(value) {
    return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 10);
}

function contentLangSuffix(lang) {
    return normalizeContentLang(lang).toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function localizedContentId(item, targetLang) {
    return `${item.id}__${contentLangSuffix(targetLang)}`.slice(0, 180);
}

function themedContentId(type, topic, targetLang) {
    return `themed_${type}_${contentLangSuffix(targetLang)}_${textHash(topic)}`;
}

function languageName(lang) {
    const normalized = normalizeContentLang(lang);
    if (normalized.startsWith('ro')) return 'Romanian';
    if (normalized.startsWith('en')) return 'English';
    return 'Russian';
}

function isTranslatableShortItem(item) {
    return ['riddle', 'tongue_twister', 'mini_game', 'reaction'].includes(item?.type);
}

function durationFromPcm(filePath) {
    const bytes = fs.statSync(filePath).size;
    return Math.ceil((bytes / (SAMPLE_RATE * 2)) * 1000);
}

function publicUrl(baseUrl, fileName) {
    return `${baseUrl}/audio/content/${fileName.replace(/\.pcm$/, '.wav')}`;
}

function matchRequest(text) {
    const value = normalizeRequest(text);
    if (!value) return null;

    const match = REQUEST_PATTERNS.find((pattern) => pattern.re.test(value));
    return match ? match.type : null;
}

function cleanTopic(raw) {
    let topic = String(raw || '')
        .replace(/[.!?…,:;]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    topic = topic.replace(/^(такое|этом|это|the|a|an|un|o)\s+/i, '').trim();
    const words = topic.split(/\s+/).filter(Boolean).slice(0, 5);
    return words.join(' ').slice(0, 80).trim();
}

function extractContentTopic(text) {
    const value = normalizeRequest(text);
    if (!value) return '';

    const patterns = [
        /(?:^|\s)про\s+(.+)$/i,
        /(?:^|\s)о\s+(.+)$/i,
        /(?:^|\s)об\s+(.+)$/i,
        /\babout\s+(.+)$/i,
        /\bdespre\s+(.+)$/i,
    ];
    for (const pattern of patterns) {
        const match = value.match(pattern);
        const topic = cleanTopic(match?.[1]);
        if (topic) return topic;
    }
    return '';
}

function getClarification(text) {
    const value = normalizeRequest(text);
    if (!value) return null;

    const hasRiddle = /загадк|riddle|ghicitoare|ghicitori/i.test(value);
    const hasTongueTwister = /скороговорк|tongue\s+twister|framantare|frământare|dictie|dicție|limba|limbă/i.test(value);
    const hasGame = /(поигра|сыгра|игр[ауеы]?|play|game|joc|jucam|jucăm|joaca|joacă)/i.test(value);
    const topics = [hasRiddle, hasTongueTwister, hasGame].filter(Boolean).length;
    if (topics < 2) return null;

    const language = langKey(detectRequestLang(text));
    const phrases = {
        ru: [
            'Я чуть запуталась. Ты хочешь загадку, скороговорку или игру?',
            'Давай уточним. Мне загадать загадку, сказать скороговорку или начать игру?',
            'Кажется, тут сразу несколько идей. Что выбираем: загадку, скороговорку или игру?',
            'Повтори, пожалуйста, что именно хочешь: загадку, игру или скороговорку?',
            'Я не до конца поняла. Скажи коротко: загадка, игра или скороговорка?',
        ],
        ro: [
            'M-am incurcat putin. Vrei o ghicitoare, o framantare de limba sau un joc?',
            'Hai sa lamurim. Sa spun o ghicitoare, o framantare de limba sau sa incepem un joc?',
            'Parca sunt mai multe idei aici. Alegem ghicitoare, joc sau framantare de limba?',
        ],
        en: [
            'I got a little mixed up. Do you want a riddle, a tongue twister, or a game?',
            'Let us choose clearly. Should I tell a riddle, say a tongue twister, or start a game?',
            'I hear a few ideas at once. What do we pick: riddle, tongue twister, or game?',
        ],
    };

    return {
        lang: normalizeContentLang(detectRequestLang(text)),
        reply: pickPhrase(phrases[language], `content_clarify_${language}`),
    };
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
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
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
        ALTER TABLE content_items
        ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb
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
            `INSERT INTO content_items (id, type, title, text, lang, answers, tags, metadata, source)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)
             ON CONFLICT (id) DO UPDATE SET
                type = EXCLUDED.type,
                title = EXCLUDED.title,
                text = EXCLUDED.text,
                lang = EXCLUDED.lang,
                answers = EXCLUDED.answers,
                tags = EXCLUDED.tags,
                metadata = EXCLUDED.metadata,
                source = EXCLUDED.source,
                updated_at = now()`,
            [
                item.id,
                item.type,
                item.title,
                item.text,
                item.lang || 'ru-RU',
                JSON.stringify(item.answers || []),
                JSON.stringify(item.tags || []),
                JSON.stringify(item.metadata || {}),
                item.source || 'seed',
            ]
        );
    }

    ready = true;
    logger.info(`[Content] content ready; seeded ${SEED_ITEMS.length} item(s)`);
}

async function pickItem(type, lang = 'ru-RU') {
    const preferredLang = normalizeContentLang(lang);
    if (ready && pool) {
        const result = await pool.query(
            `SELECT id, type, title, text, lang, answers, tags, metadata
             FROM content_items
             WHERE type = $1 AND enabled = true AND lang IN ($2, 'ru-RU')
             ORDER BY random()
             LIMIT 1`,
            [type, preferredLang]
        );
        return result.rows[0] || null;
    }

    const items = SEED_ITEMS.filter((item) => (
        item.type === type &&
        ((item.lang || 'ru-RU') === preferredLang || (item.lang || 'ru-RU') === 'ru-RU')
    ));
    return items[Math.floor(Math.random() * items.length)] || null;
}

async function pickExactLangItem(type, lang) {
    const exactLang = normalizeContentLang(lang);
    if (ready && pool) {
        const result = await pool.query(
            `SELECT id, type, title, text, lang, answers, tags, metadata
             FROM content_items
             WHERE type = $1 AND enabled = true AND lang = $2
             ORDER BY random()
             LIMIT 1`,
            [type, exactLang]
        );
        return result.rows[0] || null;
    }

    const items = SEED_ITEMS.filter((item) => item.type === type && (item.lang || 'ru-RU') === exactLang);
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

async function upsertContentItem(item) {
    if (!ready || !pool) return;
    await pool.query(
        `INSERT INTO content_items (id, type, title, text, lang, answers, tags, metadata, source)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)
         ON CONFLICT (id) DO UPDATE SET
            type = EXCLUDED.type,
            title = EXCLUDED.title,
            text = EXCLUDED.text,
            lang = EXCLUDED.lang,
            answers = EXCLUDED.answers,
            tags = EXCLUDED.tags,
            metadata = EXCLUDED.metadata,
            source = EXCLUDED.source,
            updated_at = now()`,
        [
            item.id,
            item.type,
            item.title || '',
            item.text,
            item.lang || 'ru-RU',
            JSON.stringify(item.answers || []),
            JSON.stringify(item.tags || []),
            JSON.stringify(item.metadata || {}),
            item.source || 'runtime',
        ]
    );
}

async function findContentItemById(id) {
    if (!ready || !pool) return null;
    const result = await pool.query(
        `SELECT id, type, title, text, lang, answers, tags, metadata
         FROM content_items
         WHERE id = $1 AND enabled = true
         LIMIT 1`,
        [id]
    );
    return result.rows[0] || null;
}

function parseLocalizationJson(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch (_) {
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
            return JSON.parse(match[0]);
        } catch (err) {
            return null;
        }
    }
}

async function generateLocalizedItem(masterItem, targetLang) {
    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'test') {
        return null;
    }
    if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const target = normalizeContentLang(targetLang);
    const targetName = languageName(target);
    const sourceAnswers = answerList(masterItem);
    const prompt = {
        target_language: targetName,
        content_type: masterItem.type,
        source_title: masterItem.title || '',
        source_text: masterItem.text || '',
        source_answers: sourceAnswers,
    };

    const response = await openai.chat.completions.create({
        model: LOCALIZATION_MODEL,
        max_tokens: 420,
        response_format: { type: 'json_object' },
        messages: [
            {
                role: 'system',
                content: [
                    'You adapt short children content for Lumi, a warm AI toy for ages 3-8.',
                    'Return only valid JSON with keys: title, text, answers.',
                    'Keep the content short, natural, kind, and safe.',
                    'Do not reveal riddle answers inside the riddle text.',
                    'For riddles, translate/adapt the answer list into the target language.',
                    'For tongue twisters, create a natural equivalent in the target language instead of literal translation if needed.',
                    'Use simple words. No markdown.',
                ].join(' '),
            },
            {
                role: 'user',
                content: JSON.stringify(prompt),
            },
        ],
    });

    const parsed = parseLocalizationJson(response.choices[0]?.message?.content);
    if (!parsed || !String(parsed.text || '').trim()) {
        throw new Error('localization returned invalid JSON');
    }

    const localizedAnswers = Array.isArray(parsed.answers)
        ? parsed.answers.map((answer) => String(answer || '').trim()).filter(Boolean)
        : [];

    if (masterItem.type === 'riddle' && localizedAnswers.length === 0) {
        throw new Error('localized riddle has no answers');
    }

    return {
        id: localizedContentId(masterItem, target),
        type: masterItem.type,
        title: String(parsed.title || masterItem.title || '').trim(),
        text: String(parsed.text || '').trim(),
        lang: target,
        answers: localizedAnswers,
        tags: [...new Set([...(masterItem.tags || []), 'localized', contentLangSuffix(target)])],
        metadata: {
            ...(masterItem.metadata || {}),
            localized_from: masterItem.id,
            localized_from_lang: masterItem.lang || 'ru-RU',
            localization_model: LOCALIZATION_MODEL,
        },
        source: 'runtime_localized',
    };
}

async function localizeItemForLang(item, targetLang) {
    const target = normalizeContentLang(targetLang);
    const itemLang = normalizeContentLang(item.lang || 'ru-RU');
    if (itemLang === target || target === 'ru-RU' || !isTranslatableShortItem(item)) {
        return item;
    }

    const localizedId = localizedContentId(item, target);
    const existing = await findContentItemById(localizedId);
    if (existing) return existing;

    try {
        logger.info(`[Content] Localizing ${item.id} -> ${target}`);
        const localized = await generateLocalizedItem(item, target);
        if (!localized) return item;
        await upsertContentItem(localized);
        logger.info(`[Content] Localized content ready: ${localized.id}`);
        return localized;
    } catch (err) {
        logger.warn(`[Content] Localization failed for ${item.id} -> ${target}: ${err.message}`);
        return item;
    }
}

async function generateThemedItem(type, topic, targetLang) {
    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'test') {
        return null;
    }
    if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const target = normalizeContentLang(targetLang);
    const targetName = languageName(target);
    const prompt = {
        target_language: targetName,
        content_type: type,
        topic,
    };

    const response = await openai.chat.completions.create({
        model: LOCALIZATION_MODEL,
        max_tokens: 360,
        response_format: { type: 'json_object' },
        messages: [
            {
                role: 'system',
                content: [
                    'You create short children content for Lumi, a warm AI toy for ages 3-8.',
                    'Return only valid JSON with keys: title, text, answers.',
                    'The content must be in the target language.',
                    'For riddle: make a simple riddle about the topic. Do not say the answer in the riddle text. Put 1-4 accepted answers in answers.',
                    'For tongue_twister: create a short natural tongue twister about the topic. Put answers as an empty array.',
                    'Keep it safe, kind, short, and easy to pronounce by TTS. No markdown.',
                ].join(' '),
            },
            {
                role: 'user',
                content: JSON.stringify(prompt),
            },
        ],
    });

    const parsed = parseLocalizationJson(response.choices[0]?.message?.content);
    if (!parsed || !String(parsed.text || '').trim()) {
        throw new Error('themed content returned invalid JSON');
    }

    const answers = Array.isArray(parsed.answers)
        ? parsed.answers.map((answer) => String(answer || '').trim()).filter(Boolean)
        : [];

    if (type === 'riddle' && answers.length === 0) {
        throw new Error('themed riddle has no answers');
    }

    const targetSuffix = contentLangSuffix(target);
    return {
        id: themedContentId(type, topic, target),
        type,
        title: String(parsed.title || topic).trim(),
        text: String(parsed.text || '').trim(),
        lang: target,
        answers,
        tags: ['short', 'themed', targetSuffix, safeFilePart(topic)],
        metadata: {
            topic,
            generated_for_topic: true,
            generation_model: LOCALIZATION_MODEL,
        },
        source: 'runtime_themed',
    };
}

async function getThemedItem(type, topic, targetLang) {
    if (!['riddle', 'tongue_twister'].includes(type) || !topic) return null;
    const target = normalizeContentLang(targetLang);
    const id = themedContentId(type, topic, target);
    const existing = await findContentItemById(id);
    if (existing) return existing;

    try {
        logger.info(`[Content] Generating themed ${type}: ${topic} -> ${target}`);
        const generated = await generateThemedItem(type, topic, target);
        if (!generated) return null;
        await upsertContentItem(generated);
        logger.info(`[Content] Themed content ready: ${generated.id}`);
        return generated;
    } catch (err) {
        logger.warn(`[Content] Themed content failed for ${type}/${topic}: ${err.message}`);
        return null;
    }
}

async function ensureAudio(item, baseUrl) {
    if (!audioDir) throw new Error('content audioDir is not initialized');

    const fileName = `${safeFilePart(item.id)}_${safeFilePart(CONTENT_VOICE)}_${textHash(item.text)}.pcm`;
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

async function ensureCachedReply(reply, options = {}) {
    const baseUrl = options.baseUrl;
    if (!baseUrl) throw new Error('ensureCachedReply requires baseUrl');

    const text = String(reply || '').trim();
    if (!text) throw new Error('ensureCachedReply requires reply text');

    const key = safeFilePart(options.key || 'reply');
    const item = {
        id: `cached_reply_${key}_${textHash(text)}`,
        type: 'cached_reply',
        title: options.title || key,
        text,
        lang: normalizeContentLang(options.lang, text),
        tags: ['cached_reply', key],
        metadata: {
            cache_key: key,
        },
    };

    await upsertContentItem(item);
    const audio = await ensureAudio(item, baseUrl);
    return {
        audioUrl: audio.url,
        durationMs: audio.durationMs,
        cached: audio.cached,
    };
}

async function tryHandleShortRequest(text, options = {}) {
    const type = matchRequest(text);
    if (!type) return null;

    const baseUrl = options.baseUrl;
    if (!baseUrl) throw new Error('tryHandleShortRequest requires baseUrl');

    const contentLang = normalizeContentLang(options.lang, text);
    const topic = extractContentTopic(text);
    const item = await getThemedItem(type, topic, contentLang) || await pickItem(type, contentLang);
    if (!item) return null;
    let localizedItem = await localizeItemForLang(item, contentLang);
    if (contentLang !== 'ru-RU' && normalizeContentLang(localizedItem.lang || 'ru-RU') !== contentLang) {
        localizedItem = await pickExactLangItem(type, contentLang) || localizedItem;
    }

    const audio = await ensureAudio(localizedItem, baseUrl);
    return {
        item: localizedItem,
        reply: localizedItem.text,
        audioUrl: audio.url,
        durationMs: audio.durationMs,
        cached: audio.cached,
        lang: localizedItem.lang || contentLang,
    };
}

async function pickItems(type, limit = 5) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 20));
    if (ready && pool) {
        const result = await pool.query(
            `SELECT id, type, title, text, lang, answers, tags, metadata
             FROM content_items
             WHERE type = $1 AND enabled = true
             ORDER BY random()
             LIMIT ${safeLimit}`,
            [type]
        );
        return result.rows;
    }

    return SEED_ITEMS
        .filter((item) => item.type === type)
        .sort(() => Math.random() - 0.5)
        .slice(0, safeLimit);
}

function normalizeAnswer(value) {
    return String(value || '')
        .toLocaleLowerCase('ru-RU')
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/[ё]/g, 'е')
        .replace(/[^\p{L}0-9\s-]+/gu, ' ')
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

function pickPhrase(phrases, key = 'default') {
    if (!Array.isArray(phrases) || phrases.length === 0) return '';
    if (phrases.length === 1) return phrases[0];

    const last = lastPhraseByKey.get(key);
    const variants = phrases.filter((phrase) => phrase !== last);
    const chosen = variants[Math.floor(Math.random() * variants.length)];
    lastPhraseByKey.set(key, chosen);
    return chosen;
}

function pendingFromItem(item) {
    if (!item || item.type !== 'riddle') return null;
    const answers = answerList(item);
    if (answers.length === 0) return null;
    return {
        type: item.type,
        id: item.id,
        title: item.title || '',
        text: item.text || '',
        lang: item.lang || 'ru-RU',
        answers,
    };
}

function checkPendingCommand(pending, answer) {
    if (!pending || pending.type !== 'riddle') return null;
    const language = langKey(pending.lang);
    const stopPhrases = {
        ru: [
            'Хорошо, остановимся с загадками. Можем просто поговорить.',
            'Ладно, загадки убираю в сторону. Что хочешь сделать теперь?',
            'Договорились, без загадок. Я рядом и слушаю.',
        ],
        ro: [
            'Bine, oprim ghicitorile. Putem doar sa povestim.',
            'De acord, pun ghicitorile deoparte. Ce vrei sa facem acum?',
            'Gata cu ghicitorile pentru moment. Sunt aici si te ascult.',
        ],
        en: [
            'Okay, we will stop the riddles. We can just talk.',
            'Sure, I will put the riddles aside. What would you like now?',
            'No more riddles for now. I am here and listening.',
        ],
    };

    if (/(стоп|хватит|не хочу|не надо|закончим|отмена|stop|enough|no more|cancel|nu vreau|gata|opreste|oprește)/i.test(answer)) {
        return {
            correct: null,
            clearPending: true,
            lang: pending.lang,
            reply: pickPhrase(stopPhrases[language], `riddle_stop_${language}`),
        };
    }

    if (/(повтори|еще раз|ещё раз|сначала|repeat|again|say it again|repeta|repetă|inca o data|încă o dată)/i.test(answer)) {
        const repeatPrefix = {
            ru: 'Повторяю.',
            ro: 'Repet.',
            en: 'I will repeat it.',
        };
        return {
            correct: null,
            keepPending: true,
            lang: pending.lang,
            reply: pending.text
                ? `${repeatPrefix[language]} ${pending.text}`
                : {
                    ru: 'Повторю загадку. Слушай внимательно.',
                    ro: 'Repet ghicitoarea. Asculta cu atentie.',
                    en: 'I will repeat the riddle. Listen carefully.',
                }[language],
        };
    }

    if (/(ещ[её]|другую|следующую|новую|давай еще|давай ещё|another|new one|next|alta|altă|urmatoarea|următoarea|noua|nouă)/i.test(answer) && !/(ответ|подскажи|answer|hint|raspuns|răspuns|indiciu)/i.test(answer)) {
        return {
            correct: null,
            nextRiddle: true,
            lang: pending.lang,
        };
    }

    return null;
}

function checkPendingAnswer(pending, userText) {
    if (!pending || pending.type !== 'riddle') return null;

    const answer = normalizeAnswer(userText);
    if (!answer) return null;

    const command = checkPendingCommand(pending, answer);
    if (command) return command;

    const answers = answerList(pending);
    const normalizedAnswers = answers.map(normalizeAnswer).filter(Boolean);
    const correct = normalizedAnswers.some((value) => (
        answer === value ||
        answer.includes(value) ||
        value.includes(answer)
    ));
    const correctAnswer = answers[0] || 'не знаю';
    const language = langKey(pending.lang);
    const phraseSets = {
        ru: {
            hint: [
                `Хорошо, подсказываю. Это ${correctAnswer}. Хочешь ещё одну загадку?`,
                `Ладно, открываю маленький секрет. Это ${correctAnswer}. Берём следующую?`,
                `Сдаёмся красиво. Ответ: ${correctAnswer}. Теперь можно взять реванш!`,
                `Подсказка превратилась в ответ: это ${correctAnswer}. Попробуем ещё раз?`,
            ],
            correct: [
                'Да, правильно! Ты здорово отгадал. Хочешь ещё одну загадку?',
                'Точно! Вот это внимательные ушки. Давай следующую?',
                'Ура, угадал! Я даже чуть подпрыгнул от радости. Ещё одну?',
                'Верно! Загадка раскрыта. Берём новую?',
                'Да, это правильный ответ. Ты сегодня настоящий сыщик загадок!',
            ],
            wrong: [
                `Не угадали, но попытка была смелая. Ответ: ${correctAnswer}. Давай ещё одну?`,
                `Ой, это был хитрый поворот. Правильный ответ: ${correctAnswer}. Попробуем новую?`,
                `Хорошая версия, но загадка спрятала другое. Это ${correctAnswer}. Идём дальше?`,
                `Мимо, но красиво мимо. Ответ: ${correctAnswer}. Хочешь ещё загадку?`,
                `Почти поймали, но она ускользнула. Это ${correctAnswer}. Давай реванш?`,
                `Хи-хи, загадка сегодня хитрит. Правильный ответ: ${correctAnswer}. Ещё одну?`,
                `Нет, но мне нравится твоя идея. Ответ был ${correctAnswer}. Попробуем снова?`,
                `Не совсем. Загадочный сундук открылся: там ${correctAnswer}. Давай следующую?`,
            ],
        },
        ro: {
            hint: [
                `Bine, iti spun un indiciu mare. Raspunsul este ${correctAnswer}. Mai vrei o ghicitoare?`,
                `Deschidem secretul micut. Este ${correctAnswer}. Incercam inca una?`,
                `Raspunsul era ${correctAnswer}. Putem lua revansa!`,
            ],
            correct: [
                'Da, corect! Ai ghicit foarte bine. Mai vrei o ghicitoare?',
                'Exact! Ce urechi atente. Trecem la urmatoarea?',
                'Bravo, ai gasit raspunsul! Mai incercam una?',
            ],
            wrong: [
                `Nu chiar, dar a fost o idee curajoasa. Raspunsul este ${correctAnswer}. Mai incercam una?`,
                `Aproape, dar ghicitoarea ascundea altceva. Era ${correctAnswer}. Vrei alta?`,
                `Nu este acesta raspunsul. Raspunsul era ${correctAnswer}. Luam revansa?`,
            ],
        },
        en: {
            hint: [
                `Okay, here is the answer. It is ${correctAnswer}. Would you like another riddle?`,
                `Tiny secret unlocked. The answer is ${correctAnswer}. Shall we try one more?`,
                `The answer was ${correctAnswer}. We can take a rematch!`,
            ],
            correct: [
                'Yes, correct! You solved it beautifully. Would you like another riddle?',
                'Exactly! Those are very careful ears. Shall we try the next one?',
                'Bravo, you found the answer! One more?',
            ],
            wrong: [
                `Not quite, but that was a brave try. The answer is ${correctAnswer}. Want another one?`,
                `Almost, but the riddle hid something else. It was ${correctAnswer}. Shall we try a new one?`,
                `No, but I like your idea. The answer was ${correctAnswer}. Want a rematch?`,
            ],
        },
    };

    if (/(не знаю|сдаюсь|подскажи|скажи ответ|i dont know|i do not know|hint|tell me|answer|nu stiu|nu știu|indiciu|raspuns|răspuns)/i.test(answer)) {
        return {
            correct: false,
            lang: pending.lang,
            reply: pickPhrase(phraseSets[language].hint, `riddle_hint_${language}`),
        };
    }

    if (correct) {
        return {
            correct: true,
            lang: pending.lang,
            reply: pickPhrase(phraseSets[language].correct, `riddle_correct_${language}`),
        };
    }

    return {
        correct: false,
        lang: pending.lang,
        reply: pickPhrase(phraseSets[language].wrong, `riddle_wrong_${language}`),
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
    const langs = await pool.query(`
        SELECT lang, count(*)::int AS count
        FROM content_items
        WHERE enabled = true
        GROUP BY lang
        ORDER BY lang
    `);
    const sources = await pool.query(`
        SELECT source, count(*)::int AS count
        FROM content_items
        WHERE enabled = true
        GROUP BY source
        ORDER BY source
    `);
    const audio = await pool.query(`
        SELECT count(*)::int AS count
        FROM content_audio_cache
    `);

    return {
        db_ready: true,
        by_type: Object.fromEntries(items.rows.map((row) => [row.type, row.count])),
        by_lang: Object.fromEntries(langs.rows.map((row) => [row.lang, row.count])),
        by_source: Object.fromEntries(sources.rows.map((row) => [row.source, row.count])),
        cached_audio: audio.rows[0]?.count || 0,
    };
}

module.exports = {
    init,
    classifyRequest: matchRequest,
    extractContentTopic,
    getClarification,
    ensureCachedReply,
    tryHandleShortRequest,
    pickItems,
    pendingFromItem,
    checkPendingAnswer,
    stats,
};
