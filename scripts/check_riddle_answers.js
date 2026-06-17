'use strict';

const assert = require('assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';

const content = require('../modules/content');

const pending = {
    type: 'riddle',
    id: 'test_riddle',
    title: 'Test riddle',
    text: 'Who has big teeth and lives in the river?',
    lang: 'ru-RU',
    answers: ['крокодил'],
};

assert.strictEqual(content.checkPendingAnswer(pending, 'крокодил').correct, true);
assert.strictEqual(content.checkPendingAnswer(pending, 'это крокодил').correct, true);
assert.strictEqual(content.checkPendingAnswer(pending, 'крокодил!').correct, true);
assert.strictEqual(content.checkPendingAnswer(pending, 'заяц').correct, false);
assert.strictEqual(content.checkPendingAnswer(pending, 'это заяц').correct, false);
assert.strictEqual(content.checkPendingAnswer(pending, 'крок').correct, false);
assert.strictEqual(content.checkPendingAnswer(pending, 'дил').correct, false);

const multiWord = {
    ...pending,
    answers: ['белый медведь'],
};
assert.strictEqual(content.checkPendingAnswer(multiWord, 'это белый медведь').correct, true);
assert.strictEqual(content.checkPendingAnswer(multiWord, 'медведь').correct, false);

console.log('riddle answer checks ok');
