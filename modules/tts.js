'use strict';

/**
 * TTS — Yandex SpeechKit
 *
 * Input:  text string
 * Output: saves WAV file (PCM16 LE, mono, 16000 Hz) to outputPath
 *         ESP32 gets raw PCM (strips WAV header)
 *         Browser gets full WAV (plays natively)
 *         Returns duration in milliseconds
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const YANDEX_TTS_URL  = 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize';
const FOLDER_ID       = process.env.YANDEX_FOLDER_ID;
const API_KEY         = process.env.YANDEX_API_KEY;

const VOICE       = 'alena';
const SPEED       = '1.0';
const SAMPLE_RATE = 16000;
const FORMAT      = 'lpcm';   // raw PCM16 LE from Yandex

// ── WAV header builder ────────────────────────────────────────────────────────
function buildWavHeader(pcmByteLength) {
    const header      = Buffer.alloc(44);
    const byteRate    = SAMPLE_RATE * 1 * 2;  // sampleRate * channels * bytesPerSample
    const blockAlign  = 1 * 2;

    header.write('RIFF',                   0, 'ascii');
    header.writeUInt32LE(36 + pcmByteLength, 4);
    header.write('WAVE',                   8, 'ascii');
    header.write('fmt ',                  12, 'ascii');
    header.writeUInt32LE(16,              16);   // PCM chunk size
    header.writeUInt16LE(1,               20);   // AudioFormat = PCM
    header.writeUInt16LE(1,               22);   // NumChannels = mono
    header.writeUInt32LE(SAMPLE_RATE,     24);
    header.writeUInt32LE(byteRate,        28);
    header.writeUInt16LE(blockAlign,      32);
    header.writeUInt16LE(16,              34);   // BitsPerSample
    header.write('data',                  36, 'ascii');
    header.writeUInt32LE(pcmByteLength,   40);

    return header;
}


// ── Yandex TTS request ────────────────────────────────────────────────────────
function requestYandexTTS(text) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams({
            text,
            voice:           VOICE,
            speed:           '0.95',        // чуть медленнее для детей
            format:          FORMAT,
            sampleRateHertz: String(SAMPLE_RATE),
            folderId:        FOLDER_ID,
        }).toString();

        const options = {
            method: 'POST',
            headers: {
                'Authorization':  `Api-Key ${API_KEY}`,
                'Content-Type':   'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            },
        };

        const req = https.request(YANDEX_TTS_URL, options, (res) => {
            if (res.statusCode !== 200) {
                let errBody = '';
                res.on('data', chunk => errBody += chunk);
                res.on('end', () => reject(new Error(
                    `Yandex TTS error ${res.statusCode}: ${errBody}`
                )));
                return;
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── Main synthesize function ──────────────────────────────────────────────────
/**
 * Synthesize text → save two files:
 *   outputPath        (.pcm) — raw PCM for ESP32
 *   outputPath + .wav (.wav) — WAV with header for browser
 *
 * @param {string} text
 * @param {string} outputPath  — path ending in .pcm
 * @returns {Promise<number>}  — duration in ms
 */
async function synthesize(text, outputPath) {
    if (!FOLDER_ID || !API_KEY) {
        throw new Error('Yandex TTS: YANDEX_FOLDER_ID or YANDEX_API_KEY not set');
    }

    const pcmBuffer = await requestYandexTTS(text);

    // Save raw PCM for ESP32
    fs.writeFileSync(outputPath, pcmBuffer);

    // Save WAV for browser (same base path, .wav extension)
    const wavPath   = outputPath.replace(/\.pcm$/, '.wav');
    const wavBuffer = Buffer.concat([buildWavHeader(pcmBuffer.length), pcmBuffer]);
    fs.writeFileSync(wavPath, wavBuffer);

    const durationMs = Math.ceil((pcmBuffer.length / (SAMPLE_RATE * 2)) * 1000);
    logger.info(`[TTS] alena: ${pcmBuffer.length} bytes PCM, ~${durationMs}ms`);
    return durationMs;
}

module.exports = { synthesize };
