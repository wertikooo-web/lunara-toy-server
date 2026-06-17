'use strict';

const content = require('./content');

const STORY_TYPES = [
    'story_template',
    'fairytale_template',
    'lore_character',
    'lore_place',
    'lore_object',
    'helper',
    'goal',
    'problem',
    'reward',
    'emotion',
    'word_animal',
    'word_place',
    'word_action',
    'word_object',
    'character_trait',
    'world_rule',
];

function isStoryRequest(text) {
    const value = String(text || '')
        .toLocaleLowerCase('ru-RU')
        .replace(/ё/g, 'е')
        .trim();

    const hasStoryWord = (
        value.includes('сказк') ||
        value.includes('истори') ||
        value.includes('рассказ') ||
        value.includes('приключени')
    );
    if (!hasStoryWord) return false;

    if (/(почему|зачем|что ты|что это|какую|какая|классно|нравится|понравилось|не надо|не хочу|хватит|стоп)/i.test(value)) {
        return false;
    }

    return (
        /(расскажи|придумай|сочини|начни|давай|хочу|можно|почитай|рассказывать)/i.test(value) ||
        /^(сказку|сказка|историю|история|рассказ|приключение)$/i.test(value)
    );
}

function buildStoryFollowupContext(userText) {
    const value = String(userText || '').trim();
    if (!value) return '';

    return [
        'PREVIOUS_STORY_CONTEXT:',
        'Предыдущий ответ Lumi был сказкой или историей.',
        'Сейчас ребёнок, скорее всего, реагирует на неё, задаёт вопрос или перебивает.',
        'Не начинай новую сказку и не продолжай сюжет, если ребёнок явно не просит "расскажи/продолжи сказку".',
        'Если ребёнок просит продолжить, продолжи прежнюю историю по памяти диалога, не начинай новую.',
        'Если ребёнок говорит, что понравилось, коротко порадуйся и предложи выбрать: продолжить, новую загадку, игру или поговорить.',
        'Если ребёнок спрашивает "почему ты рассказываешь сказку", мягко объясни: "ты попросил сказку, и я начала; можем остановиться".',
    ].join('\n');
}

function trimForPrompt(value, maxLength = 260) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength).trim()}...`;
}

function itemLine(item) {
    if (!item) return '';
    const title = trimForPrompt(item.title, 80);
    const text = trimForPrompt(item.text);
    if (!text) return '';
    if (title && title !== text) return `${title}: ${text}`;
    return text;
}

function compact(items, max = 5) {
    return (items || [])
        .map(itemLine)
        .filter(Boolean)
        .slice(0, max);
}

async function buildStoryContext(userText) {
    if (!isStoryRequest(userText)) return null;

    const picked = {};
    await Promise.all(STORY_TYPES.map(async (type) => {
        const limit = type.endsWith('_template') ? 1 : 2;
        picked[type] = await content.pickItems(type, limit);
    }));

    const lines = [
        'STORY_ENGINE_CONTEXT:',
        'Собери короткую детскую историю Lumi из выбранных элементов ниже.',
        'Не перечисляй элементы и не говори, что используешь базу данных.',
        'Не раскрывай ответ заранее, если история похожа на загадку.',
        'Стиль: добрый, безопасный, мягкий, с ясным хорошим финалом.',
        'Длина: 4-5 коротких предложений. Примерно 55-85 слов.',
        'Последнее предложение обязательно завершает историю. Не заканчивай вопросом.',
        'Мир Lumi: нет настоящего зла; есть трудность, помощь, маленькое чудо и добрый финал.',
        '',
    ];

    const sections = [
        ['Шаблон истории', compact(picked.story_template, 1)],
        ['Шаблон сказки', compact(picked.fairytale_template, 1)],
        ['Герои/lore', compact([...(picked.lore_character || []), ...(picked.helper || [])], 3)],
        ['Места', compact([...(picked.lore_place || []), ...(picked.word_place || [])], 3)],
        ['Предметы', compact([...(picked.lore_object || []), ...(picked.word_object || [])], 3)],
        ['Цели', compact(picked.goal, 2)],
        ['Проблемы', compact(picked.problem, 2)],
        ['Эмоции', compact(picked.emotion, 2)],
        ['Награды/финалы', compact(picked.reward, 2)],
        ['Действия', compact(picked.word_action, 2)],
        ['Животные', compact(picked.word_animal, 2)],
        ['Черты персонажей', compact(picked.character_trait, 2)],
        ['Правила мира', compact(picked.world_rule, 1)],
    ];

    for (const [label, values] of sections) {
        if (!values.length) continue;
        lines.push(`${label}:`);
        for (const value of values) lines.push(`- ${value}`);
        lines.push('');
    }

    return {
        type: 'story',
        contentContext: lines.join('\n').trim(),
        prompt: [
            'Ребёнок попросил:',
            String(userText || '').trim(),
            '',
            'Ответь как Lumi. Сразу расскажи историю, без вступления. 4-5 коротких предложений. Заверши историю полностью.',
        ].join('\n'),
        maxTokens: 230,
    };
}

module.exports = {
    isStoryRequest,
    buildStoryFollowupContext,
    buildStoryContext,
};
