'use strict';

/**
 * TTS — Yandex SpeechKit
 *
 * Input:  text string
 * Output: saves raw PCM16 LE, mono, 16000 Hz to outputPath
 *         returns duration in milliseconds
 *
 * API docs: https://cloud.yandex.ru/docs/speechkit/tts/request
 * Endpoint: https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize
 *
 * Yandex возвращает OggOpus по умолчанию.
 * Мы запрашиваем LPCM (raw PCM, без заголовка) напрямую — ffmpeg не нужен.
 */

const https  = require('https');
const fs     = require('fs');
const logger = require('./logger');

const YANDEX_TTS_URL  = 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize';
const FOLDER_ID       = process.env.YANDEX_FOLDER_ID;   // ID каталога в Yandex Cloud
const API_KEY         = process.env.YANDEX_API_KEY;      // API-ключ сервисного аккаунта

const VOICE           = 'alena';      // голос Маша
const EMOTION         = 'friendly';   // friendly | neutral | evil
const SPEED           = '1.0';        // 0.1 – 3.0
const SAMPLE_RATE     = 16000;        // Hz — должно совпадать с I2S на ESP32
const FORMAT          = 'lpcm';       // lpcm = raw PCM16 LE без заголовка

/**
 * Выполняет HTTP POST запрос к Yandex TTS API.
 * @param {string} text
 * @returns {Promise<Buffer>} — raw PCM16 LE буфер
 */
function requestYandexTTS(text) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams({
            text,
            voice:           VOICE,
            emotion:         EMOTION,
            speed:           SPEED,
            format:          FORMAT,
            sampleRateHertz: String(SAMPLE_RATE),
            folderId:        FOLDER_ID,
        }).toString();

        const options = {
            method:  'POST',
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
                res.on('end', () => {
                    reject(new Error(
                        `Yandex TTS error ${res.statusCode}: ${errBody}`
                    ));
                });
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

/**
 * Синтезировать текст → PCM файл.
 * @param {string} text        — текст для синтеза
 * @param {string} outputPath  — путь для записи .pcm файла
 * @returns {Promise<number>}  — длительность в миллисекундах
 */
async function synthesize(text, outputPath) {
    if (!FOLDER_ID || !API_KEY) {
        throw new Error(
            'Yandex TTS: YANDEX_FOLDER_ID or YANDEX_API_KEY not set in environment'
        );
    }

    const pcmBuffer = await requestYandexTTS(text);
    fs.writeFileSync(outputPath, pcmBuffer);

    // Расчёт длительности: bytes / (sample_rate * bytes_per_sample * channels) * 1000
    const durationMs = Math.ceil(
        (pcmBuffer.length / (SAMPLE_RATE * 2 * 1)) * 1000
    );

    logger.info(`[TTS] Yandex masha: ${pcmBuffer.length} bytes, ~${durationMs}ms`);
    return durationMs;
}

module.exports = { synthesize };
