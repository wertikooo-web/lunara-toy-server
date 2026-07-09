'use strict';

const SUPPORTED_LOCALES = new Set(['ru-RU', 'ro-RO', 'en-US']);
const AMBIGUOUS_SHORT_WORDS = new Set([
    'a', 'i', 'o', 'ok', 'okay', 'da', 'no', 'nu', 'mama', 'papa', 'lumi',
    'yes', 'yeah', 'hello', 'hi', 'salut', 'привет', 'да', 'нет', 'мама', 'папа',
]);

function normalizeLocale(value, fallback = null) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'auto') return 'auto';
    if (raw === 'ru' || raw.startsWith('ru-') || raw === 'russian') return 'ru-RU';
    if (raw === 'ro' || raw.startsWith('ro-') || raw === 'romanian') return 'ro-RO';
    if (raw === 'en' || raw.startsWith('en-') || raw === 'english') return 'en-US';
    return fallback;
}

function words(text) {
    return String(text || '')
        .toLocaleLowerCase('ru-RU')
        .match(/[\p{L}0-9'-]+/gu) || [];
}

function explicitLanguageCommand(text) {
    const value = String(text || '').toLocaleLowerCase('ru-RU');
    // Триггерим по предлогу направления (на/по-/pe/in/to/включи), а не по глаголу.
    // Это защищает от случайных срабатываний вроде "мы учим английский в школе",
    // где название языка просто упомянуто, а не запрошена смена языка.
    if (/на\s+английск|по-английск|включи\s+английск|switch\s+to\s+english|in\s+english|to\s+english|pe\s+englez|în\s+englez/i.test(value)) return 'en-US';
    if (/на\s+румынск|по-румынск|включи\s+румынск|in\s+romanian|to\s+romanian|pe\s+român|în\s+român/i.test(value)) return 'ro-RO';
    if (/на\s+русск|по-русски|включи\s+русск|in\s+russian|to\s+russian|pe\s+rus[aă]|în\s+rus[aă]/i.test(value)) return 'ru-RU';
    return null;
}

function detectLanguageFromText(text) {
    const value = String(text || '').trim();
    if (!value) return null;
    const tokenList = words(value);
    const letters = (value.match(/\p{L}/gu) || []).length;
    const cyrillic = (value.match(/[\u0400-\u04FF]/g) || []).length;
    if (letters > 0 && cyrillic / letters > 0.3) return 'ru-RU';

    const romanianTokens = new Set([
        'buna', 'bună', 'salut', 'ce', 'cum', 'mai', 'faci', 'sunt', 'este', 'esti', 'ești',
        'vreau', 'spune', 'poveste', 'ghicitoare', 'joc', 'hai', 'multumesc', 'mulțumesc',
        'pentru', 'despre', 'unde', 'cine', 'de', 'la', 'cu', 'si', 'și', 'nu', 'da', 'imi', 'îmi',
        'place', 'frumos', 'copil', 'urs', 'ursulet', 'ursuleț', 'pisica', 'pisică', 'mancare', 'mâncare',
        'banc', 'gluma', 'glume', 'ghici', 'ghicitori', 'povesti', 'cantece', 'cantec', 'vulpe', 'lup', 'ursu',
    ]);
    const roHits = tokenList.filter(token => romanianTokens.has(token)).length;
    if (/[ăâîșțĂÂÎȘȚ]/.test(value) || roHits >= 1) {
        return 'ro-RO';
    }

    const ascii = (value.match(/[a-zA-Z]/g) || []).length;
    if (letters > 0 && ascii / letters > 0.8) return 'en-US';
    return null;
}

function isAmbiguousShort(text) {
    const tokenList = words(text);
    if (tokenList.length === 0 || tokenList.length > 2) return false;
    return tokenList.every(token => AMBIGUOUS_SHORT_WORDS.has(token));
}

function resolveConversationLanguage(state, mode, text, fallback = 'ru-RU', detectedLanguage = null) {
    const configuredMode = normalizeLocale(mode, 'ru-RU');
    const fallbackLocale = normalizeLocale(fallback, 'ru-RU');
    const previous = normalizeLocale(state?.activeLanguage, null);

    if (configuredMode !== 'auto') {
        if (state) {
            state.activeLanguage = configuredMode;
            state.languageCandidate = null;
            state.languageCandidateCount = 0;
        }
        return {
            language: configuredMode,
            mode: configuredMode,
            changed: Boolean(previous && previous !== configuredMode),
            reason: 'parent_fixed',
        };
    }

    const explicit = explicitLanguageCommand(text);
    const sttDetected = normalizeLocale(detectedLanguage, null);
    const detected = explicit || sttDetected || detectLanguageFromText(text);
    const tokenCount = words(text).length;
    const ambiguous = isAmbiguousShort(text);
    let active = previous || fallbackLocale;
    let reason = previous ? 'keep_active' : 'fallback';

    if (explicit) {
        active = explicit;
        reason = 'explicit_command';
        if (state) {
            state.languageCandidate = null;
            state.languageCandidateCount = 0;
        }
    } else if (sttDetected && !ambiguous) {
        active = sttDetected;
        reason = 'stt_detected';
        if (state) {
            state.languageCandidate = null;
            state.languageCandidateCount = 0;
        }
    } else if (detected && detected === active) {
        reason = 'detected_same';
        if (state) {
            state.languageCandidate = null;
            state.languageCandidateCount = 0;
        }
    } else if (detected && !ambiguous && tokenCount >= 3) {
        active = detected;
        reason = 'detected_full_phrase';
        if (state) {
            state.languageCandidate = null;
            state.languageCandidateCount = 0;
        }
    } else if (detected && !ambiguous && state) {
        if (state.languageCandidate === detected) state.languageCandidateCount = Number(state.languageCandidateCount || 0) + 1;
        else {
            state.languageCandidate = detected;
            state.languageCandidateCount = 1;
        }
        if (state.languageCandidateCount >= 2) {
            active = detected;
            reason = 'detected_two_short_phrases';
            state.languageCandidate = null;
            state.languageCandidateCount = 0;
        } else {
            reason = 'wait_second_short_phrase';
        }
    } else if (ambiguous) {
        reason = 'ambiguous_keep_active';
    }

    if (state) state.activeLanguage = active;
    return {
        language: active,
        mode: 'auto',
        detected_language: detected,
        changed: Boolean(previous && previous !== active),
        reason,
    };
}

module.exports = {
    normalizeLocale,
    detectLanguageFromText,
    explicitLanguageCommand,
    resolveConversationLanguage,
};
