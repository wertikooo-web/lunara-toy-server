'use strict';

const assert = require('assert');
const stt = require('../modules/stt');

assert.strictEqual(stt.sanitizeShortRussianTranscript('Yes.', { language: 'ru-RU' }), 'да');
assert.strictEqual(stt.sanitizeShortRussianTranscript('yeah', { language: 'ru-RU' }), 'да');
assert.strictEqual(stt.sanitizeShortRussianTranscript('OK', { language: 'ru-RU' }), 'окей');
assert.strictEqual(stt.sanitizeShortRussianTranscript('No.', { language: 'ru-RU' }), 'no');
assert.strictEqual(stt.sanitizeShortRussianTranscript('you', { language: 'ru-RU' }), '');
assert.strictEqual(stt.sanitizeShortRussianTranscript('Thank you.', { language: 'ru-RU' }), '');
assert.strictEqual(stt.sanitizeShortRussianTranscript('да', { language: 'ru-RU' }), 'да');
assert.strictEqual(stt.sanitizeShortRussianTranscript('окей', { language: 'ru-RU' }), 'да');
assert.strictEqual(stt.sanitizeShortRussianTranscript('No.', { language: 'en-US' }), 'No');

console.log('[Smoke] stt short phrase sanitizer ok');
