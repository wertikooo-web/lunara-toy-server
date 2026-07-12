'use strict';

const fs = require('fs');
const path = require('path');
const content = require('./content');
const logger = require('./logger');
const routingSignals = require('./routingSignals');

const ROOT = path.resolve(__dirname, '..');
const PACKS_DIR = path.join(ROOT, 'data', 'content-packs');
const MANIFEST_PATH = path.join(PACKS_DIR, 'manifest.json');
const FALLBACK_STORY_PACKS = ['stories_ru_v1.json'];

const STOPWORDS = new Set([
    'сказк', 'сказка', 'сказку', 'истори', 'история', 'историю', 'рассказ', 'расскажи', 'рассказывать',
    'про', 'об', 'о', 'где', 'там', 'кто', 'кто-то', 'ктонибудь', 'кто-нибудь', 'что', 'что-то', 'чтонибудь',
    'какой', 'какая', 'какие', 'какую', 'какая-то', 'какой-то', 'какие-то', 'какую-то', 'одна', 'один', 'одно',
    'этот', 'эта', 'это', 'эту', 'тот', 'та', 'такой', 'такая', 'такое', 'такие', 'есть', 'был', 'была', 'были',
    'он', 'она', 'они', 'его', 'ее', 'её', 'ему', 'ней', 'него', 'себе', 'себя', 'мне', 'тебе', 'нам',
    'и', 'а', 'но', 'или', 'да', 'ну', 'вот', 'же', 'бы', 'ли', 'на', 'в', 'во', 'из', 'за', 'под', 'над',
    'для', 'без', 'по', 'с', 'со', 'у', 'от', 'до', 'как', 'потом', 'сначала', 'пожалуйста', 'слушай'
]);

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

const CLASSIC_STORY_MATCHERS = [
    {
        title: 'Колобок',
        aliases: ['колобок', 'колобка', 'колобку', 'колобк', 'круглый хлеб', 'круглый пирожок', 'пирожок сбежал'],
        clueGroups: [
            ['испек', 'испеч', 'спек', 'печь', 'истек', 'мука', 'тесто', 'хлеб', 'пирожок', 'булочка'],
            ['сбежал', 'убежал', 'укатился', 'покатился', 'катится', 'свалил', 'убежал от бабушки', 'убежал от дедушки'],
        ],
        bonusClues: ['подоконник', 'окошко', 'бабушка', 'дедушка', 'лиса', 'положил на подоконник'],
    },
    {
        title: 'Репка',
        aliases: ['репка', 'репку', 'репке', 'репы', 'большая репка'],
        clueGroups: [
            ['посадил', 'выросла', 'огород', 'репка', 'овощ'],
            ['тянули', 'тянут', 'вытянуть', 'тащили', 'помогали', 'всей семьей', 'вместе'],
        ],
    },
    {
        title: 'Красная Шапочка',
        aliases: ['красная шапочка', 'красную шапочку', 'девочка в красной шапочке'],
        clueGroups: [
            ['девочка', 'шапочка', 'красная', 'красной'],
            ['волк', 'бабушка', 'пирожки', 'лес'],
        ],
    },
    {
        title: 'Кот в сапогах',
        aliases: ['кот в сапогах', 'кота в сапогах', 'котик в сапогах'],
        clueGroups: [
            ['кот', 'сапоги', 'сапогах'],
            ['маркиз', 'мельник', 'людоед', 'хозяин', 'король'],
        ],
    },
    {
        title: 'Три медведя',
        aliases: ['три медведя', 'трех медведей', 'трёх медведей', 'про трех медведей', 'про трёх медведей'],
        clueGroups: [
            ['девочка', 'маша', 'машенька', 'домик', 'дом'],
            ['медведь', 'медведи', 'каша', 'стул', 'кровать'],
        ],
    },
    {
        title: 'Теремок',
        aliases: ['теремок', 'теремка', 'теремке', 'домик в поле'],
        clueGroups: [
            ['домик', 'теремок', 'поле'],
            ['мышка', 'лягушка', 'зайчик', 'лисичка', 'волк', 'медведь', 'жили вместе'],
        ],
    },
    {
        title: 'Гуси-лебеди',
        aliases: ['гуси лебеди', 'гуси-лебеди', 'гусей лебедей'],
        clueGroups: [
            ['гуси', 'лебеди', 'птицы'],
            ['унесли', 'брата', 'братца', 'баба яга', 'печка', 'яблоня', 'молочная река'],
        ],
    },
    {
        title: 'Золушка',
        aliases: ['золушка', 'золушку', 'золушке'],
        clueGroups: [
            ['туфелька', 'башмачок', 'хрустальная', 'платье', 'бал'],
            ['мачеха', 'фея', 'принц', 'тыква'],
        ],
    },
    {
        title: 'Дюймовочка',
        aliases: ['дюймовочка', 'дюймовочку', 'маленькая девочка из цветка'],
        clueGroups: [
            ['маленькая', 'крошечная', 'цветок', 'тюльпан'],
            ['жаба', 'крот', 'ласточка', 'эльф'],
        ],
    },
];

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
        .replace(/(иями|ями|ами|ого|ему|ыми|ими|ая|яя|ое|ее|ые|ие|ую|юю|ом|ем|ой|ей|ах|ях|ам|ям|ов|ев|ия|ий|ый|а|я|у|ю|ы|и|е|о)$/iu, '')
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
            if (hayStem.length < 4) return hayWord === needleWord;
            return hayStem.startsWith(needleStem) || needleStem.startsWith(hayStem);
        });
    });
}

function hasNeedle(haystack, needle) {
    return approxHasNeedle(haystack, needle);
}

function meaningfulStems(text) {
    return normalize(text)
        .split(' ')
        .map(stemWord)
        .filter((word) => word.length >= 4 && !STOPWORDS.has(word));
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

    // Negative guard: a complaint/correction/inconsistency mentioning storytelling
    // in passing ("...начинаешь про кошку рассказывать") is not a request for a
    // (possibly unrelated) prepared story — it must reach the LLM so it can
    // actually address what the child said. Confirmed production bug: this
    // exact phrasing previously matched "рассказ" (from "рассказывать") and
    // triggered an auto-selected, unrelated story instead of an apology.
    if (routingSignals.isCorrection(text) || routingSignals.isComplaintAboutUnderstanding(text) || routingSignals.isConversationInconsistency(text)) {
        return false;
    }

    return /(сказк|истори|рассказ|на ночь|story|povest)/iu.test(t);
}

function extractTopic(text) {
    const t = normalize(text);
    if (!t) return '';

    if (/(на ночь|перед сном|спать|сонн)/iu.test(t)) return 'сон';

    const patterns = [
        /(?:про|о|об)\s+(.+)$/iu,
        /(?:сказк|истори|рассказ)\s+(?:про|о|об)?\s*(.+)$/iu,
        /(?:about|despre)\s+(.+)$/iu,
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

function storyIdentityText(item) {
    return [
        item.id || '',
        item.title || '',
        Array.isArray(item.tags) ? item.tags.join(' ') : '',
    ].join(' ');
}

function matcherTargetsItem(item, matcher) {
    const identity = storyIdentityText(item);
    return [matcher.title, ...(matcher.aliases || [])].some((alias) => hasNeedle(identity, alias));
}

function requestMatchesAlias(requestText, matcher) {
    return (matcher.aliases || []).some((alias) => hasNeedle(requestText, alias));
}

function requestMatchesClues(requestText, matcher) {
    const groups = matcher.clueGroups || [];
    if (groups.length === 0) return false;

    return groups.every((group) => group.some((phrase) => hasNeedle(requestText, phrase)));
}

function classicMatcherScore(item, requestText) {
    if (!requestText) return 0;

    let score = 0;
    for (const matcher of CLASSIC_STORY_MATCHERS) {
        if (!matcherTargetsItem(item, matcher)) continue;

        if (requestMatchesAlias(requestText, matcher)) score += 120;

        if (requestMatchesClues(requestText, matcher)) {
            score += 90;
            logger.debug?.(`[StoryContentPatch] semantic story clue matched title="${matcher.title}" request="${requestText}"`);
        }

        for (const group of matcher.clueGroups || []) {
            for (const phrase of group) {
                if (hasNeedle(requestText, phrase)) score += 2;
            }
        }

        for (const phrase of matcher.bonusClues || []) {
            if (hasNeedle(requestText, phrase)) score += 4;
        }
    }

    return score;
}

function overlapScore(item, requestText) {
    const stems = Array.from(new Set(meaningfulStems(requestText)));
    if (stems.length === 0) return 0;

    const title = normalize(item.title || '');
    let score = 0;
    let matchesInTitle = 0;

    for (const stem of stems) {
        if (stem.length < 4) continue;
        // Если слово из запроса есть в названии сказки - даем ОЧЕНЬ много баллов
        if (title.includes(stem)) {
            score += 40;
            matchesInTitle++;
        }
    }

    // Если ни одно ключевое слово не попало в название - обнуляем локальный счетчик
    if (matchesInTitle === 0) return 0;

    return score;
}

function scoreStory(item, topic, groups, requestText) {
    const hay = storySearchText(item);
    let score = 0;

    // 1. Сначала проверяем точные ручные правила классики (Колобок, Репка и т.д.)
    const classicScore = classicMatcherScore(item, requestText);

    // 2. Проверяем строгий автоматический overlap по словам в названии
    const autoScore = overlapScore(item, requestText);

    // Берем максимальный балл из двух систем поиска
    score += Math.max(classicScore, autoScore);

    // 2b. Классические матчеры и RU-суффиксный стемминг рассчитаны на русский язык
    // и не сработают для en/ro паков. Даём прямое совпадение слова из названия
    // с запросом отдельным высоким приоритетом, чтобы такие сказки тоже проходили
    // порог кэша, а не всегда улетали в LLM.
    if (item.lang && item.lang !== 'ru-RU') {
        const titleWords = normalize(item.title || '').split(' ').filter((word) => word.length >= 3);
        const reqNorm = normalize(requestText);
        if (titleWords.some((word) => reqNorm.includes(word))) score += 60;
    }

    // 3. Добавляем контекстные баллы за топики и группы
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

    if (!topic && groups.length === 0 && meaningfulStems(text).length === 0) {
        return pickRandom(storyItems);
    }

    const scored = storyItems
        .map((item) => ({ item, score: scoreStory(item, topic, groups, text) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return null;

    const bestScore = scored[0].score;

    // Если точного совпадения по названию не нашли (score низкий) -
    // возвращаем null, чтобы запрос ушёл в ИИ (LLM). Никакого левого контента.
    if (bestScore < 55) {
        logger.info(`[StoryContentPatch] Best score ${bestScore} is too low. Bypassing cache to LLM.`);
        return null;
    }

    const bestWindow = bestScore >= 80 ? 0 : 2;
    const best = scored.filter((entry) => entry.score >= Math.max(1, bestScore - bestWindow)).slice(0, 12);
    const picked = pickRandom(best.map((entry) => entry.item));

    if (picked) {
        logger.info(`[StoryContentPatch] Auto-selected story id=${picked.id || ''} title="${picked.title || ''}" score=${bestScore}`);
    }

    return picked;
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

// Подключаем наш новый модуль с живыми фразами и падежами
const voiceUx = require('./voiceUxPhrases');

content.tryHandleShortRequest = async function patchedStoryTryHandleShortRequest(text, options = {}) {
    if (!isStoryRequest(text)) {
        return originalTryHandleShortRequest ? originalTryHandleShortRequest(text, options) : null;
    }

    const searchStartedAt = Date.now();
    const item = pickPreparedStory(text);
    const storySearchMs = Date.now() - searchStartedAt;
    const level = storySearchMs > 1000 ? 'error' : (storySearchMs > 300 ? 'warn' : 'info');
    logger[level](`[StoryContentPatch] story_search_ms=${storySearchMs} found=${Boolean(item)}`);

    if (!item) {
        return null;
    }

    const baseUrl = options.baseUrl;
    if (!baseUrl) throw new Error('storyContentPatch requires baseUrl');

    // 1. Берем случайное живое вступление с НАЗВАНИЕМ сказки в ПРАВИЛЬНОМ падеже
    const chosenIntro = voiceUx.getRandomStoryIntro(item.title || 'story');
    
    // 2. Склеиваем: Вступление + Перенос строки (чтобы Яндекс сделал паузу в секунду) + Текст сказки
    const fullSpeechText = `${chosenIntro}\n\n${item.text}`;

    // 3. Отправляем этот склеенный текст на озвучку
    const audio = await content.ensureCachedReply(fullSpeechText, {
        baseUrl,
        lang: item.lang || 'ru-RU',
        // Версия ключа управляется через AUDIO_CACHE_VERSION — меняя её на Railway,
        // можно принудительно сбросить весь кэш озвучки сказок без деплоя кода.
        key: `story_${item.id || 'item'}_${process.env.AUDIO_CACHE_VERSION || 'v3'}`,
        title: item.title || 'story',
    });

    return {
        item,
        reply: fullSpeechText,
        audioUrl: audio.audioUrl,
        durationMs: audio.durationMs,
        cached: audio.cached,
        lang: item.lang || 'ru-RU',
    };
};

loadStories();
logger.info('[StoryContentPatch] prepared story intents enabled');
