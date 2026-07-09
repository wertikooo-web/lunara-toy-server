'use strict';

const fs = require('fs');
const logger = require('./logger');

let openaiClient = null;
let groqClient = null;

const STT_PROVIDER = String(process.env.STT_PROVIDER || 'openai').trim().toLowerCase();
// Использовать обычный whisper-large-v3 для Groq, он в разы точнее на русском, чем turbo
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3'; 
const OPENAI_STT_MODEL = 'whisper-1';
const DEFAULT_STT_LANGUAGE = process.env.DEFAULT_STT_LANGUAGE || process.env.STT_LANGUAGE || 'ru-RU';
const MIN_STT_PCM_BYTES = Number(process.env.MIN_STT_PCM_BYTES || 6000);

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS = 16;
const BYTES_PER_SAMPLE = BITS / 8;

// Секретное оружие: контекстный промпт, обучающий Whisper правильному распознаванию
const WHISPER_PROMPT = "Разговор ребенка с умной игрушкой Lumi. Короткие ответы, детская речь, русские слова, подсказки, названия животных, да, нет, окей.";

function buildWavHeader(pcmByteLength) {
    const header = Buffer.alloc(44);
    const byteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
    const blockAlign = CHANNELS * BYTES_PER_SAMPLE;

    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + pcmByteLength, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(CHANNELS, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(BITS, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(pcmByteLength, 40);

    return header;
}

function getProvider() {
    return STT_PROVIDER === 'groq' ? 'groq' : 'openai';
}

function getOpenAIClient() {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is not set');
    }
    if (!openaiClient) {
        const OpenAI = require('openai');
        openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return openaiClient;
}

function getGroqClient() {
    if (!process.env.GROQ_API_KEY) {
        throw new Error('GROQ_API_KEY is not set');
    }
    if (!groqClient) {
        const Groq = require('groq-sdk');
        groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
    }
    return groqClient;
}

function normalizeDetectedLanguage(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return null;
    if (raw === 'ru' || raw.startsWith('ru-') || raw.includes('russian')) return 'ru-RU';
    if (raw === 'ro' || raw.startsWith('ro-') || raw.includes('romanian')) return 'ro-RO';
    if (raw === 'en' || raw.startsWith('en-') || raw.includes('english')) return 'en-US';
    return null;
}

function localeToIsoLanguage(value) {
    const normalized = normalizeDetectedLanguage(value);
    if (normalized === 'ru-RU') return 'ru';
    if (normalized === 'ro-RO') return 'ro';
    if (normalized === 'en-US') return 'en';
    return null;
}

function normalizeText(text) {
    return String(text || '')
        .trim()
        .replace(/[.!?,;:]+$/g, '')
        .replace(/\s+/g, ' ');
}

function sanitizeShortRussianTranscript(text, options = {}) {
    const targetLanguage = normalizeDetectedLanguage(options.language || DEFAULT_STT_LANGUAGE);
    const raw = normalizeText(text);

    if (!raw) return raw;
    if (targetLanguage !== 'ru-RU') return raw;

    const lower = raw.toLowerCase();
    const words = lower.split(/\s+/).filter(Boolean);
    const short = words.length <= 3 && raw.length <= 24;
    if (!short) return raw;

    const yesMap = new Set(['yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'да', 'ага', 'угу', 'ок', 'окей']);
    const russianNoMap = new Set(['нет', 'неа']);
    const ambiguousEnglishNoMap = new Set(['no', 'nope']);
    const fillerMap = new Set(['you', 'yo', 'u', 'thank', 'thanks', 'subtitles']);

    if (yesMap.has(lower)) return lower === 'ok' || lower === 'okay' ? 'окей' : 'да';
    if (russianNoMap.has(lower)) return 'нет';
    if (ambiguousEnglishNoMap.has(lower)) return 'no';
    if (fillerMap.has(lower)) return '';
    if (lower === 'thank you' || lower === 'thank you very much') return '';

    return raw;
}

async function transcribeFile(audioPath, options = {}) {
    const startedAt = Date.now();
    const provider = getProvider();
    const effectiveLanguage = options.language || DEFAULT_STT_LANGUAGE;
    const languageHint = localeToIsoLanguage(effectiveLanguage);
    let response;
    let model;

    if (provider === 'groq') {
        model = GROQ_STT_MODEL;
        const request = {
            file: fs.createReadStream(audioPath),
            model,
            response_format: 'verbose_json',
            temperature: 0.1, // Даем модели микро-флекс на игнорирование шумов
            prompt: WHISPER_PROMPT // Направляем контекст
        };
        if (languageHint) request.language = languageHint;
        response = await getGroqClient().audio.transcriptions.create(request);
    } else {
        model = OPENAI_STT_MODEL;
        const request = {
            file: fs.createReadStream(audioPath),
            model,
            response_format: 'verbose_json',
            temperature: 0.1,
            prompt: WHISPER_PROMPT
        };
        if (languageHint) request.language = languageHint;
        response = await getOpenAIClient().audio.transcriptions.create(request);
    }

    const originalText = String(response?.text || '').trim();
    const sanitizedText = sanitizeShortRussianTranscript(originalText, { language: effectiveLanguage });
    const result = {
        text: sanitizedText,
        originalText,
        language: normalizeDetectedLanguage(response?.language) || normalizeDetectedLanguage(effectiveLanguage),
        provider,
        model,
    };

    const changed = originalText !== sanitizedText ? ` sanitized=${JSON.stringify(sanitizedText)}` : '';
    logger.info(
        `[STT] provider=${provider} model=${model} requested=${languageHint || '-'} detected=${result.language || '-'} duration_ms=${Date.now() - startedAt}${changed}`
    );

    return result;
}

async function transcribe(pcmPath, options = {}) {
    const pcmData = fs.readFileSync(pcmPath);
    if (pcmData.length > 0 && pcmData.length < MIN_STT_PCM_BYTES) {
        logger.info(`[STT] skipped too-short pcm bytes=${pcmData.length} min=${MIN_STT_PCM_BYTES}`);
        return '';
    }

    const wavData = Buffer.concat([buildWavHeader(pcmData.length), pcmData]);
    const wavPath = /\.pcm$/i.test(pcmPath) ? pcmPath.replace(/\.pcm$/i, '.wav') : `${pcmPath}.wav`;

    fs.writeFileSync(wavPath, wavData);

    try {
        const result = await transcribeFile(wavPath, options);
        return result.text;
    } finally {
        fs.rmSync(wavPath, { force: true });
    }
}

module.exports = {
    transcribe,
    transcribeFile,
    sanitizeShortRussianTranscript,
    normalizeDetectedLanguage,
    localeToIsoLanguage,
};
