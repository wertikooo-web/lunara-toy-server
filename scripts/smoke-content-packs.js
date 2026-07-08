'use strict';

const assert = require('assert');
const path = require('path');
const loader = require('../modules/contentPackLoader');

const result = loader.loadContentItems({ rootDir: path.resolve(__dirname, '..') });

assert.strictEqual(result.manifestFound, true, 'content-packs manifest should exist');
assert.ok(result.loadedPacks.length >= 5, 'should load manifest packs and legacy packs');
assert.ok(result.items.length >= 25, 'should load starter content pack items');

const byType = result.items.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
}, {});

assert.ok(byType.riddle >= 5, 'should load riddles');
assert.ok(byType.tongue_twister >= 5, 'should load tongue twisters');
assert.ok(byType.joke >= 5, 'should load jokes');
assert.ok(byType.fact >= 5, 'should load facts');
assert.ok(byType.mini_game >= 5, 'should load mini games');

const sample = result.items.find((item) => item.id === 'fact_ru_v1_001');
assert.ok(sample, 'fact_ru_v1_001 should exist');
assert.strictEqual(sample.metadata.pack_id, 'facts_ru_v1');
assert.strictEqual(sample.metadata.pack_version, 'v1');
assert.strictEqual(sample.source, 'content_pack');

console.log('[Smoke] content packs ok', JSON.stringify({ count: result.items.length, byType }));
