'use strict';

// Одноразовая миграция: до перехода на Named Assets Pattern (tts.js: getAssetPath/
// synthesizeAsset) thinking-фразы жили под именами thinking_<intent>_<n>_ru.pcm/.wav.
// Новая схема — thinking_<variant>_<lang>_<gender>.pcm/.wav (variant = <intent>_<n>).
// Старые файлы озвучены только на русском/female — переносим их в новые слоты,
// чтобы не жечь TTS-квоту повторно на все 72 фразы.
//
// Запуск: node scripts/migrate-thinking-assets.js [--dry-run]

const fs = require('fs');
const path = require('path');
const tts = require('../modules/tts');

const DIR_AUDIO = process.env.AUDIO_DIR ? path.resolve(process.env.AUDIO_DIR) : path.join(__dirname, '..', 'audio');
const SERVER_JS_PATH = path.join(__dirname, '..', 'server.js');
const DRY_RUN = process.argv.includes('--dry-run');

function extractOldFileKeys() {
    const source = fs.readFileSync(SERVER_JS_PATH, 'utf8');
    const matches = source.match(/file:\s*'thinking_[a-z0-9_]+'/g) || [];
    const keys = matches.map((m) => m.match(/'([^']+)'/)[1]);
    return Array.from(new Set(keys));
}

function oldVariantFromFileKey(fileKey) {
    // 'thinking_story_1_ru' -> 'story_1' — та же логика, что в server.js/thinkingAudioCommand.
    return fileKey.replace(/^thinking_/, '').replace(/_ru$/, '');
}

function migrateOne(fileKey) {
    const variant = oldVariantFromFileKey(fileKey);
    const oldPcm = path.join(DIR_AUDIO, `${fileKey}.pcm`);
    const oldWav = path.join(DIR_AUDIO, `${fileKey}.wav`);
    const newPcm = tts.getAssetPath('thinking', 'ru-RU', 'female', variant);
    const newWav = newPcm.replace(/\.pcm$/, '.wav');

    const result = { fileKey, variant, moved: [], skipped: [] };

    for (const [oldPath, newPath] of [[oldPcm, newPcm], [oldWav, newWav]]) {
        if (!fs.existsSync(oldPath)) {
            result.skipped.push(path.basename(oldPath) + ' (source missing)');
            continue;
        }
        if (fs.existsSync(newPath)) {
            result.skipped.push(path.basename(oldPath) + ' (target already exists)');
            continue;
        }
        if (DRY_RUN) {
            result.moved.push(`${path.basename(oldPath)} -> ${path.basename(newPath)} [dry-run]`);
            continue;
        }
        fs.mkdirSync(path.dirname(newPath), { recursive: true });
        fs.renameSync(oldPath, newPath);
        result.moved.push(`${path.basename(oldPath)} -> ${path.basename(newPath)}`);
    }

    return result;
}

function main() {
    const fileKeys = extractOldFileKeys();
    console.log(`[Migrate] found ${fileKeys.length} thinking phrase key(s) in server.js${DRY_RUN ? ' (dry-run)' : ''}`);

    let totalMoved = 0;
    let totalSkipped = 0;

    for (const fileKey of fileKeys) {
        const result = migrateOne(fileKey);
        totalMoved += result.moved.length;
        totalSkipped += result.skipped.length;
        for (const line of result.moved) console.log(`  [OK]   ${line}`);
        for (const line of result.skipped) console.log(`  [skip] ${line}`);
    }

    console.log(`[Migrate] done: moved=${totalMoved} skipped=${totalSkipped}`);
}

main();
