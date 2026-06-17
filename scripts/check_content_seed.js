'use strict';

const assert = require('assert');
const seed = require('../data/content_seed.json');

const KNOWN_TYPES = new Set([
    'riddle',
    'tongue_twister',
    'mini_game',
    'reaction',
    'riddle_template',
    'story_template',
    'fairytale_template',
    'word_animal',
    'word_place',
    'word_action',
    'word_object',
    'helper',
    'goal',
    'problem',
    'reward',
    'emotion',
    'lore_character',
    'lore_place',
    'lore_object',
    'character_trait',
    'child_archetype',
    'dialog_template',
    'memory_fact',
    'content_tag',
    'generation_prompt',
    'content_pipeline',
    'system_rule',
    'memory_rule',
    'lumi_mode',
    'schema_rule',
    'world_rule',
]);

const SHORT_TYPES = new Set(['riddle', 'tongue_twister', 'mini_game', 'reaction']);
const items = Array.isArray(seed.items) ? seed.items : [];

const ids = new Set();
for (const item of items) {
    assert.ok(item.id && typeof item.id === 'string', 'content item without id');
    assert.ok(!ids.has(item.id), `duplicate content id: ${item.id}`);
    ids.add(item.id);

    assert.ok(KNOWN_TYPES.has(item.type), `unknown content type: ${item.type} (${item.id})`);
    assert.ok(String(item.text || '').trim(), `empty text: ${item.id}`);

    if (SHORT_TYPES.has(item.type)) {
        assert.ok(String(item.text).length <= 500, `short content too long: ${item.id}`);
    }

    if (item.type === 'riddle') {
        assert.ok(Array.isArray(item.answers) && item.answers.length > 0, `riddle without answers: ${item.id}`);
    }
}

console.log(`content seed checks ok (${items.length} items)`);
