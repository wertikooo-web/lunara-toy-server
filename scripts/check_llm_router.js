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

console.log('llm router checks ok');
