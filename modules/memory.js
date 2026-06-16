'use strict';

const { Pool } = require('pg');
const logger = require('./logger');

const DATABASE_URL = process.env.DATABASE_URL;
const DEFAULT_DEVICE_ID = process.env.DEFAULT_DEVICE_ID || 'demo_lumi_001';

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
    formatProfileForPrompt,
    normalizeDeviceId,
};
