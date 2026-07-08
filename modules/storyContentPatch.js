'use strict';

const fs = require('fs');
const path = require('path');
const content = require('./content');
const logger = require('./logger');

const ROOT = path.resolve(__dirname, '..');
const PACKS_DIR = path.join(ROOT, 'data', 'content-packs');
const MANIFEST_PATH = path.join(PACKS_DIR, 'manifest.json');
const FALLBACK_STORY_PACKS = ['stories_ru_v1.json'];

const TOPIC_GROUPS = {
    animals: [
        'животные', 'звери', 'зверята', 'кот', 'котик', 'котенок', 'котёнок', 'кошка', 'собака', 'щенок', 'щеночек',
        'зайчик', 'заяц', 'медведь', 'медвежонок', 'лиса', 'лисичка', 'ежик', 'ёжик', 'белка', 'белочка',
        'мышонок', 'волк', 'волчонок', 'пингвин', 'дельфин', 'рыбка', 'сова', 'совенок', 'совёнок', 'хомяк',
        'лягушонок', 'бобр', 'олень', 'олененок', 'оленёнок', 'птица', 'птичка', 'цыпленок', 'цыплёнок',
        'козленок', 'козлёнок', 'гуси', 'лебеди', 'журавль', 'петух', 'курочка', 'утенок', 'утёнок', 'слоненок', 'слонёнок'
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
        'дыня', 'груша', 'суп', 'котлета', 'орех', 'мандарин', 'репка', 'репку', 'пирожок', 'пирожки'
    ],
    habits: [
        'привычки', 'режим', 'зубы', 'зубная', 'мыть руки', 'мыло', 'ручки', 'убирать', 'игрушки', 'тапочки',
        'шкаф', 'будильник', 'мочалка', 'веник', 'одежда', 'куртка'
    ],
    micro_world: [
        'микромир', 'муравей', 'пчелка', 'пчёлка', 'паучок', 'божья коровка', 'светлячок', 'микроб', 'кузнечик',
        'улитка', 'гусеница', 'шмель', 'жук', 'комарик'
    ],
    school: [
        'школа', 'школьные', 'карандаш', 'тетрадка', 'линейка', 'пенал', 'цифры', 'урок', 'ластик', 'точилка',
        'ручка', 'циркуль', 'альбом', 'краски', 'рюкзак'
    ],
    professions: [
        'профессии', 'доктор', 'врач', 'пожарный', 'строитель', 'повар', 'спасатель', 'парикмахер', 'механик',
        'мастерок', 'кисточка', 'стетоскоп', 'градусник', 'шланг', 'солдат', 'портной', 'дровосек'
    ],
    nature: [
        'природа', 'облако', 'ручей', 'ручеек', 'ручеёк', 'дождик', 'дождь', 'ветер', 'ветерок', 'одуванчик',
        'снег', 'снеговик', 'дерево', 'листопад', 'океан', 'море', 'волна', 'вулкан', 'гейзер', 'роса', 'сосулька',
        'подснежник', 'коралл', 'лес', 'река'
    ],
    classic_story: [
        'колобок', 'колобка', 'репка', 'репку', 'теремок', 'машенька', 'маша', 'морозко', 'снегурочка',
        'красная шапочка', 'золушка', 'рапунцель', 'белоснежка', 'дюймовочка', 'пиноккио', 'маугли', 'питер пен',
        'алиса', 'кот в сапогах', 'бременские музыканты', 'три медведя', 'гуси-лебеди', 'гуси лебеди', 'царевна лягушка',
        'по щучьему велению', 'аленький цветочек', 'серебряное копытце', 'гадкий утенок', 'гадкий утёнок'
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

function stemWord(value) {
    return normalize(value)
        .replace(/(ами|ями|ого|ему|ыми|ими|ая|яя|ое|ее|ые|ие|ую|юю|ом|ем|ой|ей|ах|ях|ам|ям|ов|ев|а|я|у|ю|ы|и|е|о)$/iu, '')
        .trim();
}

function approxHasNeedle(haystack, needle) {
    const normalizedHay = normalize(haystack);
    const normalizedNeedle = normalize(needle);
    if (!normalizedNeedle) return false;
    if (normalizedHay.includes(normalizedNeedle)) return true;

    const hayWords = normalizedHay.split(' ').filter(Boolean);
    const needleWords = normalizedNeedle.split(' ').filter(Boolean);
    if (needleWords.length === 0) return false;

    return needleWords.every((needleWord) => {
        const needleStem = stemWord(needleWord);
        if (needleStem.length < 4) return hayWords.includes(needleWord);
        return hayWords.some((hayWord) => {
            const hayStem = stemWord(hayWord);
            return hayStem.startsWith(needleStem) || needleStem.startsWith(hayStem);
        });
    });
}

function hasNeedle(haystack, needle) {
    return approxHasNeedle(haystack, needle);
}

function getStoryPackFiles() {
    try {
        const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
        const files = (manifest.packs || [])
            .filter((pack) => pack?.active !== false && pack?.type === 'story' && pack?.file)
            .map((pack) => pack.file);
        return files.length > 0 ? files : FALLBACK_STORY_PACKS;
    } catch (err) {
        logger.warn(`[StoryContentPatch] failed to read manifest, using fallback story packs: ${err.message}`);
        return FALLBACK_STORY_PACKS;
    }
}

function loadStories() {
    const files = getStoryPackFiles();
    const loaded = [];

    for (const file of files) {
        const packPath = path.join(PACKS_DIR, file);
        try {
            const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
            const items = Array.isArray(pack.items)
                ? pack.items.filter((item) => item?.type === 'story' && item.text)
                : [];
            for (const item of items) {
                loaded.push({
                    ...item,
                    pack_id: item.pack_id || pack.pack_id || path.basename(file, '.json'),
                    source_pack_file: file,
                });
            }
            logger.info(`[StoryContentPatch] loaded ${items.length} story item(s) from ${file}`);
        } catch (err) {
            logger.warn(`[StoryContentPatch] failed to load ${file}: ${err.message}`);
        }
    }

    storyItems = loaded;
    logger.info(`[StoryContentPatch] loaded ${storyItems.length} prepared story item(s) from ${files.length} story pack(s)`);
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
        item.metadata?.author || '',
    ].join(' ');
}

function scoreStory(item, topic, groups) {
    const hay = storySearchText(item);
    let score = 0;

    if (topic) {
        if (hasNeedle(item.title || '', topic)) score += 25;
        if (hasNeedle(item.metadata?.block || '', topic)) score += 7;
        if (hasNeedle(Array.isArray(item.tags) ? item.tags.join(' ') : '', topic)) score += 6;
        if (hasNeedle(item.text || '', topic)) score += 4;
    }

    for (const group of groups) {
        if (Array.isArray(item.tags) && item.tags.includes(group)) score += 6;
        if (hasNeedle(item.metadata?.block || '', group)) score += 4;
        for (const word of TOPIC_GROUPS[group] || []) {
            if (hasNeedle(item.title || '', word)) score += 8;
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
