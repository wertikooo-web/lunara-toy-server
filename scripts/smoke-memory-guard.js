'use strict';

const assert = require('assert');
const guard = require('../modules/memoryGuard');

function expectBlocked(text, reasonIncludes) {
    const result = guard.shouldRememberUserText(text);
    assert.strictEqual(result.allow, false, `${text} should be blocked`);
    if (reasonIncludes) {
        assert.ok(result.reason.includes(reasonIncludes), `${text} reason should include ${reasonIncludes}, got ${result.reason}`);
    }
}

function expectAllowed(text) {
    const result = guard.shouldRememberUserText(text);
    assert.strictEqual(result.allow, true, `${text} should be allowed, got ${result.reason}`);
}

expectBlocked('А на Боку-ка реку царство и лёжа на Боку', 'garbage');
expectBlocked('Thank you.', 'filler');
expectBlocked('Это звучит очень забавно', 'no_explicit');
expectBlocked('моя школа номер 5', 'sensitive');
expectAllowed('Я люблю пиццу');
expectAllowed('Мой любимый цвет красный');
expectAllowed('Меня зовут Максим');
expectAllowed('Запомни, моего кота зовут Барсик');

const filtered = guard.filterUnsafeActions({
    set: { favorite_food: 'пицца', best_friend: 'школа номер 5' },
    add: { current_interests: ['динозавры', 'Thank you'] },
    remove: {},
});
assert.strictEqual(filtered.actions.set.favorite_food, 'пицца');
assert.strictEqual(filtered.actions.set.best_friend, undefined);
assert.deepStrictEqual(filtered.actions.add.current_interests, ['динозавры']);
assert.ok(filtered.removed >= 2);

console.log('[Smoke] memory guard ok');
