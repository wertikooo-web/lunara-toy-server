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
const memory   = require('./modules/memory');
const content  = require('./modules/content');
const storyEngine = require('./modules/storyEngine');

// ── Directories ──────────────────────────────────────────────────────────────
const DIR_AUDIO   = path.join(__dirname, 'audio');
const DIR_UPLOADS = path.join(__dirname, 'uploads');
const DIR_CONTENT_AUDIO = path.join(DIR_AUDIO, 'content');
[DIR_AUDIO, DIR_UPLOADS, DIR_CONTENT_AUDIO].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Express (static audio files) ─────────────────────────────────────────────
const app = express();
// CORS — allow browser demo client
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-session-id, x-device-id');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use('/audio', express.static(DIR_AUDIO, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.pcm')) {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', 'attachment');
        }
    }
}));
app.use('/', express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/content/stats', async (_req, res) => {
    try {
        res.json(await content.stats());
    } catch (err) {
        logger.error(`[Content] stats error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// ── /chat endpoint — for browser demo client ─────────────────────────────────
app.use(express.json());
app.post('/chat', async (req, res) => {
    const text = (req.body?.text || '').trim();
    const lang = req.body?.lang || 'ru-RU';
    const requestedModel = req.body?.model || 'auto';
    if (!text) {
        return res.status(400).json({ error: 'text is required' });
    }

    const ts = Date.now();
    const deviceId = memory.normalizeDeviceId(req.headers['x-device-id'] || req.body?.device_id);
    // Use a fixed key for demo client history (browser session)
    const sessionKey = req.headers['x-session-id'] || deviceId;
    if (!demoSessions.has(sessionKey)) {
        demoSessions.set(sessionKey, {});
    }
    const sessionRef = demoSessions.get(sessionKey);
    const baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

    try {
        const pendingAnswer = content.checkPendingAnswer(sessionRef.pendingContent, text);
        if (pendingAnswer?.nextRiddle) {
            sessionRef.pendingContent = null;
            const shortContent = await content.tryHandleShortRequest('загадай загадку', {
                baseUrl,
                lang: pendingAnswer.lang || lang,
            });
            if (shortContent) {
                sessionRef.pendingContent = content.pendingFromItem(shortContent.item);
                return res.json({
                    reply: shortContent.reply,
                    audio_url: shortContent.audioUrl,
                    duration_ms: shortContent.durationMs,
                    device_id: deviceId,
                    content_id: shortContent.item.id,
                    content_type: shortContent.item.type,
                    cached_audio: shortContent.cached,
                    ...cachedModelMeta(),
                });
            }
        }
        if (pendingAnswer) {
            if (!pendingAnswer.keepPending) {
                sessionRef.pendingContent = null;
            }
            const audio = await content.ensureCachedReply(pendingAnswer.reply, {
                baseUrl,
                lang: pendingAnswer.lang || lang,
                key: `riddle_${pendingAnswer.correct === true ? 'correct' : pendingAnswer.correct === false ? 'answer' : 'command'}`,
            });
            return res.json({
                reply: pendingAnswer.reply,
                audio_url: audio.audioUrl,
                duration_ms: audio.durationMs,
                device_id: deviceId,
                content_answer: true,
                correct: pendingAnswer.correct,
                cached_audio: audio.cached,
                ...cachedModelMeta(),
            });
        }

        const clarification = content.getClarification(text);
        if (clarification) {
            const audio = await content.ensureCachedReply(clarification.reply, {
                baseUrl,
                lang: clarification.lang || lang,
                key: 'clarification',
            });
            return res.json({
                reply: clarification.reply,
                audio_url: audio.audioUrl,
                duration_ms: audio.durationMs,
                device_id: deviceId,
                needs_clarification: true,
                cached_audio: audio.cached,
                ...cachedModelMeta(),
            });
        }

        const shortContent = await content.tryHandleShortRequest(text, { baseUrl, lang });
        if (shortContent) {
            sessionRef.pendingContent = content.pendingFromItem(shortContent.item);
            return res.json({
                reply: shortContent.reply,
                audio_url: shortContent.audioUrl,
                duration_ms: shortContent.durationMs,
                device_id: deviceId,
                content_id: shortContent.item.id,
                content_type: shortContent.item.type,
                cached_audio: shortContent.cached,
                ...cachedModelMeta(),
            });
        }

        const profile = await memory.getProfile(deviceId);
        const memoryContext = memory.formatProfileForPrompt(profile);
        const story = await storyEngine.buildStoryContext(text);
        const followupContext = !story && sessionRef.lastContentMode === 'story'
            ? storyEngine.buildStoryFollowupContext(text)
            : '';

        // LLM
        const llmResult = story
            ? await llm.chat(sessionRef, story.prompt, lang, {
                memoryContext,
                contentContext: story.contentContext,
                maxTokens: story.maxTokens,
                model: requestedModel,
                routingText: text,
                isStory: true,
                returnMeta: true,
            })
            : await llm.chat(sessionRef, text, lang, {
                memoryContext,
                contentContext: followupContext,
                model: requestedModel,
                routingText: text,
                returnMeta: true,
            });
        const reply = llmResult.reply;

        // TTS
        const outputPath = path.join(DIR_AUDIO, `response_${ts}.pcm`);
        const durationMs = await tts.synthesize(reply, outputPath, lang);
        const audioUrl = `${baseUrl}/audio/response_${ts}.wav`;

        res.json({
            reply,
            audio_url: audioUrl,
            duration_ms: durationMs,
            device_id: deviceId,
            content_type: story ? 'story' : undefined,
            model_used: llmResult.model_used,
            provider: llmResult.provider,
            latency_ms: llmResult.latency_ms,
            requested_model: llmResult.requested_model,
            router_choice: llmResult.router_choice,
            fallback: llmResult.fallback,
            fallback_reason: llmResult.fallback_reason,
            continued: llmResult.continued,
        });
        sessionRef.lastContentMode = story ? 'story' : null;
        memory.rememberFromText(deviceId, text, profile)
            .catch(err => logger.warn(`[Memory] auto-update failed: ${err.message}`));
    } catch (err) {
        logger.error(`[/chat] error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

function cachedModelMeta() {
    return {
        model_used: null,
        provider: 'content_cache',
        latency_ms: 0,
    };
}

// Demo session storage (in-memory, keyed by x-session-id header)
const demoSessions = new Map();

async function synthesizeReply(reply, ts, lang, baseUrl) {
    const outputPath = path.join(DIR_AUDIO, `response_${ts}.pcm`);
    const durationMs = await tts.synthesize(reply, outputPath, lang);
    const audioUrl = `${baseUrl}/audio/response_${ts}.wav`;
    return { audioUrl, durationMs };
}


const server = http.createServer(app);

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    const url = new URL(req.url || '/', 'http://localhost');
    const deviceId = memory.normalizeDeviceId(url.searchParams.get('device_id'));
    logger.info(`[WS] ESP32 connected from ${clientIp} device_id=${deviceId}`);

    // Per-connection state
    const state = {
        status:       'IDLE',       // IDLE | RECORDING | PROCESSING
        audioChunks:  [],           // Buffer[] — incoming PCM chunks
        audioBytes:   0,            // total bytes received
        generation:   0,            // номер запроса; растёт на каждую новую запись (для перебивания)
        pendingContent: null,
        lastContentMode: null,
    };

    // ── Heartbeat — WebSocket protocol ping (binary, not JSON) ────────────────
    let isAlive = true;
    const heartbeatInterval = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
            clearInterval(heartbeatInterval);
            return;
        }
        if (!isAlive) {
            logger.warn('[WS] No pong — terminating dead connection');
            clearInterval(heartbeatInterval);
            ws.terminate();
            return;
        }
        isAlive = false;
        ws.ping(Buffer.alloc(0)); // WebSocket protocol ping — NOT a JSON message
    }, 30000);

    ws.on('pong', () => { isAlive = true; });

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
    {
        const baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
        const greetingUrl = `${baseUrl}/audio/greeting_ru.wav`;
        send({
            type:         'ready',
            name:         'Lumi',
            device_id:    deviceId,
            greeting_url: greetingUrl,
        });
    }

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
            const raw = data.toString('utf8').substring(0, 50);
            logger.warn(`[WS] JSON parse error: ${e.message} | raw: ${JSON.stringify(raw)}`);
            return;
        }

        logger.info(`[WS] received: ${msg.type}`);

        switch (msg.type) {

        case 'start':
            if (state.status === 'RECORDING') {
                logger.warn('[WS] "start" received but already RECORDING — ignored');
                return;
            }
            if (state.status === 'PROCESSING') {
                // Barge-in: ребёнок перебивает, пока сервер думает над прошлым ответом.
                // Поднимаем поколение — результат старого пайплайна будет отброшен.
                logger.info('[WS] "start" during PROCESSING — interrupting previous response');
            }
            state.generation += 1;      // новое поколение запроса
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
                logger.info('[WS] audio too short — Lumi gently asks to repeat');
                const r = retryAudioCommand();
                sendAudio(r.url, r.durationMs);
                state.status      = 'IDLE';
                state.audioChunks = [];
                state.audioBytes  = 0;
                return;
            }
            state.status = 'PROCESSING';
            sendStatus('processing');
            {
                const myGen = state.generation;
                // Иногда заполняем паузу обработки «мыслительным» звуком (случайной фразой).
                // Настоящий ответ Lumi придёт через ~2 сек и естественно прервёт его.
                const t = thinkingAudioCommand();
                if (t) sendAudio(t.url, t.durationMs);
                await handlePipeline(ws, state, send, sendStatus, sendAudio, sendError, myGen, deviceId);
            }
            break;

        case 'ping':
            send({ type: 'pong' });
            break;

        case 'reset':
            state.status      = 'IDLE';
            state.audioChunks = [];
            state.audioBytes  = 0;
            state.pendingContent = null;
            state.lastContentMode = null;
            llm.resetHistory(ws);
            logger.info('[WS] dialog reset');
            send({ type: 'ready', name: 'Lumi' });
            break;

        default:
            logger.debug(`[WS] unknown message type: ${msg.type}`);
        }
    });

    ws.on('close', () => {
        clearInterval(heartbeatInterval);
        llm.resetHistory(ws);
        logger.info('[WS] ESP32 disconnected');
    });

    ws.on('error', err => {
        logger.error(`[WS] socket error: ${err.message}`);
    });
});

// ── AI Pipeline ───────────────────────────────────────────────────────────────
async function handlePipeline(
    ws,
    state,
    send,
    sendStatus,
    sendAudio,
    sendError,
    myGen,
    deviceId
) {
    const ts = Date.now();

    // Актуален ли ещё этот пайплайн? Если ребёнок начал новую запись (перебил),
    // поколение вырастет, и результат этого (устаревшего) пайплайна нужно отбросить.
    const isCurrent = () => myGen === state.generation;

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

        if (!isCurrent()) {
            logger.info('[Pipeline] superseded after STT — discarding (child interrupted)');
            return; // finally{} НЕ тронет статус, т.к. нас перебили
        }

        if (!transcript || transcript.trim().length === 0) {
            logger.info('[Pipeline] empty transcript — Lumi gently asks to repeat');
            const r = retryAudioCommand();
            sendAudio(r.url, r.durationMs);
            return; // finally{} сбросит state в IDLE и удалит upload
        }

        // 4. LLM — Claude
        sendStatus('responding');
        const baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
        const pendingAnswer = content.checkPendingAnswer(state.pendingContent, transcript);
        if (pendingAnswer?.nextRiddle) {
            state.pendingContent = null;
            const shortContent = await content.tryHandleShortRequest('загадай загадку', {
                baseUrl,
                lang: pendingAnswer.lang || 'auto',
            });
            if (shortContent) {
                if (!isCurrent()) {
                    logger.info('[Pipeline] superseded after next riddle — discarding (child interrupted)');
                    return;
                }
                state.pendingContent = content.pendingFromItem(shortContent.item);
                sendAudio(shortContent.audioUrl, shortContent.durationMs);
                logger.info(`[Pipeline] sent next riddle content: ${shortContent.item.id} cached=${shortContent.cached}`);
                return;
            }
        }
        if (pendingAnswer) {
            if (!pendingAnswer.keepPending) {
                state.pendingContent = null;
            }
            logger.info(`[Pipeline] content answer correct=${pendingAnswer.correct}`);
            const audio = await content.ensureCachedReply(pendingAnswer.reply, {
                baseUrl,
                lang: pendingAnswer.lang || 'auto',
                key: `riddle_${pendingAnswer.correct === true ? 'correct' : pendingAnswer.correct === false ? 'answer' : 'command'}`,
            });

            if (!isCurrent()) {
                logger.info('[Pipeline] superseded after content answer — discarding (child interrupted)');
                return;
            }

            sendAudio(audio.audioUrl, audio.durationMs);
            return;
        }

        const clarification = content.getClarification(transcript);
        if (clarification) {
            logger.info('[Pipeline] content clarification requested');
            const audio = await content.ensureCachedReply(clarification.reply, {
                baseUrl,
                lang: clarification.lang || 'auto',
                key: 'clarification',
            });

            if (!isCurrent()) {
                logger.info('[Pipeline] superseded after content clarification — discarding (child interrupted)');
                return;
            }

            sendAudio(audio.audioUrl, audio.durationMs);
            return;
        }

        const shortContent = await content.tryHandleShortRequest(transcript, { baseUrl, lang: 'auto' });
        if (shortContent) {
            if (!isCurrent()) {
                logger.info('[Pipeline] superseded after content cache — discarding (child interrupted)');
                return;
            }
            state.pendingContent = content.pendingFromItem(shortContent.item);
            sendAudio(shortContent.audioUrl, shortContent.durationMs);
            logger.info(`[Pipeline] sent cached content audio: ${shortContent.item.id} cached=${shortContent.cached}`);
            return;
        }

        logger.info('[Pipeline] LLM start…');
        const profile = await memory.getProfile(deviceId);
        const memoryContext = memory.formatProfileForPrompt(profile);
        const story = await storyEngine.buildStoryContext(transcript);
        const followupContext = !story && state.lastContentMode === 'story'
            ? storyEngine.buildStoryFollowupContext(transcript)
            : '';
        const reply = story
            ? await llm.chat(ws, story.prompt, 'auto', {
                memoryContext,
                contentContext: story.contentContext,
                maxTokens: story.maxTokens,
                model: 'auto',
                routingText: transcript,
                isStory: true,
            })
            : await llm.chat(ws, transcript, 'auto', {
                memoryContext,
                contentContext: followupContext,
                model: 'auto',
                routingText: transcript,
            });
        logger.info(`[Pipeline] reply: "${reply}"`);

        if (!isCurrent()) {
            logger.info('[Pipeline] superseded after LLM — discarding (child interrupted)');
            return;
        }

        // 5. TTS — Google
        logger.info('[Pipeline] TTS start…');
        const outputPath = path.join(DIR_AUDIO, `response_${ts}.pcm`);
        const durationMs = await tts.synthesize(reply, outputPath, null); // null = auto-detect
        logger.info(`[Pipeline] TTS saved: ${outputPath}, ~${durationMs}ms`);

        if (!isCurrent()) {
            logger.info('[Pipeline] superseded after TTS — discarding (child interrupted)');
            return;
        }

        // 6. Build public URL and notify ESP32
        const audioUrl = `${baseUrl}/audio/response_${ts}.wav`;

        sendAudio(audioUrl, durationMs);
        logger.info(`[Pipeline] sent audio command: ${audioUrl}`);
        state.lastContentMode = story ? 'story' : null;
        memory.rememberFromText(deviceId, transcript, profile)
            .catch(err => logger.warn(`[Memory] auto-update failed: ${err.message}`));

    } catch (err) {
        logger.error(`[Pipeline] error: ${err.message}`);
        if (isCurrent()) sendError('Processing error');
    } finally {
        // Clean up upload immediately
        fs.unlink(uploadPath, () => {});
        // Возвращаем в IDLE ТОЛЬКО если нас не перебили — иначе новая запись уже
        // владеет состоянием (status='RECORDING'), и затирать его нельзя.
        if (isCurrent()) state.status = 'IDLE';
    }
}


// ── Pre-generate greeting PCM ─────────────────────────────────────────────────
const GREETING_TEXT = 'Привет! Я Луми. Нажми кнопку и говори!';
const GREETING_FILE = path.join(DIR_AUDIO, 'greeting_ru.pcm');

// Тёплая просьба повторить — играется когда нажатие слишком короткое
// или речь не распозналась. Lumi не выдаёт сухую ошибку, а ласково просит ещё разок.
const RETRY_TEXT = 'Ой! Скажи ещё разочек, пожалуйста? Я очень хочу тебя послушать!';
const RETRY_FILE = path.join(DIR_AUDIO, 'retry_ru.pcm');

// Собирает команду воспроизведения для кешированного retry-аудио.
function retryAudioCommand() {
    const baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
    const url = `${baseUrl}/audio/retry_ru.wav`;
    let durationMs = 1500; // запасное значение, если файл ещё не готов
    try {
        const bytes = fs.statSync(RETRY_FILE).size;
        durationMs = Math.ceil((bytes / (16000 * 2)) * 1000);
    } catch (_) { /* файл ещё не сгенерирован — отдаём запасную длительность */ }
    return { url, durationMs };
}

async function ensureRetry() {
    if (fs.existsSync(RETRY_FILE)) {
        logger.info('[Retry] Using cached retry_ru.pcm');
        return;
    }
    try {
        logger.info('[Retry] Generating retry_ru.pcm...');
        await tts.synthesize(RETRY_TEXT, RETRY_FILE, 'ru-RU');
        logger.info('[Retry] retry_ru.pcm ready');
    } catch (err) {
        logger.error(`[Retry] Failed to generate: ${err.message}`);
    }
}

// Короткий «мыслительный» звук — иногда играется в момент начала обработки,
// чтобы заполнить паузу. Настоящий ответ Lumi его прерывает (так устроено устройство).
// Несколько фраз + случайность, чтобы не звучало как заевшая пластинка.
const THINKING_CHANCE = 0.35; // как часто вообще играть думалку (0..1)
const THINKING_PHRASES = [
    { text: 'Хм, дай-ка подумать...', file: 'thinking_1_ru' },
    { text: 'Секундочку...',          file: 'thinking_2_ru' },
    { text: 'Ой, интересно...',       file: 'thinking_3_ru' },
    { text: 'Так-так, дай подумаю...', file: 'thinking_4_ru' },
];

// Решает, играть ли думалку, и если да — возвращает случайную фразу.
// Возвращает null, когда в этот раз думалку играть не надо.
function thinkingAudioCommand() {
    if (Math.random() >= THINKING_CHANCE) return null;

    const phrase  = THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
    const baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
    const url     = `${baseUrl}/audio/${phrase.file}.wav`;

    let durationMs = 1200;
    try {
        const bytes = fs.statSync(path.join(DIR_AUDIO, `${phrase.file}.pcm`)).size;
        durationMs = Math.ceil((bytes / (16000 * 2)) * 1000);
    } catch (_) { /* файл ещё не готов — запасная длительность */ }
    return { url, durationMs };
}

async function ensureThinking() {
    for (const phrase of THINKING_PHRASES) {
        const pcmPath = path.join(DIR_AUDIO, `${phrase.file}.pcm`);
        if (fs.existsSync(pcmPath)) {
            logger.info(`[Thinking] Using cached ${phrase.file}.pcm`);
            continue;
        }
        try {
            logger.info(`[Thinking] Generating ${phrase.file}.pcm...`);
            await tts.synthesize(phrase.text, pcmPath, 'ru-RU');
            logger.info(`[Thinking] ${phrase.file}.pcm ready`);
        } catch (err) {
            logger.error(`[Thinking] Failed to generate ${phrase.file}: ${err.message}`);
        }
    }
}

async function ensureGreeting() {
    if (fs.existsSync(GREETING_FILE)) {
        logger.info('[Greeting] Using cached greeting_ru.pcm');
        return;
    }
    try {
        logger.info('[Greeting] Generating greeting_ru.pcm...');
        await tts.synthesize(GREETING_TEXT, GREETING_FILE, 'ru-RU');
        logger.info('[Greeting] greeting_ru.pcm ready');
    } catch (err) {
        logger.error(`[Greeting] Failed to generate: ${err.message}`);
    }
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    logger.info(`Lunara TOY server listening on port ${PORT}`);
    await memory.init();
    await content.init({ audioDir: DIR_CONTENT_AUDIO });
    cleaner.start(DIR_AUDIO, 10 * 60 * 1000, ['greeting_ru.pcm', 'greeting_ru.wav', 'retry_ru.pcm', 'retry_ru.wav', 'thinking_1_ru.pcm', 'thinking_1_ru.wav', 'thinking_2_ru.pcm', 'thinking_2_ru.wav', 'thinking_3_ru.pcm', 'thinking_3_ru.wav', 'thinking_4_ru.pcm', 'thinking_4_ru.wav']); // clean /audio/ every 10 min, keep greeting + retry + thinking phrases
    await ensureGreeting();
    await ensureRetry();
    await ensureThinking();
});
