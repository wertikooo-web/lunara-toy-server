'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MANIFEST_PATH = 'data/content-packs/manifest.json';
const LEGACY_SEED_PATH = 'data/content_seed.json';

function sha(value) {
    return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 10);
}

function safeIdPart(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 70) || 'item';
}

function readJsonIfExists(filePath, fallback = null) {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeLang(lang, fallback = 'ru-RU') {
    const value = String(lang || fallback).trim();
    if (value.startsWith('ru')) return 'ru-RU';
    if (value.startsWith('ro')) return 'ro-RO';
    if (value.startsWith('en')) return 'en-US';
    return fallback;
}

function inferTypeFromPackId(packId, fallback = 'content') {
    const value = String(packId || '').toLowerCase();
    if (value.includes('riddle')) return 'riddle';
    if (value.includes('tongue_twister')) return 'tongue_twister';
    if (value.includes('joke')) return 'joke';
    if (value.includes('fact')) return 'fact';
    if (value.includes('mini_game') || value.includes('game')) return 'mini_game';
    if (value.includes('thinking_phrase')) return 'thinking_phrase';
    return fallback;
}

function inferLangFromPackId(packId, fallback = 'ru-RU') {
    const value = String(packId || '').toLowerCase();
    if (/_ro(?:_|$)/.test(value)) return 'ro-RO';
    if (/_en(?:_|$)/.test(value)) return 'en-US';
    if (/_ru(?:_|$)/.test(value)) return 'ru-RU';
    return fallback;
}

function normalizeItem(rawItem, context = {}) {
    if (!rawItem) return null;
    const type = rawItem.type || context.type || inferTypeFromPackId(context.packId, 'content');
    const lang = normalizeLang(rawItem.lang || context.lang || inferLangFromPackId(context.packId));
    const text = String(rawItem.text || rawItem.prompt || rawItem.content || '').trim();
    if (!text) return null;
    const packId = String(context.packId || rawItem.pack_id || 'content_pack_v1');
    const source = rawItem.source || context.source || 'content_pack';
    const index = Number.isInteger(context.index) ? context.index + 1 : 1;
    const id = String(rawItem.id || `${safeIdPart(packId)}_${String(index).padStart(3, '0')}_${sha(text)}`).slice(0, 180);
    const metadata = {
        ...(rawItem.metadata || {}),
        pack_id: packId,
        pack_version: rawItem.pack_version || context.packVersion || packId,
    };
    if (rawItem.topic) metadata.topic = rawItem.topic;
    if (rawItem.difficulty) metadata.difficulty = rawItem.difficulty;
    if (rawItem.age_min !== undefined) metadata.age_min = rawItem.age_min;
    if (rawItem.age_max !== undefined) metadata.age_max = rawItem.age_max;
    if (rawItem.generated === true) metadata.generated = true;

    return {
        id,
        type,
        title: String(rawItem.title || rawItem.name || `${type} ${index}`).trim().slice(0, 180),
        text,
        lang,
        answers: Array.isArray(rawItem.answers) ? rawItem.answers.map((answer) => String(answer || '').trim()).filter(Boolean) : [],
        tags: Array.isArray(rawItem.tags) ? rawItem.tags.map((tag) => String(tag || '').trim()).filter(Boolean) : [],
        metadata,
        source,
    };
}

function normalizeStringPackEntry(text, context = {}) {
    const type = context.type || inferTypeFromPackId(context.packId, 'content');
    const packId = String(context.packId || `${type}_pack_v1`);
    const lang = normalizeLang(context.lang || inferLangFromPackId(packId));
    const index = Number.isInteger(context.index) ? context.index + 1 : 1;
    const clean = String(text || '').trim();
    if (!clean) return null;
    const prefixByType = {
        tongue_twister: 'Скороговорка. ',
        fact: 'Факт. ',
        mini_game: 'Игра. ',
    };
    return normalizeItem({
        id: `${safeIdPart(packId)}_${String(index).padStart(3, '0')}_${sha(clean)}`,
        type,
        title: `${type} ${index}`,
        text: type === 'riddle' || clean.startsWith(prefixByType[type] || '__no_prefix__') ? clean : `${prefixByType[type] || ''}${clean}`,
        lang,
        tags: ['content_pack', safeIdPart(type), safeIdPart(lang)],
        metadata: { generated_from_string_entry: true },
        source: context.source || 'content_pack',
    }, context);
}

function buildGeneratedRiddle(index) {
    const data = [
        ['мяч', 'Круглый, прыгучий, по полу скачет, а поймаешь — снова играть захочет.'],
        ['кубик', 'У него ровные бока, можно строить башню издалека.'],
        ['ложка', 'В суп ныряет, кашу поднимает, ко рту дорожку знает.'],
        ['тарелка', 'Круглая поляна на столе, на ней обед живёт в тепле.'],
        ['чашка', 'У неё есть ушко, но она не слушает, чай и какао бережно держит.'],
        ['подушка', 'Мягкая тучка у меня в кроватке, на ней спят щёки сладко-сладко.'],
        ['одеяло', 'Ночью меня обнимает, от холода спасает.'],
        ['лампа', 'Солнце маленькое дома живёт, вечером комнату светом зальёт.'],
        ['дверь', 'Открывается и закрывается, в комнату всех пропускает.'],
        ['окно', 'В стене прозрачный глаз, улицу показывает для нас.'],
        ['карандаш', 'Деревянный носик по бумаге бежит, линии и домики рисовать спешит.'],
        ['ластик', 'Ошибки тихо съедает, листик чистым оставляет.'],
        ['рюкзак', 'На спине сидит дружок, в нём тетрадка и пирожок.'],
        ['машина', 'Колёса крутит, по дороге спешит, людей и грузы возить любит.'],
        ['самолёт', 'Не птица, а летает, людей над облаками катает.'],
        ['корабль', 'По воде большой дом плывёт, к берегу дорогу найдёт.'],
        ['снеговик', 'Из снежных шаров стоит во дворе, морковный нос на морозе в игре.'],
        ['снежинка', 'Белая звёздочка с неба летит, на ладошке тихонько таит.'],
        ['радуга', 'После дождя мост цветной в небе встаёт, пройти по нему никто не идёт.'],
        ['дождь', 'С неба капли стучат по дорожке, прячем под зонтик ладошки и ножки.'],
        ['ветер', 'Его не видно, но он шумит, листья качает и в окна свистит.'],
        ['трава', 'Зелёный ковёр у дома растёт, летом щекочет и мягко зовёт.'],
        ['яблоко', 'Круглое, сладкое, на ветке висит, в ладошку просится и хрустит.'],
        ['морковь', 'Оранжевый носик в земле сидит, зайчик её очень любит.'],
        ['банан', 'Жёлтая лодочка сладкая внутри, кожуру сними и скорее посмотри.'],
        ['молоко', 'Белое, в стакане живёт, усы над губой оставляет.'],
        ['печенье', 'Круглое, хрусткое, к чаю спешит, крошки на столе после себя оставит.'],
        ['барабан', 'Палочки по нему стучат, ноги сами танцевать хотят.'],
        ['колокольчик', 'Маленький звонкий язычок поёт: динь-динь, кто идёт?'],
        ['пазл', 'Кусочки дружат и вместе встают, картинку целую потом создают.'],
        ['пирамидка', 'Кольца по росту на палочку встали, дети её собирали.'],
        ['кукла', 'Глазки закрывает, платье надевает, в детской комнате играет.'],
        ['мишка', 'Плюшевый, мягкий, любит обниматься, с ним не страшно просыпаться.'],
        ['робот', 'Железный дружок говорит: би-бип, шагает смешно и моргает.'],
        ['фонарик', 'Маленький лучик в руке живёт, тёмный угол быстро найдёт.'],
        ['ключ', 'Маленький зубастик замок открывает, дверь в комнату пускает.'],
        ['замок', 'Без ключа молчит у двери, охраняет дом.'],
        ['мыло', 'Пузырится, пенится, руки спасает, грязь с ладошек убегать заставляет.'],
        ['зубная щётка', 'Утром и вечером танцует во рту, зубкам дарит чистоту.'],
        ['полотенце', 'После воды обнимает, капельки быстро собирает.'],
        ['носки', 'На ножках сидят, пальчики греют, в паре гулять умеют.'],
        ['шапка', 'На голове живёт зимой, ушки прячет от стужи.'],
        ['варежки', 'Две тёплые сестрички ладошки берегут, зимой гулять идут.'],
        ['велосипед', 'Два колеса и руль вперёд, кто педали крутит — тот едет.'],
        ['светофор', 'Три глаза у дороги стоят, красный, жёлтый, зелёный говорят.'],
        ['ёлка', 'Зимой нарядная стоит, огоньками вся блестит.'],
        ['подарок', 'В коробке прячется сюрприз, развяжи ленточку — улыбнись.'],
        ['зеркало', 'Молчит, но всё повторяет, лицо утром показывает.'],
        ['телефон', 'Звонит, мигает, голоса передаёт, бабушку и папу в гости зовёт.'],
        ['часы', 'Стрелки ходят круг за кругом, время показывают друг за другом.'],
    ];
    const [answer, clue] = data[index % data.length];
    return { answer, clue };
}

function buildGeneratedJoke(index) {
    const animals = ['кот', 'пёс', 'ёжик', 'заяц', 'медвежонок', 'пингвин', 'слонёнок', 'жираф', 'хомяк', 'лягушонок', 'утёнок', 'цыплёнок', 'бобёр', 'енот', 'лисёнок'];
    const objects = ['рюкзак', 'будильник', 'карандаш', 'чайник', 'ботинок', 'мяч', 'фонарик', 'зонтик', 'пылесос', 'холодильник', 'самокат', 'компас', 'носок', 'шарик', 'кубик'];
    const places = ['на кухне', 'в комнате', 'на прогулке', 'у окна', 'под столом', 'возле шкафа', 'в песочнице', 'на ковре', 'у двери', 'на балконе'];
    const a = animals[index % animals.length];
    const o = objects[(index * 3) % objects.length];
    const p = places[(index * 7) % places.length];
    const templates = [
        `Почему ${a} взял ${o}? Потому что хотел быть самым подготовленным к весёлой прогулке.`,
        `${a} спрятал ${o} ${p}. Говорит: пусть и он немного отдохнёт.`,
        `Что сказал ${o}, когда увидел ${a}? Только не щекочи меня, я и так смешной.`,
        `${a} пришёл ${p} и спросил: тут принимают смешные идеи вместо билетов?`,
        `Почему ${o} засмеялся? Потому что ${a} рассказал ему очень серьёзное ку-ку.`,
        `${a} решил стать учёным и начал изучать ${o}. Вывод был простой: смешно, но непонятно.`,
    ];
    return templates[index % templates.length];
}

function buildGeneratedTongueTwister(index) {
    const phrases = [
        'Шустрый Шурик шуршит шишками у шалаша',
        'Соня с Саней сушат сушки на солнышке',
        'Рыжий рак ронял ракушки у реки',
        'Лала ловко лепит ландыши из ленты',
        'Коля катит кубик к красной коробке',
        'Паша пёк пышные плюшки для папы',
        'Мила мыла маленькую миску мыльной мочалкой',
        'Боря бодро барабанит в большой барабан',
        'Женя жужжит жуком у жёлтой жимолости',
        'Чижик чирикал чаще, чем чайник чихал',
        'Щенок щекотал щёткой щёки щуки',
        'Цапля цокала цок-цок у цветной циновки',
        'Зоя завязала зелёный зонт за забором',
        'Галя гладит глиняного гуся у горки',
        'Тима топал тихо-так у тёплой тропинки',
    ];
    const endings = ['сначала медленно, потом быстрее', 'без спешки и без ошибки', 'утром, днём и вечером', 'под весёлую считалку', 'рядом с игрушечной машинкой'];
    return `${phrases[index % phrases.length]} ${endings[index % endings.length]}.`;
}

function generatedItemsForPack(packObject, context, existingCount) {
    const target = Math.max(0, Math.min(Number(packObject?.generate_to || 0), 300));
    if (!target || existingCount >= target) return [];
    const packId = String(packObject?.pack_id || context.packId || 'content_pack_v1');
    const type = packObject?.type || context.type || inferTypeFromPackId(packId, 'content');
    const lang = normalizeLang(packObject?.lang || context.lang || inferLangFromPackId(packId));
    const generated = [];
    for (let i = existingCount; i < target; i++) {
        let raw = null;
        if (type === 'riddle') {
            const riddle = buildGeneratedRiddle(i);
            raw = { text: riddle.clue, answers: [riddle.answer], topic: 'generated', generated: true };
        } else if (type === 'joke') {
            raw = { text: buildGeneratedJoke(i), topic: 'юмор', generated: true };
        } else if (type === 'tongue_twister') {
            raw = { text: `Скороговорка. ${buildGeneratedTongueTwister(i)} Давай сначала медленно, потом быстрее.`, topic: 'речь', generated: true };
        } else {
            break;
        }
        generated.push(normalizeItem({
            ...raw,
            id: `${safeIdPart(packId)}_${String(i + 1).padStart(3, '0')}`,
            type,
            title: `${type} ${i + 1}`,
            lang,
            tags: ['content_pack', safeIdPart(type), safeIdPart(lang), 'generated'],
            source: 'content_pack_generated',
        }, { ...context, packId, type, lang, index: i, source: 'content_pack_generated' }));
    }
    return generated.filter(Boolean);
}

function normalizePackObject(packObject, context = {}) {
    const packId = String(packObject?.pack_id || context.packId || context.file || 'content_pack_v1');
    const type = packObject?.type || context.type || inferTypeFromPackId(packId, 'content');
    const lang = normalizeLang(packObject?.lang || context.lang || inferLangFromPackId(packId));
    const packVersion = packObject?.pack_version || context.packVersion || packId;
    const source = packObject?.source || context.source || 'content_pack';
    const rawItems = Array.isArray(packObject?.items) ? packObject.items : Array.isArray(packObject?.entries) ? packObject.entries : [];
    const items = rawItems.map((item, index) => {
        const itemContext = { packId, type, lang, packVersion, source, index };
        if (typeof item === 'string') return normalizeStringPackEntry(item, itemContext);
        return normalizeItem(item, itemContext);
    }).filter(Boolean);
    return [...items, ...generatedItemsForPack(packObject, { packId, type, lang, packVersion, source }, items.length)];
}

function loadManifestPacks(rootDir) {
    const manifestPath = path.join(rootDir, DEFAULT_MANIFEST_PATH);
    const manifest = readJsonIfExists(manifestPath, null);
    if (!manifest) return { items: [], loadedPacks: [], manifestFound: false };
    const entries = Array.isArray(manifest.packs) ? manifest.packs : [];
    const items = [];
    const loadedPacks = [];
    for (const entry of entries) {
        if (!entry || entry.active === false) continue;
        const file = String(entry.file || '').trim();
        if (!file) continue;
        const packPath = path.join(path.dirname(manifestPath), file);
        const packObject = readJsonIfExists(packPath, null);
        if (!packObject) continue;
        const packItems = normalizePackObject(packObject, {
            packId: entry.pack_id || packObject.pack_id || file.replace(/\.json$/i, ''),
            type: entry.type || packObject.type,
            lang: entry.lang || packObject.lang,
            packVersion: entry.pack_version || packObject.pack_version,
            source: entry.source || packObject.source || 'content_pack',
            file,
        });
        items.push(...packItems);
        loadedPacks.push({ file, count: packItems.length });
    }
    return { items, loadedPacks, manifestFound: true };
}

function loadLegacySeed(rootDir) {
    const seedPath = path.join(rootDir, LEGACY_SEED_PATH);
    const seed = readJsonIfExists(seedPath, { items: [] });
    const items = [];
    const loadedPacks = [];
    if (Array.isArray(seed.items)) {
        const normalized = seed.items.map((item, index) => normalizeItem(item, { packId: 'legacy_items', source: item?.source || 'legacy_seed', index })).filter(Boolean);
        items.push(...normalized);
        if (normalized.length) loadedPacks.push({ file: LEGACY_SEED_PATH, count: normalized.length, mode: 'items' });
    }
    if (seed.packs && typeof seed.packs === 'object') {
        for (const [packId, entries] of Object.entries(seed.packs)) {
            const packItems = normalizePackObject({ pack_id: packId, type: inferTypeFromPackId(packId, 'content'), lang: inferLangFromPackId(packId), entries: Array.isArray(entries) ? entries : [], source: 'legacy_pack' });
            items.push(...packItems);
            if (packItems.length) loadedPacks.push({ file: `${LEGACY_SEED_PATH}:${packId}`, count: packItems.length, mode: 'packs' });
        }
    }
    return { items, loadedPacks };
}

function dedupeItems(items) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
        if (!item?.id || seen.has(item.id)) continue;
        seen.add(item.id);
        result.push(item);
    }
    return result;
}

function loadContentItems(options = {}) {
    const rootDir = options.rootDir || path.resolve(__dirname, '..');
    const manifestResult = loadManifestPacks(rootDir);
    const legacyResult = loadLegacySeed(rootDir);
    return {
        items: dedupeItems([...manifestResult.items, ...legacyResult.items]),
        manifestFound: manifestResult.manifestFound,
        loadedPacks: [...manifestResult.loadedPacks, ...legacyResult.loadedPacks],
    };
}

module.exports = {
    loadContentItems,
    normalizeItem,
    normalizeStringPackEntry,
    normalizePackObject,
    inferTypeFromPackId,
    inferLangFromPackId,
};
