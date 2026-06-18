'use strict';

const OpenAI = require('openai');
const { Pool } = require('pg');
const logger = require('./logger');

const DATABASE_URL = process.env.DATABASE_URL;
const DEFAULT_DEVICE_ID = process.env.DEFAULT_DEVICE_ID || 'lumi_001';
const AUTO_UPDATE = process.env.MEMORY_AUTO_UPDATE !== 'false';
const EXTRACT_MODEL = process.env.MEMORY_EXTRACT_MODEL || 'gpt-4o-mini';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let pool = null;
let ready = false;

const PROFILE_FIELDS = [
    'child_name',
    'age',
    'favorite_color',
    'favorite_animal',
    'favorite_game',
    'favorite_toy',
    'favorite_cartoon',
    'favorite_character',
    'pet_name',
    'best_friend',
    'favorite_food',
    'current_interest',
    'last_story',
    'last_adventure',
    'special_phrase',
    'shared_world_state',
];

const FIELD_LIMITS = {
    child_name: 40,
    age: 12,
    favorite_color: 40,
    favorite_animal: 60,
    favorite_game: 80,
    favorite_toy: 80,
    favorite_cartoon: 80,
    favorite_character: 80,
    pet_name: 60,
    best_friend: 60,
    favorite_food: 80,
    current_interest: 120,
    last_story: 160,
    last_adventure: 160,
    special_phrase: 120,
    shared_world_state: 220,
};

const MEMORY_LIST_FIELDS = [
    'favorite_colors',
    'favorite_animals',
    'favorite_games',
    'favorite_toys',
    'favorite_cartoons',
    'favorite_characters',
    'pets',
    'best_friends',
    'favorite_foods',
    'current_interests',
    'recent_stories',
    'recent_adventures',
    'special_phrases',
    'shared_world_states',
];

const LIST_LIMITS = {
    favorite_colors: 8,
    favorite_animals: 8,
    favorite_games: 8,
    favorite_toys: 8,
    favorite_cartoons: 8,
    favorite_characters: 8,
    pets: 8,
    best_friends: 8,
    favorite_foods: 10,
    current_interests: 8,
    recent_stories: 5,
    recent_adventures: 5,
    special_phrases: 6,
    shared_world_states: 6,
};

const FIELD_TO_LIST = {
    favorite_color: 'favorite_colors',
    favorite_animal: 'favorite_animals',
    favorite_game: 'favorite_games',
    favorite_toy: 'favorite_toys',
    favorite_cartoon: 'favorite_cartoons',
    favorite_character: 'favorite_characters',
    pet_name: 'pets',
    best_friend: 'best_friends',
    favorite_food: 'favorite_foods',
    current_interest: 'current_interests',
    last_story: 'recent_stories',
    last_adventure: 'recent_adventures',
    special_phrase: 'special_phrases',
    shared_world_state: 'shared_world_states',
};

function normalizeDeviceId(value) {
    const deviceId = String(value || '').trim();
    return deviceId || DEFAULT_DEVICE_ID;
}

async function init() {
    if (!DATABASE_URL) {
        logger.warn('[Memory] DATABASE_URL is not set; memory is disabled');
        return;
    }

    pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });

    await pool.query(`
        CREATE TABLE IF NOT EXISTS child_profiles (
            device_id TEXT PRIMARY KEY,
            child_name TEXT DEFAULT '',
            age TEXT DEFAULT '',
            favorite_color TEXT DEFAULT '',
            favorite_animal TEXT DEFAULT '',
            favorite_game TEXT DEFAULT '',
            favorite_toy TEXT DEFAULT '',
            favorite_cartoon TEXT DEFAULT '',
            favorite_character TEXT DEFAULT '',
            pet_name TEXT DEFAULT '',
            best_friend TEXT DEFAULT '',
            favorite_food TEXT DEFAULT '',
            current_interest TEXT DEFAULT '',
            last_story TEXT DEFAULT '',
            last_adventure TEXT DEFAULT '',
            special_phrase TEXT DEFAULT '',
            shared_world_state TEXT DEFAULT '',
            memory_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    await pool.query(`
        ALTER TABLE child_profiles
        ADD COLUMN IF NOT EXISTS memory_json JSONB NOT NULL DEFAULT '{}'::jsonb
    `);

    ready = true;
    logger.info('[Memory] PostgreSQL memory ready');
}

async function getProfile(deviceId) {
    const id = normalizeDeviceId(deviceId);
    if (!ready || !pool) return null;

    await pool.query(
        'INSERT INTO child_profiles (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING',
        [id]
    );

    const result = await pool.query(
        'SELECT * FROM child_profiles WHERE device_id = $1 LIMIT 1',
        [id]
    );
    return result.rows[0] || null;
}

async function updateProfile(deviceId, patch) {
    const id = normalizeDeviceId(deviceId);
    if (!ready || !pool) return null;

    const entries = Object.entries(patch || {})
        .filter(([key, value]) => PROFILE_FIELDS.includes(key) && value !== undefined);

    if (entries.length === 0) {
        return getProfile(id);
    }

    await pool.query(
        'INSERT INTO child_profiles (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING',
        [id]
    );

    const sets = entries.map(([key], index) => `${key} = $${index + 2}`);
    const values = entries.map(([, value]) => value === null ? '' : String(value));

    const result = await pool.query(
        `UPDATE child_profiles
         SET ${sets.join(', ')}, updated_at = now()
         WHERE device_id = $1
         RETURNING *`,
        [id, ...values]
    );

    return result.rows[0] || null;
}

function cleanPatch(rawPatch) {
    const clean = {};
    for (const field of PROFILE_FIELDS) {
        const value = rawPatch?.[field];
        if (typeof value !== 'string' && typeof value !== 'number') continue;

        const text = String(value).trim().replace(/\s+/g, ' ');
        if (!text) continue;

        const limit = FIELD_LIMITS[field] || 80;
        clean[field] = text.slice(0, limit);
    }
    return clean;
}

function parseMemoryJson(value) {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

function cleanListValues(values, limit = 80) {
    const raw = Array.isArray(values) ? values : [values];
    const seen = new Set();
    const clean = [];

    for (const value of raw) {
        if (typeof value !== 'string' && typeof value !== 'number') continue;
        const text = String(value).trim().replace(/\s+/g, ' ').slice(0, limit);
        if (!text) continue;

        const key = text.toLocaleLowerCase('ru-RU');
        if (seen.has(key)) continue;
        seen.add(key);
        clean.push(text);
    }

    return clean;
}

function normalizeMemoryActions(raw) {
    const actions = { set: {}, add: {}, remove: {} };

    const rawSet = raw?.set && typeof raw.set === 'object' ? raw.set : {};
    const rawAdd = raw?.add && typeof raw.add === 'object' ? raw.add : {};
    const rawRemove = raw?.remove && typeof raw.remove === 'object' ? raw.remove : {};

    for (const [field, value] of Object.entries(rawSet)) {
        if (!PROFILE_FIELDS.includes(field)) continue;
        const cleaned = cleanPatch({ [field]: value })[field];
        if (cleaned) actions.set[field] = cleaned;
    }

    for (const field of PROFILE_FIELDS) {
        if (raw?.[field] === undefined || actions.set[field]) continue;
        const cleaned = cleanPatch({ [field]: raw[field] })[field];
        if (cleaned) actions.set[field] = cleaned;
    }

    for (const field of MEMORY_LIST_FIELDS) {
        const limit = FIELD_LIMITS[field] || 100;
        const addValues = cleanListValues(rawAdd[field], limit);
        const removeValues = cleanListValues(rawRemove[field], limit);
        if (addValues.length > 0) actions.add[field] = addValues;
        if (removeValues.length > 0) actions.remove[field] = removeValues;
    }

    return actions;
}

function hasMemoryActions(actions) {
    return ['set', 'add', 'remove'].some((section) => Object.keys(actions?.[section] || {}).length > 0);
}

function mergeList(currentValues, addValues = [], removeValues = [], maxItems = 8) {
    const removeKeys = new Set(cleanListValues(removeValues).map((v) => v.toLocaleLowerCase('ru-RU')));
    const existing = cleanListValues(currentValues)
        .filter((value) => !removeKeys.has(value.toLocaleLowerCase('ru-RU')));

    const result = [];
    const seen = new Set();

    for (const value of cleanListValues(addValues)) {
        const key = value.toLocaleLowerCase('ru-RU');
        if (removeKeys.has(key) || seen.has(key)) continue;
        result.push(value);
        seen.add(key);
    }

    for (const value of existing) {
        const key = value.toLocaleLowerCase('ru-RU');
        if (seen.has(key)) continue;
        result.push(value);
        seen.add(key);
    }

    return result.slice(0, maxItems);
}

async function applyMemoryActions(deviceId, actions) {
    const id = normalizeDeviceId(deviceId);
    if (!ready || !pool) return null;
    if (!hasMemoryActions(actions)) return getProfile(id);
    actions.set = actions.set || {};
    actions.add = actions.add || {};
    actions.remove = actions.remove || {};

    const profile = await getProfile(id);
    const memoryJson = parseMemoryJson(profile?.memory_json);
    const scalarPatch = cleanPatch(actions.set || {});

    for (const [field, value] of Object.entries(scalarPatch)) {
        const listField = FIELD_TO_LIST[field];
        if (!listField) continue;
        actions.add[listField] = cleanListValues([value, ...(actions.add[listField] || [])]);
    }

    for (const field of MEMORY_LIST_FIELDS) {
        const next = mergeList(
            memoryJson[field],
            actions.add[field] || [],
            actions.remove[field] || [],
            LIST_LIMITS[field] || 8
        );
        if (next.length > 0) memoryJson[field] = next;
        else delete memoryJson[field];
    }

    const scalarEntries = Object.entries(scalarPatch);
    const sets = scalarEntries.map(([key], index) => `${key} = $${index + 2}`);
    const values = scalarEntries.map(([, value]) => value);
    const memoryParamIndex = values.length + 2;

    const result = await pool.query(
        `UPDATE child_profiles
         SET ${sets.length ? sets.join(', ') + ',' : ''} memory_json = $${memoryParamIndex}::jsonb, updated_at = now()
         WHERE device_id = $1
         RETURNING *`,
        [id, ...values, JSON.stringify(memoryJson)]
    );

    return result.rows[0] || null;
}

async function extractPatchFromText(userText, profile = null) {
    const text = String(userText || '').trim();
    if (!text || text.length < 3) return {};

    const response = await openai.chat.completions.create({
        model: EXTRACT_MODEL,
        temperature: 0,
        max_tokens: 360,
        response_format: { type: 'json_object' },
        messages: [
            {
                role: 'system',
                content: [
                    'You extract safe child profile memory for a toy named Lumi.',
                    'Return ONLY JSON in this shape: {"set":{},"add":{},"remove":{}}.',
                    'set may use only these scalar keys:',
                    PROFILE_FIELDS.join(', '),
                    'add/remove may use only these list keys:',
                    MEMORY_LIST_FIELDS.join(', '),
                    'Use short values. Store stable, child-friendly preferences and shared play context.',
                    'Important: when the child says they also like something, ADD it. Do not remove old likes unless the child clearly says they no longer like it.',
                    'If the child says a new favorite ("my favorite color is red"), set the scalar field and add it to the matching list. Keep previous list items.',
                    'Use remove only for explicit negations like "I no longer like pizza" or "green is not my favorite anymore".',
                    'Allowed examples: first name, age, favorite colors/animals/games/toys/cartoons/characters/foods, pet first names with type if stated, best friend first name, current interests, recent stories/adventures, special phrases, shared imaginary world state.',
                    'Never store surname, address, phone, school, exact location, medical, religious, political, traumatic, sexual, secret, or safety-risk details.',
                    'If the child mentions sensitive/private details, ignore them and return {} unless another clearly safe preference is present.',
                    'If there is no new safe memory, return {"set":{},"add":{},"remove":{}}.',
                    'If the child corrects a previous memory, return the corrected field.',
                ].join('\n'),
            },
            {
                role: 'user',
                content: JSON.stringify({
                    current_profile: profile || {},
                    child_message: text,
                }),
            },
        ],
    });

    let parsed;
    try {
        parsed = JSON.parse(response.choices[0]?.message?.content || '{}');
    } catch (err) {
        logger.warn(`[Memory] extractor returned invalid JSON: ${err.message}`);
        return {};
    }

    return normalizeMemoryActions(parsed);
}

async function rememberFromText(deviceId, userText, profile = null) {
    if (!AUTO_UPDATE) return null;
    if (!ready || !pool) return null;

    const actions = await extractPatchFromText(userText, profile);
    if (!hasMemoryActions(actions)) {
        logger.debug('[Memory] no new memory extracted');
        return null;
    }

    const updated = await applyMemoryActions(deviceId, actions);
    const keys = [
        ...Object.keys(actions.set || {}).map((key) => `set.${key}`),
        ...Object.keys(actions.add || {}).map((key) => `add.${key}`),
        ...Object.keys(actions.remove || {}).map((key) => `remove.${key}`),
    ];
    logger.info(`[Memory] updated ${normalizeDeviceId(deviceId)} actions: ${keys.join(', ')}`);
    return updated;
}

function formatProfileForPrompt(profile) {
    if (!profile) return '';

    const labels = {
        child_name: 'Имя ребёнка',
        age: 'Возраст',
        favorite_color: 'Любимый цвет',
        favorite_animal: 'Любимое животное',
        favorite_game: 'Любимая игра',
        favorite_toy: 'Любимая игрушка',
        favorite_cartoon: 'Любимый мультфильм',
        favorite_character: 'Любимый персонаж',
        pet_name: 'Питомец',
        best_friend: 'Лучший друг',
        favorite_food: 'Любимая еда',
        current_interest: 'Текущий интерес',
        last_story: 'Последняя сказка',
        last_adventure: 'Последнее приключение',
        special_phrase: 'Особая фраза',
        shared_world_state: 'Общий мир с Lumi',
    };

    const lines = PROFILE_FIELDS
        .map((field) => [labels[field], String(profile[field] || '').trim()])
        .filter(([, value]) => value.length > 0)
        .map(([label, value]) => `- ${label}: ${value}`);

    const memoryLabels = {
        favorite_colors: 'Любимые цвета',
        favorite_animals: 'Любимые животные',
        favorite_games: 'Любимые игры',
        favorite_toys: 'Любимые игрушки',
        favorite_cartoons: 'Любимые мультфильмы',
        favorite_characters: 'Любимые персонажи',
        pets: 'Питомцы',
        best_friends: 'Друзья',
        favorite_foods: 'Любимая еда',
        current_interests: 'Интересы сейчас',
        recent_stories: 'Недавние сказки',
        recent_adventures: 'Недавние приключения',
        special_phrases: 'Особые фразы',
        shared_world_states: 'Общий мир с Lumi',
    };

    const memoryJson = parseMemoryJson(profile.memory_json);
    const memoryLines = MEMORY_LIST_FIELDS
        .map((field) => [memoryLabels[field], cleanListValues(memoryJson[field]).slice(0, LIST_LIMITS[field] || 8)])
        .filter(([, values]) => values.length > 0)
        .map(([label, values]) => `- ${label}: ${values.join(', ')}`);

    if (lines.length === 0 && memoryLines.length === 0) return '';

    return [
        'ПАМЯТЬ О РЕБЁНКЕ:',
        ...lines,
        ...memoryLines,
        '',
        'Используй эту память мягко и редко, только когда она уместна.',
        'Не перечисляй память ребёнку и не делай вид, что знаешь больше, чем здесь написано.',
        'Не запоминай и не проси фамилию, адрес, телефон, школу или другие чувствительные данные.',
    ].join('\n');
}

module.exports = {
    init,
    getProfile,
    updateProfile,
    extractPatchFromText,
    rememberFromText,
    formatProfileForPrompt,
    normalizeDeviceId,
};
