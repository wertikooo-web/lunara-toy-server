'use strict';

const assert = require('assert');
const router = require('../modules/llmRouter');

const RU_RIDDLE = '\u0437\u0430\u0433\u0430\u0434\u0430\u0439 \u0437\u0430\u0433\u0430\u0434\u043a\u0443 \u043f\u0440\u043e \u043c\u0438\u0448\u043a\u0443';
const RU_SAD = '\u043c\u043d\u0435 \u0441\u0442\u0440\u0430\u0448\u043d\u043e \u0438 \u0433\u0440\u0443\u0441\u0442\u043d\u043e';
const RU_SCHOOL = '\u043c\u0435\u043d\u044f \u043e\u0431\u0438\u0434\u0435\u043b\u0438 \u0432 \u0448\u043a\u043e\u043b\u0435';
const RU_MEMORY = '\u043f\u043e\u043c\u043d\u0438\u0448\u044c, \u0447\u0442\u043e \u044f \u043b\u044e\u0431\u043b\u044e \u043f\u0438\u0446\u0446\u0443?';
const RU_MATH = '\u0441\u043a\u043e\u043b\u044c\u043a\u043e \u0431\u0443\u0434\u0435\u0442 \u0434\u0432\u0430 \u043f\u043b\u044e\u0441 \u0434\u0432\u0430';

assert.strictEqual(router.normalizeModelName('gpt'), 'gpt');
assert.strictEqual(router.normalizeModelName('GPT-4o-mini'), 'gpt');
assert.strictEqual(router.normalizeModelName('deepseek'), 'deepseek');
assert.strictEqual(router.normalizeModelName('auto'), 'auto');
assert.strictEqual(router.normalizeModelName('unknown'), 'gpt');

assert.strictEqual(router.getModelProvider('gpt').provider, 'openai');
assert.strictEqual(router.getModelProvider('deepseek').provider, 'deepseek');

assert.strictEqual(router.routeAutoModel({ text: RU_RIDDLE }).provider, 'deepseek');
assert.strictEqual(router.routeAutoModel({ text: RU_SAD }).provider, 'openai');
assert.strictEqual(router.routeAutoModel({ text: 'tell me a story about the moon' }).provider, 'deepseek');
assert.strictEqual(router.routeAutoModel({ text: RU_MATH }).provider, 'deepseek');
assert.strictEqual(router.routeAutoModel({ text: RU_SCHOOL }).provider, 'openai');
assert.strictEqual(router.routeAutoModel({
    text: RU_RIDDLE,
    memoryContext: '\u041f\u0430\u043c\u044f\u0442\u044c \u043e \u0440\u0435\u0431\u0435\u043d\u043a\u0435: \u043b\u044e\u0431\u0438\u0442 \u0434\u0438\u043d\u043e\u0437\u0430\u0432\u0440\u043e\u0432',
}).provider, 'deepseek');
assert.strictEqual(router.routeAutoModel({ text: RU_MEMORY }).provider, 'openai');

assert.strictEqual(router.looksUnfinished('\u041e\u0439, \u044d\u0442\u043e \u0436\u0435 \u043b\u0435\u0433\u043a\u043e! \u0414\u0432\u0430 \u043f\u043b\u044e\u0441 \u0434\u0432\u0430 - \u0447\u0435\u0442\u044b\u0440\u0435.'), false);
assert.strictEqual(router.looksUnfinished('\u041a\u0430\u043a \u0447\u0435\u0442\u044b\u0440\u0435 \u043c\u043e\u0438 \u043c\u044f\u0433\u043a\u0438\u0435 \u043b\u0430\u043f\u043a\u0438, \u043a\u043e\u0442\u043e\u0440\u044b\u043c\u0438'), true);
assert.strictEqual(router.looksUnfinished('\u042f \u0445\u043e\u0442\u0435\u043b \u0441\u043a\u0430\u0437\u0430\u0442\u044c, \u0447\u0442\u043e'), true);
assert.strictEqual(router.looksUnfinished('\u0413\u043e\u0442\u043e\u0432\u043e', 'length'), true);

console.log('llm router checks ok');
