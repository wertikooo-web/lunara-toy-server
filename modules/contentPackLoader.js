'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MANIFEST_PATH = 'data/content-packs/manifest.json';
const LEGACY_SEED_PATH = 'data/content_seed.json';

function sha(value) {
    return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 10);
}

function safeIdPart(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 70) || 'item';
}

function readJsonIfExists(filePath, fallback = null) {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
}

function normalizeLang(lang, fallback = 'ru-RU') {
    const value = String(lang || fallback).trim();
    if (value.startsWith('ru')) return 'ru-RU';
    if (value.startsWith('ro')) return 'ro-RO';
    if (value.startsWith('en')) return 'en-US';
    return fallback;
}

function inferTypeFromPackId(packId, fallback = 'content') {
    const value = String(packId || '').toLowerCase();
    if (value.includes('riddle')) return 'riddle';
    if (value.includes('tongue_twister')) return 'tongue_twister';
    if (value.includes('joke')) return 'joke';
    if (value.includes('fact')) return 'fact';
    if (value.includes('mini_game') || value.includes('game')) return 'mini_game';
    if (value.includes('thinking_phrase')) return 'thinking_phrase';
    return fallback;
}

function inferLangFromPackId(packId, fallback = 'ru-RU') {
    const value = String(packId || '').toLowerCase();
    if (/_ro(?:_|$)/.test(value)) return 'ro-RO';
    if (/_en(?:_|$)/.test(value)) return 'en-US';
    if (/_ru(?:_|$)/.test(value)) return 'ru-RU';
    return fallback;
}

function normalizeItem(rawItem, context = {}) {
    if (!rawItem) return null;

    const type = rawItem.type || context.type || inferTypeFromPackId(context.packId, 'content');
    const lang = normalizeLang(rawItem.lang || context.lang || inferLangFromPackId(context.packId));
    const text = String(rawItem.text || rawItem.prompt || rawItem.content || '').trim();
    if (!text) return null;

    const packId = String(context.packId || rawItem.pack_id || 'content_pack_v1');
    const source = rawItem.source || context.source || 'content_pack';
    const index = Number.isInteger(context.index) ? context.index + 1 : 1;
    const id = String(rawItem.id || `${safeIdPart(packId)}_${String(index).padStart(3, '0')}_${sha(text)}`).slice(0, 180);

    const metadata = {
        ...(rawItem.metadata || {}),
        pack_id: packId,
        pack_version: rawItem.pack_version || context.packVersion || packId,
    };
    if (rawItem.topic) metadata.topic = rawItem.topic;
    if (rawItem.difficulty) metadata.difficulty = rawItem.difficulty;
    if (rawItem.age_min !== undefined) metadata.age_min = rawItem.age_min;
    if (rawItem.age_max !== undefined) metadata.age_max = rawItem.age_max;

    return {
        id,
        type,
        title: String(rawItem.title || rawItem.name || `${type} ${index}`).trim().slice(0, 180),
        text,
        lang,
        answers: Array.isArray(rawItem.answers) ? rawItem.answers.map((answer) => String(answer || '').trim()).filter(Boolean) : [],
        tags: Array.isArray(rawItem.tags) ? rawItem.tags.map((tag) => String(tag || '').trim()).filter(Boolean) : [],
        metadata,
        source,
    };
}

function normalizeStringPackEntry(text, context = {}) {
    const type = context.type || inferTypeFromPackId(context.packId, 'content');
    const packId = String(context.packId || `${type}_pack_v1`);
    const lang = normalizeLang(context.lang || inferLangFromPackId(packId));
    const index = Number.isInteger(context.index) ? context.index + 1 : 1;
    const clean = String(text || '').trim();
    if (!clean) return null;

    const prefixByType = {
        tongue_twister: 'Скороговорка. ',
        joke: 'Шутка. ',
        fact: 'Факт. ',
        mini_game: 'Игра. ',
    };

    return normalizeItem({
        id: `${safeIdPart(packId)}_${String(index).padStart(3, '0')}_${sha(clean)}`,
        type,
        title: `${type} ${index}`,
        text: type === 'riddle' || clean.startsWith(prefixByType[type] || '__no_prefix__') ? clean : `${prefixByType[type] || ''}${clean}`,
        lang,
        tags: ['content_pack', safeIdPart(type), safeIdPart(lang)],
        metadata: {
            generated_from_string_entry: true,
        },
        source: context.source || 'content_pack',
    }, context);
}

function normalizePackObject(packObject, context = {}) {
    const packId = String(packObject?.pack_id || context.packId || context.file || 'content_pack_v1');
    const type = packObject?.type || context.type || inferTypeFromPackId(packId, 'content');
    const lang = normalizeLang(packObject?.lang || context.lang || inferLangFromPackId(packId));
    const packVersion = packObject?.pack_version || context.packVersion || packId;
    const source = packObject?.source || context.source || 'content_pack';
    const rawItems = Array.isArray(packObject?.items) ? packObject.items : Array.isArray(packObject?.entries) ? packObject.entries : [];

    return rawItems.map((item, index) => {
        const itemContext = { packId, type, lang, packVersion, source, index };
        if (typeof item === 'string') return normalizeStringPackEntry(item, itemContext);
        return normalizeItem(item, itemContext);
    }).filter(Boolean);
}

function loadManifestPacks(rootDir) {
    const manifestPath = path.join(rootDir, DEFAULT_MANIFEST_PATH);
    const manifest = readJsonIfExists(manifestPath, null);
    if (!manifest) return { items: [], loadedPacks: [], manifestFound: false };

    const entries = Array.isArray(manifest.packs) ? manifest.packs : [];
    const items = [];
    const loadedPacks = [];

    for (const entry of entries) {
        if (!entry || entry.active === false) continue;
        const file = String(entry.file || '').trim();
        if (!file) continue;
        const packPath = path.join(path.dirname(manifestPath), file);
        const packObject = readJsonIfExists(packPath, null);
        if (!packObject) continue;
        const packItems = normalizePackObject(packObject, {
            packId: entry.pack_id || packObject.pack_id || file.replace(/\.json$/i, ''),
            type: entry.type || packObject.type,
            lang: entry.lang || packObject.lang,
            packVersion: entry.pack_version || packObject.pack_version,
            source: entry.source || packObject.source || 'content_pack',
            file,
        });
        items.push(...packItems);
        loadedPacks.push({ file, count: packItems.length });
    }

    return { items, loadedPacks, manifestFound: true };
}

function loadLegacySeed(rootDir) {
    const seedPath = path.join(rootDir, LEGACY_SEED_PATH);
    const seed = readJsonIfExists(seedPath, { items: [] });
    const items = [];
    const loadedPacks = [];

    if (Array.isArray(seed.items)) {
        const normalized = seed.items.map((item, index) => normalizeItem(item, {
            packId: 'legacy_items',
            source: item?.source || 'legacy_seed',
            index,
        })).filter(Boolean);
        items.push(...normalized);
        if (normalized.length) loadedPacks.push({ file: LEGACY_SEED_PATH, count: normalized.length, mode: 'items' });
    }

    if (seed.packs && typeof seed.packs === 'object') {
        for (const [packId, entries] of Object.entries(seed.packs)) {
            const packItems = normalizePackObject({
                pack_id: packId,
                type: inferTypeFromPackId(packId, 'content'),
                lang: inferLangFromPackId(packId),
                entries: Array.isArray(entries) ? entries : [],
                source: 'legacy_pack',
            });
            items.push(...packItems);
            if (packItems.length) loadedPacks.push({ file: `${LEGACY_SEED_PATH}:${packId}`, count: packItems.length, mode: 'packs' });
        }
    }

    return { items, loadedPacks };
}

function dedupeItems(items) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
        if (!item?.id || seen.has(item.id)) continue;
        seen.add(item.id);
        result.push(item);
    }
    return result;
}

function loadContentItems(options = {}) {
    const rootDir = options.rootDir || path.resolve(__dirname, '..');
    const manifestResult = loadManifestPacks(rootDir);
    const legacyResult = loadLegacySeed(rootDir);
    const items = dedupeItems([
        ...manifestResult.items,
        ...legacyResult.items,
    ]);

    return {
        items,
        manifestFound: manifestResult.manifestFound,
        loadedPacks: [
            ...manifestResult.loadedPacks,
            ...legacyResult.loadedPacks,
        ],
    };
}

module.exports = {
    loadContentItems,
    normalizeItem,
    normalizeStringPackEntry,
    normalizePackObject,
    inferTypeFromPackId,
    inferLangFromPackId,
};
