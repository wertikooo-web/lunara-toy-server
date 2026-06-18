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

const DEFAULT_SETTINGS = {
    language: 'ru-RU',
    model_mode: 'auto',
    personality_preset: 'gentle',
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
    quiet_hours_enabled: false,
    quiet_hours_start: '22:00',
    quiet_hours_end: '07:00',
    content_enabled: ['riddle', 'story', 'tongue_twister', 'mini_game', 'learning', 'roleplay'],
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
        const value = safeText(raw.personality_preset, 24);
        patch.personality_preset = PERSONALITY_PRESETS[value] ? value : DEFAULT_SETTINGS.personality_preset;
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
    if ('quiet_hours_enabled' in raw) patch.quiet_hours_enabled = raw.quiet_hours_enabled === true || raw.quiet_hours_enabled === 'true' || raw.quiet_hours_enabled === 'on';
    if ('quiet_hours_start' in raw) patch.quiet_hours_start = normalizeTime(raw.quiet_hours_start, DEFAULT_SETTINGS.quiet_hours_start);
    if ('quiet_hours_end' in raw) patch.quiet_hours_end = normalizeTime(raw.quiet_hours_end, DEFAULT_SETTINGS.quiet_hours_end);
    if ('content_enabled' in raw) {
        patch.content_enabled = cleanStringArray(raw.content_enabled, ['riddle', 'story', 'tongue_twister', 'mini_game', 'learning', 'roleplay'], 8);
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
            quiet_hours_enabled BOOLEAN NOT NULL DEFAULT false,
            quiet_hours_start TEXT NOT NULL DEFAULT '22:00',
            quiet_hours_end TEXT NOT NULL DEFAULT '07:00',
            content_enabled JSONB NOT NULL DEFAULT '["riddle","story","tongue_twister","mini_game","learning","roleplay"]'::jsonb,
            allowed_topics JSONB NOT NULL DEFAULT '["животные","космос","сказки","дружба"]'::jsonb,
            blocked_topics JSONB NOT NULL DEFAULT '[]'::jsonb,
            memory_enabled BOOLEAN NOT NULL DEFAULT true,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS custom_toy_type TEXT NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS custom_personality TEXT NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS daily_limit_minutes INTEGER NOT NULL DEFAULT 0");
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
    const dailyExceeded = limitMinutes > 0 && usedSeconds >= limitMinutes * 60;
    return {
        allowed: !quiet && !dailyExceeded,
        reason: quiet ? 'quiet_hours' : dailyExceeded ? 'daily_limit' : 'ok',
        used_minutes: usedMinutes,
        daily_limit_minutes: limitMinutes,
        remaining_minutes: limitMinutes > 0 ? Math.max(0, limitMinutes - usedMinutes) : null,
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
             answer_length = $5,
             humor_level = $6,
             activity_level = $7,
             question_frequency = $8,
             voice = $9,
             voice_speed = $10,
             story_length = $11,
             custom_toy_type = $12,
             custom_personality = $13,
             daily_limit_minutes = $14,
             quiet_hours_enabled = $15,
             quiet_hours_start = $16,
             quiet_hours_end = $17,
             content_enabled = $18::jsonb,
             allowed_topics = $19::jsonb,
             blocked_topics = $20::jsonb,
             memory_enabled = $21,
             updated_at = now()
         WHERE device_id = $1`,
        [
            id,
            DEFAULT_SETTINGS.language,
            DEFAULT_SETTINGS.model_mode,
            DEFAULT_SETTINGS.personality_preset,
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

const ANSWER_LENGTH_PROMPTS = {
    very_short: 'very short: 1-2 short sentences, with pauses, no long monologues',
    short: 'short: 2-4 short sentences, finish the thought completely',
    normal: 'normal: up to 5 short sentences, still voice-first and not lecture-like',
};

const HUMOR_PROMPTS = {
    low: 'low humor: warm and simple, almost no jokes',
    normal: 'normal humor: occasional light playful phrase',
    high: 'more humor: add gentle child-safe playfulness, but do not derail the answer',
};

const ACTIVITY_PROMPTS = {
    calm: 'calm activity: quieter, slower, suitable for bedtime or tired child',
    normal: 'normal activity: balanced, friendly, not too energetic',
    active: 'active: more energetic and game-like, but still concise',
};

const QUESTION_PROMPTS = {
    rare: 'rare follow-up questions: usually answer without asking back',
    sometimes: 'sometimes ask one small follow-up when it naturally helps',
    often: 'often invite the child with one small question or choice, but not after every sentence',
};

function formatSettingsForPrompt(settings = {}) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const personality = PERSONALITY_PRESETS[s.personality_preset] || PERSONALITY_PRESETS.gentle;
    const toyType = safeText(s.toy_type || 'bear', 40);
    const lines = [
        'PARENT CONFIG FOR THIS TOY:',
        `- Toy name: ${safeText(s.toy_name || 'Lumi', 40)}`,
        `- Toy character type: ${toyType}`,
        `- Main language setting: ${s.language}`,
        `- Personality preset: ${personality}`,
        s.custom_personality ? `- Parent custom personality notes: ${safeText(s.custom_personality, 220)}` : '',
        `- Answer length rule: ${ANSWER_LENGTH_PROMPTS[s.answer_length] || ANSWER_LENGTH_PROMPTS.short}`,
        `- Humor rule: ${HUMOR_PROMPTS[s.humor_level] || HUMOR_PROMPTS.normal}`,
        `- Activity rule: ${ACTIVITY_PROMPTS[s.activity_level] || ACTIVITY_PROMPTS.normal}`,
        `- Follow-up question rule: ${QUESTION_PROMPTS[s.question_frequency] || QUESTION_PROMPTS.sometimes}`,
        `- Enabled content: ${cleanStringArray(s.content_enabled).join(', ') || 'none'}`,
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
    deleteProfileSnapshot,
    touchDevice,
    getRuntimeState,
    recordRuntimeUsage,
    modelModeToModelName,
    formatSettingsForPrompt,
};
