'use strict';

const fs = require('fs');
const path = require('path');
const content = require('./content');
const logger = require('./logger');
const voiceUx = require('./voiceUxPhrases');

const ROOT = path.resolve(__dirname, '..');
const PACKS_DIR = path.join(ROOT, 'data', 'content-packs');
const MANIFEST_PATH = path.join(PACKS_DIR, 'manifest.json');

const MATCHERS = [
    {
        title: 'Колобок',
        aliases: [
            'колобок', 'колобка', 'колобку', 'колобке', 'колобком', 'колобк',
            'прошелка', 'прошёлка', 'про шелка', 'про шёлка', 'сказка прошелка',
            'круглый хлеб', 'круглый пирожок', 'пирожок сбежал', 'пирожок убежал'
        ],
        clues: ['испек', 'испеч', 'спек', 'печь', 'истек', 'мука', 'тесто', 'подоконник', 'окошко', 'убежал', 'сбежал', 'укатился', 'покатился', 'бабушка', 'дедушка', 'лиса'],
        minClues: 2,
    },
    {
        title: 'Рыбака и рыбку',
        aliases: [
            'сказка о рыбаке и рыбке', 'сказка про рыбака и рыбку', 'рыбак и рыбка',
            'сказку о рыбаке и рыбке', 'сказку про рыбака и рыбку',
            'рыбака и рыбку', 'золотая рыбка', 'золотую рыбку', 'старик и рыбка',
            'старуха и рыбка', 'синее море', 'разбитое корыто'
        ],
        clues: ['рыбак', 'рыбка', 'золотая', 'старик', 'старуха', 'корыто', 'море', 'желание'],
        minClues: 2,
    },
    {
        title: 'Репка',
        aliases: ['репка', 'репку', 'репке', 'репы', 'большая репка'],
        clues: ['репка', 'тянут', 'тянули', 'вытянуть', 'огород', 'дедка', 'бабка', 'внучка', 'жучка', 'мышка'],
        minClues: 2,
    },
    {
        title: 'Теремок',
        aliases: ['теремок', 'теремка', 'теремке', 'домик в поле'],
        clues: ['теремок', 'домик', 'мышка', 'лягушка', 'квакушка', 'зайчик', 'лисичка', 'волк', 'медведь'],
        minClues: 2,
    },
    {
        title: 'Красная Шапочка',
        aliases: ['красная шапочка', 'красную шапочку', 'девочка в красной шапочке'],
        clues: ['красная', 'шапочка', 'девочка', 'бабушка', 'волк', 'пирожки', 'лес'],
        minClues: 2,
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

function has(text, phrase) {
    const t = normalize(text);
    const p = normalize(phrase);
    if (!t || !p) return false;
    return t.includes(p);
}

function isStoryRequest(text) {
    return /(сказк|истори|рассказ|колоб|прошелк|прошёлк|рыбак|рыбк|золот.*рыбк|репк|теремок|красн.*шапочк)/iu.test(normalize(text));
}

function matcherForRequest(text) {
    const t = normalize(text);
    if (!t) return null;

    for (const matcher of MATCHERS) {
        if ((matcher.aliases || []).some((alias) => has(t, alias))) return matcher;
        const clueHits = (matcher.clues || []).filter((clue) => has(t, clue)).length;
        if (clueHits >= (matcher.minClues || 2)) return matcher;
    }

    return null;
}

function itemMatchesTitle(item, matcher) {
    const identity = normalize([
        item.id || '',
        item.title || '',
        Array.isArray(item.tags) ? item.tags.join(' ') : '',
        item.metadata?.author || '',
    ].join(' '));

    if (has(identity, matcher.title)) return true;
    return (matcher.aliases || []).some((alias) => has(identity, alias));
}

function getStoryPackFiles() {
    try {
        const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
        return (manifest.packs || [])
            .filter((pack) => pack?.active !== false && pack?.type === 'story' && pack?.file)
            .map((pack) => pack.file);
    } catch (err) {
        logger.warn(`[ClassicStoryGuard] failed to read manifest: ${err.message}`);
        return [];
    }
}

function loadStories() {
    const loaded = [];
    for (const file of getStoryPackFiles()) {
        try {
            const pack = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, file), 'utf8'));
            const items = Array.isArray(pack.items) ? pack.items : [];
            for (const item of items) {
                if (item?.type === 'story' && item.text) {
                    loaded.push({ ...item, source_pack_file: file });
                }
            }
        } catch (err) {
            logger.warn(`[ClassicStoryGuard] failed to load ${file}: ${err.message}`);
        }
    }
    storyItems = loaded;
    logger.info(`[ClassicStoryGuard] loaded ${storyItems.length} story item(s) for exact classic matching`);
}

const originalTryHandleShortRequest = typeof content.tryHandleShortRequest === 'function'
    ? content.tryHandleShortRequest.bind(content)
    : null;

content.tryHandleShortRequest = async function classicStoryGuardTryHandleShortRequest(text, options = {}) {
    if (!isStoryRequest(text)) {
        return originalTryHandleShortRequest ? originalTryHandleShortRequest(text, options) : null;
    }

    const matcher = matcherForRequest(text);
    if (!matcher) {
        return originalTryHandleShortRequest ? originalTryHandleShortRequest(text, options) : null;
    }

    const item = storyItems.find((candidate) => itemMatchesTitle(candidate, matcher));
    if (!item) {
        logger.warn(`[ClassicStoryGuard] matcher title="${matcher.title}" but story item not found`);
        return originalTryHandleShortRequest ? originalTryHandleShortRequest(text, options) : null;
    }

    const baseUrl = options.baseUrl;
    if (!baseUrl) throw new Error('classicStoryGuardPatch requires baseUrl');

    logger.info(`[ClassicStoryGuard] exact story matched request="${String(text || '').slice(0, 120)}" title="${item.title || ''}" id=${item.id || ''}`);

    const chosenIntro = voiceUx.getRandomStoryIntro(item.title || 'story');
    const fullSpeechText = `${chosenIntro}\n\n${item.text}`;

    const audio = await content.ensureCachedReply(fullSpeechText, {
        baseUrl,
        lang: item.lang || 'ru-RU',
        key: `story_exact_${item.id || 'item'}_v4_slanted`,
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
logger.info('[ClassicStoryGuard] exact classic story matching enabled');
