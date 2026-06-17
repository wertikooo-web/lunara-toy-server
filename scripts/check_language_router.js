'use strict';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test';

const assert = require('assert');
const tts = require('../modules/tts');

assert.strictEqual(tts.normalizeExplicitLang('ru-RU'), 'ru');
assert.strictEqual(tts.normalizeExplicitLang('ro-RO'), 'ro');
assert.strictEqual(tts.normalizeExplicitLang('en-US'), 'en');
assert.strictEqual(tts.normalizeExplicitLang('auto'), null);
assert.strictEqual(tts.normalizeExplicitLang(null), null);

assert.strictEqual(tts.detectLang('Привет, я Луми.'), 'ru');
assert.strictEqual(tts.detectLang('Bună, eu sunt Lumi.'), 'ro');
assert.strictEqual(tts.detectLang('Hello, I am Lumi.'), 'en');

console.log('language router checks ok');
