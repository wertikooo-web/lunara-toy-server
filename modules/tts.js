'use strict';

/**
 * TTS — Smart router:
 *   Russian  → Yandex SpeechKit (alena, best quality for Russian)
 *   Other    → OpenAI TTS (alloy, supports Romanian, English, etc.)
 *
 * Language detected automatically from text.
 * Output: WAV file for browser + PCM file for ESP32
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const OpenAI = require('openai');
const logger = require('./logger');
const language = require('./language');

const YANDEX_TTS_URL   = 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize';
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;
const YANDEX_API_KEY   = process.env.YANDEX_API_KEY;
const YANDEX_VOICE_FEMALE = 'alena';
const YANDEX_VOICE_MALE   = 'ermil';
const SAMPLE_RATE      = 16000;

// Каталог для "именованных" системных аудио-ассетов (greeting/retry/thinking).
// Тот же каталог, что server.js вычисляет для DIR_AUDIO — единый источник истины
// для файла-имени живёт здесь, а не в server.js.
const DIR_AUDIO = process.env.AUDIO_DIR ? path.resolve(process.env.AUDIO_DIR) : path.join(__dirname, '..', 'audio');

const openai       = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL = 'tts-1';

// Language + gender → voice mapping
const OPENAI_VOICES = {
    ro: { male: 'onyx', female: 'nova' },
    en: { male: 'echo', female: 'shimmer' },
    default: { male: 'fable', female: 'alloy' },
};

// ── Language detection ────────────────────────────────────────────────────────
// Делегируем в language.js — там уже проверенные паттерны для румынского
// (в т.ч. короткие слова без диакритики), вместо собственной урезанной копии.
function detectLang(text) {
    const detected = language.detectLanguageFromText(text);
    if (detected === 'ru-RU') return 'ru';
    if (detected === 'ro-RO') return 'ro';
    if (detected === 'en-US') return 'en';
    return 'default';
}

function normalizeExplicitLang(lang) {
    if (!lang || lang === 'auto') return null;
    if (lang.startsWith('ru')) return 'ru';
    if (lang.startsWith('ro')) return 'ro';
    if (lang.startsWith('en')) return 'en';
    return null;
}

// ── WAV header ────────────────────────────────────────────────────────────────
function buildWavHeader(pcmLen) {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0, 'ascii');   h.writeUInt32LE(36 + pcmLen, 4);
    h.write('WAVE', 8, 'ascii');   h.write('fmt ', 12, 'ascii');
    h.writeUInt32LE(16, 16);       h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);        h.writeUInt32LE(SAMPLE_RATE, 24);
    h.writeUInt32LE(SAMPLE_RATE * 2, 28);  h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);       h.write('data', 36, 'ascii');
    h.writeUInt32LE(pcmLen, 40);
    return h;
}

function saveFiles(pcmBuffer, outputPath) {
    fs.writeFileSync(outputPath, pcmBuffer);
    const wavPath = outputPath.replace(/\.pcm$/, '.wav');
    fs.writeFileSync(wavPath, Buffer.concat([buildWavHeader(pcmBuffer.length), pcmBuffer]));
    return Math.ceil((pcmBuffer.length / (SAMPLE_RATE * 2)) * 1000);
}

// ── Yandex TTS ────────────────────────────────────────────────────────────────
function normalizeSpeechSpeed(voiceSpeed = 'normal') {
    if (voiceSpeed === 'slow') return 0.8;
    if (voiceSpeed === 'fast') return 1.1;
    return 0.9;
}

function yandexTTS(text, speed, toyGender, explicitVoiceId) {
    const voice = explicitVoiceId || (toyGender === 'male' ? YANDEX_VOICE_MALE : YANDEX_VOICE_FEMALE);
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams({
            text, voice, speed: String(speed),
            format: 'lpcm', sampleRateHertz: String(SAMPLE_RATE),
            folderId: YANDEX_FOLDER_ID,
        }).toString();

        const req = https.request(YANDEX_TTS_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Api-Key ${YANDEX_API_KEY}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            if (res.statusCode !== 200) {
                let err = '';
                res.on('data', c => err += c);
                res.on('end', () => reject(new Error(`Yandex TTS ${res.statusCode}: ${err}`)));
                return;
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── OpenAI TTS → PCM 16kHz ───────────────────────────────────────────────────
async function callOpenaiTTSOnce(text, voice, speed) {
    const response = await openai.audio.speech.create({
        model: OPENAI_MODEL, voice, input: text,
        response_format: 'pcm',  // PCM16 LE 24kHz
        speed,
    });
    return Buffer.from(await response.arrayBuffer());
}

async function openaiTTS(text, lang, speed, toyGender, explicitVoiceId) {
    const genderVoices = OPENAI_VOICES[lang] || OPENAI_VOICES.default;
    const voice = explicitVoiceId || (toyGender === 'male' ? genderVoices.male : genderVoices.female);
    logger.info(`[TTS] OpenAI voice: ${voice} (lang=${lang}, gender=${toyGender || 'female'})`);

    let pcm24k;
    try {
        pcm24k = await callOpenaiTTSOnce(text, voice, speed);
    } catch (err) {
        logger.error(`[TTS] OpenAI TTS failed (voice=${voice}, lang=${lang}): ${err.message}`, err);
        logger.warn('[TTS] retrying OpenAI TTS once before giving up');
        try {
            pcm24k = await callOpenaiTTSOnce(text, voice, speed);
        } catch (retryErr) {
            logger.error(`[TTS] OpenAI TTS retry also failed: ${retryErr.message}`, retryErr);
            throw new Error(`OpenAI TTS unavailable: ${retryErr.message}`);
        }
    }

    return resample24to16(pcm24k);
}

function resample24to16(pcm24k) {
    const n24 = pcm24k.length / 2;
    const n16 = Math.floor(n24 * 16000 / 24000);
    const out = Buffer.alloc(n16 * 2);
    for (let i = 0; i < n16; i++) {
        const pos  = i * 24000 / 16000;
        const idx  = Math.floor(pos);
        const frac = pos - idx;
        const s0   = pcm24k.readInt16LE(Math.min(idx, n24 - 1) * 2);
        const s1   = pcm24k.readInt16LE(Math.min(idx + 1, n24 - 1) * 2);
        out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s0 + frac * (s1 - s0)))), i * 2);
    }
    return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────
// voiceConfig (опционально, options.voiceConfig): { id, provider, gender }.
// Если не передан — старое поведение (авто по языку) не меняется ни для одного
// из существующих вызовов tts.synthesize() в проекте.
function resolveProvider(detectedLang, voiceConfig) {
    const autoProvider = detectedLang === 'ru' ? 'yandex' : 'openai';
    if (!voiceConfig?.provider) return autoProvider;

    if (voiceConfig.provider === 'yandex' && detectedLang !== 'ru') {
        logger.warn(`[TTS] voice provider "yandex" is not compatible with lang="${detectedLang}"; falling back to openai`);
        return 'openai';
    }
    return voiceConfig.provider;
}

async function synthesize(text, outputPath, lang = null, options = {}) {
    // Use explicit lang from client if provided, otherwise auto-detect
    const explicitLang = normalizeExplicitLang(lang);
    const detectedLang = explicitLang || detectLang(text);
    const speed = normalizeSpeechSpeed(options.voiceSpeed || 'normal');
    const voiceConfig = options.voiceConfig || null;
    const toyGender = voiceConfig?.gender || options.toyGender;
    const provider = resolveProvider(detectedLang, voiceConfig);
    logger.info(`[TTS] lang=${detectedLang} provider=${provider} (${explicitLang ? 'explicit' : 'auto'}), speed=${speed}, gender=${toyGender || 'female(default)'}, voiceId=${voiceConfig?.id || 'auto'}`);

    async function callYandex(useExplicitVoice) {
        if (!YANDEX_FOLDER_ID || !YANDEX_API_KEY) throw new Error('Yandex TTS keys not set');
        return yandexTTS(text, speed, toyGender, useExplicitVoice ? voiceConfig?.id : null);
    }
    async function callOpenai(useExplicitVoice) {
        return openaiTTS(text, detectedLang, speed, toyGender, useExplicitVoice ? voiceConfig?.id : null);
    }

    const ttsCallStartedAt = Date.now();
    let pcmBuffer;
    try {
        pcmBuffer = provider === 'yandex' ? await callYandex(true) : await callOpenai(true);
    } catch (primaryErr) {
        const providerLabel = provider === 'yandex' ? 'Yandex' : 'OpenAI';
        logger.error(`[TTS] ${providerLabel} failed: ${primaryErr.message}`);

        // OpenAI — мультиязычный, безопасный fallback для любого языка. Yandex-голоса
        // (alena/ermil) заточены под русский без явного lang в запросе — пробуем их как
        // fallback только когда текст реально русский, иначе рискуем выдать ребёнку кашу.
        const fallbackProvider = provider === 'yandex' ? 'openai' : (detectedLang === 'ru' ? 'yandex' : null);
        if (!fallbackProvider) {
            throw new Error(`TTS unavailable: ${providerLabel} failed and no safe fallback for lang=${detectedLang}: ${primaryErr.message}`);
        }

        const fallbackLabel = fallbackProvider === 'yandex' ? 'Yandex' : 'OpenAI';
        logger.warn(`[TTS] falling back to ${fallbackLabel}`);
        try {
            pcmBuffer = fallbackProvider === 'yandex' ? await callYandex(false) : await callOpenai(false);
        } catch (fallbackErr) {
            logger.error(`[TTS] ${fallbackLabel} fallback also failed: ${fallbackErr.message}`);
            throw new Error(`TTS unavailable: both providers failed (${providerLabel}: ${primaryErr.message}; ${fallbackLabel}: ${fallbackErr.message})`);
        }
    }

    const ttsLatencyMs = Date.now() - ttsCallStartedAt;
    const durationMs = saveFiles(pcmBuffer, outputPath);
    logger.info(`[TTS] done: bytes=${pcmBuffer.length} tts_latency_ms=${ttsLatencyMs} audio_duration_ms=${durationMs}`);
    return durationMs;
}

// ── Named audio assets (greeting/retry/thinking-filler system phrases) ─────────
// Единый источник истины для имени файла: <type>[_<variant>]_<lang>_<gender>.pcm.
// server.js больше не знает, как называется файл на диске — он просто просит
// "дай мне озвучку типа X на языке Y голосом Z", а tts.js решает, есть ли она
// в кэше или нужно сгенерировать.
function normalizeAssetLangKey(lang) {
    const value = String(lang || '').toLowerCase();
    if (value.startsWith('ru')) return 'ru';
    if (value.startsWith('ro')) return 'ro';
    if (value.startsWith('en')) return 'en';
    return 'ru';
}

function normalizeAssetGenderKey(gender) {
    return gender === 'male' ? 'male' : 'female';
}

function getAssetPath(type, lang, gender, variant, voiceLabel, speedLabel) {
    const langKey = normalizeAssetLangKey(lang);
    const genderKey = normalizeAssetGenderKey(gender);
    // voiceLabel (bare explicit voice id, если задан) — без него смена конкретного голоса
    // на тот же пол (toy_gender — отдельное поле, не меняется автоматически при выборе
    // голоса) не давала бы новый файл: старый кэш по (type,lang,gender) отдавался как есть.
    // speedLabel — только для non-default скорости (slow/fast), чтобы не переименовывать
    // все существующие файлы на самой частой ('normal') скорости.
    const parts = [String(type || 'asset'), variant, langKey, genderKey, voiceLabel, speedLabel].filter(Boolean);
    return path.join(DIR_AUDIO, `${parts.join('_')}.pcm`);
}

function durationFromExistingPcm(pcmPath) {
    try {
        const bytes = fs.statSync(pcmPath).size;
        return Math.ceil((bytes / (SAMPLE_RATE * 2)) * 1000);
    } catch (_) {
        return 1500;
    }
}

// Ленивая генерация: если ассет уже есть на диске — отдаём его сразу, без обращения
// к провайдерам TTS. Если нет — генерируем один раз и кладём в тот же именованный слот.
// На ошибке генерации логирует и возвращает null — сервер не падает, просто пропускает
// эту конкретную реплику (retry/greeting/thinking — не критичные для работы пути).
async function synthesizeAsset(type, text, lang, gender, options = {}) {
    const voiceLabel = options.voiceConfig?.id ? String(options.voiceConfig.id).replace(/[^a-zA-Z0-9_-]/g, '_') : null;
    const speedLabel = (options.voiceSpeed && options.voiceSpeed !== 'normal') ? `sp${options.voiceSpeed}` : null;
    const pcmPath = getAssetPath(type, lang, gender, options.variant, voiceLabel, speedLabel);
    const wavPath = pcmPath.replace(/\.pcm$/, '.wav');

    if (fs.existsSync(pcmPath) && fs.existsSync(wavPath)) {
        return { pcmPath, wavPath, durationMs: durationFromExistingPcm(pcmPath), cached: true };
    }

    try {
        fs.mkdirSync(path.dirname(pcmPath), { recursive: true });
        // gender был только в имени файла (getAssetPath) и не долетал до synthesize(),
        // из-за чего мужские ассеты озвучивались женским голосом по умолчанию.
        const durationMs = await synthesize(text, pcmPath, lang, { ...options, toyGender: gender });
        return { pcmPath, wavPath, durationMs, cached: false };
    } catch (err) {
        logger.error(
            `[TTS] synthesizeAsset failed (type=${type}, lang=${lang}, gender=${gender || 'female'}, variant=${options.variant || '-'}): ${err.message}`,
            err
        );
        return null;
    }
}

// Общий (не привязанный к устройству) кэш: имя файла складывается из
// type+variant+lang+gender, deviceId в нём не участвует — один и тот же ассет
// переиспользуется всеми устройствами с одинаковыми настройками языка/пола.
// Поэтому у смены настроек ОДНОГО устройства нет "своих" файлов для удаления —
// оно просто начинает запрашивать другой (lang,gender) слот, который либо уже
// в кэше (другое устройство его прогрело), либо сгенерируется лениво при первом
// обращении. clearCache здесь — инструмент для принудительного сброса конкретного
// слота (например, когда поменялся сам текст фразы в коде), а не автоматика на
// каждое сохранение настроек.
function clearCache(filter = {}) {
    if (!fs.existsSync(DIR_AUDIO)) return 0;

    const langKey = filter.lang ? normalizeAssetLangKey(filter.lang) : null;
    const genderKey = filter.gender ? normalizeAssetGenderKey(filter.gender) : null;
    let removed = 0;

    for (const fileName of fs.readdirSync(DIR_AUDIO)) {
        if (!/\.(pcm|wav)$/.test(fileName)) continue;
        if (filter.type && !fileName.startsWith(`${filter.type}_`)) continue;
        if (langKey && !fileName.includes(`_${langKey}_`)) continue;
        if (genderKey
            && !fileName.includes(`_${genderKey}_`)
            && !fileName.endsWith(`_${genderKey}.pcm`)
            && !fileName.endsWith(`_${genderKey}.wav`)) continue;

        try {
            fs.unlinkSync(path.join(DIR_AUDIO, fileName));
            removed += 1;
        } catch (err) {
            logger.warn(`[TTS] clearCache failed to remove ${fileName}: ${err.message}`);
        }
    }

    logger.info(`[TTS] clearCache removed ${removed} file(s) matching ${JSON.stringify(filter)}`);
    return removed;
}

module.exports = {
    synthesize,
    detectLang,
    normalizeExplicitLang,
    getAssetPath,
    synthesizeAsset,
    clearCache,
};
