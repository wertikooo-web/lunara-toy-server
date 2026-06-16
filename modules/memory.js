'use strict';

const OpenAI = require('openai');
const { Pool } = require('pg');
const logger = require('./logger');

const DATABASE_URL = process.env.DATABASE_URL;
const DEFAULT_DEVICE_ID = process.env.DEFAULT_DEVICE_ID || 'demo_lumi_001';
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
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
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

async function extractPatchFromText(userText, profile = null) {
    const text = String(userText || '').trim();
    if (!text || text.length < 3) return {};

    const response = await openai.chat.completions.create({
        model: EXTRACT_MODEL,
        temperature: 0,
        max_tokens: 220,
        response_format: { type: 'json_object' },
        messages: [
            {
                role: 'system',
                content: [
                    'You extract safe child profile memory for a toy named Lumi.',
                    'Return ONLY a JSON object with keys from this whitelist:',
                    PROFILE_FIELDS.join(', '),
                    'Use short values. Store only stable, child-friendly preferences and shared play context.',
                    'Allowed examples: first name, age, favorite color/animal/game/toy/cartoon/character/food, pet first name, best friend first name, current interest, last story/adventure, special phrase, shared imaginary world state.',
                    'Never store surname, address, phone, school, exact location, medical, religious, political, traumatic, sexual, secret, or safety-risk details.',
                    'If the child mentions sensitive/private details, ignore them and return {} unless another clearly safe preference is present.',
                    'If there is no new safe memory, return {}.',
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

    return cleanPatch(parsed);
}

async function rememberFromText(deviceId, userText, profile = null) {
    if (!AUTO_UPDATE) return null;
    if (!ready || !pool) return null;

    const patch = await extractPatchFromText(userText, profile);
    const keys = Object.keys(patch);
    if (keys.length === 0) {
        logger.debug('[Memory] no new memory extracted');
        return null;
    }

    const updated = await updateProfile(deviceId, patch);
    logger.info(`[Memory] updated ${normalizeDeviceId(deviceId)} fields: ${keys.join(', ')}`);
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

    if (lines.length === 0) return '';

    return [
        'ПАМЯТЬ О РЕБЁНКЕ:',
        ...lines,
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
