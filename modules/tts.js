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

const YANDEX_TTS_URL   = 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize';
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;
const YANDEX_API_KEY   = process.env.YANDEX_API_KEY;
const YANDEX_VOICE     = 'alena';
const YANDEX_SPEED     = '0.85';
const SAMPLE_RATE      = 16000;

const openai       = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_VOICE = 'alloy';
const OPENAI_MODEL = 'tts-1';

// ── Language detection ────────────────────────────────────────────────────────
function isRussian(text) {
    const letters  = (text.match(/\p{L}/gu) || []).length;
    const cyrillic = (text.match(/[\u0400-\u04FF]/g) || []).length;
    return letters > 0 && (cyrillic / letters) > 0.3;
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
function yandexTTS(text) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams({
            text, voice: YANDEX_VOICE, speed: YANDEX_SPEED,
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
async function openaiTTS(text) {
    const response = await openai.audio.speech.create({
        model: OPENAI_MODEL, voice: OPENAI_VOICE, input: text,
        response_format: 'pcm',  // PCM16 LE 24kHz
        speed: 0.9,
    });
    const pcm24k = Buffer.from(await response.arrayBuffer());
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
async function synthesize(text, outputPath) {
    const ru = isRussian(text);
    logger.info(`[TTS] lang=${ru ? 'ru→Yandex' : 'other→OpenAI'}`);

    let pcmBuffer;
    if (ru) {
        if (!YANDEX_FOLDER_ID || !YANDEX_API_KEY) throw new Error('Yandex TTS keys not set');
        pcmBuffer = await yandexTTS(text);
    } else {
        pcmBuffer = await openaiTTS(text);
    }

    const durationMs = saveFiles(pcmBuffer, outputPath);
    logger.info(`[TTS] done: ${pcmBuffer.length} bytes, ~${durationMs}ms`);
    return durationMs;
}

module.exports = { synthesize };
