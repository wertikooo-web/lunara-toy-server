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
    console.log('[ContentPackPreload] joke request pattern injected into content.js');
};
