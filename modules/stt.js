 'use strict';

const fs = require('fs');
const logger = require('./logger');

let openaiClient = null;
let groqClient = null;

const STT_PROVIDER = String(process.env.STT_PROVIDER || 'openai').trim().toLowerCase();
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
const OPENAI_STT_MODEL = 'whisper-1';

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

async function transcribe(pcmPath) {
    const startedAt = Date.now();

    const pcmData = fs.readFileSync(pcmPath);
    const wavData = Buffer.concat([buildWavHeader(pcmData.length), pcmData]);
    const wavPath = /\.pcm$/i.test(pcmPath) ? pcmPath.replace(/\.pcm$/i, '.wav') : `${pcmPath}.wav`;

    fs.writeFileSync(wavPath, wavData);

    try {
        const provider = getProvider();
        let response;

        if (provider === 'groq') {
            response = await getGroqClient().audio.transcriptions.create({
                file: fs.createReadStream(wavPath),
                model: GROQ_STT_MODEL,
                response_format: 'json',
                temperature: 0,
            });

            logger.info(`[STT] provider=groq model=${GROQ_STT_MODEL} duration_ms=${Date.now() - startedAt}`);
        } else {
            response = await getOpenAIClient().audio.transcriptions.create({
                file: fs.createReadStream(wavPath),
                model: OPENAI_STT_MODEL,
            });

            logger.info(`[STT] provider=openai model=${OPENAI_STT_MODEL} duration_ms=${Date.now() - startedAt}`);
        }

        return (response.text || '').trim();
    } finally {
        fs.rmSync(wavPath, { force: true });
    }
}

module.exports = { transcribe };
