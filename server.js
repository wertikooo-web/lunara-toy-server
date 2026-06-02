'use strict';

require('dotenv').config();

const express   = require('express');
const http      = require('http');
const path      = require('path');
const fs        = require('fs');
const { WebSocketServer, WebSocket } = require('ws');

const stt      = require('./modules/stt');
const llm      = require('./modules/llm');
const tts      = require('./modules/tts');
const cleaner  = require('./modules/cleaner');
const logger   = require('./modules/logger');

// ── Directories ──────────────────────────────────────────────────────────────
const DIR_AUDIO   = path.join(__dirname, 'audio');
const DIR_UPLOADS = path.join(__dirname, 'uploads');
[DIR_AUDIO, DIR_UPLOADS].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Express (static audio files) ─────────────────────────────────────────────
const app = express();
// CORS — allow browser demo client
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-session-id');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use('/audio', express.static(DIR_AUDIO));
app.use('/', express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── /chat endpoint — for browser demo client ─────────────────────────────────
app.use(express.json());
app.post('/chat', async (req, res) => {
    const text = (req.body?.text || '').trim();
    const lang = req.body?.lang || 'ru-RU';
    if (!text) {
        return res.status(400).json({ error: 'text is required' });
    }

    const ts = Date.now();
    // Use a fixed key for demo client history (browser session)
    const sessionKey = req.headers['x-session-id'] || 'demo';
    if (!demoSessions.has(sessionKey)) {
        demoSessions.set(sessionKey, {});
    }
    const sessionRef = demoSessions.get(sessionKey);

    try {
        // LLM
        const reply = await llm.chat(sessionRef, text, lang);

        // TTS
        const outputPath = path.join(DIR_AUDIO, `response_${ts}.pcm`);
        const durationMs = await tts.synthesize(reply, outputPath, lang);
        const baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
        const audioUrl = `${baseUrl}/audio/response_${ts}.wav`;

        res.json({ reply, audio_url: audioUrl, duration_ms: durationMs });
    } catch (err) {
        logger.error(`[/chat] error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Demo session storage (in-memory, keyed by x-session-id header)
const demoSessions = new Map();


const server = http.createServer(app);

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    logger.info(`[WS] ESP32 connected from ${clientIp}`);

    // Per-connection state
    const state = {
        status:       'IDLE',       // IDLE | RECORDING | PROCESSING
        audioChunks:  [],           // Buffer[] — incoming PCM chunks
        audioBytes:   0,            // total bytes received
    };

    // ── Send helpers ─────────────────────────────────────────────────────────
    function send(obj) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify(obj));
    }

    function sendStatus(stateName) {
        send({ type: 'status', state: stateName });
    }

    function sendError(message) {
        logger.warn(`[WS] error → ESP32: ${message}`);
        send({ type: 'error', message });
        state.status = 'IDLE';
        state.audioChunks = [];
        state.audioBytes  = 0;
    }

    function sendAudio(url, durationMs, sampleRate = 16000) {
        send({
            type:        'audio',
            url,
            duration_ms: durationMs,
            sample_rate: sampleRate,
            channels:    1,
            bits:        16,
        });
    }

    // ── Greeting ─────────────────────────────────────────────────────────────
    send({
        type:      'ready',
        assistant: { name: 'Lumi', greeting: 'Привет! Я Луми. Нажми кнопку и говори!' },
    });

    // ── Message handler ───────────────────────────────────────────────────────
    ws.on('message', async (data, isBinary) => {
        // Binary frame — PCM audio chunk from ESP32
        if (isBinary) {
            if (state.status !== 'RECORDING') {
                logger.debug('[WS] binary frame ignored — not in RECORDING state');
                return;
            }
            state.audioChunks.push(Buffer.from(data));
            state.audioBytes += data.length;
            return;
        }

        // Text frame — JSON command
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch (e) {
            logger.warn(`[WS] JSON parse error: ${e.message}`);
            return;
        }

        switch (msg.type) {

        case 'start':
            if (state.status !== 'IDLE') {
                logger.warn('[WS] "start" received but not IDLE — ignored');
                return;
            }
            state.status      = 'RECORDING';
            state.audioChunks = [];
            state.audioBytes  = 0;
            logger.info('[WS] recording started');
            sendStatus('listening');
            break;

        case 'end':
            if (state.status !== 'RECORDING') {
                logger.warn('[WS] "end" received but not RECORDING — ignored');
                return;
            }
            if (state.audioBytes < 1600) {
                sendError('Audio too short');
                return;
            }
            state.status = 'PROCESSING';
            sendStatus('processing');
            await handlePipeline(ws, state, send, sendAudio, sendError);
            break;

        case 'ping':
            send({ type: 'pong' });
            break;

        case 'reset':
            state.status      = 'IDLE';
            state.audioChunks = [];
            state.audioBytes  = 0;
            llm.resetHistory(ws);
            logger.info('[WS] dialog reset');
            send({ type: 'ready', assistant: { name: 'Lumi' } });
            break;

        default:
            logger.debug(`[WS] unknown message type: ${msg.type}`);
        }
    });

    ws.on('close', () => {
        llm.resetHistory(ws);
        logger.info('[WS] ESP32 disconnected');
    });

    ws.on('error', err => {
        logger.error(`[WS] socket error: ${err.message}`);
    });
});

// ── AI Pipeline ───────────────────────────────────────────────────────────────
async function handlePipeline(ws, state, send, sendAudio, sendError) {
    const ts = Date.now();

    // 1. Merge PCM chunks
    const pcmBuffer  = Buffer.concat(state.audioChunks);
    state.audioChunks = [];
    state.audioBytes  = 0;

    const uploadPath = path.join(DIR_UPLOADS, `input_${ts}.pcm`);

    try {
        // 2. Save incoming PCM
        fs.writeFileSync(uploadPath, pcmBuffer);
        logger.info(`[Pipeline] saved input PCM: ${pcmBuffer.length} bytes`);

        // 3. STT — Whisper
        logger.info('[Pipeline] STT start…');
        const transcript = await stt.transcribe(uploadPath);
        logger.info(`[Pipeline] transcript: "${transcript}"`);

        if (!transcript || transcript.trim().length === 0) {
            sendError('Speech not recognized');
            return;
        }

        // 4. LLM — Claude
        sendStatus('responding');
        logger.info('[Pipeline] LLM start…');
        const reply = await llm.chat(ws, transcript);
        logger.info(`[Pipeline] reply: "${reply}"`);

        // 5. TTS — Google
        logger.info('[Pipeline] TTS start…');
        const outputPath = path.join(DIR_AUDIO, `response_${ts}.pcm`);
        const durationMs = await tts.synthesize(reply, outputPath, lang);
        logger.info(`[Pipeline] TTS saved: ${outputPath}, ~${durationMs}ms`);

        // 6. Build public URL and notify ESP32
        const baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
        const audioUrl = `${baseUrl}/audio/response_${ts}.wav`;

        sendAudio(audioUrl, durationMs);
        logger.info(`[Pipeline] sent audio command: ${audioUrl}`);

    } catch (err) {
        logger.error(`[Pipeline] error: ${err.message}`);
        sendError('Processing error');
    } finally {
        // Clean up upload immediately
        fs.unlink(uploadPath, () => {});
        state.status = 'IDLE';
    }
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    logger.info(`Lunara TOY server listening on port ${PORT}`);
    cleaner.start(DIR_AUDIO, 10 * 60 * 1000); // clean /audio/ every 10 min
});
