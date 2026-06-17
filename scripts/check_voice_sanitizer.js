'use strict';

const assert = require('assert');
const { sanitizeVoiceReply } = require('../modules/voiceSanitizer');

assert.strictEqual(
    sanitizeVoiceReply('"Удивлённо приподнимает уши* Ой, и правда капуста!'),
    'Ой, и правда капуста!'
);

assert.strictEqual(
    sanitizeVoiceReply('*улыбается* Правильно! Это крокодил.'),
    'Правильно! Это крокодил.'
);

assert.strictEqual(
    sanitizeVoiceReply('Реакция: "Не совсем. Ответ: крокодил."'),
    'Не совсем. Ответ: крокодил.'
);

assert.strictEqual(
    sanitizeVoiceReply('- **Ой!** Давай попробуем ещё раз.'),
    'Ой! Давай попробуем ещё раз.'
);

assert.strictEqual(
    sanitizeVoiceReply('[шёпотом] Я рядом. Всё хорошо.'),
    'Я рядом. Всё хорошо.'
);

assert.strictEqual(
    sanitizeVoiceReply('Скажи: "это заяц".'),
    'Скажи: это заяц.'
);

console.log('voice sanitizer checks ok');
