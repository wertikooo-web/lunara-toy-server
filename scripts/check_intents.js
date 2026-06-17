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
    ['tell me a riddle', 'riddle'],
    ['say a tongue twister', 'tongue_twister'],
    ['let us play a game', 'mini_game'],
    ['spune o ghicitoare', 'riddle'],
    ['spune o framantare de limba', 'tongue_twister'],
    ['hai sa jucam un joc', 'mini_game'],
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
    'play a riddle game',
    'vreau joc si ghicitoare',
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

const pendingEn = {
    type: 'riddle',
    id: 'test_en',
    title: 'test',
    text: 'Riddle. What shines in the sky?',
    lang: 'en-US',
    answers: ['star', 'stars'],
};

const pendingRo = {
    type: 'riddle',
    id: 'test_ro',
    title: 'test',
    text: 'Ghicitoare. Ce straluceste pe cer?',
    lang: 'ro-RO',
    answers: ['stele', 'stelele'],
};

eq(content.checkPendingAnswer(pending, 'ботинки').correct, true, 'pending correct answer');
eq(content.checkPendingAnswer(pending, 'горилла').correct, false, 'pending wrong answer');
ok(content.checkPendingAnswer(pending, 'не знаю').reply, 'pending hint');
eq(content.checkPendingAnswer(pending, 'повтори загадку').keepPending, true, 'pending repeat');
eq(content.checkPendingAnswer(pending, 'стоп').clearPending, true, 'pending stop');
eq(content.checkPendingAnswer(pending, 'ещё одну').nextRiddle, true, 'pending next riddle');
eq(content.checkPendingAnswer(pendingEn, 'stars').correct, true, 'pending english correct answer');
ok(content.checkPendingAnswer(pendingEn, 'banana').reply.includes('answer'), 'pending english wrong answer');
eq(content.checkPendingAnswer(pendingRo, 'stele').correct, true, 'pending romanian correct answer');
ok(/Raspunsul|Era|raspunsul/.test(content.checkPendingAnswer(pendingRo, 'banana').reply), 'pending romanian wrong answer');
eq(content.checkPendingAnswer(pendingEn, 'another one').nextRiddle, true, 'pending english next riddle');
eq(content.checkPendingAnswer(pendingRo, 'alta').nextRiddle, true, 'pending romanian next riddle');

(async () => {
    for (let i = 0; i < 20; i += 1) {
        const story = await storyEngine.buildStoryContext('расскажи историю про луну');
        ok(story, 'story context exists');
        ok(story.contentContext.length <= 7000, `story context too long: ${story.contentContext.length}`);
        ok(story.prompt.includes('4-5 коротких предложений'), 'story prompt length rule missing');
        eq(story.maxTokens, 230, 'story max tokens');
    }
    console.log('intent checks ok');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
