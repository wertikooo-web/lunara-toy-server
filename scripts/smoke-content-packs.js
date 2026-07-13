'use strict';

const assert = require('assert');
const path = require('path');
const loader = require('../modules/contentPackLoader');

const result = loader.loadContentItems({ rootDir: path.resolve(__dirname, '..') });

assert.strictEqual(result.manifestFound, true, 'content-packs manifest should exist');
assert.ok(result.loadedPacks.length >= 5, 'should load manifest packs and legacy packs');

const byType = result.items.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
}, {});

assert.ok(byType.riddle >= 100, 'should load converted riddle pack');
assert.ok(byType.tongue_twister >= 150, 'should load 150 tongue twisters');
assert.ok(byType.joke >= 150, 'should load 150 jokes');
assert.ok(byType.fact >= 5, 'should load facts');
assert.ok(byType.mini_game >= 5, 'should load mini games');

function findByType(type) {
    return result.items.find((item) => item.type === type && String(item.text || '').trim());
}

function assertValidSource(item, type) {
    assert.ok(item, `${type} sample should exist`);
    assert.ok(['db_export', 'content_pack_generated', 'content_pack', 'legacy_pack', 'legacy_riddles_ru_json'].includes(item.source), `${type} sample has unexpected source ${item.source}`);
    assert.ok(item.metadata?.pack_id, `${type} sample should include metadata.pack_id`);
    assert.ok(item.metadata?.pack_version, `${type} sample should include metadata.pack_version`);
}

const sampleRiddle = findByType('riddle');
assertValidSource(sampleRiddle, 'riddle');
assert.ok(Array.isArray(sampleRiddle.answers) && sampleRiddle.answers.length > 0, 'riddle sample should have answers');

assertValidSource(findByType('joke'), 'joke');
assertValidSource(findByType('tongue_twister'), 'tongue_twister');
assertValidSource(findByType('fact'), 'fact');
assertValidSource(findByType('mini_game'), 'mini_game');

console.log('[Smoke] content packs ok', JSON.stringify({ count: result.items.length, byType }));
