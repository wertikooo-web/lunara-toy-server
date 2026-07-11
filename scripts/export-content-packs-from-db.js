'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'content-packs');
const DATABASE_URL = process.env.DATABASE_URL;
const PGSSL = process.env.PGSSL === 'true';

const TARGET_PACKS = [
    {
        file: 'riddles_ru_v1.json',
        pack_id: 'riddles_ru_v1',
        type: 'riddle',
        dbTypes: ['riddle'],
    },
    {
        file: 'tongue_twisters_ru_v1.json',
        pack_id: 'tongue_twisters_ru_v1',
        type: 'tongue_twister',
        dbTypes: ['tongue_twister'],
    },
    {
        file: 'jokes_ru_v1.json',
        pack_id: 'jokes_ru_v1',
        type: 'joke',
        dbTypes: ['joke'],
    },
    {
        file: 'facts_ru_v1.json',
        pack_id: 'facts_ru_v1',
        type: 'fact',
        dbTypes: ['fact'],
    },
    {
        file: 'games_ru_v1.json',
        pack_id: 'games_ru_v1',
        type: 'mini_game',
        dbTypes: ['mini_game'],
    },
];

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function parseJsonish(value, fallback) {
    if (Array.isArray(value) || (value && typeof value === 'object')) return value;
    if (typeof value !== 'string') return fallback;
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

function normalizeLang(lang) {
    const value = String(lang || 'ru-RU');
    if (value.startsWith('ru')) return 'ru-RU';
    if (value.startsWith('ro')) return 'ro-RO';
    if (value.startsWith('en')) return 'en-US';
    return value || 'ru-RU';
}

function cleanSpokenText(text, type) {
    let value = String(text || '').trim();

    if (type === 'joke') {
        value = value.replace(/^\s*(?:шутка|анекдот|joke)(?:\s*№?\s*\d+)?\s*[.:—–-]\s*/iu, '');
    }

    if (type === 'fact') {
        value = value.replace(/^\s*(?:факт|интересный\s+факт|fact|interesting\s+fact)(?:\s*№?\s*\d+)?\s*[.:—–-]\s*/iu, '');
    }

    return value.trim();
}

function normalizeItem(row, pack) {
    const answers = parseJsonish(row.answers, []);
    const tags = parseJsonish(row.tags, []);
    const metadata = parseJsonish(row.metadata, {});
    return {
        id: row.id,
        type: pack.type,
        title: row.title || '',
        text: cleanSpokenText(row.text, pack.type),
        lang: normalizeLang(row.lang),
        answers: Array.isArray(answers) ? answers : [],
        tags: Array.isArray(tags) ? tags : [],
        metadata: {
            ...metadata,
            migrated_from_db_type: row.type,
            migrated_from_db_source: row.source || '',
            pack_id: pack.pack_id,
            pack_version: 'v1',
        },
        source: 'db_export',
    };
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function exportPack(pool, pack) {
    const result = await pool.query(
        `SELECT id, type, title, text, lang, answers, tags, metadata, source
         FROM content_items
         WHERE enabled = true
           AND type = ANY($1::text[])
           AND COALESCE(text, '') <> ''
         ORDER BY id`,
        [pack.dbTypes]
    );

    const items = result.rows.map((row) => normalizeItem(row, pack));
    const payload = {
        pack_id: pack.pack_id,
        type: pack.type,
        lang: 'ru-RU',
        pack_version: 'v1',
        source: 'db_export',
        items,
    };

    writeJson(path.join(OUT_DIR, pack.file), payload);
    return { file: pack.file, count: items.length };
}

async function exportLegacyArchive(pool) {
    const result = await pool.query(
        `SELECT id, type, title, text, lang, answers, tags, metadata, source
         FROM content_items
         WHERE enabled = true
           AND COALESCE(text, '') <> ''
         ORDER BY type, id`
    );

    const legacyDir = path.join(OUT_DIR, 'legacy');
    ensureDir(legacyDir);

    const byType = new Map();
    for (const row of result.rows) {
        if (!byType.has(row.type)) byType.set(row.type, []);
        byType.get(row.type).push(row);
    }

    const summary = [];
    for (const [type, rows] of byType.entries()) {
        const file = `${type.replace(/[^a-zA-Z0-9_-]+/g, '_')}_ru_v1.json`;
        const payload = {
            pack_id: `${type}_ru_v1`,
            type,
            lang: 'ru-RU',
            pack_version: 'v1',
            source: 'db_export_legacy_archive',
            items: rows.map((row) => ({
                id: row.id,
                type: row.type,
                title: row.title || '',
                text: cleanSpokenText(row.text, row.type),
                lang: normalizeLang(row.lang),
                answers: parseJsonish(row.answers, []),
                tags: parseJsonish(row.tags, []),
                metadata: {
                    ...parseJsonish(row.metadata, {}),
                    migrated_from_db_source: row.source || '',
                    pack_id: `${type}_ru_v1`,
                    pack_version: 'v1',
                },
                source: 'db_export_legacy_archive',
            })),
        };
        writeJson(path.join(legacyDir, file), payload);
        summary.push({ file: `legacy/${file}`, type, count: rows.length });
    }

    return summary;
}

async function main() {
    if (!DATABASE_URL) {
        throw new Error('DATABASE_URL is required to export content packs from Postgres');
    }

    ensureDir(OUT_DIR);
    const pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: PGSSL ? { rejectUnauthorized: false } : undefined,
    });

    try {
        const packs = [];
        for (const pack of TARGET_PACKS) {
            packs.push(await exportPack(pool, pack));
        }

        const legacy = process.argv.includes('--legacy-all') ? await exportLegacyArchive(pool) : [];
        // stdout должен содержать ТОЛЬКО чистый однострочный JSON — человекочитаемый
        // маркер и остальные логи идут в stderr, чтобы не портить машинный вывод, если
        // кто-то когда-нибудь начнёт парсить stdout этого скрипта.
        console.error('[ExportContentPacks] done');
        console.log(JSON.stringify({ packs, legacy }));
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error('[ExportContentPacks] failed:', err.message);
    process.exit(1);
});
