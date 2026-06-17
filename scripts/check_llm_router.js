'use strict';

const assert = require('assert');
const router = require('../modules/llmRouter');

assert.strictEqual(router.normalizeModelName('gpt'), 'gpt');
assert.strictEqual(router.normalizeModelName('GPT-4o-mini'), 'gpt');
assert.strictEqual(router.normalizeModelName('deepseek'), 'deepseek');
assert.strictEqual(router.normalizeModelName('auto'), 'auto');
assert.strictEqual(router.normalizeModelName('unknown'), 'gpt');

assert.strictEqual(router.getModelProvider('gpt').provider, 'openai');
assert.strictEqual(router.getModelProvider('deepseek').provider, 'deepseek');

assert.strictEqual(
    router.routeAutoModel({ text: 'загадай загадку про мишку' }).provider,
    'deepseek'
);
assert.strictEqual(
    router.routeAutoModel({ text: 'мне страшно и грустно' }).provider,
    'openai'
);
assert.strictEqual(
    router.routeAutoModel({ text: 'tell me a story about the moon' }).provider,
    'deepseek'
);
assert.strictEqual(
    router.routeAutoModel({ text: 'меня обидели в школе' }).provider,
    'openai'
);
assert.strictEqual(
    router.routeAutoModel({
        text: 'загадай загадку про мишку',
        memoryContext: 'Память о ребенке: любит динозавров',
    }).provider,
    'deepseek'
);
assert.strictEqual(
    router.routeAutoModel({ text: 'помнишь, что я люблю пиццу?' }).provider,
    'openai'
);
assert.strictEqual(router.looksUnfinished('\u041e\u0439, \u044d\u0442\u043e \u0436\u0435 \u043b\u0435\u0433\u043a\u043e! \u0414\u0432\u0430 \u043f\u043b\u044e\u0441 \u0434\u0432\u0430 - \u0447\u0435\u0442\u044b\u0440\u0435.'), false);
assert.strictEqual(router.looksUnfinished('\u041a\u0430\u043a \u0447\u0435\u0442\u044b\u0440\u0435 \u043c\u043e\u0438 \u043c\u044f\u0433\u043a\u0438\u0435 \u043b\u0430\u043f\u043a\u0438, \u043a\u043e\u0442\u043e\u0440\u044b\u043c\u0438'), true);
assert.strictEqual(router.looksUnfinished('\u042f \u0445\u043e\u0442\u0435\u043b \u0441\u043a\u0430\u0437\u0430\u0442\u044c, \u0447\u0442\u043e'), true);
assert.strictEqual(router.looksUnfinished('\u0413\u043e\u0442\u043e\u0432\u043e', 'length'), true);

console.log('llm router checks ok');
