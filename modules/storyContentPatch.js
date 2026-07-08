'use strict';

const fs = require('fs');
const path = require('path');
const content = require('./content');
const logger = require('./logger');

const ROOT = path.resolve(__dirname, '..');
const STORY_PACK_PATH = path.join(ROOT, 'data', 'content-packs', 'stories_ru_v1.json');

const TOPIC_GROUPS = {
    animals: [
        'животные', 'звери', 'зверята', 'кот', 'котик', 'котенок', 'котёнок', 'кошка', 'собака', 'щенок', 'щеночек',
        'зайчик', 'заяц', 'медведь', 'медвежонок', 'лиса', 'лисичка', 'ежик', 'ёжик', 'белка', 'белочка',
        'мышонок', 'волк', 'волчонок', 'пингвин', 'дельфин', 'рыбка', 'сова', 'совенок', 'совёнок', 'хомяк',
        'лягушонок', 'бобр', 'олень', 'олененок', 'оленёнок', 'птица', 'птичка', 'цыпленок', 'цыплёнок'
    ],
    space: [
        'космос', 'звезда', 'звездочка', 'звёздочка', 'луна', 'солнце', 'планета', 'марс', 'венера', 'сатурн',
        'комета', 'космонавт', 'звездопад', 'звёздопад', 'млечный путь'
    ],
    sleep: [
        'сон', 'спать', 'засыпать', 'на ночь', 'ночь', 'подушка', 'одеяло', 'ночник', 'кроватка', 'колыбельная'
    ],
    transport: [
        'транспорт', 'машина', 'машинка', 'автобус', 'поезд', 'электричка', 'трамвай', 'самокат', 'велосипед',
        'кораблик', 'корабль', 'трактор', 'вертолет', 'вертолёт', 'мусоровоз', 'навигатор', 'карта', 'санки', 'ракета'
    ],
    food: [
        'еда', 'фрукты', 'овощи', 'яблоко', 'морковка', 'клубника', 'каша', 'чай', 'мед', 'мёд', 'банан', 'сыр',
        'помидор', 'огурчик', 'лимон', 'хлеб', 'черника', 'картошка', 'йогурт', 'малина', 'тыква', 'редис', 'виноград',
        'дыня', 'груша', 'суп', 'котлета', 'орех', 'мандарин'
    ],
    habits: [
        'привычки', 'режим', 'зубы', 'зубная', 'мыть руки', 'мыло', 'ручки', 'убирать', 'игрушки', 'тапочки',
        'шкаф', 'будильник', 'мочалка', 'веник', 'одежда', 'куртка'
    ],
    micro_world: [
        'микромир', 'муравей', 'пчелка', 'пчёлка', 'паучок', 'божья коровка', 'светлячок', 'микроб', 'кузнечик',
        'улитка', 'гусеница', 'шмель', 'жук'
    ],
    school: [
        'школа', 'школьные', 'карандаш', 'тетрадка', 'линейка', 'пенал', 'цифры', 'урок', 'ластик', 'точилка',
        'ручка', 'циркуль', 'альбом', 'краски', 'рюкзак'
    ],
    professions: [
        'профессии', 'доктор', 'врач', 'пожарный', 'строитель', 'повар', 'спасатель', 'парикмахер', 'механик',
        'мастерок', 'кисточка', 'стетоскоп', 'градусник', 'шланг'
    ],
    nature: [
        'природа', 'облако', 'ручей', 'ручеек', 'ручеёк', 'дождик', 'дождь', 'ветер', 'ветерок', 'одуванчик',
        'снег', 'снеговик', 'дерево', 'листопад', 'океан', 'море', 'волна', 'вулкан', 'гейзер', 'роса', 'сосулька',
        'подснежник', 'коралл'
    ],
};

let storyItems = [];

function normalize(value) {
    return String(value || '')
        .toLocaleLowerCase('ru-RU')
        .replace(/ё/g, 'е')
        .replace(/[^\p{L}0-9\s-]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function hasNeedle(haystack, needle) {
    const cleanNeedle = normalize(needle);
    if (!cleanNeedle) return false;
    return normalize(haystack).includes(cleanNeedle);
}

function loadStories() {
    try {
        const pack = JSON.parse(fs.readFileSync(STORY_PACK_PATH, 'utf8'));
        storyItems = Array.isArray(pack.items) ? pack.items.filter((item) => item?.type === 'story' && item.text) : [];
        logger.info(`[StoryContentPatch] loaded ${storyItems.length} prepared story item(s)`);
    } catch (err) {
        storyItems = [];
        logger.warn(`[StoryContentPatch] failed to load stories pack: ${err.message}`);
    }
}

function isStoryRequest(text) {
    const t = normalize(text);
    if (!t) return false;
    return /(сказк|истори|рассказ|на ночь|story|povest)/iu.test(t);
}

function extractTopic(text) {
    const t = normalize(text);
    if (!t) return '';

    if (/(на ночь|перед сном|спать|сонн)/iu.test(t)) return 'сон';

    const patterns = [
        /(?:про|о|об)\s+(.+)$/iu,
        /(?:сказк|истори|рассказ)\s+(?:про|о|об)?\s*(.+)$/iu,
    ];

    for (const pattern of patterns) {
        const match = t.match(pattern);
        const topic = normalize(match?.[1])
            .replace(/^(сказк[ауи]?|истори[юя]?|рассказ|коротк[а-я]*|добру[а-я]*|маленьк[а-я]*)\s+/iu, '')
            .trim();
        if (topic && !/^(сказк|истори|рассказ)$/iu.test(topic)) return topic;
    }

    return '';
}

function topicGroups(topicOrText) {
    const value = normalize(topicOrText);
    const groups = [];

    for (const [group, words] of Object.entries(TOPIC_GROUPS)) {
        if (words.some((word) => hasNeedle(value, word))) {
            groups.push(group);
        }
    }

    return groups;
}

function storySearchText(item) {
    return [
        item.title || '',
        item.text || '',
        Array.isArray(item.tags) ? item.tags.join(' ') : '',
        item.metadata?.block || '',
    ].join(' ');
}

function scoreStory(item, topic, groups) {
    const hay = storySearchText(item);
    let score = 0;

    if (topic) {
        if (hasNeedle(item.title || '', topic)) score += 10;
        if (hasNeedle(item.metadata?.block || '', topic)) score += 7;
        if (hasNeedle(Array.isArray(item.tags) ? item.tags.join(' ') : '', topic)) score += 5;
        if (hasNeedle(item.text || '', topic)) score += 3;
    }

    for (const group of groups) {
        if (Array.isArray(item.tags) && item.tags.includes(group)) score += 6;
        if (hasNeedle(item.metadata?.block || '', group)) score += 4;
        for (const word of TOPIC_GROUPS[group] || []) {
            if (hasNeedle(item.title || '', word)) score += 4;
            else if (hasNeedle(hay, word)) score += 1;
        }
    }

    return score;
}

function pickRandom(items) {
    if (!Array.isArray(items) || items.length === 0) return null;
    return items[Math.floor(Math.random() * items.length)] || null;
}

function pickPreparedStory(text) {
    if (storyItems.length === 0) return null;

    const topic = extractTopic(text);
    const groups = topicGroups(`${topic} ${text}`);

    if (!topic && groups.length === 0) {
        return pickRandom(storyItems);
    }

    const scored = storyItems
        .map((item) => ({ item, score: scoreStory(item, topic, groups) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return null;

    const bestScore = scored[0].score;
    const best = scored.filter((entry) => entry.score >= Math.max(1, bestScore - 2)).slice(0, 12);
    return pickRandom(best.map((entry) => entry.item));
}

const originalClassifyRequest = typeof content.classifyRequest === 'function'
    ? content.classifyRequest.bind(content)
    : null;

const originalTryHandleShortRequest = typeof content.tryHandleShortRequest === 'function'
    ? content.tryHandleShortRequest.bind(content)
    : null;

content.classifyRequest = function patchedStoryClassifyRequest(text) {
    if (isStoryRequest(text)) return 'story';
    return originalClassifyRequest ? originalClassifyRequest(text) : null;
};

content.tryHandleShortRequest = async function patchedStoryTryHandleShortRequest(text, options = {}) {
    if (!isStoryRequest(text)) {
        return originalTryHandleShortRequest ? originalTryHandleShortRequest(text, options) : null;
    }

    const item = pickPreparedStory(text);
    if (!item) {
        return null;
    }

    const baseUrl = options.baseUrl;
    if (!baseUrl) throw new Error('storyContentPatch requires baseUrl');

    const audio = await content.ensureCachedReply(item.text, {
        baseUrl,
        lang: item.lang || 'ru-RU',
        key: `story_${item.id || 'item'}`,
        title: item.title || 'story',
    });

    return {
        item,
        reply: item.text,
        audioUrl: audio.audioUrl,
        durationMs: audio.durationMs,
        cached: audio.cached,
        lang: item.lang || 'ru-RU',
    };
};

loadStories();
logger.info('[StoryContentPatch] prepared story intents enabled');
