'use strict';

const path = require('path');
const Module = require('module');

const originalJsLoader = Module._extensions['.js'];
const contentPath = path.resolve(__dirname, 'content.js');

function replaceOnce(source, from, to, label) {
    if (!source.includes(from)) {
        throw new Error(`[ContentPackPreload] missing patch point: ${label}`);
    }
    return source.replace(from, to);
}

function patchContentSource(source) {
    let patched = source;

    patched = replaceOnce(
        patched,
        "let docSeed = { items: [] };\ntry {\n    docSeed = require('../data/content_seed.json');\n} catch (_) {\n    docSeed = { items: [] };\n}\n",
        "let docSeed = { items: [] };\ntry {\n    docSeed = require('../data/content_seed.json');\n} catch (_) {\n    docSeed = { items: [] };\n}\n\nfunction expandSeedPacks(seed) {\n    const items = Array.isArray(seed.items) ? [...seed.items] : [];\n    const packs = seed.packs || {};\n    const addPack = (packName, type, prefix, textBuilder, tags, minAge = 'age_3_8') => {\n        const list = Array.isArray(packs[packName]) ? packs[packName] : [];\n        list.forEach((raw, index) => {\n            const text = String(raw || '').trim();\n            if (!text) return;\n            items.push({\n                id: `${prefix}_${String(index + 1).padStart(3, '0')}`,\n                type,\n                title: `${type} ${index + 1}`,\n                text: textBuilder(text),\n                lang: 'ru-RU',\n                answers: [],\n                tags: [...tags, minAge],\n                metadata: { pack: packName },\n                source: 'content_pack',\n            });\n        });\n    };\n    addPack('thinking_phrase_ru_v1', 'thinking_phrase', 'thinking_phrase_ru', (text) => text, ['thinking', 'short']);\n    addPack('jokes_ru_v1', 'joke', 'joke_ru', (text) => text.startsWith('Шутка.') ? text : `Шутка. ${text}`, ['joke', 'short']);\n    addPack('tongue_twisters_ru_v1', 'tongue_twister', 'tongue_twister_ru', (text) => `Скороговорка. ${text} Давай сначала медленно, потом быстрее.`, ['tongue_twister', 'speech', 'short'], 'age_4_8');\n    return items;\n}\n",
        'compact seed pack expander'
    );

    patched = replaceOnce(
        patched,
        "    ...(Array.isArray(docSeed.items) ? docSeed.items : []),",
        "    ...expandSeedPacks(docSeed),",
        'seed pack expansion use'
    );

    patched = replaceOnce(
        patched,
        "    {\n        type: 'speech_development',\n        re: /(?:развитие\\s+речи|упражнен.{0,20}реч|поиграем.{0,20}(?:в\\s+слова|со\\s+словами)|(?:рифм|слог|букв|звук).{0,30}(?:игр|упраж|повтор)|speech\\s+development|speech\\s+game|rhyme|syllable|letter\\s+game|dezvoltarea\\s+vorbirii|joc.{0,20}(?:cuvinte|rime|silabe)|sunet.{0,20}silab)/iu,\n    },",
        "    {\n        type: 'speech_development',\n        re: /(?:развитие\\s+речи|упражнен.{0,20}реч|поиграем.{0,20}(?:в\\s+слова|со\\s+словами)|(?:рифм|слог|букв|звук).{0,30}(?:игр|упраж|повтор)|speech\\s+development|speech\\s+game|rhyme|syllable|letter\\s+game|dezvoltarea\\s+vorbirii|joc.{0,20}(?:cuvinte|rime|silabe)|sunet.{0,20}silab)/iu,\n    },\n    {\n        type: 'joke',\n        re: /(?:расскажи|скажи|дай|хочу|давай|можно|придумай).{0,30}(?:шутк|анекдот|смешн)|(?:пошути|рассмеши)|(?:tell|say|give|want).{0,30}(?:joke|funny)|(?:spune|zi|vreau|hai).{0,35}(?:gluma|glumă|amuzant)/iu,\n    },",
        'joke request pattern'
    );

    return patched;
}

Module._extensions['.js'] = function patchedLoader(module, filename) {
    if (path.resolve(filename) !== contentPath) {
        return originalJsLoader(module, filename);
    }

    const source = require('fs').readFileSync(filename, 'utf8');
    const patched = patchContentSource(source);
    module._compile(patched, filename);
    console.log('[ContentPackPreload] content pack expansion and joke request pattern injected into content.js');
};
