'use strict';

/**
 * STT — Speech-to-Text via OpenAI Whisper API
 *
 * Input:  path to raw PCM16 LE, mono, 16000 Hz file
 * Output: transcribed string
 *
 * Whisper API requires an audio file with a proper container format.
 * We wrap the raw PCM in a WAV header before sending.
 */

const fs      = require('fs');
const path    = require('path');
const OpenAI  = require('openai');
const logger  = require('./logger');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// WAV parameters — must match ESP32 recording format (see config.h)
const SAMPLE_RATE  = 16000;
const CHANNELS     = 1;
const BITS         = 16;
const BYTES_PER_SAMPLE = BITS / 8;

/**
 * Build a minimal WAV header for raw PCM data.
 * @param {number} pcmByteLength
 * @returns {Buffer} 44-byte WAV header
 */
function buildWavHeader(pcmByteLength) {
    const header = Buffer.alloc(44);
    const byteRate    = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
    const blockAlign  = CHANNELS * BYTES_PER_SAMPLE;

    header.write('RIFF',                  0, 'ascii');
    header.writeUInt32LE(36 + pcmByteLength, 4);   // ChunkSize
    header.write('WAVE',                  8, 'ascii');
    header.write('fmt ',                 12, 'ascii');
    header.writeUInt32LE(16,             16);       // Subchunk1Size (PCM)
    header.writeUInt16LE(1,              20);       // AudioFormat (PCM = 1)
    header.writeUInt16LE(CHANNELS,       22);
    header.writeUInt32LE(SAMPLE_RATE,    24);
    header.writeUInt32LE(byteRate,       28);
    header.writeUInt16LE(blockAlign,     32);
    header.writeUInt16LE(BITS,           34);
    header.write('data',                 36, 'ascii');
    header.writeUInt32LE(pcmByteLength,  40);

    return header;
}

/**
 * Wrap raw PCM file in WAV container, transcribe via Whisper.
 * @param {string} pcmPath  — path to raw PCM file
 * @returns {Promise<string>} — transcribed text
 */
async function transcribe(pcmPath) {
    const pcmData  = fs.readFileSync(pcmPath);
    const wavData  = Buffer.concat([buildWavHeader(pcmData.length), pcmData]);

    // Write temp WAV file next to the PCM file
    const wavPath  = pcmPath.replace(/\.pcm$/, '.wav');
    fs.writeFileSync(wavPath, wavData);

    try {
        const response = await client.audio.transcriptions.create({
            file:     fs.createReadStream(wavPath),
            model:    'whisper-1',
            language: 'ru',          // primary language; remove for auto-detect
        });
        return response.text.trim();
    } finally {
        // Clean up temp WAV
        fs.unlink(wavPath, () => {});
    }
}

module.exports = { transcribe };
