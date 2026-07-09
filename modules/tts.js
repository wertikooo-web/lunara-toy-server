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
const OpenAI = require('openai');
const logger = require('./logger');
const language = require('./language');

const YANDEX_TTS_URL   = 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize';
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;
const YANDEX_API_KEY   = process.env.YANDEX_API_KEY;
const YANDEX_VOICE_FEMALE = 'alena';
const YANDEX_VOICE_MALE   = 'ermil';
const SAMPLE_RATE      = 16000;

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
    logger.info(`[TTS] lang=${detectedLang} provider=${provider} (${explicitLang ? 'explicit' : 'auto'}), speed=${speed}`);

    let pcmBuffer;
    if (provider === 'yandex') {
        if (!YANDEX_FOLDER_ID || !YANDEX_API_KEY) throw new Error('Yandex TTS keys not set');
        pcmBuffer = await yandexTTS(text, speed, toyGender, voiceConfig?.id);
    } else {
        pcmBuffer = await openaiTTS(text, detectedLang, speed, toyGender, voiceConfig?.id);
    }

    const durationMs = saveFiles(pcmBuffer, outputPath);
    logger.info(`[TTS] done: ${pcmBuffer.length} bytes, ~${durationMs}ms`);
    return durationMs;
}

module.exports = { synthesize, detectLang, normalizeExplicitLang };
