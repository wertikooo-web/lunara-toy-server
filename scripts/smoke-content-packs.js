'use strict';

const assert = require('assert');
const path = require('path');
const loader = require('../modules/contentPackLoaderV2');

const result = loader.loadContentItems({ rootDir: path.resolve(__dirname, '..') });

assert.strictEqual(result.manifestFound, true, 'content-packs manifest should exist');
assert.ok(result.loadedPacks.length >= 5, 'should load manifest packs and legacy packs');

const byType = result.items.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
}, {});

assert.ok(byType.riddle >= 150, 'should load 150 riddles');
assert.ok(byType.tongue_twister >= 150, 'should load 150 tongue twisters');
assert.ok(byType.joke >= 150, 'should load 150 jokes');
assert.ok(byType.fact >= 5, 'should load facts');
assert.ok(byType.mini_game >= 5, 'should load mini games');

const generatedRiddle = result.items.find((item) => item.id === 'riddles_ru_v1_150');
assert.ok(generatedRiddle, 'generated riddle #150 should exist');
assert.strictEqual(generatedRiddle.source, 'content_pack_generated');
assert.ok(Array.isArray(generatedRiddle.answers) && generatedRiddle.answers.length > 0, 'generated riddle should have answers');

const generatedJoke = result.items.find((item) => item.id === 'jokes_ru_v1_150');
assert.ok(generatedJoke, 'generated joke #150 should exist');
assert.strictEqual(generatedJoke.source, 'content_pack_generated');

const generatedTongueTwister = result.items.find((item) => item.id === 'tongue_twisters_ru_v1_150');
assert.ok(generatedTongueTwister, 'generated tongue twister #150 should exist');
assert.strictEqual(generatedTongueTwister.source, 'content_pack_generated');

console.log('[Smoke] content packs ok', JSON.stringify({ count: result.items.length, byType }));
