'use strict';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test';

const assert = require('assert');
const content = require('../modules/content');
const storyEngine = require('../modules/storyEngine');

function eq(actual, expected, label) {
    assert.strictEqual(actual, expected, `${label}: expected ${expected}, got ${actual}`);
}

function ok(value, label) {
    assert.ok(value, label);
}

function no(value, label) {
    assert.ok(!value, label);
}

const classifierCases = [
    ['загадай загадку', 'riddle'],
    ['еще одну загадку', 'riddle'],
    ['ещё одну загадку', 'riddle'],
    ['скажи скороговорку', 'tongue_twister'],
    ['давай поиграем', 'mini_game'],
    ['моя игрушка кошка', null],
    ['нельзя игрушка', null],
    ['я видел загадку в книжке', null],
    ['скороговорка сложная', null],
];

for (const [text, expected] of classifierCases) {
    eq(content.classifyRequest(text), expected, `classify "${text}"`);
}

const clarifyCases = [
    'давай поиграем загадку',
    'давай это будет игра в загадки',
    'давай я скороговоркой произнесу загадку',
    'хочу игру и скороговорку',
];

for (const text of clarifyCases) {
    ok(content.getClarification(text), `clarify "${text}"`);
}

for (const text of ['загадай загадку', 'скажи скороговорку', 'давай поиграем', 'кошка это игрушка']) {
    no(content.getClarification(text), `no clarify "${text}"`);
}

const storyCases = [
    ['расскажи сказку', true],
    ['придумай историю', true],
    ['классно мне нравится', false],
    ['почему ты мне эту сказку рассказываешь', false],
    ['не надо сказку', false],
    ['продолжи сказку', false],
];

for (const [text, expected] of storyCases) {
    eq(storyEngine.isStoryRequest(text), expected, `story "${text}"`);
}

const pending = {
    type: 'riddle',
    id: 'test',
    title: 'test',
    text: 'Загадка. Их всегда двое. Что это?',
    answers: ['ботинки', 'обувь'],
};

eq(content.checkPendingAnswer(pending, 'ботинки').correct, true, 'pending correct answer');
eq(content.checkPendingAnswer(pending, 'горилла').correct, false, 'pending wrong answer');
ok(content.checkPendingAnswer(pending, 'не знаю').reply, 'pending hint');
eq(content.checkPendingAnswer(pending, 'повтори загадку').keepPending, true, 'pending repeat');
eq(content.checkPendingAnswer(pending, 'стоп').clearPending, true, 'pending stop');
eq(content.checkPendingAnswer(pending, 'ещё одну').nextRiddle, true, 'pending next riddle');

console.log('intent checks ok');
