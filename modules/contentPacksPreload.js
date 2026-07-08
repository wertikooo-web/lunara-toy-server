'use strict';

const fs = require('fs');
const path = require('path');

const originalReadFileSync = fs.readFileSync;
const contentPath = path.resolve(__dirname, 'content.js');

function replaceOnce(source, from, to, label) {
    if (!source.includes(from)) {
        throw new Error(`[ContentPacksPreload] missing patch point: ${label}`);
    }
    return source.replace(from, to);
}

function patchContentSource(source) {
    let patched = source;

    patched = replaceOnce(
        patched,
        "const tts = require('./tts');\n",
        "const tts = require('./tts');\nconst contentPackLoader = require('./contentPackLoaderV2');\n",
        'require contentPackLoaderV2'
    );

    patched = replaceOnce(
        patched,
        "const SEED_ITEMS = [\n    ...BUILTIN_SHORT_ITEMS,\n    ...MULTILINGUAL_SHORT_ITEMS,\n    ...(Array.isArray(docSeed.items) ? docSeed.items : []),\n];",
        "const contentPackSeed = contentPackLoader.loadContentItems({ rootDir: path.resolve(__dirname, '..') });\nconst SEED_ITEMS = [\n    ...BUILTIN_SHORT_ITEMS,\n    ...MULTILINGUAL_SHORT_ITEMS,\n    ...contentPackSeed.items,\n];\nif (contentPackSeed.loadedPacks.length > 0) {\n    const totalPackItems = contentPackSeed.loadedPacks.reduce((sum, pack) => sum + (pack.count || 0), 0);\n    logger.info(`[ContentPacks] loaded ${contentPackSeed.loadedPacks.length} pack source(s), ${totalPackItems} item(s)`);\n}",
        'SEED_ITEMS content pack merge'
    );

    patched = replaceOnce(
        patched,
        "    {\n        type: 'speech_development',\n        re: /(?:развитие\\s+речи|упражнен.{0,20}реч|поиграем.{0,20}(?:в\\s+слова|со\\s+словами)|(?:рифм|слог|букв|звук).{0,30}(?:игр|упраж|повтор)|speech\\s+development|speech\\s+game|rhyme|syllable|letter\\s+game|dezvoltarea\\s+vorbirii|joc.{0,20}(?:cuvinte|rime|silabe)|sunet.{0,20}silab)/iu,\n    },",
        "    {\n        type: 'speech_development',\n        re: /(?:развитие\\s+речи|упражнен.{0,20}реч|поиграем.{0,20}(?:в\\s+слова|со\\s+словами)|(?:рифм|слог|букв|звук).{0,30}(?:игр|упраж|повтор)|speech\\s+development|speech\\s+game|rhyme|syllable|letter\\s+game|dezvoltarea\\s+vorbirii|joc.{0,20}(?:cuvinte|rime|silabe)|sunet.{0,20}silab)/iu,\n    },\n    {\n        type: 'joke',\n        re: /(?:шутк|анекдот|пошути|рассмеши|joke|funny|gluma|glumă)/iu,\n    },\n    {\n        type: 'fact',\n        re: /(?:факт|интересн|расскажи что-нибудь|fact|interesting|fapt|interesant)/iu,\n    },",
        'joke and fact request patterns'
    );

    return patched;
}

fs.readFileSync = function patchedReadFileSync(filePath, options) {
    const data = originalReadFileSync.apply(this, arguments);
    if (path.resolve(String(filePath)) !== contentPath) return data;

    const encoding = typeof options === 'string' ? options : options?.encoding;
    if (encoding && String(encoding).toLowerCase() !== 'utf8' && String(encoding).toLowerCase() !== 'utf-8') {
        return data;
    }

    const source = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    const patched = patchContentSource(source);
    console.log('[ContentPacksPreload] content packs injected into content.js');
    return Buffer.isBuffer(data) ? Buffer.from(patched, 'utf8') : patched;
};
