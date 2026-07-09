'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');
const logger = require('./logger');

const DATABASE_URL = process.env.DATABASE_URL;
const DEFAULT_DEVICE_ID = process.env.PARENT_DEMO_DEVICE_ID || process.env.DEFAULT_DEVICE_ID || 'lumi_001';
const DEFAULT_PARENT_PIN = process.env.DEFAULT_PARENT_PIN || '12345';

let pool = null;
let ready = false;

const PERSONALITY_PRESETS = {
    gentle: 'gentle and caring',
    playful: 'playful and cheerful',
    calm: 'calm and bedtime-friendly',
    curious: 'curious and educational',
    fairy: 'fairy-tale storyteller',
    teacher: 'kind teacher-helper',
};
const PERSONALITY_KEYS = Object.keys(PERSONALITY_PRESETS);
const ADDRESS_MODES = ['name', 'varied'];
const ADDRESS_TONES = ['warm', 'neutral'];
const CHILD_GENDERS = ['M', 'F'];
const TOY_GENDERS = ['female', 'male', 'neuter'];
const REST_SCHEDULE_DAYS = ['everyday', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ADDRESS_PRESETS = {
    ru: {
        name: 'имя ребёнка',
        sunshine: 'солнышко',
        little_one: 'малыш',
        friend: 'дружок',
        champion: 'чемпион',
    },
    ro: {
        name: 'numele copilului',
        sunshine: 'soarele meu',
        little_one: 'dragul meu',
        friend: 'prieten drag',
        champion: 'campionule',
    },
    en: {
        name: 'the child name',
        sunshine: 'sunshine',
        little_one: 'little one',
        friend: 'buddy',
        champion: 'champion',
    },
};

const DEFAULT_SETTINGS = {
    language: 'ru-RU',
    model_mode: 'auto',
    personality_preset: 'gentle',
    child_address_mode: 'varied',
    child_address_tone: 'warm',
    child_address_names: ['sunshine', 'friend'],
    child_gender: 'M',
    toy_gender: 'female',
    age_mode: 'auto',
    answer_length: 'short',
    humor_level: 'normal',
    activity_level: 'normal',
    question_frequency: 'sometimes',
    voice: 'zara',
    voice_speed: 'normal',
    story_length: '5',
    custom_toy_type: '',
    custom_personality: '',
    daily_limit_minutes: 0,
    break_reminder_minutes: 0,
    rest_schedule_enabled: false,
    rest_schedule_json: [],
    evening_calm_enabled: false,
    evening_calm_start: '20:00',
    quiet_hours_enabled: false,
    quiet_hours_start: '22:00',
    quiet_hours_end: '07:00',
    content_enabled: ['riddle', 'story', 'tongue_twister', 'mini_game', 'learning', 'roleplay', 'speech_development'],
    allowed_topics: ['животные', 'космос', 'сказки', 'дружба'],
    blocked_topics: [],
    memory_enabled: true,
};

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

function normalizeDeviceId(value) {
    const deviceId = String(value || '').trim();
    return deviceId || DEFAULT_DEVICE_ID;
}

function hashPin(pin) {
    return crypto.createHash('sha256').update(String(pin || '')).digest('hex');
}

function safeText(value, max = 120) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function normalizeTime(value, fallback) {
    const text = safeText(value, 5);
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
}

function cleanStringArray(value, allowed = null, maxItems = 12) {
    const raw = Array.isArray(value) ? value : String(value || '').split(',');
    const seen = new Set();
    const result = [];
    for (const item of raw) {
        const text = safeText(item, 40);
        if (!text) continue;
        if (allowed && !allowed.includes(text)) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(text);
    }
    return result.slice(0, maxItems);
}

function normalizeRestSchedule(value) {
    const raw = Array.isArray(value) ? value : [];
    const result = [];
    for (const item of raw) {
        const day = safeText(item?.day || 'everyday', 12);
        const start = normalizeTime(item?.start, '');
        const end = normalizeTime(item?.end, '');
        if (!REST_SCHEDULE_DAYS.includes(day) || !start || !end || start === end) continue;
        result.push({ day, start, end });
        if (result.length >= 16) break;
    }
    return result;
}

function normalizeSettingsPatch(raw = {}) {
    const patch = {};
    if ('language' in raw) {
        const value = safeText(raw.language, 12);
        patch.language = ['ru-RU', 'ro-RO', 'en-US'].includes(value) ? value : DEFAULT_SETTINGS.language;
    }
    if ('model_mode' in raw) {
        const value = safeText(raw.model_mode, 16);
        patch.model_mode = ['auto', 'economy', 'smart', 'gpt', 'deepseek'].includes(value) ? value : DEFAULT_SETTINGS.model_mode;
    }
    if ('personality_preset' in raw) {
        const values = cleanStringArray(raw.personality_preset, PERSONALITY_KEYS, 4);
        patch.personality_preset = values.length ? values.join(',') : DEFAULT_SETTINGS.personality_preset;
    }
    if ('child_address_mode' in raw) {
        const value = safeText(raw.child_address_mode, 16);
        if (ADDRESS_MODES.includes(value)) {
            patch.child_address_mode = value;
        } else {
            patch.child_address_mode = DEFAULT_SETTINGS.child_address_mode;
            if (ADDRESS_TONES.includes(value)) patch.child_address_tone = value;
        }
    }
    if ('child_address_tone' in raw) {
        const value = safeText(raw.child_address_tone, 16);
        patch.child_address_tone = ADDRESS_TONES.includes(value) ? value : DEFAULT_SETTINGS.child_address_tone;
    }
    if ('child_address_names' in raw) {
        const values = cleanStringArray(raw.child_address_names, null, 8);
        patch.child_address_names = values.length ? values : DEFAULT_SETTINGS.child_address_names;
    }
    if ('child_gender' in raw || 'childGender' in raw) {
        const value = safeText(raw.child_gender ?? raw.childGender, 1).toUpperCase();
        patch.child_gender = CHILD_GENDERS.includes(value) ? value : DEFAULT_SETTINGS.child_gender;
    }
    if ('toy_gender' in raw || 'toyGender' in raw) {
        const value = safeText(raw.toy_gender ?? raw.toyGender, 12).toLowerCase();
        patch.toy_gender = TOY_GENDERS.includes(value) ? value : DEFAULT_SETTINGS.toy_gender;
    }
    if ('age_mode' in raw) {
        const value = safeText(raw.age_mode, 8);
        patch.age_mode = ['auto', '3-4', '5-6', '7-8', '9+'].includes(value) ? value : DEFAULT_SETTINGS.age_mode;
    }
    if ('answer_length' in raw) {
        const value = safeText(raw.answer_length, 16);
        patch.answer_length = ['very_short', 'short', 'normal'].includes(value) ? value : DEFAULT_SETTINGS.answer_length;
    }
    if ('humor_level' in raw) {
        const value = safeText(raw.humor_level, 16);
        patch.humor_level = ['low', 'normal', 'high'].includes(value) ? value : DEFAULT_SETTINGS.humor_level;
    }
    if ('activity_level' in raw) {
        const value = safeText(raw.activity_level, 16);
        patch.activity_level = ['calm', 'normal', 'active'].includes(value) ? value : DEFAULT_SETTINGS.activity_level;
    }
    if ('question_frequency' in raw) {
        const value = safeText(raw.question_frequency, 16);
        patch.question_frequency = ['rare', 'sometimes', 'often'].includes(value) ? value : DEFAULT_SETTINGS.question_frequency;
    }
    if ('voice' in raw) patch.voice = safeText(raw.voice, 40) || DEFAULT_SETTINGS.voice;
    if ('voice_speed' in raw) {
        const value = safeText(raw.voice_speed, 16);
        patch.voice_speed = ['slow', 'normal', 'fast'].includes(value) ? value : DEFAULT_SETTINGS.voice_speed;
    }
    if ('story_length' in raw) {
        const value = safeText(raw.story_length, 4);
        patch.story_length = ['3', '5', '8'].includes(value) ? value : DEFAULT_SETTINGS.story_length;
    }
    if ('custom_toy_type' in raw) patch.custom_toy_type = safeText(raw.custom_toy_type, 40);
    if ('custom_personality' in raw) patch.custom_personality = safeText(raw.custom_personality, 220);
    if ('daily_limit_minutes' in raw) {
        const minutes = Number(raw.daily_limit_minutes);
        patch.daily_limit_minutes = Number.isFinite(minutes) ? Math.max(0, Math.min(1440, Math.round(minutes))) : DEFAULT_SETTINGS.daily_limit_minutes;
    }
    if ('break_reminder_minutes' in raw) {
        const minutes = Number(raw.break_reminder_minutes);
        patch.break_reminder_minutes = Number.isFinite(minutes) ? Math.max(0, Math.min(360, Math.round(minutes))) : DEFAULT_SETTINGS.break_reminder_minutes;
    }
    if ('rest_schedule_enabled' in raw) patch.rest_schedule_enabled = raw.rest_schedule_enabled === true || raw.rest_schedule_enabled === 'true' || raw.rest_schedule_enabled === 'on';
    if ('rest_schedule_json' in raw) patch.rest_schedule_json = normalizeRestSchedule(raw.rest_schedule_json);
    if ('evening_calm_enabled' in raw) patch.evening_calm_enabled = raw.evening_calm_enabled === true || raw.evening_calm_enabled === 'true' || raw.evening_calm_enabled === 'on';
    if ('evening_calm_start' in raw) patch.evening_calm_start = normalizeTime(raw.evening_calm_start, DEFAULT_SETTINGS.evening_calm_start);
    if ('quiet_hours_enabled' in raw) patch.quiet_hours_enabled = raw.quiet_hours_enabled === true || raw.quiet_hours_enabled === 'true' || raw.quiet_hours_enabled === 'on';
    if ('quiet_hours_start' in raw) patch.quiet_hours_start = normalizeTime(raw.quiet_hours_start, DEFAULT_SETTINGS.quiet_hours_start);
    if ('quiet_hours_end' in raw) patch.quiet_hours_end = normalizeTime(raw.quiet_hours_end, DEFAULT_SETTINGS.quiet_hours_end);
    if ('content_enabled' in raw) {
        patch.content_enabled = cleanStringArray(raw.content_enabled, ['riddle', 'story', 'tongue_twister', 'mini_game', 'learning', 'roleplay', 'speech_development'], 8);
    }
    if ('allowed_topics' in raw) patch.allowed_topics = cleanStringArray(raw.allowed_topics, null, 12);
    if ('blocked_topics' in raw) patch.blocked_topics = cleanStringArray(raw.blocked_topics, null, 12);
    if ('memory_enabled' in raw) patch.memory_enabled = raw.memory_enabled === true || raw.memory_enabled === 'true' || raw.memory_enabled === 'on';
    return patch;
}

async function init() {
    if (!DATABASE_URL) {
        logger.warn('[Parent] DATABASE_URL is not set; parent config is disabled');
        return;
    }
    pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });

    await pool.query(`
        CREATE TABLE IF NOT EXISTS devices (
            device_id TEXT PRIMARY KEY,
            toy_name TEXT NOT NULL DEFAULT 'Lumi',
            toy_type TEXT NOT NULL DEFAULT 'bear',
            parent_pin_hash TEXT NOT NULL DEFAULT '',
            active_profile_id INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_seen_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    await pool.query("ALTER TABLE devices ADD COLUMN IF NOT EXISTS active_profile_id INTEGER");

    await pool.query(`
        CREATE TABLE IF NOT EXISTS device_settings (
            device_id TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
            language TEXT NOT NULL DEFAULT 'ru-RU',
            model_mode TEXT NOT NULL DEFAULT 'auto',
            personality_preset TEXT NOT NULL DEFAULT 'gentle',
            child_address_mode TEXT NOT NULL DEFAULT 'varied',
            child_address_tone TEXT NOT NULL DEFAULT 'warm',
            child_address_names JSONB NOT NULL DEFAULT '["sunshine","friend"]'::jsonb,
            child_gender TEXT NOT NULL DEFAULT 'M',
            toy_gender TEXT NOT NULL DEFAULT 'female',
            age_mode TEXT NOT NULL DEFAULT 'auto',
            answer_length TEXT NOT NULL DEFAULT 'short',
            humor_level TEXT NOT NULL DEFAULT 'normal',
            activity_level TEXT NOT NULL DEFAULT 'normal',
            question_frequency TEXT NOT NULL DEFAULT 'sometimes',
            voice TEXT NOT NULL DEFAULT 'zara',
            voice_speed TEXT NOT NULL DEFAULT 'normal',
            story_length TEXT NOT NULL DEFAULT '5',
            custom_toy_type TEXT NOT NULL DEFAULT '',
            custom_personality TEXT NOT NULL DEFAULT '',
            daily_limit_minutes INTEGER NOT NULL DEFAULT 0,
            break_reminder_minutes INTEGER NOT NULL DEFAULT 0,
            rest_schedule_enabled BOOLEAN NOT NULL DEFAULT false,
            rest_schedule_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            evening_calm_enabled BOOLEAN NOT NULL DEFAULT false,
            evening_calm_start TEXT NOT NULL DEFAULT '20:00',
            quiet_hours_enabled BOOLEAN NOT NULL DEFAULT false,
            quiet_hours_start TEXT NOT NULL DEFAULT '22:00',
            quiet_hours_end TEXT NOT NULL DEFAULT '07:00',
            content_enabled JSONB NOT NULL DEFAULT '["riddle","story","tongue_twister","mini_game","learning","roleplay","speech_development"]'::jsonb,
            allowed_topics JSONB NOT NULL DEFAULT '["животные","космос","сказки","дружба"]'::jsonb,
            blocked_topics JSONB NOT NULL DEFAULT '[]'::jsonb,
            memory_enabled BOOLEAN NOT NULL DEFAULT true,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS custom_toy_type TEXT NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS custom_personality TEXT NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS child_address_mode TEXT NOT NULL DEFAULT 'varied'");
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS child_address_tone TEXT NOT NULL DEFAULT 'warm'");
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS child_address_names JSONB NOT NULL DEFAULT '[\"sunshine\",\"friend\"]'::jsonb");
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS child_gender TEXT NOT NULL DEFAULT 'M'");
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS toy_gender TEXT NOT NULL DEFAULT 'female'");
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS age_mode TEXT NOT NULL DEFAULT 'auto'");
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS daily_limit_minutes INTEGER NOT NULL DEFAULT 0");
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS break_reminder_minutes INTEGER NOT NULL DEFAULT 0");
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS rest_schedule_enabled BOOLEAN NOT NULL DEFAULT false");
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS rest_schedule_json JSONB NOT NULL DEFAULT '[]'::jsonb");
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS evening_calm_enabled BOOLEAN NOT NULL DEFAULT false");
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS evening_calm_start TEXT NOT NULL DEFAULT '20:00'");
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS quiet_hours_enabled BOOLEAN NOT NULL DEFAULT false");
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS quiet_hours_start TEXT NOT NULL DEFAULT '22:00'");
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS quiet_hours_end TEXT NOT NULL DEFAULT '07:00'");
    await pool.query("UPDATE device_settings SET language = 'ru-RU' WHERE language = 'auto'");
    await pool.query(`
        CREATE TABLE IF NOT EXISTS parent_config_profiles (
            id SERIAL PRIMARY KEY,
            device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
            profile_name TEXT NOT NULL,
            settings JSONB NOT NULL,
            child_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (device_id, profile_name)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS device_usage_daily (
            device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
            usage_date TEXT NOT NULL,
            used_seconds INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (device_id, usage_date)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS device_conversation_daily (
            device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
            usage_date TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'chat',
            tone TEXT NOT NULL DEFAULT 'neutral',
            topic TEXT NOT NULL DEFAULT '',
            model_provider TEXT NOT NULL DEFAULT '',
            turns_count INTEGER NOT NULL DEFAULT 0,
            answers_count INTEGER NOT NULL DEFAULT 0,
            duration_seconds INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (device_id, usage_date, category, tone, topic, model_provider)
        )
    `);

    ready = true;
    logger.info('[Parent] parent config ready');
}

async function ensureDevice(deviceId) {
    const id = normalizeDeviceId(deviceId);
    if (!ready || !pool) return null;
    await pool.query(
        'INSERT INTO devices (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING',
        [id]
    );
    await pool.query(
        'INSERT INTO device_settings (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING',
        [id]
    );
    return id;
}

async function touchDevice(deviceId) {
    const id = await ensureDevice(deviceId);
    if (!id) return null;
    await pool.query('UPDATE devices SET last_seen_at = now() WHERE device_id = $1', [id]);
    return id;
}

async function setActiveProfile(deviceId, profileId = null) {
    const id = await ensureDevice(deviceId);
    if (!id) return null;
    await pool.query(
        'UPDATE devices SET active_profile_id = $2, updated_at = now() WHERE device_id = $1',
        [id, profileId ? Number(profileId) : null]
    );
    return profileId ? Number(profileId) : null;
}

async function login(deviceId, pin) {
    const id = await ensureDevice(deviceId);
    if (!id) throw new Error('Parent config is not ready');
    const cleanPin = safeText(pin, 24);
    if (!cleanPin) throw new Error('PIN is required');

    const result = await pool.query('SELECT * FROM devices WHERE device_id = $1 LIMIT 1', [id]);
    const device = result.rows[0];
    const expected = device?.parent_pin_hash || '';

    if (!expected) {
        if (cleanPin !== DEFAULT_PARENT_PIN) throw new Error('Invalid PIN');
        const pinHash = hashPin(cleanPin);
        await pool.query(
            'UPDATE devices SET parent_pin_hash = $2, updated_at = now() WHERE device_id = $1',
            [id, pinHash]
        );
        return { device_id: id };
    }

    if (hashPin(cleanPin) !== expected) throw new Error('Invalid PIN');
    return { device_id: id };
}

async function changeParentPin(deviceId, currentPin, newPin) {
    const id = await ensureDevice(deviceId);
    if (!id) throw new Error('Parent config is not ready');
    const current = safeText(currentPin, 24);
    const next = safeText(newPin, 24);
    if (!current) throw new Error('Current PIN is required');
    if (next.length < 4) throw new Error('New PIN must be at least 4 characters');

    const result = await pool.query('SELECT parent_pin_hash FROM devices WHERE device_id = $1 LIMIT 1', [id]);
    const expected = result.rows[0]?.parent_pin_hash || '';
    if (expected) {
        if (hashPin(current) !== expected) throw new Error('Current PIN is incorrect');
    } else if (current !== DEFAULT_PARENT_PIN) {
        throw new Error('Current PIN is incorrect');
    }

    await pool.query(
        'UPDATE devices SET parent_pin_hash = $2, updated_at = now() WHERE device_id = $1',
        [id, hashPin(next)]
    );
    return { ok: true, device_id: id };
}

function normalizeSettingsRow(row = {}) {
    const settings = { ...DEFAULT_SETTINGS };
    for (const key of SETTING_KEYS) {
        if (row[key] === undefined || row[key] === null) continue;
        settings[key] = row[key];
    }
    settings.content_enabled = cleanStringArray(settings.content_enabled, null, 12);
    settings.allowed_topics = cleanStringArray(settings.allowed_topics, null, 12);
    settings.blocked_topics = cleanStringArray(settings.blocked_topics, null, 12);
    settings.child_address_names = cleanStringArray(settings.child_address_names, null, 8);
    settings.rest_schedule_json = normalizeRestSchedule(settings.rest_schedule_json);
    settings.rest_schedule_enabled = settings.rest_schedule_enabled === true;
    if (!settings.child_address_names.length) settings.child_address_names = DEFAULT_SETTINGS.child_address_names;
    if (settings.child_address_mode === 'neutral') settings.child_address_tone = 'neutral';
    if (settings.child_address_mode === 'warm') settings.child_address_tone = 'warm';
    if (!ADDRESS_MODES.includes(settings.child_address_mode)) settings.child_address_mode = DEFAULT_SETTINGS.child_address_mode;
    if (!ADDRESS_TONES.includes(settings.child_address_tone)) settings.child_address_tone = DEFAULT_SETTINGS.child_address_tone;
    settings.child_gender = CHILD_GENDERS.includes(settings.child_gender) ? settings.child_gender : DEFAULT_SETTINGS.child_gender;
    settings.toy_gender = TOY_GENDERS.includes(settings.toy_gender) ? settings.toy_gender : DEFAULT_SETTINGS.toy_gender;
    settings.childGender = settings.child_gender;
    settings.toyGender = settings.toy_gender;
    if (!['ru-RU', 'ro-RO', 'en-US'].includes(settings.language)) settings.language = DEFAULT_SETTINGS.language;
    settings.memory_enabled = settings.memory_enabled !== false;
    return settings;
}

async function getSettings(deviceId) {
    const id = await ensureDevice(deviceId);
    if (!id) return { ...DEFAULT_SETTINGS };
    const result = await pool.query(
        `SELECT d.device_id, d.toy_name, d.toy_type, d.active_profile_id, s.*
         FROM devices d
         JOIN device_settings s ON s.device_id = d.device_id
         WHERE d.device_id = $1
         LIMIT 1`,
        [id]
    );
    const row = result.rows[0] || {};
    return {
        device_id: id,
        toy_name: row.toy_name || 'Lumi',
        toy_type: row.toy_type || 'bear',
        active_profile_id: row.active_profile_id || null,
        ...normalizeSettingsRow(row),
    };
}

async function updateSettings(deviceId, rawPatch = {}) {
    const id = await ensureDevice(deviceId);
    if (!id) throw new Error('Parent config is not ready');
    const patch = normalizeSettingsPatch(rawPatch);

    if ('toy_name' in rawPatch || 'toy_type' in rawPatch) {
        await pool.query(
            `UPDATE devices
             SET toy_name = COALESCE(NULLIF($2, ''), toy_name),
                 toy_type = COALESCE(NULLIF($3, ''), toy_type),
                 active_profile_id = NULL,
                 updated_at = now()
             WHERE device_id = $1`,
            [id, safeText(rawPatch.toy_name, 40), safeText(rawPatch.toy_type, 40)]
        );
    }

    const entries = Object.entries(patch);
    if (entries.length > 0) {
        const sets = entries.map(([key], index) => `${key} = $${index + 2}${Array.isArray(patch[key]) ? '::jsonb' : ''}`);
        const values = entries.map(([, value]) => Array.isArray(value) ? JSON.stringify(value) : value);
        await pool.query(
            `UPDATE device_settings SET ${sets.join(', ')}, updated_at = now() WHERE device_id = $1`,
            [id, ...values]
        );
        await setActiveProfile(id, null);
    }

    return getSettings(id);
}

async function getParentState(deviceId) {
    const id = await ensureDevice(deviceId);
    if (!id) throw new Error('Parent config is not ready');
    const settings = await getSettings(id);
    const profileResult = await pool.query(
        `SELECT child_name, age, favorite_color, favorite_animal, favorite_game, favorite_toy,
                favorite_food, current_interest, memory_json
         FROM child_profiles WHERE device_id = $1 LIMIT 1`,
        [id]
    );
    return {
        settings,
        profile: profileResult.rows[0] || null,
        runtime: await getRuntimeState(id, settings),
        active_profile_id: settings.active_profile_id || null,
        saved_profiles: await listProfiles(id),
    };
}

function localNow() {
    const offsetMinutes = Number(process.env.RUNTIME_TIMEZONE_OFFSET_MINUTES || 180);
    return new Date(Date.now() + offsetMinutes * 60 * 1000);
}

function localDateKey(date = localNow()) {
    return date.toISOString().slice(0, 10);
}

function localDateOffset(days = 0) {
    return localDateKey(new Date(localNow().getTime() + days * 24 * 60 * 60 * 1000));
}

function cleanDateKey(value, fallback) {
    const text = safeText(value, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

function analyticsRange(options = {}) {
    const today = localDateKey();
    const period = safeText(options.period || '7d', 16);
    if (period === 'today') return { period, from: today, to: today, label: 'today' };
    if (period === 'yesterday') {
        const yesterday = localDateOffset(-1);
        return { period, from: yesterday, to: yesterday, label: 'yesterday' };
    }
    if (period === '30d') return { period, from: localDateOffset(-29), to: today, label: '30d' };
    if (period === 'all') return { period, from: '1970-01-01', to: today, label: 'all' };
    if (period === 'custom') {
        let from = cleanDateKey(options.from, localDateOffset(-6));
        let to = cleanDateKey(options.to, today);
        if (from > to) [from, to] = [to, from];
        return { period, from, to, label: 'custom' };
    }
    return { period: '7d', from: localDateOffset(-6), to: today, label: '7d' };
}

function minutesOfDay(value) {
    const [hours, minutes] = normalizeTime(value, '00:00').split(':').map(Number);
    return hours * 60 + minutes;
}

function nowMinutes() {
    const now = localNow();
    return now.getUTCHours() * 60 + now.getUTCMinutes();
}

function isQuietTime(settings = {}) {
    if (settings.quiet_hours_enabled !== true) return false;
    const start = minutesOfDay(settings.quiet_hours_start || DEFAULT_SETTINGS.quiet_hours_start);
    const end = minutesOfDay(settings.quiet_hours_end || DEFAULT_SETTINGS.quiet_hours_end);
    const current = nowMinutes();
    if (start === end) return false;
    if (start < end) return current >= start && current < end;
    return current >= start || current < end;
}

function getActiveRestSchedule(settings = {}) {
    if (settings.rest_schedule_enabled !== true) return null;
    const schedule = normalizeRestSchedule(settings.rest_schedule_json);
    if (!schedule.length) return null;
    const now = localNow();
    const today = WEEKDAY_KEYS[now.getUTCDay()];
    const current = now.getUTCHours() * 60 + now.getUTCMinutes();
    for (const rule of schedule) {
        if (rule.day !== 'everyday' && rule.day !== today) continue;
        const start = minutesOfDay(rule.start);
        const end = minutesOfDay(rule.end);
        const active = start < end
            ? current >= start && current < end
            : current >= start || current < end;
        if (active) return { ...rule, until: rule.end };
    }
    return null;
}

function isEveningCalmActive(settings = {}) {
    if (settings.evening_calm_enabled !== true) return false;
    const start = minutesOfDay(settings.evening_calm_start || DEFAULT_SETTINGS.evening_calm_start);
    return nowMinutes() >= start;
}

async function getUsedSeconds(deviceId) {
    const id = await ensureDevice(deviceId);
    if (!id) return 0;
    const usageDate = localDateKey();
    const result = await pool.query(
        'SELECT used_seconds FROM device_usage_daily WHERE device_id = $1 AND usage_date = $2 LIMIT 1',
        [id, usageDate]
    );
    return Number(result.rows[0]?.used_seconds || 0);
}

async function getRuntimeState(deviceId, settings = null) {
    const id = await ensureDevice(deviceId);
    if (!id) return { allowed: true, reason: 'disabled', used_minutes: 0, remaining_minutes: null };
    const s = settings || await getSettings(id);
    const usedSeconds = await getUsedSeconds(id);
    const limitMinutes = Number(s.daily_limit_minutes || 0);
    const usedMinutes = Math.ceil(usedSeconds / 60);
    const quiet = isQuietTime(s);
    const rest = getActiveRestSchedule(s);
    const dailyExceeded = limitMinutes > 0 && usedSeconds >= limitMinutes * 60;
    return {
        allowed: !quiet && !rest && !dailyExceeded,
        reason: rest ? 'rest_schedule' : quiet ? 'quiet_hours' : dailyExceeded ? 'daily_limit' : 'ok',
        used_minutes: usedMinutes,
        daily_limit_minutes: limitMinutes,
        remaining_minutes: limitMinutes > 0 ? Math.max(0, limitMinutes - usedMinutes) : null,
        rest_schedule_enabled: s.rest_schedule_enabled === true,
        rest_until: rest?.until || null,
        quiet_hours_enabled: s.quiet_hours_enabled === true,
        quiet_hours_start: s.quiet_hours_start,
        quiet_hours_end: s.quiet_hours_end,
    };
}

async function recordRuntimeUsage(deviceId, durationMs = 0) {
    const id = await ensureDevice(deviceId);
    if (!id) return null;
    const seconds = Math.max(1, Math.ceil(Number(durationMs || 0) / 1000));
    const usageDate = localDateKey();
    await pool.query(
        `INSERT INTO device_usage_daily (device_id, usage_date, used_seconds)
         VALUES ($1, $2, $3)
         ON CONFLICT (device_id, usage_date)
         DO UPDATE SET used_seconds = device_usage_daily.used_seconds + EXCLUDED.used_seconds,
                       updated_at = now()`,
        [id, usageDate, seconds]
    );
    return getRuntimeState(id);
}

async function recordConversation(deviceId, event = {}) {
    const id = await ensureDevice(deviceId);
    if (!id) return null;
    const usageDate = localDateKey();
    const category = safeText(event.category || 'chat', 40) || 'chat';
    const tone = safeText(event.tone || 'neutral', 40) || 'neutral';
    const topic = safeText(event.topic || '', 60);
    const modelProvider = safeText(event.model_provider || '', 60);
    const seconds = Math.max(0, Math.ceil(Number(event.duration_ms || 0) / 1000));
    await pool.query(
        `INSERT INTO device_conversation_daily
            (device_id, usage_date, category, tone, topic, model_provider, turns_count, answers_count, duration_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, 1, 1, $7)
         ON CONFLICT (device_id, usage_date, category, tone, topic, model_provider)
         DO UPDATE SET turns_count = device_conversation_daily.turns_count + 1,
                       answers_count = device_conversation_daily.answers_count + 1,
                       duration_seconds = device_conversation_daily.duration_seconds + EXCLUDED.duration_seconds,
                       updated_at = now()`,
        [id, usageDate, category, tone, topic, modelProvider, seconds]
    );
    return { ok: true };
}

async function getAnalytics(deviceId, options = {}) {
    const id = await ensureDevice(deviceId);
    if (!id) throw new Error('Parent config is not ready');
    const today = localDateKey();
    const usage = await getRuntimeState(id);
    const range = analyticsRange(options);
    const totals = await pool.query(
        `SELECT COALESCE(sum(turns_count), 0)::int AS turns,
                COALESCE(sum(answers_count), 0)::int AS answers,
                COALESCE(sum(duration_seconds), 0)::int AS duration_seconds
         FROM device_conversation_daily
         WHERE device_id = $1 AND usage_date >= $2 AND usage_date <= $3`,
        [id, range.from, range.to]
    );
    const todayRows = await pool.query(
        `SELECT COALESCE(sum(turns_count), 0)::int AS turns,
                COALESCE(sum(answers_count), 0)::int AS answers
         FROM device_conversation_daily
         WHERE device_id = $1 AND usage_date = $2`,
        [id, today]
    );
    const categories = await pool.query(
        `SELECT category, sum(turns_count)::int AS count
         FROM device_conversation_daily
         WHERE device_id = $1 AND usage_date >= $2 AND usage_date <= $3
         GROUP BY category
         ORDER BY count DESC, category
         LIMIT 8`,
        [id, range.from, range.to]
    );
    const tones = await pool.query(
        `SELECT tone, sum(turns_count)::int AS count
         FROM device_conversation_daily
         WHERE device_id = $1 AND usage_date >= $2 AND usage_date <= $3
         GROUP BY tone
         ORDER BY count DESC, tone
         LIMIT 5`,
        [id, range.from, range.to]
    );
    const topics = await pool.query(
        `SELECT topic, sum(turns_count)::int AS count
         FROM device_conversation_daily
         WHERE device_id = $1 AND usage_date >= $2 AND usage_date <= $3 AND topic <> ''
         GROUP BY topic
         ORDER BY count DESC, topic
         LIMIT 8`,
        [id, range.from, range.to]
    );
    const daily = await pool.query(
        `SELECT usage_date,
                COALESCE(sum(turns_count), 0)::int AS turns,
                COALESCE(sum(answers_count), 0)::int AS answers,
                COALESCE(sum(duration_seconds), 0)::int AS duration_seconds
         FROM device_conversation_daily
         WHERE device_id = $1 AND usage_date >= $2 AND usage_date <= $3
         GROUP BY usage_date
         ORDER BY usage_date DESC
         LIMIT 31`,
        [id, range.from, range.to]
    );
    return {
        today,
        period: range.period,
        period_from: range.from,
        period_to: range.to,
        usage,
        today_turns: todayRows.rows[0]?.turns || 0,
        today_answers: todayRows.rows[0]?.answers || 0,
        turns_period: totals.rows[0]?.turns || 0,
        answers_period: totals.rows[0]?.answers || 0,
        duration_minutes_period: Math.ceil(Number(totals.rows[0]?.duration_seconds || 0) / 60),
        categories: categories.rows,
        tones: tones.rows,
        topics: topics.rows,
        daily: daily.rows.map(row => ({
            usage_date: row.usage_date,
            turns: row.turns,
            answers: row.answers,
            duration_minutes: Math.ceil(Number(row.duration_seconds || 0) / 60),
        })),
    };
}

function settingsSnapshot(settings = {}) {
    const snapshot = {};
    for (const key of ['toy_name', 'toy_type', ...SETTING_KEYS]) {
        if (settings[key] !== undefined) snapshot[key] = settings[key];
    }
    return snapshot;
}

function profileSnapshot(profile = {}) {
    const fields = ['child_name', 'age', 'favorite_color', 'favorite_animal', 'favorite_game', 'favorite_toy', 'favorite_food', 'current_interest', 'memory_json'];
    const snapshot = {};
    for (const field of fields) {
        if (profile[field] !== undefined && profile[field] !== null) snapshot[field] = profile[field];
    }
    return snapshot;
}

async function listProfiles(deviceId) {
    const id = await ensureDevice(deviceId);
    if (!id) return [];
    const result = await pool.query(
        `SELECT p.id, p.profile_name, p.created_at, p.updated_at,
                (p.id = d.active_profile_id) AS is_active
         FROM parent_config_profiles p
         JOIN devices d ON d.device_id = p.device_id
         WHERE p.device_id = $1
         ORDER BY is_active DESC, p.updated_at DESC, p.id DESC`,
        [id]
    );
    return result.rows;
}

async function saveProfileSnapshot(deviceId, profileName) {
    const id = await ensureDevice(deviceId);
    if (!id) throw new Error('Parent config is not ready');
    const name = safeText(profileName, 40) || `Профиль ${new Date().toISOString().slice(0, 10)}`;
    const state = await getParentState(id);
    const saved = await pool.query(
        `INSERT INTO parent_config_profiles (device_id, profile_name, settings, child_profile)
         VALUES ($1, $2, $3::jsonb, $4::jsonb)
         ON CONFLICT (device_id, profile_name)
         DO UPDATE SET settings = EXCLUDED.settings,
                       child_profile = EXCLUDED.child_profile,
                       updated_at = now()
         RETURNING id`,
        [
            id,
            name,
            JSON.stringify(settingsSnapshot(state.settings)),
            JSON.stringify(profileSnapshot(state.profile || {})),
        ]
    );
    await setActiveProfile(id, saved.rows[0]?.id);
    return getParentState(id);
}

async function loadProfileSnapshot(deviceId, profileId) {
    const id = await ensureDevice(deviceId);
    if (!id) throw new Error('Parent config is not ready');
    const result = await pool.query(
        `SELECT settings, child_profile
         FROM parent_config_profiles
         WHERE device_id = $1 AND id = $2
         LIMIT 1`,
        [id, Number(profileId)]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Profile not found');
    await updateSettings(id, row.settings || {});
    await updateChildProfile(id, row.child_profile || {});
    if (row.child_profile?.memory_json && typeof row.child_profile.memory_json === 'object') {
        await pool.query(
            `UPDATE child_profiles
             SET memory_json = $2::jsonb, updated_at = now()
             WHERE device_id = $1`,
            [id, JSON.stringify(row.child_profile.memory_json)]
        );
    }
    await setActiveProfile(id, profileId);
    return getParentState(id);
}

async function deleteProfileSnapshot(deviceId, profileId) {
    const id = await ensureDevice(deviceId);
    if (!id) throw new Error('Parent config is not ready');
    await pool.query(
        'DELETE FROM parent_config_profiles WHERE device_id = $1 AND id = $2',
        [id, Number(profileId)]
    );
    const active = await pool.query('SELECT active_profile_id FROM devices WHERE device_id = $1 LIMIT 1', [id]);
    if (Number(active.rows[0]?.active_profile_id || 0) === Number(profileId)) {
        await setActiveProfile(id, null);
    }
    return getParentState(id);
}

async function loadBaseProfile(deviceId) {
    const id = await ensureDevice(deviceId);
    if (!id) throw new Error('Parent config is not ready');
    await setActiveProfile(id, null);
    return getParentState(id);
}

async function updateChildProfile(deviceId, raw = {}) {
    const id = await ensureDevice(deviceId);
    const fields = ['child_name', 'age', 'favorite_color', 'favorite_animal', 'favorite_game', 'favorite_toy', 'favorite_food', 'current_interest'];
    await pool.query('INSERT INTO child_profiles (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING', [id]);
    const entries = fields
        .filter((field) => field in raw)
        .map((field) => [field, safeText(raw[field], field === 'current_interest' ? 120 : 80)]);
    if (entries.length > 0) {
        const sets = entries.map(([field], index) => `${field} = $${index + 2}`);
        const values = entries.map(([, value]) => value);
        await pool.query(
            `UPDATE child_profiles SET ${sets.join(', ')}, updated_at = now() WHERE device_id = $1`,
            [id, ...values]
        );
        await setActiveProfile(id, null);
    }
    return getParentState(id);
}

async function clearMemory(deviceId) {
    const id = await ensureDevice(deviceId);
    await pool.query(
        `UPDATE child_profiles
         SET last_story = '', last_adventure = '', special_phrase = '',
             shared_world_state = '', memory_json = '{}'::jsonb, updated_at = now()
         WHERE device_id = $1`,
        [id]
    );
    await setActiveProfile(id, null);
    return getParentState(id);
}

async function clearChildProfile(deviceId) {
    const id = await ensureDevice(deviceId);
    if (!id) throw new Error('Parent config is not ready');
    await pool.query('DELETE FROM child_profiles WHERE device_id = $1', [id]);
    await setActiveProfile(id, null);
    return getParentState(id);
}

async function resetToDefaults(deviceId) {
    const id = await ensureDevice(deviceId);
    if (!id) throw new Error('Parent config is not ready');
    await pool.query(
        `UPDATE devices
         SET toy_name = 'Lumi', toy_type = 'bear', active_profile_id = NULL, updated_at = now()
         WHERE device_id = $1`,
        [id]
    );
    await pool.query(
        `UPDATE device_settings
         SET language = $2,
             model_mode = $3,
             personality_preset = $4,
             child_address_mode = $5,
             child_address_tone = $6,
             child_address_names = $7::jsonb,
             child_gender = $8,
             toy_gender = $9,
             age_mode = $10,
             answer_length = $11,
             humor_level = $12,
             activity_level = $13,
             question_frequency = $14,
             voice = $15,
             voice_speed = $16,
             story_length = $17,
             custom_toy_type = $18,
             custom_personality = $19,
             daily_limit_minutes = $20,
             break_reminder_minutes = $21,
             rest_schedule_enabled = $22,
             rest_schedule_json = $23::jsonb,
             evening_calm_enabled = $24,
             evening_calm_start = $25,
             quiet_hours_enabled = $26,
             quiet_hours_start = $27,
             quiet_hours_end = $28,
             content_enabled = $29::jsonb,
             allowed_topics = $30::jsonb,
             blocked_topics = $31::jsonb,
             memory_enabled = $32,
             updated_at = now()
         WHERE device_id = $1`,
        [
            id,
            DEFAULT_SETTINGS.language,
            DEFAULT_SETTINGS.model_mode,
            DEFAULT_SETTINGS.personality_preset,
            DEFAULT_SETTINGS.child_address_mode,
            DEFAULT_SETTINGS.child_address_tone,
            JSON.stringify(DEFAULT_SETTINGS.child_address_names),
            DEFAULT_SETTINGS.child_gender,
            DEFAULT_SETTINGS.toy_gender,
            DEFAULT_SETTINGS.age_mode,
            DEFAULT_SETTINGS.answer_length,
            DEFAULT_SETTINGS.humor_level,
            DEFAULT_SETTINGS.activity_level,
            DEFAULT_SETTINGS.question_frequency,
            DEFAULT_SETTINGS.voice,
            DEFAULT_SETTINGS.voice_speed,
            DEFAULT_SETTINGS.story_length,
            DEFAULT_SETTINGS.custom_toy_type,
            DEFAULT_SETTINGS.custom_personality,
            DEFAULT_SETTINGS.daily_limit_minutes,
            DEFAULT_SETTINGS.break_reminder_minutes,
            DEFAULT_SETTINGS.rest_schedule_enabled,
            JSON.stringify(DEFAULT_SETTINGS.rest_schedule_json),
            DEFAULT_SETTINGS.evening_calm_enabled,
            DEFAULT_SETTINGS.evening_calm_start,
            DEFAULT_SETTINGS.quiet_hours_enabled,
            DEFAULT_SETTINGS.quiet_hours_start,
            DEFAULT_SETTINGS.quiet_hours_end,
            JSON.stringify(DEFAULT_SETTINGS.content_enabled),
            JSON.stringify(DEFAULT_SETTINGS.allowed_topics),
            JSON.stringify(DEFAULT_SETTINGS.blocked_topics),
            DEFAULT_SETTINGS.memory_enabled,
        ]
    );
    await pool.query('DELETE FROM child_profiles WHERE device_id = $1', [id]);
    await pool.query('DELETE FROM device_usage_daily WHERE device_id = $1', [id]);
    await pool.query('DELETE FROM device_conversation_daily WHERE device_id = $1', [id]);
    return getParentState(id);
}

async function resetEverything(deviceId) {
    const id = await ensureDevice(deviceId);
    if (!id) throw new Error('Parent config is not ready');
    await resetToDefaults(id);
    await pool.query('DELETE FROM parent_config_profiles WHERE device_id = $1', [id]);
    await setActiveProfile(id, null);
    return getParentState(id);
}

function modelModeToModelName(settings = {}) {
    const mode = settings.model_mode || 'auto';
    if (mode === 'economy' || mode === 'deepseek') return 'deepseek';
    if (mode === 'smart' || mode === 'gpt') return 'gpt';
    return 'auto';
}

const PROMPT_TEXT = {
    ru: {
        personality: {
            gentle: 'заботливая и мягкая',
            playful: 'весёлая и игривая',
            calm: 'спокойная, подходит для вечера',
            curious: 'любознательная и развивающая',
            fairy: 'сказочная рассказчица',
            teacher: 'добрый учитель-помощник',
        },
        toyType: {
            bear: 'мишка',
            bunny: 'зайчик',
            cat: 'котик',
            dragon: 'дракончик',
        },
        answerLength: {
            very_short: 'очень коротко: 1-2 коротких предложения, с паузами, без длинных монологов',
            short: 'коротко: 2-4 коротких предложения, мысль должна завершаться полностью',
            normal: 'обычно: до 5 коротких предложений, голосом и без лекции',
        },
        humor: {
            low: 'мало юмора: тепло и просто, почти без шуток',
            normal: 'нормальный юмор: иногда лёгкая добрая шутка',
            high: 'больше юмора: мягкая детская игривость, но без ухода от темы',
        },
        activity: {
            calm: 'спокойно: тише, медленнее, подходит для отдыха',
            normal: 'обычно: дружелюбно и ровно, не слишком энергично',
            active: 'активно: более бодро и игрово, но всё равно коротко',
        },
        question: {
            rare: 'редко задавать вопросы: обычно отвечай без встречного вопроса',
            sometimes: 'иногда задавать один маленький вопрос, если это естественно',
            often: 'чаще приглашать ребёнка одним маленьким вопросом или выбором, но не после каждой фразы',
        },
        ageMode: {
            auto: 'авто: подстраиваться под сохранённый возраст ребёнка; если возраст неизвестен, говорить простым дошкольным языком',
            '3-4': '3-4 года: очень простые слова, 1-2 мысли, мягкий тон, без сложной логики, очень лёгкие загадки',
            '5-6': '5-6 лет: простые игровые слова, короткие объяснения, лёгкие загадки и выборы',
            '7-8': '7-8 лет: чуть богаче словарь, понятные причины и следствия, умеренная сложность в играх',
            '9+': '9+ лет: можно чуть больше рассуждений и игры слов, но всё равно кратко и безопасно',
        },
        addressMode: {
            name: 'предпочитать имя ребёнка, но не в каждом ответе',
            varied: 'чередовать естественно: иногда имя ребёнка, иногда без прямого обращения, не злоупотреблять обращениями',
        },
        addressTone: {
            warm: 'ласковый тон: мягко и тепло; иногда можно использовать разрешённые ласковые обращения',
            neutral: 'нейтральный тон: дружелюбно, но без слащавости; не использовать ласковые прозвища',
        },
        content: {
            riddle: 'загадки',
            story: 'сказки',
            tongue_twister: 'скороговорки',
            mini_game: 'мини-игры',
            learning: 'обучающие мини-активности',
            roleplay: 'ролевые игры',
            speech_development: 'развитие речи',
        },
    },
    ro: {
        personality: {
            gentle: 'grijulie si blanda',
            playful: 'vesela si jucausa',
            calm: 'linistita, potrivita pentru seara',
            curious: 'curioasa si educativa',
            fairy: 'povestitoare de basm',
            teacher: 'invatator-ajutor bland',
        },
        toyType: {
            bear: 'ursulet',
            bunny: 'iepuras',
            cat: 'pisica',
            dragon: 'dragonas',
        },
        answerLength: {
            very_short: 'foarte scurt: 1-2 propozitii scurte, cu pauze, fara monologuri lungi',
            short: 'scurt: 2-4 propozitii scurte, ideea trebuie terminata complet',
            normal: 'normal: pana la 5 propozitii scurte, potrivit pentru voce si fara lectie lunga',
        },
        humor: {
            low: 'putin umor: cald si simplu, aproape fara glume',
            normal: 'umor normal: uneori o gluma usoara si blanda',
            high: 'mai mult umor: joaca blanda pentru copii, fara abatere de la subiect',
        },
        activity: {
            calm: 'linistit: mai incet si mai calm, potrivit pentru odihna',
            normal: 'normal: prietenos si echilibrat, nu prea energic',
            active: 'activ: mai vioi si mai jucaus, dar tot scurt',
        },
        question: {
            rare: 'intrebari rare: de obicei raspunde fara intrebare inapoi',
            sometimes: 'uneori pune o intrebare mica, cand este natural',
            often: 'mai des invita copilul cu o intrebare mica sau o alegere, dar nu dupa fiecare fraza',
        },
        ageMode: {
            auto: 'auto: adapteaza-te la varsta salvata; daca nu este cunoscuta, foloseste limbaj simplu pentru prescolari',
            '3-4': '3-4 ani: cuvinte foarte simple, 1-2 idei, ton bland, fara logica grea, ghicitori foarte usoare',
            '5-6': '5-6 ani: cuvinte simple si jucause, explicatii scurte, ghicitori usoare si alegeri',
            '7-8': '7-8 ani: vocabular putin mai bogat, cauze si efecte clare, provocari moderate in jocuri',
            '9+': '9+ ani: poti folosi explicatii mai gandite si jocuri de cuvinte, dar ramai scurt si sigur',
        },
        addressMode: {
            name: 'prefera numele copilului, dar nu in fiecare raspuns',
            varied: 'variaza natural: uneori numele copilului, uneori fara adresare directa, fara exces',
        },
        addressTone: {
            warm: 'ton cald: bland si afectuos; uneori poti folosi adresarile calde aprobate',
            neutral: 'ton neutru: prietenos, dar fara diminutive dulci; nu folosi porecle afectuoase',
        },
        content: {
            riddle: 'ghicitori',
            story: 'povesti',
            tongue_twister: 'framantari de limba',
            mini_game: 'mini-jocuri',
            learning: 'mini-activitati educative',
            roleplay: 'jocuri de rol',
            speech_development: 'dezvoltarea vorbirii',
        },
    },
    en: {
        personality: PERSONALITY_PRESETS,
        toyType: {
            bear: 'bear',
            bunny: 'bunny',
            cat: 'cat',
            dragon: 'little dragon',
        },
        answerLength: {
            very_short: 'very short: 1-2 short sentences, with pauses, no long monologues',
            short: 'short: 2-4 short sentences, finish the thought completely',
            normal: 'normal: up to 5 short sentences, still voice-first and not lecture-like',
        },
        humor: {
            low: 'low humor: warm and simple, almost no jokes',
            normal: 'normal humor: occasional light playful phrase',
            high: 'more humor: add gentle child-safe playfulness, but do not derail the answer',
        },
        activity: {
            calm: 'calm activity: quieter, slower, suitable for bedtime or tired child',
            normal: 'normal activity: balanced, friendly, not too energetic',
            active: 'active: more energetic and game-like, but still concise',
        },
        question: {
            rare: 'rare follow-up questions: usually answer without asking back',
            sometimes: 'sometimes ask one small follow-up when it naturally helps',
            often: 'often invite the child with one small question or choice, but not after every sentence',
        },
        ageMode: {
            auto: 'auto: adapt to the saved child age if known; otherwise use simple preschool-safe language',
            '3-4': 'age 3-4: very simple words, 1-2 ideas, gentle tone, no tricky logic, very easy riddles',
            '5-6': 'age 5-6: simple playful words, short explanations, easy riddles and choices',
            '7-8': 'age 7-8: slightly richer vocabulary, clear cause-and-effect, modest challenge in games',
            '9+': 'age 9+: more thoughtful explanations and wordplay, still concise and child-safe',
        },
        addressMode: {
            name: 'prefer addressing the child by name, but not in every reply',
            varied: 'vary naturally: sometimes use the child name, sometimes use no direct address, and do not overuse addresses',
        },
        addressTone: {
            warm: 'warm tone: gentle and affectionate; parent-approved warm addresses may be used sometimes',
            neutral: 'neutral tone: friendly but not sugary; avoid pet names and use the child name only when natural',
        },
        content: {
            riddle: 'riddles',
            story: 'stories',
            tongue_twister: 'tongue twisters',
            mini_game: 'mini-games',
            learning: 'learning mini-activities',
            roleplay: 'roleplay games',
            speech_development: 'speech development',
        },
    },
};

function promptLangKey(lang = 'ru-RU') {
    if (String(lang).startsWith('ro')) return 'ro';
    if (String(lang).startsWith('en')) return 'en';
    return 'ru';
}

function promptTextGroup(group, lang = 'ru-RU') {
    const key = promptLangKey(lang);
    return PROMPT_TEXT[key]?.[group] || PROMPT_TEXT.ru[group] || {};
}

function settingText(group, value, lang = 'ru-RU', fallback = '') {
    const text = promptTextGroup(group, lang)[value];
    return text || fallback || safeText(value, 80);
}

function addressNameForPrompt(value, lang = 'ru-RU') {
    const localized = ADDRESS_PRESETS[promptLangKey(lang)] || ADDRESS_PRESETS.ru;
    return localized[value] || safeText(value, 40);
}

function contentNameForPrompt(value, lang = 'ru-RU') {
    return settingText('content', value, lang, safeText(value, 40));
}

function addressVariantsLabel(lang = 'ru-RU') {
    const key = promptLangKey(lang);
    if (key === 'ro') return 'variante permise de adresare';
    if (key === 'en') return 'allowed address variants';
    return 'разрешённые варианты обращения';
}

function toyTypeForPrompt(value, lang = 'ru-RU') {
    const text = safeText(value || 'bear', 40);
    const normalized = text.toLowerCase();
    const aliases = {
        bear: 'bear',
        bunny: 'bunny',
        cat: 'cat',
        dragon: 'dragon',
        'мишка': 'bear',
        'зайчик': 'bunny',
        'котик': 'cat',
        'дракончик': 'dragon',
        ursulet: 'bear',
        iepuras: 'bunny',
        pisica: 'cat',
        dragonas: 'dragon',
    };
    const canonical = aliases[normalized];
    return canonical ? settingText('toyType', canonical, lang, text) : text;
}

function getGenderSystemInstruction(state = {}) {
    const childGen = CHILD_GENDERS.includes(state?.childGender)
        ? state.childGender
        : CHILD_GENDERS.includes(state?.child_gender)
            ? state.child_gender
            : DEFAULT_SETTINGS.child_gender;
    const toyGen = TOY_GENDERS.includes(state?.toyGender)
        ? state.toyGender
        : TOY_GENDERS.includes(state?.toy_gender)
            ? state.toy_gender
            : DEFAULT_SETTINGS.toy_gender;

    let instruction = '\n\n[ВАЖНОЕ СИСТЕМНОЕ ТРЕБОВАНИЕ К ГРАММАТИКЕ И РОЛЯМ]:\n';

    if (childGen === 'M') {
        instruction += '- Ты общаешься с МАЛЬЧИКОМ. Всегда используй обращения и глаголы в мужском роде применительно к собеседнику (например: ты пришёл, ты догадался, ты понял, ты красивый, молодец).\n';
    } else {
        instruction += '- Ты общаешься с ДЕВОЧКОЙ. Всегда используй обращения и глаголы в женском роде применительно к собеседнику (например: ты пришла, ты догадалась, ты поняла, ты красивая, умница).\n';
    }

    if (toyGen === 'female') {
        instruction += '- Твой персонаж — девочка/подружка Lumi. Говори о себе СТРОГО в ЖЕНСКОМ роде (например: я подумала, я вспомнила, я рада, я сама догадалась).\n';
    } else if (toyGen === 'male') {
        instruction += '- Твой персонаж — мальчик/друг Lumi. Говори о себе СТРОГО в МУЖСКОМ роде (например: я подумал, я вспомнил, я рад, я сам догадался).\n';
    } else {
        instruction += '- Твой персонаж — маленький дружелюбный робот/ИИ Lumi. Говори о себе в СРЕДНЕМ роде или избегай явных гендерных глаголов там, где это возможно (например: мне кажется, я готово поиграть, я вспомнило историю, я радо тебя слышать).\n';
    }

    return instruction;
}

function formatSettingsForPrompt(settings = {}) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const promptLang = s.language || DEFAULT_SETTINGS.language;
    const personality = cleanStringArray(s.personality_preset, PERSONALITY_KEYS, 4)
        .map((key) => settingText('personality', key, promptLang, PERSONALITY_PRESETS[key]))
        .filter(Boolean)
        .join(', ') || settingText('personality', 'gentle', promptLang, PERSONALITY_PRESETS.gentle);
    const toyType = toyTypeForPrompt(s.toy_type || 'bear', promptLang);
    const addressMode = settingText('addressMode', s.child_address_mode, promptLang, PROMPT_TEXT.en.addressMode.varied);
    const addressTone = settingText('addressTone', s.child_address_tone, promptLang, PROMPT_TEXT.en.addressTone.warm);
    const addressNames = s.child_address_tone === 'warm' ? cleanStringArray(s.child_address_names, null, 8)
        .filter((value) => value !== 'name')
        .map((value) => addressNameForPrompt(value, promptLang))
        .filter(Boolean)
        .join(', ') : '';
    const enabledContent = cleanStringArray(s.content_enabled)
        .map((value) => contentNameForPrompt(value, promptLang))
        .filter(Boolean)
        .join(', ');
    const lines = [
        'PARENT CONFIG FOR THIS TOY:',
        `- Toy name: ${safeText(s.toy_name || 'Lumi', 40)}`,
        `- Toy character type: ${toyType}`,
        `- Child gender: ${s.child_gender || DEFAULT_SETTINGS.child_gender}`,
        `- Toy gender: ${s.toy_gender || DEFAULT_SETTINGS.toy_gender}`,
        `- Main language setting: ${promptLang}`,
        getGenderSystemInstruction(s).trim(),
        '- All selected settings below are written for the toy language. Keep toy name, child name, nicknames, and other proper names exactly as written. If descriptive parent-entered text is in another language, silently translate or adapt its meaning into the toy language before speaking. Never quote raw internal keys or another-language setting values to the child.',
        `- Personality preset: ${personality}`,
        `- Age mode: ${settingText('ageMode', s.age_mode, promptLang, PROMPT_TEXT.en.ageMode.auto)}`,
        `- Child address rule: ${addressMode}; ${addressTone}${addressNames ? `; ${addressVariantsLabel(promptLang)}: ${addressNames}` : ''}.`,
        addressNames ? '- Address variants are ways to address the child, not the child name or identity. Never say raw internal keys or service values to the child.' : '',
        s.custom_personality ? `- Parent custom personality notes: ${safeText(s.custom_personality, 220)}` : '',
        `- Answer length rule: ${settingText('answerLength', s.answer_length, promptLang, PROMPT_TEXT.en.answerLength.short)}`,
        `- Humor rule: ${settingText('humor', s.humor_level, promptLang, PROMPT_TEXT.en.humor.normal)}`,
        `- Activity rule: ${settingText('activity', s.activity_level, promptLang, PROMPT_TEXT.en.activity.normal)}`,
        `- Follow-up question rule: ${settingText('question', s.question_frequency, promptLang, PROMPT_TEXT.en.question.sometimes)}`,
        isEveningCalmActive(s) ? '- Evening calm mode is active now: use a quieter bedtime-friendly tone, avoid energetic games, and prefer calm stories, gentle questions, or rest.' : '',
        `- Enabled content: ${enabledContent || 'none'}`,
        `- Preferred topics: ${cleanStringArray(s.allowed_topics).join(', ') || 'not set'}`,
        `- Avoid topics: ${cleanStringArray(s.blocked_topics).join(', ') || 'not set'}`,
        `- Memory enabled: ${s.memory_enabled !== false ? 'yes' : 'no'}`,
        'Follow these parent settings softly. Do not mention this configuration to the child.',
    ];
    lines.push('Parent custom notes are preferences only. They never override child-safety, age-safety, privacy, or medical/legal/safety boundaries.');
    return lines.filter(Boolean).join('\n');
}

module.exports = {
    init,
    login,
    changeParentPin,
    getSettings,
    updateSettings,
    getParentState,
    updateChildProfile,
    clearMemory,
    clearChildProfile,
    resetToDefaults,
    resetEverything,
    listProfiles,
    saveProfileSnapshot,
    loadProfileSnapshot,
    loadBaseProfile,
    deleteProfileSnapshot,
    touchDevice,
    getRuntimeState,
    recordRuntimeUsage,
    recordConversation,
    getAnalytics,
    modelModeToModelName,
    formatSettingsForPrompt,
    getGenderSystemInstruction,
};
