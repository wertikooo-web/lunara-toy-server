'use strict';

const assert = require('assert');
const guard = require('../modules/audioInputGuardPreload');

assert.strictEqual(guard.isTooShortPcm(4096), true, '4096 bytes should be too short');
assert.strictEqual(guard.isTooShortPcm(5999), true, '5999 bytes should be too short by default');
assert.strictEqual(guard.isTooShortPcm(6000), false, '6000 bytes should pass default minimum');
assert.strictEqual(guard.isTooShortPcm(8000), false, '8000 bytes should pass for short affirmative replies');
assert.strictEqual(guard.isTooShortPcm(12000), false, '12000 bytes should pass for short affirmative replies');

assert.strictEqual(guard.isSuspiciousForeignTranscript('you'), true, 'single English hallucination should be blocked');
assert.strictEqual(guard.isSuspiciousForeignTranscript('Thank you.'), true, 'common Whisper filler should be blocked');
assert.strictEqual(guard.isSuspiciousForeignTranscript('O que me interessa é isso.'), true, 'Portuguese hallucination should be blocked');
assert.strictEqual(guard.isSuspiciousForeignTranscript('C\'était Abidjan.'), true, 'French hallucination should be blocked');
assert.strictEqual(guard.isSuspiciousForeignTranscript('Я люблю пиццу'), false, 'Russian transcript should not be blocked');

console.log('[Smoke] audio input guard ok');
