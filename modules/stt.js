 'use strict';

const fs = require('fs');
const OpenAI = require('openai');
const Groq = require('groq-sdk');
const logger = require('./logger');

let openaiClient = null;
let groqClient = null;

const STT_PROVIDER = process.env.STT_PROVIDER || 'openai';
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS = 16;
const BYTES_PER_SAMPLE = BITS / 8;

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

async function transcribe(pcmPath) {
    const startedAt = Date.now();

    const pcmData = fs.readFileSync(pcmPath);
    const wavData = Buffer.concat([buildWavHeader(pcmData.length), pcmData]);
    const wavPath = pcmPath.replace(/\.pcm$/, '.wav');

    fs.writeFileSync(wavPath, wavData);

    try {
        let response;

        if (STT_PROVIDER === 'groq') {
            if (!process.env.GROQ_API_KEY) {
                throw new Error('GROQ_API_KEY is not set');
            }

            if (!groqClient) {
                groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
            }

            response = await groqClient.audio.transcriptions.create({
                file: fs.createReadStream(wavPath),
                model: GROQ_STT_MODEL,
                response_format: 'json',
                temperature: 0,
            });

            logger.info(`[STT] provider=groq model=${GROQ_STT_MODEL} duration_ms=${Date.now() - startedAt}`);
        } else {
            if (!process.env.OPENAI_API_KEY) {
                throw new Error('OPENAI_API_KEY is not set');
            }

            if (!openaiClient) {
                openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            }

            response = await openaiClient.audio.transcriptions.create({
                file: fs.createReadStream(wavPath),
                model: 'whisper-1',
            });

            logger.info(`[STT] provider=openai model=whisper-1 duration_ms=${Date.now() - startedAt}`);
        }

        return (response.text || '').trim();
    } finally {
        fs.unlink(wavPath, () => {});
    }
}

module.exports = { transcribe };
