'use strict';

function normalizeText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[.,!?;:()[\]{}"«»“”]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function wordCount(text) {
    return normalizeText(text).split(' ').filter(Boolean).length;
}

function uniqueWordRatio(text) {
    const words = normalizeText(text).split(' ').filter(Boolean);
    if (words.length === 0) return 0;
    return new Set(words).size / words.length;
}

function hasPhrase(text, phrase) {
    const t = ` ${normalizeText(text)} `;
    const p = ` ${normalizeText(phrase)} `;
    return t.includes(p);
}

function hasAnyPhrase(text, phrases = []) {
    return phrases.some((phrase) => hasPhrase(text, phrase));
}

function hasRegex(text, pattern) {
    return pattern.test(normalizeText(text));
}

function looksLikeKnownSttFiller(text) {
    const t = normalizeText(text);
    return /^(thank you|thanks|thank you very much|yeah boss|yes boss|ok boss|okay boss|subtitles|bye bye|c'était abidjan|c etait abidjan)$/.test(t)
        || /^(субтитры|спасибо за просмотр|подписывайтесь|лайк и подписка)$/.test(t);
}

function looksLikePlaybackGarbage(text) {
    const t = normalizeText(text);
    if (!t) return true;

    // Real example from logs after Lumi playback/self-listening.
    if (/боку.*реку.*царств.*лежа.*боку/.test(t)) return true;

    // Repeated odd fragments often come from TTS leakage or Whisper hallucination.
    if (/(\b\S{2,}\b)(?:\s+\1){2,}/.test(t)) return true;

    // NOTE: previously rejected any text mixing Cyrillic and Latin script as an STT
    // hallucination. Removed — Moldovan kids routinely say Latin-script brand/game
    // names inside Russian sentences ("мультик Roblox", "любимая игра Minecraft"),
    // and that pattern was silently discarding real, safe favorite-game/cartoon facts.

    // Common Russian function words only, without any useful personal fact.
    if (/^(а|и|ну|вот|это|там|как|на|у|по|да|нет|не|я|мы|ты|он|она)(\s+(а|и|ну|вот|это|там|как|на|у|по|да|нет|не|я|мы|ты|он|она)){3,}$/.test(t)) {
        return true;
    }

    return false;
}

function hasExplicitMemorySignal(text) {
    const t = normalizeText(text);
    if (!t) return false;

    // Do not use JS \b for Cyrillic phrases: it is ASCII-centric and misses Russian words.
    const cyrillicSignals = [
        'запомни',
        'запиши',
        'запомнила',
        'помни',
        'меня зовут',
        'мое имя',
        'моё имя',
        'я называюсь',
        'называй меня',
        'я люблю',
        'мне нравится',
        'мне нравятся',
        'я обожаю',
        'мой любимый',
        'моя любимая',
        'мое любимое',
        'моё любимое',
        'мои любимые',
        'это моя любимая',
        'это мой любимый',
        'это мое любимое',
        'это моё любимое',
        'у меня есть',
        'у меня живет',
        'у меня живёт',
        'моего кота зовут',
        'мою кошку зовут',
        'мою собаку зовут',
        'моего питомца зовут',
        'мой друг',
        'моя подруга',
        'лучший друг',
        'лучшая подруга',
        'я больше не люблю',
        'мне больше не нравится',
        'это не мой любимый',
        'это не моя любимая',
    ];

    return hasAnyPhrase(t, cyrillicSignals)
        || /(^|\s)мне\s+\d{1,2}\s+(год|года|лет)(\s|$)/.test(t)
        || /\b(my name is|call me|i am \d{1,2}|i'm \d{1,2}|i like|i love|my favorite|my favourite|i have a pet)\b/.test(t)
        || /\b(ma cheama|mă cheamă|imi place|îmi place|culoarea mea preferata|culoarea mea preferată)\b/.test(t);
}

function hasSensitiveMemoryRisk(text) {
    const t = normalizeText(text);
    return hasAnyPhrase(t, [
        'адрес',
        'телефон',
        'номер телефона',
        'школа',
        'садик',
        'детский сад',
        'улица',
        'номер дома',
        'квартира',
        'пароль',
        'фамилия',
    ]) || /\b(address|phone|school|street|password|house number|surname|last name)\b/.test(t);
}

function shouldRememberUserText(text, options = {}) {
    const raw = String(text || '').trim();
    const normalized = normalizeText(raw);

    if (!normalized) {
        return { allow: false, reason: 'empty_transcript' };
    }

    if (raw.length < 5 || wordCount(raw) < 2) {
        return { allow: false, reason: 'too_short_for_memory' };
    }

    if (looksLikeKnownSttFiller(raw)) {
        return { allow: false, reason: 'known_stt_filler' };
    }

    if (looksLikePlaybackGarbage(raw)) {
        return { allow: false, reason: 'playback_or_stt_garbage' };
    }

    if (hasSensitiveMemoryRisk(raw)) {
        return { allow: false, reason: 'sensitive_memory_risk' };
    }

    if (!hasExplicitMemorySignal(raw)) {
        return { allow: false, reason: 'no_explicit_memory_signal' };
    }

    if (wordCount(raw) >= 7 && uniqueWordRatio(raw) < 0.45) {
        return { allow: false, reason: 'low_unique_word_ratio' };
    }

    if (options.afterPlaybackMs !== undefined && Number(options.afterPlaybackMs) >= 0 && Number(options.afterPlaybackMs) < 800) {
        return { allow: false, reason: 'too_close_to_playback' };
    }

    return { allow: true, reason: 'explicit_safe_memory_signal' };
}

function filterUnsafeActions(actions = {}) {
    const filtered = { set: {}, add: {}, remove: {} };
    let removed = 0;

    for (const section of ['set', 'add', 'remove']) {
        const source = actions?.[section] && typeof actions[section] === 'object' ? actions[section] : {};
        for (const [field, value] of Object.entries(source)) {
            const values = Array.isArray(value) ? value : [value];
            const safeValues = values.filter((item) => {
                const text = String(item || '').trim();
                if (!text) return false;
                if (hasSensitiveMemoryRisk(text)) return false;
                if (looksLikeKnownSttFiller(text)) return false;
                if (looksLikePlaybackGarbage(text)) return false;
                return true;
            });
            removed += values.length - safeValues.length;
            if (safeValues.length === 0) continue;
            filtered[section][field] = Array.isArray(value) ? safeValues : safeValues[0];
        }
    }

    return { actions: filtered, removed };
}

module.exports = {
    normalizeText,
    shouldRememberUserText,
    filterUnsafeActions,
    hasExplicitMemorySignal,
    looksLikePlaybackGarbage,
    looksLikeKnownSttFiller,
};
