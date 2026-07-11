'use strict';

require('dotenv').config();

const express   = require('express');
const http      = require('http');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const stt      = require('./modules/stt');
const llm      = require('./modules/llm');
const tts      = require('./modules/tts');
const cleaner  = require('./modules/cleaner');
const logger   = require('./modules/logger');
const memory   = require('./modules/memory');
const content  = require('./modules/content');
const storyEngine = require('./modules/storyEngine');
const parentConfig = require('./modules/parentConfig');
const riddleEngine = require('./modules/riddleEngine');
let server = null;
let shuttingDown = false;
const breakReminderSent = new Set();

function formatFatalError(err) {
    if (err instanceof Error) return err.stack || err.message;
    try {
        return JSON.stringify(err);
    } catch (_jsonErr) {
        return String(err);
    }
}

function requestProcessRestart(reason, err) {
    logger.error(`[Process] ${reason}: ${formatFatalError(err)}`);
    if (shuttingDown) return;
    shuttingDown = true;

    setTimeout(() => {
        logger.error(`[Process] forcing exit after ${reason}`);
        process.exit(1);
    }, 3000).unref();

    if (server?.listening) {
        server.close(() => {
            logger.error(`[Process] closed server after ${reason}`);
            process.exit(1);
        });
        return;
    }

    process.exit(1);
}

process.on('unhandledRejection', (reason) => {
    requestProcessRestart('unhandledRejection', reason);
});

process.on('uncaughtException', (err) => {
    requestProcessRestart('uncaughtException', err);
});

// ── Directories ──────────────────────────────────────────────────────────────
const DIR_AUDIO   = process.env.AUDIO_DIR ? path.resolve(process.env.AUDIO_DIR) : path.join(__dirname, 'audio');
const DIR_UPLOADS = path.join(__dirname, 'uploads');
const DIR_CONTENT_AUDIO = path.join(DIR_AUDIO, 'content');
[DIR_AUDIO, DIR_UPLOADS, DIR_CONTENT_AUDIO].forEach(d => fs.mkdirSync(d, { recursive: true }));

if (process.env.AUDIO_DIR) {
    logger.info(`[Audio] using persistent AUDIO_DIR: ${DIR_AUDIO}`);
} else {
    logger.warn('[Audio] AUDIO_DIR is not set; audio cache uses app-local storage and will be lost on redeploy');
}

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
app.get('/parent', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'parent.html'));
});
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
const voiceCloneRawUpload = express.raw({
    type: ['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/mpeg', 'application/octet-stream'],
    limit: '12mb',
});

const parentSessions = new Map();
const revokedParentTokens = new Set();
const deviceSockets = new Map();
const PARENT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PARENT_TOKEN_SECRET = process.env.PARENT_TOKEN_SECRET || process.env.OPENAI_API_KEY || 'lunara-parent-demo-secret';

// Feature flag: включает Hybrid Semantic Intent Pipeline (content.getSemanticIntent) в
// handlePipeline. По умолчанию выключен — при USE_SEMANTIC_INTENT!=='true' роутинг работает
// по-старому (чистый RegEx), классификатор вообще не вызывается.
const USE_SEMANTIC_INTENT = process.env.USE_SEMANTIC_INTENT === 'true';

function signParentPayload(payload) {
    return crypto.createHmac('sha256', PARENT_TOKEN_SECRET).update(payload).digest('base64url');
}

function createParentToken(deviceId) {
    const payload = Buffer.from(JSON.stringify({
        device_id: memory.normalizeDeviceId(deviceId),
        created_at: Date.now(),
    })).toString('base64url');
    const token = `pt1.${payload}.${signParentPayload(payload)}`;
    parentSessions.set(token, {
        device_id: memory.normalizeDeviceId(deviceId),
        created_at: Date.now(),
    });
    return token;
}

function getParentSession(req) {
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.headers['x-parent-token'] || '');
    if (!token || revokedParentTokens.has(token)) return null;
    const liveSession = parentSessions.get(token);
    if (liveSession) {
        if (Date.now() - liveSession.created_at > PARENT_TOKEN_TTL_MS) {
            parentSessions.delete(token);
            return null;
        }
        return liveSession;
    }
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'pt1') return null;
    const [, payload, signature] = parts;
    if (signParentPayload(payload) !== signature) return null;
    let session = null;
    try {
        session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch (_err) {
        return null;
    }
    if (!session?.device_id || Date.now() - Number(session.created_at || 0) > PARENT_TOKEN_TTL_MS) {
        parentSessions.delete(token);
        return null;
    }
    return {
        device_id: memory.normalizeDeviceId(session.device_id),
        created_at: Number(session.created_at),
    };
}

function requireParent(req, res) {
    const session = getParentSession(req);
    if (!session) {
        res.status(401).json({ error: 'parent auth required' });
        return null;
    }
    return session;
}

function clampVolumeLevel(value) {
    const level = Number(value);
    return Number.isFinite(level) ? Math.max(2, Math.min(10, Math.round(level))) : 7;
}

function sendDeviceCommand(deviceId, payload) {
    const id = memory.normalizeDeviceId(deviceId);
    const ws = deviceSockets.get(id);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
}

function sendVolumeToDevice(deviceId, volumeLevel) {
    const id = memory.normalizeDeviceId(deviceId);
    const level = clampVolumeLevel(volumeLevel);
    const sent = sendDeviceCommand(id, { type: 'set_volume', volumeLevel: level });
    if (sent) logger.info(`[Volume] sent set_volume level=${level} device_id=${id}`);
    return sent;
}

function isVolumeAckMessage(msg) {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'volume_ack' || msg.type === 'set_volume_ack') return true;
    if (msg.type !== 'ack') return false;
    return ['set_volume', 'volume'].includes(msg.command || msg.name || msg.ackType);
}

function volumeLevelFromAck(msg) {
    return clampVolumeLevel(msg?.volumeLevel ?? msg?.volume_level ?? msg?.level ?? msg?.volume);
}

function minimaxGroupId() {
    return process.env.MINIMAX_GROUP_ID || process.env.MINIMAX_GROUPID || process.env.MINIMAX_GROUP || '';
}

function minimaxApiUrl(pathname, envName) {
    const override = process.env[envName];
    if (override) return override;
    const baseUrl = (process.env.MINIMAX_BASE_URL || 'https://api.minimax.chat').replace(/\/+$/, '');
    const groupId = minimaxGroupId();
    const joiner = pathname.includes('?') ? '&' : '?';
    return `${baseUrl}${pathname}${groupId ? `${joiner}GroupId=${encodeURIComponent(groupId)}` : ''}`;
}

function requireMiniMaxConfig() {
    if (!process.env.MINIMAX_API_KEY) {
        const err = new Error('MINIMAX_API_KEY is not configured');
        err.statusCode = 503;
        throw err;
    }
    if (!minimaxGroupId() && !process.env.MINIMAX_FILE_UPLOAD_URL && !process.env.MINIMAX_VOICE_CLONE_URL && !process.env.MINIMAX_T2A_URL) {
        const err = new Error('MINIMAX_GROUP_ID is not configured');
        err.statusCode = 503;
        throw err;
    }
}

async function readMiniMaxJson(response, label) {
    const text = await response.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : {};
    } catch (_err) {
        const err = new Error(`${label} returned non-JSON response`);
        err.statusCode = response.status || 502;
        throw err;
    }
    const baseResp = json.base_resp || json.baseResp || {};
    const statusCode = Number(baseResp.status_code ?? baseResp.statusCode ?? 0);
    if (!response.ok || statusCode !== 0) {
        const message = baseResp.status_msg || baseResp.statusMsg || json.error || json.message || `${label} failed`;
        const err = new Error(message);
        err.statusCode = response.ok ? 502 : response.status;
        throw err;
    }
    return json;
}

function extractMiniMaxFileId(json) {
    return json?.file?.file_id || json?.file?.id || json?.file_id || json?.id || json?.data?.file_id;
}

function extractMiniMaxVoiceId(json, fallback) {
    return json?.voice_id || json?.data?.voice_id || json?.voice?.voice_id || fallback;
}

function decodeMaybeHexAudio(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) return Buffer.from(text, 'hex');
    return Buffer.from(text, 'base64');
}

async function extractMiniMaxAudioBuffer(response) {
    const contentType = String(response.headers.get('content-type') || '');
    if (!contentType.includes('application/json')) {
        if (!response.ok) {
            const err = new Error(`MiniMax T2A failed with HTTP ${response.status}`);
            err.statusCode = response.status;
            throw err;
        }
        return Buffer.from(await response.arrayBuffer());
    }

    const json = await readMiniMaxJson(response, 'MiniMax T2A');
    const audioValue = json?.data?.audio || json?.audio || json?.data?.audio_file || json?.audio_file;
    const audioBuffer = decodeMaybeHexAudio(audioValue);
    if (audioBuffer?.length) return audioBuffer;

    const audioUrl = json?.data?.audio_url || json?.audio_url || json?.data?.url;
    if (audioUrl) {
        const audioResponse = await fetch(audioUrl);
        if (!audioResponse.ok) throw new Error(`MiniMax audio download failed with HTTP ${audioResponse.status}`);
        return Buffer.from(await audioResponse.arrayBuffer());
    }

    throw new Error('MiniMax T2A response does not contain audio');
}

app.post('/api/parent/login', async (req, res) => {
    try {
        const deviceId = req.body?.device_id || 'lumi_001';
        const pin = req.body?.pin || '12345';
        const login = await parentConfig.login(deviceId, pin);
        const token = createParentToken(login.device_id);
        res.json({ ok: true, token, device_id: login.device_id });
    } catch (err) {
        logger.warn(`[Parent] login failed: ${err.message}`);
        res.status(401).json({ error: err.message });
    }
});

app.post('/api/parent/logout', (req, res) => {
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.headers['x-parent-token'] || '');
    if (token) {
        parentSessions.delete(token);
        revokedParentTokens.add(token);
    }
    res.json({ ok: true });
});

app.get('/api/parent/state', async (req, res) => {
    const session = requireParent(req, res);
    if (!session) return;
    try {
        res.json(await parentConfig.getParentState(session.device_id));
    } catch (err) {
        logger.error(`[Parent] state error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/parent/analytics', async (req, res) => {
    const session = requireParent(req, res);
    if (!session) return;
    try {
        res.json(await parentConfig.getAnalytics(session.device_id, req.query || {}));
    } catch (err) {
        logger.error(`[Parent] analytics error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/parent/settings', async (req, res) => {
    const session = requireParent(req, res);
    if (!session) return;
    try {
        const previousSettings = await parentConfig.getSettings(session.device_id);
        const settings = await parentConfig.updateSettings(session.device_id, req.body || {});
        if ('language' in (req.body || {}) && settings.language !== previousSettings.language) {
            // Смена языка устройства — сбрасываем историю диалога этой сессии, чтобы
            // старые реплики на прежнем языке не тянули LLM обратно в него.
            const ws = deviceSockets.get(memory.normalizeDeviceId(session.device_id));
            if (ws) {
                llm.resetHistory(ws);
                logger.info(`[Parent] language changed ${previousSettings.language} -> ${settings.language}, dialog history reset device_id=${session.device_id}`);
            }
        }
        const volumeLevel = clampVolumeLevel(settings.volume_level);
        logger.info(`[Volume] saved level=${volumeLevel} source=parent_panel device_id=${session.device_id}`);
        if (!sendVolumeToDevice(session.device_id, volumeLevel)) {
            logger.info(`[Volume] device offline, saved only level=${volumeLevel} device_id=${session.device_id}`);
        }
        clearDemoSession(session.device_id);
        res.json({ ok: true, settings, session_reset: true });
    } catch (err) {
        logger.error(`[Parent] settings error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/parent/volume-test', async (req, res) => {
    const session = requireParent(req, res);
    if (!session) return;
    try {
        const settings = await parentConfig.getSettings(session.device_id);
        const volumeLevel = clampVolumeLevel(req.body?.volume_level ?? settings.volume_level);
        const sentVolume = sendVolumeToDevice(session.device_id, volumeLevel);
        if (!sentVolume) {
            return res.status(409).json({ ok: false, online: false, error: 'device is offline' });
        }

        const baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
        const lang = 'ru-RU';
        const gender = settings.toyGender || settings.toy_gender;
        const text = 'Вот так я сейчас говорю. Хорошо слышно?';
        const asset = await tts.synthesizeAsset('volume_test', text, lang, gender, { voiceConfig: buildVoiceConfig(settings) });
        if (!asset) throw new Error('volume test audio is unavailable');

        const audioUrl = `${baseUrl}/audio/${path.basename(asset.wavPath)}`;
        const sentAudio = sendDeviceCommand(session.device_id, {
            type: 'audio',
            url: audioUrl,
            duration_ms: asset.durationMs,
            sample_rate: 16000,
            channels: 1,
            bits: 16,
        });
        if (!sentAudio) {
            return res.status(409).json({ ok: false, online: false, error: 'device is offline' });
        }

        logger.info(`[Volume] test_play level=${volumeLevel} device_id=${session.device_id}`);
        res.json({ ok: true, online: true, volume_level: volumeLevel, audio_url: audioUrl, duration_ms: asset.durationMs });
    } catch (err) {
        logger.error(`[Volume] test error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/parent/profile', async (req, res) => {
    const session = requireParent(req, res);
    if (!session) return;
    try {
        const state = await parentConfig.updateChildProfile(session.device_id, req.body || {});
        clearDemoSession(session.device_id);
        res.json({ ...state, session_reset: true });
    } catch (err) {
        logger.error(`[Parent] profile error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/parent/profile-translations', async (req, res) => {
    const session = requireParent(req, res);
    if (!session) return;
    try {
        const lang = String(req.query.lang || 'ru-RU');
        const profile = await memory.getProfile(session.device_id);
        const translations = await memory.translateProfileForLang(session.device_id, profile || {}, lang);
        res.json(translations);
    } catch (err) {
        logger.error(`[Parent] profile translation error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/parent/password', async (req, res) => {
    const session = requireParent(req, res);
    if (!session) return;
    try {
        res.json(await parentConfig.changeParentPin(
            session.device_id,
            req.body?.current_pin,
            req.body?.new_pin
        ));
    } catch (err) {
        logger.warn(`[Parent] password change failed: ${err.message}`);
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/parent/memory/clear', async (req, res) => {
    const session = requireParent(req, res);
    if (!session) return;
    try {
        const state = await parentConfig.clearMemory(session.device_id);
        clearDemoSession(session.device_id);
        res.json({ ...state, session_reset: true });
    } catch (err) {
        logger.error(`[Parent] memory clear error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/parent/profile/clear', async (req, res) => {
    const session = requireParent(req, res);
    if (!session) return;
    try {
        const state = await parentConfig.clearChildProfile(session.device_id);
        clearDemoSession(session.device_id);
        res.json({ ...state, session_reset: true });
    } catch (err) {
        logger.error(`[Parent] child profile clear error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/parent/reset', async (req, res) => {
    const session = requireParent(req, res);
    if (!session) return;
    try {
        const state = await parentConfig.resetToDefaults(session.device_id);
        clearDemoSession(session.device_id);
        res.json({ ...state, session_reset: true });
    } catch (err) {
        logger.error(`[Parent] reset error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/parent/reset-all', async (req, res) => {
    const session = requireParent(req, res);
    if (!session) return;
    try {
        const state = await parentConfig.resetEverything(session.device_id);
        clearDemoSession(session.device_id);
        res.json({ ...state, session_reset: true });
    } catch (err) {
        logger.error(`[Parent] reset all error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/parent/profiles', async (req, res) => {
    const session = requireParent(req, res);
    if (!session) return;
    try {
        res.json(await parentConfig.saveProfileSnapshot(session.device_id, req.body?.profile_name));
    } catch (err) {
        logger.error(`[Parent] profile save error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/parent/profiles/base/load', async (req, res) => {
    const session = requireParent(req, res);
    if (!session) return;
    try {
        const state = await parentConfig.loadBaseProfile(session.device_id);
        clearDemoSession(session.device_id);
        res.json({ ...state, session_reset: true });
    } catch (err) {
        logger.error(`[Parent] base profile load error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/parent/profiles/:id/load', async (req, res) => {
    const session = requireParent(req, res);
    if (!session) return;
    try {
        const state = await parentConfig.loadProfileSnapshot(session.device_id, req.params.id);
        clearDemoSession(session.device_id);
        res.json({ ...state, session_reset: true });
    } catch (err) {
        logger.error(`[Parent] profile load error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/parent/profiles/:id', async (req, res) => {
    const session = requireParent(req, res);
    if (!session) return;
    try {
        res.json(await parentConfig.deleteProfileSnapshot(session.device_id, req.params.id));
    } catch (err) {
        logger.error(`[Parent] profile delete error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/parent/voice-preview', async (req, res) => {
    const session = requireParent(req, res);
    if (!session) return;
    const text = String(req.body?.text || '').trim();
    const lang = req.body?.lang || 'ru-RU';
    if (!text) {
        return res.status(400).json({ error: 'text is required' });
    }

    try {
        const settings = await parentConfig.getSettings(session.device_id);
        // Явный voice_id из тела запроса — превью ещё не сохранённого выбора в панели.
        // Если не передан — превьюим текущий сохранённый голос (старое поведение).
        const requestedVoiceId = req.body?.voice_id || req.body?.voice;
        const previewVoice = requestedVoiceId ? parentConfig.getVoiceById(requestedVoiceId) : null;
        const voiceConfig = previewVoice
            ? { id: bareVoiceId(previewVoice), provider: previewVoice.provider, gender: settings.toyGender || settings.toy_gender }
            : buildVoiceConfig(settings);
        const ts = Date.now();
        const outputPath = path.join(DIR_AUDIO, `preview_${ts}.pcm`);
        const durationMs = await tts.synthesize(text, outputPath, lang, { voiceSpeed: settings.voice_speed, voiceConfig });
        const baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
        res.json({
            ok: true,
            text,
            audio_url: `${baseUrl}/audio/preview_${ts}.wav`,
            duration_ms: durationMs,
        });
    } catch (err) {
        logger.error(`[Parent] voice preview error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/parent/voice-clone-demo', voiceCloneRawUpload, async (req, res) => {
    const session = requireParent(req, res);
    if (!session) return;

    try {
        requireMiniMaxConfig();
        const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const contentType = String(req.headers['content-type'] || 'audio/wav').split(';')[0].toLowerCase();
        const allowedTypes = new Set(['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/mpeg', 'application/octet-stream']);

        if (!audio.length || audio.length < 1024) {
            return res.status(400).json({ error: 'voice sample audio is required' });
        }
        if (!allowedTypes.has(contentType)) {
            return res.status(415).json({ error: 'voice sample must be WAV or MP3' });
        }

        const uploadType = contentType === 'application/octet-stream' ? 'audio/wav' : contentType;
        const extension = uploadType === 'audio/mpeg' ? 'mp3' : 'wav';
        const form = new FormData();
        form.append('purpose', 'voice_clone');
        form.append('file', new Blob([audio], { type: uploadType }), `lunara_voice_sample_${Date.now()}.${extension}`);

        const uploadResponse = await fetch(minimaxApiUrl('/v1/files/upload', 'MINIMAX_FILE_UPLOAD_URL'), {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.MINIMAX_API_KEY}` },
            body: form,
        });
        const uploadJson = await readMiniMaxJson(uploadResponse, 'MiniMax file upload');
        const fileId = extractMiniMaxFileId(uploadJson);
        if (!fileId) {
            const err = new Error('MiniMax file upload did not return file_id');
            err.statusCode = 502;
            throw err;
        }

        const requestedVoiceId = `lunara_demo_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const cloneOptions = {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ file_id: fileId, voice_id: requestedVoiceId }),
        };
        let cloneResponse = await fetch(minimaxApiUrl('/v1/voice_clone', 'MINIMAX_VOICE_CLONE_URL'), cloneOptions);
        if (cloneResponse.status === 404 && !process.env.MINIMAX_VOICE_CLONE_URL) {
            cloneResponse = await fetch(minimaxApiUrl('/v1/voice_cloning', 'MINIMAX_VOICE_CLONE_URL'), cloneOptions);
        }
        const cloneJson = await readMiniMaxJson(cloneResponse, 'MiniMax voice clone');
        const voiceId = extractMiniMaxVoiceId(cloneJson, requestedVoiceId);

        logger.info(`[MiniMaxVoiceClone] cloned voice_id=${voiceId} device_id=${session.device_id}`);
        res.json({ ok: true, voice_id: voiceId });
    } catch (err) {
        logger.error(`[MiniMaxVoiceClone] clone error: ${err.message}`);
        res.status(err.statusCode || 500).json({ error: err.message || 'MiniMax voice clone failed' });
    }
});

app.post('/api/parent/voice-clone-preview', async (req, res) => {
    const session = requireParent(req, res);
    if (!session) return;

    try {
        requireMiniMaxConfig();
        const text = String(req.body?.text || '').trim();
        const voiceId = String(req.body?.voice_id || '').trim();

        if (!voiceId) return res.status(400).json({ error: 'voice_id is required' });
        if (!text) return res.status(400).json({ error: 'text is required' });
        if (text.length > 500) return res.status(400).json({ error: 'text must be 500 characters or less' });

        const payload = {
            model: process.env.MINIMAX_T2A_MODEL || 'speech-02-hd',
            text,
            stream: false,
            voice_setting: {
                voice_id: voiceId,
                speed: 1,
                vol: 1,
                pitch: 0,
            },
            audio_setting: {
                sample_rate: 32000,
                bitrate: 128000,
                format: 'mp3',
                channel: 1,
            },
        };

        const t2aResponse = await fetch(minimaxApiUrl('/v1/t2a_v2', 'MINIMAX_T2A_URL'), {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });
        const audio = await extractMiniMaxAudioBuffer(t2aResponse);

        logger.info(`[MiniMaxVoiceClone] preview voice_id=${voiceId} chars=${text.length} device_id=${session.device_id}`);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-store');
        res.send(audio);
    } catch (err) {
        logger.error(`[MiniMaxVoiceClone] preview error: ${err.message}`);
        res.status(err.statusCode || 500).json({ error: err.message || 'MiniMax preview failed' });
    }
});

app.get('/api/parent/voices', async (req, res) => {
    const session = requireParent(req, res);
    if (!session) return;
    try {
        const settings = await parentConfig.getSettings(session.device_id);
        const lang = req.query?.lang || settings.language || 'ru-RU';
        res.json({ ok: true, voices: parentConfig.getVoicesForLang(lang) });
    } catch (err) {
        logger.error(`[Parent] voices list error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/chat', async (req, res) => {
    const text = (req.body?.text || '').trim();
    const lang = req.body?.lang || 'ru-RU';
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
        const settings = await parentConfig.getSettings(deviceId);
        content.setVoiceConfig(buildVoiceConfig(settings));
        sessionRef.childGender = settings.childGender || settings.child_gender || 'M';
        sessionRef.toyGender = settings.toyGender || settings.toy_gender || 'female';
        const effectiveLang = settings.language || lang;
        const runtime = await parentConfig.getRuntimeState(deviceId, settings);
        if (!runtime.allowed) {
            const reply = runtimeLimitReply(runtime, effectiveLang);
            const audio = await synthesizeReply(reply, ts, effectiveLang, baseUrl, settings.voice_speed, buildVoiceConfig(settings));
            recordAnalyticsSafe(deviceId, text, reply, { type: 'runtime_limit', durationMs: audio.durationMs, provider: 'system' });
            return res.json({
                reply,
                audio_url: audio.audioUrl,
                duration_ms: audio.durationMs,
                device_id: deviceId,
                runtime,
                ...cachedModelMeta(),
            });
        }
        if (shouldSendBreakReminder(deviceId, runtime, settings)) {
            const reply = breakReminderReply(effectiveLang);
            const audio = await synthesizeReply(reply, ts, effectiveLang, baseUrl, settings.voice_speed, buildVoiceConfig(settings));
            recordUsageSafe(deviceId, audio.durationMs);
            recordAnalyticsSafe(deviceId, text, reply, { type: 'break_reminder', durationMs: audio.durationMs, provider: 'system' });
            return res.json({
                reply,
                audio_url: audio.audioUrl,
                duration_ms: audio.durationMs,
                device_id: deviceId,
                runtime,
                ...cachedModelMeta(),
            });
        }
        const pendingAnswer = content.checkPendingAnswer(sessionRef.pendingContent, text);
        if (pendingAnswer?.nextRiddle) {
            sessionRef.pendingContent = null;
            const shortContent = await content.tryHandleShortRequest('загадай загадку', {
                baseUrl,
                lang: pendingAnswer.lang || effectiveLang,
            });
            if (shortContent && isContentTypeAllowed(settings, shortContent.item?.type)) {
                sessionRef.pendingContent = content.pendingFromItem(shortContent.item);
                recordUsageSafe(deviceId, shortContent.durationMs);
                recordAnalyticsSafe(deviceId, text, shortContent.reply, { type: shortContent.item?.type, durationMs: shortContent.durationMs, provider: 'content_cache' });
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
            recordUsageSafe(deviceId, audio.durationMs);
            recordAnalyticsSafe(deviceId, text, pendingAnswer.reply, { type: 'riddle', durationMs: audio.durationMs, provider: 'content_cache' });
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
                lang: clarification.lang || effectiveLang,
                key: 'clarification',
            });
            recordUsageSafe(deviceId, audio.durationMs);
            recordAnalyticsSafe(deviceId, text, clarification.reply, { type: 'clarification', durationMs: audio.durationMs, provider: 'content_cache' });
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

        const requestedContentType = content.classifyRequest(text);
        if (requestedContentType && !isContentTypeAllowed(settings, requestedContentType)) {
            const reply = disabledContentReply(requestedContentType, effectiveLang);
            const audio = await synthesizeReply(reply, ts, effectiveLang, baseUrl, settings.voice_speed, buildVoiceConfig(settings));
            recordUsageSafe(deviceId, audio.durationMs);
            recordAnalyticsSafe(deviceId, text, reply, { type: requestedContentType, durationMs: audio.durationMs, provider: 'system' });
            return res.json({
                reply,
                audio_url: audio.audioUrl,
                duration_ms: audio.durationMs,
                device_id: deviceId,
                content_type: requestedContentType,
                disabled_by_parent: true,
                ...cachedModelMeta(),
            });
        }

        const shortContent = await content.tryHandleShortRequest(text, { baseUrl, lang: effectiveLang });
        if (shortContent && isContentTypeAllowed(settings, shortContent.item?.type)) {
            sessionRef.pendingContent = content.pendingFromItem(shortContent.item);
            recordUsageSafe(deviceId, shortContent.durationMs);
            recordAnalyticsSafe(deviceId, text, shortContent.reply, { type: shortContent.item?.type, durationMs: shortContent.durationMs, provider: 'content_cache' });
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

        const settingsContext = parentConfig.formatSettingsForPrompt(settings);
        const profile = await memory.getProfile(deviceId);
        const memoryContext = settings.memory_enabled === false ? '' : memory.formatProfileForPrompt(profile);
        const modelName = req.body?.model || parentConfig.modelModeToModelName(settings);
        const story = await storyEngine.buildStoryContext(text);
        if (story && !isContentTypeAllowed(settings, 'story')) {
            const reply = disabledContentReply('story', effectiveLang);
            const audio = await synthesizeReply(reply, ts, effectiveLang, baseUrl, settings.voice_speed, buildVoiceConfig(settings));
            recordUsageSafe(deviceId, audio.durationMs);
            recordAnalyticsSafe(deviceId, text, reply, { type: 'story', durationMs: audio.durationMs, provider: 'system' });
            return res.json({
                reply,
                audio_url: audio.audioUrl,
                duration_ms: audio.durationMs,
                device_id: deviceId,
                content_type: 'story',
                disabled_by_parent: true,
                ...cachedModelMeta(),
            });
        }
        const followupContext = !story && sessionRef.lastContentMode === 'story'
            ? storyEngine.buildStoryFollowupContext(text)
            : '';
        const requestedContentContext = contentModeContext(requestedContentType);

        // LLM
        const llmResult = story
            ? await llm.chat(sessionRef, story.prompt, effectiveLang, {
                memoryContext,
                contentContext: [settingsContext, story.contentContext, requestedContentContext].filter(Boolean).join('\n\n'),
                maxTokens: story.maxTokens,
                model: modelName,
                routingText: text,
                isStory: true,
                returnMeta: true,
            })
            : await llm.chat(sessionRef, text, effectiveLang, {
                memoryContext,
                contentContext: [settingsContext, followupContext, requestedContentContext].filter(Boolean).join('\n\n'),
                model: modelName,
                routingText: text,
                returnMeta: true,
            });
        const reply = llmResult.reply;

        // TTS
        const outputPath = path.join(DIR_AUDIO, `response_${ts}.pcm`);
        const durationMs = await tts.synthesize(reply, outputPath, effectiveLang, { voiceSpeed: settings.voice_speed, voiceConfig: buildVoiceConfig(settings) });
        recordUsageSafe(deviceId, durationMs);
        recordAnalyticsSafe(deviceId, text, reply, { type: story ? 'story' : requestedContentType, durationMs, provider: 'llm' });
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
        if (settings.memory_enabled !== false) {
            memory.rememberFromText(deviceId, text, profile)
                .catch(err => logger.warn(`[Memory] auto-update failed: ${err.message}`));
        }
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

function isContentTypeAllowed(settings, type) {
    if (!type) return true;
    const enabled = Array.isArray(settings?.content_enabled) ? settings.content_enabled : [];
    if (enabled.length === 0) return false;
    if (type === 'riddle') return enabled.includes('riddle');
    if (type === 'tongue_twister') return enabled.includes('tongue_twister');
    if (type === 'mini_game') return enabled.includes('mini_game');
    if (type === 'speech_development') return enabled.includes('speech_development');
    if (type === 'story' || type === 'story_template' || type === 'fairytale_template') return enabled.includes('story');
    return true;
}

function disabledContentReply(type, lang = 'ru-RU') {
    const key = String(lang).startsWith('ro') ? 'ro' : String(lang).startsWith('en') ? 'en' : 'ru';
    const alternatives = {
        ru: {
            riddle: 'Можем просто поболтать, поиграть в слова или придумать смешного героя.',
            tongue_twister: 'Можем сказать смешное слово, поиграть в рифмы или просто поболтать.',
            mini_game: 'Можем спокойно поговорить, придумать маленькую историю или выбрать другое занятие.',
            speech_development: 'Можем просто поболтать, назвать любимые слова или придумать рифму.',
            story: 'Можем придумать маленького героя, поговорить о твоём дне или выбрать что-то другое.',
        },
        ro: {
            riddle: 'Putem sa vorbim, sa ne jucam cu cuvinte sau sa inventam un personaj amuzant.',
            tongue_twister: 'Putem spune un cuvant haios, cauta rime sau doar sa povestim putin.',
            mini_game: 'Putem vorbi linistit, inventa o povestioara mica sau alege altceva.',
            speech_development: 'Putem vorbi putin, spune cuvinte preferate sau gasi o rima.',
            story: 'Putem inventa un personaj mic, vorbi despre ziua ta sau alege altceva.',
        },
        en: {
            riddle: 'We can chat, play with words, or invent a funny little character.',
            tongue_twister: 'We can say a silly word, find a rhyme, or just chat for a bit.',
            mini_game: 'We can talk calmly, make up a tiny story, or choose something else.',
            speech_development: 'We can chat, name favorite words, or find a little rhyme.',
            story: 'We can invent a small character, talk about your day, or choose something else.',
        },
    };
    const replies = {
        ru: [
            `Ой, извини, сейчас я не смогу это сделать. ${alternatives.ru[type] || alternatives.ru.story}`,
            `Хм, сейчас это не получится. ${alternatives.ru[type] || alternatives.ru.story}`,
            `Давай это оставим на потом, хорошо? ${alternatives.ru[type] || alternatives.ru.story}`,
            `Сейчас я лучше не буду это делать. ${alternatives.ru[type] || alternatives.ru.story}`,
        ],
        ro: [
            `Of, scuze, acum nu pot face asta. ${alternatives.ro[type] || alternatives.ro.story}`,
            `Hm, acum nu iese asta. ${alternatives.ro[type] || alternatives.ro.story}`,
            `Hai sa lasam asta pentru mai tarziu, bine? ${alternatives.ro[type] || alternatives.ro.story}`,
            `Acum mai bine nu fac asta. ${alternatives.ro[type] || alternatives.ro.story}`,
        ],
        en: [
            `Oops, sorry, I cannot do that right now. ${alternatives.en[type] || alternatives.en.story}`,
            `Hmm, that will not work right now. ${alternatives.en[type] || alternatives.en.story}`,
            `Let us save that for later, okay? ${alternatives.en[type] || alternatives.en.story}`,
            `I had better not do that right now. ${alternatives.en[type] || alternatives.en.story}`,
        ],
    };
    const variants = replies[key] || replies.ru;
    return variants[Math.floor(Math.random() * variants.length)];
}

function contentModeContext(type) {
    if (type !== 'speech_development') return '';
    return [
        'SPEECH DEVELOPMENT MODE:',
        '- This is playful speech development, not therapy or medical advice.',
        '- Offer one short voice exercise: repeat a sound/syllable, find a rhyme, name words starting with a letter, or say a short phrase slowly.',
        '- Keep it warm, simple, and easy to pronounce. Do not mention diagnosis or treatment.',
        '- Ask the child to try one small step, then wait.',
    ].join('\n');
}

// Demo session storage (in-memory, keyed by x-session-id header)
const demoSessions = new Map();

function clearDemoSession(deviceId) {
    const id = memory.normalizeDeviceId(deviceId);
    demoSessions.delete(id);
    logger.info(`[Parent] cleared browser demo session for device_id=${id}`);
}

// Явный голос из настроек родителя (settings.voice — id из parentConfig.VOICE_REGISTRY,
// например 'openai:nova'). Пусто/неизвестный id -> null -> tts.js сам выбирает голос по
// toyGender, как раньше.
function bareVoiceId(voice) {
    // VOICE_REGISTRY хранит id с префиксом провайдера ('openai:nova') для однозначной
    // идентификации в панели/БД, но сам tts.js (yandexTTS/openaiTTS) ждёт голое имя
    // голоса конкретного провайдера — префикс тут не нужен и ничего не значит.
    return voice.id.includes(':') ? voice.id.split(':').slice(1).join(':') : voice.id;
}

function buildVoiceConfig(settings) {
    const gender = settings?.toyGender || settings?.toy_gender;
    // gender собираем ВСЕГДА (даже без явного voice/при нерезолвящемся id) — иначе
    // toyGender молча терялся: synthesizeReply() не прокидывает его отдельным options
    // полем, а tts.js берёт gender только из voiceConfig.gender, и без него откатывался
    // на дефолтную женщину, полностью игнорируя настройку "Пол" в панели.
    if (!settings?.voice) return gender ? { gender } : null;
    const voice = parentConfig.getVoiceById(settings.voice);
    if (!voice) return gender ? { gender } : null;
    return { id: bareVoiceId(voice), provider: voice.provider, gender };
}

async function synthesizeReply(reply, ts, lang, baseUrl, voiceSpeed = 'normal', voiceConfig = null) {
    const outputPath = path.join(DIR_AUDIO, `response_${ts}.pcm`);
    const durationMs = await tts.synthesize(reply, outputPath, lang, { voiceSpeed, voiceConfig });
    const audioUrl = `${baseUrl}/audio/response_${ts}.wav`;
    return { audioUrl, durationMs };
}

function runtimeLimitReply(runtime, lang = 'ru-RU') {
    const key = String(lang).startsWith('ro') ? 'ro' : String(lang).startsWith('en') ? 'en' : 'ru';
    if (runtime?.reason === 'rest_schedule') {
        const until = runtime?.rest_until || '';
        const timeText = until ? {
            ru: ` в ${until}`,
            ro: ` la ${until}`,
            en: ` at ${until}`,
        }[key] : '';
        return {
            ru: `Ой, я сейчас отдыхаю. Я смогу поговорить с тобой${timeText}.`,
            ro: `Of, acum ma odihnesc. Pot vorbi cu tine${timeText}.`,
            en: `Oops, I am resting now. I can talk with you${timeText}.`,
        }[key];
    }
    if (runtime?.reason === 'daily_limit') {
        return {
            ru: 'На сегодня мое время закончилось. Давай отдохнём, а завтра снова поговорим.',
            ro: 'Timpul Lumi pentru azi s-a terminat. Hai sa ne odihnim, iar maine vorbim din nou.',
            en: 'Lumi time is finished for today. Let us rest, and we can talk again tomorrow.',
        }[key];
    }
    return {
        ru: 'Сейчас у меня время тишины. Давай отдохнём и поговорим позже.',
        ro: 'Acum este timpul de liniste pentru Lumi. Hai sa ne odihnim si vorbim mai tarziu.',
        en: 'It is quiet time for Lumi now. Let us rest and talk later.',
    }[key];
}

function breakReminderReply(lang = 'ru-RU') {
    const key = String(lang).startsWith('ro') ? 'ro' : String(lang).startsWith('en') ? 'en' : 'ru';
    const variants = {
        ru: [
            'Я немного устала. Давай сделаем маленький перерыв, а потом продолжим.',
            'Мне кажется, пора чуть-чуть отдохнуть. Поставим Lumi на паузу?',
            'Давай дадим ушкам и голове передышку. Я буду ждать рядом.',
        ],
        ro: [
            'Am obosit putin. Hai sa facem o pauza mica, apoi continuam.',
            'Cred ca e timpul sa ne odihnim putin. Punem Lumi pe pauza?',
            'Hai sa dam urechilor si capului o pauza. Eu astept aici.',
        ],
        en: [
            'I am a little tired. Let us take a small break, then continue.',
            'I think it is time for a tiny rest. Shall we pause Lumi?',
            'Let us give our ears and heads a short break. I will wait right here.',
        ],
    };
    const list = variants[key] || variants.ru;
    return list[Math.floor(Math.random() * list.length)];
}

function shouldSendBreakReminder(deviceId, runtime = {}, settings = {}) {
    const minutes = Number(settings.break_reminder_minutes || 0);
    if (!Number.isFinite(minutes) || minutes <= 0) return false;
    const used = Number(runtime.used_minutes || 0);
    if (used < minutes) return false;
    const today = new Date(Date.now() + Number(process.env.RUNTIME_TIMEZONE_OFFSET_MINUTES || 180) * 60 * 1000).toISOString().slice(0, 10);
    const key = `${today}:${deviceId}:${minutes}`;
    if (breakReminderSent.has(key)) return false;
    breakReminderSent.add(key);
    return true;
}

function recordUsageSafe(deviceId, durationMs) {
    parentConfig.recordRuntimeUsage(deviceId, durationMs)
        .catch(err => logger.warn(`[Parent] usage record failed: ${err.message}`));
}

function analyticsCategory(type, text = '') {
    if (type === 'riddle') return 'riddles';
    if (type === 'story' || type === 'story_template' || type === 'fairytale_template') return 'stories';
    if (type === 'tongue_twister') return 'tongue_twisters';
    if (type === 'mini_game') return 'mini_games';
    if (type === 'learning') return 'learning';
    if (type === 'speech_development') return 'speech_development';
    if (type === 'runtime_limit') return 'limits';
    if (type === 'break_reminder') return 'wellbeing';
    const normalized = String(text || '').toLowerCase();
    if (/загад|riddle|ghic/i.test(normalized)) return 'riddles';
    if (/сказ|истор|story|povest/i.test(normalized)) return 'stories';
    if (/скороговор|tongue|framant/i.test(normalized)) return 'tongue_twisters';
    if (/реч|слог|рифм|букв|звук|speech|syllable|rhyme|letter|sound|vorbir|silab|rima|sunet/i.test(normalized)) return 'speech_development';
    if (/игр|game|joac/i.test(normalized)) return 'mini_games';
    return 'chat';
}

function analyticsTone(text = '') {
    const normalized = String(text || '').toLowerCase();
    if (/страш|боюсь|плак|груст|обид|злюсь|sad|scared|fric|trist/i.test(normalized)) return 'supportive';
    if (/ура|класс|супер|люблю|нрав|happy|great|imi place/i.test(normalized)) return 'happy';
    if (/почему|как|зачем|сколько|why|how|de ce|cum/i.test(normalized)) return 'curious';
    return 'neutral';
}

function analyticsTopic(text = '', type = '') {
    if (type) return analyticsCategory(type, text);
    const normalized = String(text || '').toLowerCase();
    const topics = [
        ['animals', /живот|кот|собак|заяц|крокодил|animal|cat|dog|iepure|pisic/i],
        ['space', /космос|луна|звезд|планет|space|moon|star|luna|stea/i],
        ['food', /еда|пицц|яблок|картош|food|pizza|apple|mancare/i],
        ['family', /мама|папа|бабуш|семь|family|mother|father|mama|tata/i],
        ['school', /школ|урок|учител|school|lesson|scoala/i],
    ];
    return topics.find(([, pattern]) => pattern.test(normalized))?.[0] || '';
}

function recordAnalyticsSafe(deviceId, inputText, outputText, meta = {}) {
    parentConfig.recordConversation(deviceId, {
        category: analyticsCategory(meta.type, inputText),
        tone: analyticsTone(`${inputText} ${outputText}`),
        topic: analyticsTopic(inputText, meta.type),
        model_provider: meta.provider || '',
        duration_ms: meta.durationMs || 0,
    }).catch(err => logger.warn(`[Parent] analytics record failed: ${err.message}`));
}


server = http.createServer(app);

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    const url = new URL(req.url || '/', 'http://localhost');
    const deviceId = memory.normalizeDeviceId(url.searchParams.get('device_id'));
    logger.info(`[WS] ESP32 connected from ${clientIp} device_id=${deviceId}`);
    deviceSockets.set(deviceId, ws);
    parentConfig.touchDevice(deviceId).catch(err => logger.warn(`[Parent] touch failed: ${err.message}`));

    // Per-connection state
    const state = {
        status:       'IDLE',       // IDLE | RECORDING | PROCESSING
        audioChunks:  [],           // Buffer[] — incoming PCM chunks
        audioBytes:   0,            // total bytes received
        generation:   0,            // номер запроса; растёт на каждую новую запись (для перебивания)
        pendingContent: null,
        activeRiddle: null,
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
    // Ленивая генерация под настройки конкретного устройства (язык/пол игрушки),
    // а не заранее захардкоженный русский файл на все случаи.
    (async () => {
        const baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
        const settings = await parentConfig.getSettings(deviceId);
        const volumeLevel = clampVolumeLevel(settings.volume_level);
        if (sendVolumeToDevice(deviceId, volumeLevel)) {
            logger.info(`[Volume] synced_on_connect level=${volumeLevel} device_id=${deviceId}`);
        }
        const lang = resolveSystemPhraseLang(settings.language);
        const gender = settings.toyGender || settings.toy_gender;
        const asset = await tts.synthesizeAsset('greeting', GREETING_TEXTS[lang], lang, gender, { voiceConfig: buildVoiceConfig(settings) });
        send({
            type:         'ready',
            name:         settings.toy_name || 'Lumi',
            device_id:    deviceId,
            greeting_url: asset ? `${baseUrl}/audio/${path.basename(asset.wavPath)}` : null,
        });
    })().catch((err) => {
        logger.error(`[Greeting] failed to prepare greeting for ${deviceId}: ${err.message}`, err);
        send({ type: 'ready', name: 'Lumi', device_id: deviceId, greeting_url: null });
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
            const raw = data.toString('utf8').substring(0, 50);
            logger.warn(`[WS] JSON parse error: ${e.message} | raw: ${JSON.stringify(raw)}`);
            return;
        }

        logger.info(`[WS] received: ${msg.type}`);

        if (isVolumeAckMessage(msg)) {
            logger.info(`[Volume] ack level=${volumeLevelFromAck(msg)} device_id=${deviceId}`);
        }

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
                const shortAudioSettings = await parentConfig.getSettings(deviceId);
                const r = await retryAudioCommand(shortAudioSettings.language, shortAudioSettings.toyGender || shortAudioSettings.toy_gender, buildVoiceConfig(shortAudioSettings));
                if (r) sendAudio(r.url, r.durationMs);
                state.status      = 'IDLE';
                state.audioChunks = [];
                state.audioBytes  = 0;
                return;
            }
            state.status = 'PROCESSING';
            sendStatus('processing');
                        {
                const myGen = state.generation;
                // Thinking phrase теперь запускается только внутри handlePipeline(),
                // после STT и только если основной LLM-ответ не успевает быстро подготовиться.
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
            state.activeRiddle = null;
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
        if (deviceSockets.get(deviceId) === ws) deviceSockets.delete(deviceId);
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
    // Сквозной идентификатор запроса для трассировки по стадиям STT/LLM/TTS в логах —
    // без этого асинхронные пайплайны разных подключений/ходов перемешиваются в Railway.
    const reqId = `req_${ts.toString(36)}`;

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
        // Без language-хинта Whisper всегда падал на DEFAULT_STT_LANGUAGE ('ru-RU'),
        // независимо от настроенного языка игрушки — отсюда requested=ru в логах даже
        // для устройств на ro/es/fr/it, и как следствие смешение языков в ответе LLM.
        const sttSettings = await parentConfig.getSettings(deviceId);
        const sttStartedAt = Date.now();
        const { text: transcript, language: detectedSttLang } = await stt.transcribe(uploadPath, { language: sttSettings.language });
        logger.info(`[Pipeline] transcript: "${transcript}"`);
        logger.info(`[Pipeline][${reqId}] stage=stt_done duration_ms=${Date.now() - sttStartedAt}`);

        // Whisper иногда распознаёт речь ребёнка на другом языке, чем настроен у
        // игрушки (детектор внутри stt.js это уже логирует как requested/detected, но
        // раньше это отбрасывалось на выходе). Если языки реально разошлись — не
        // переключаем игрушку насильно, а мягко просим LLM напомнить ребёнку о текущем
        // языке, не срывая остальной ответ.
        const requestedSttLangKey = String(sttSettings.language || 'ru-RU').slice(0, 2).toLowerCase();
        const detectedSttLangKey = String(detectedSttLang || '').slice(0, 2).toLowerCase();
        const languageMismatch = (detectedSttLangKey && detectedSttLangKey !== requestedSttLangKey)
            ? { requested: sttSettings.language, detected: detectedSttLang }
            : null;

        if (!isCurrent()) {
            logger.info('[Pipeline] superseded after STT — discarding (child interrupted)');
            return; // finally{} НЕ тронет статус, т.к. нас перебили
        }

        if (!transcript || transcript.trim().length === 0) {
            logger.info('[Pipeline] empty transcript — Lumi gently asks to repeat');
            const emptyTranscriptSettings = await parentConfig.getSettings(deviceId);
            const r = await retryAudioCommand(emptyTranscriptSettings.language, emptyTranscriptSettings.toyGender || emptyTranscriptSettings.toy_gender, buildVoiceConfig(emptyTranscriptSettings));
            if (r) sendAudio(r.url, r.durationMs);
            return; // finally{} сбросит state в IDLE и удалит upload
        }

        // 4. LLM — Claude
        sendStatus('responding');
        const baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
        const settings = await parentConfig.getSettings(deviceId);
        content.setVoiceConfig(buildVoiceConfig(settings));
        state.childGender = settings.childGender || settings.child_gender || 'M';
        state.toyGender = settings.toyGender || settings.toy_gender || 'female';
        const effectiveLang = settings.language && settings.language !== 'auto' ? settings.language : 'auto';
                        // ── Riddle mode: local cached riddles without LLM ───────────────────
        // Важно: сначала проверяем, не просит ли ребёнок новую загадку.
        // Иначе фраза "дай другую загадку" будет ошибочно считаться ответом.
        if (riddleEngine.isRiddleRequest(transcript)) {
            if (!isContentTypeAllowed(settings, 'riddle')) {
                logger.info('[Riddle] blocked by parent settings');
                const reply = disabledContentReply('riddle', effectiveLang);
                const audio = await content.ensureCachedReply(reply, {
                    baseUrl,
                    lang: effectiveLang,
                    key: 'disabled_riddle',
                });

                if (!isCurrent()) {
                    logger.info('[Pipeline] superseded after disabled riddle reply — discarding');
                    return;
                }

                sendAudio(audio.audioUrl, audio.durationMs);
                recordUsageSafe(deviceId, audio.durationMs);
                recordAnalyticsSafe(deviceId, transcript, reply, {
                    type: 'riddle',
                    durationMs: audio.durationMs,
                    provider: 'system',
                });

                return;
            }

            logger.info('[Riddle] request detected');

            const result = await riddleEngine.startRiddle(baseUrl, transcript);

            state.activeRiddle = result.riddle;

            if (!isCurrent()) {
                logger.info('[Pipeline] superseded after riddle start — discarding');
                return;
            }

            sendAudio(result.audio.url, result.audio.durationMs);
            recordUsageSafe(deviceId, result.audio.durationMs);
            recordAnalyticsSafe(deviceId, transcript, 'riddle_started', {
                type: 'riddle',
                durationMs: result.audio.durationMs,
                provider: 'riddle_engine',
            });
            logger.info(`[Riddle] sent ${result.riddle.id}`);

            return;
        }

        // Если уже есть активная загадка, проверяем только короткие ответы:
        // "медведь", "это лиса", "не знаю", "скажи ответ".
        // Если фраза не похожа на ответ, отпускаем её дальше в обычный pipeline.
        if (state.activeRiddle) {
            logger.info(`[Riddle] active answer check: "${transcript}"`);

            const result = await riddleEngine.handleActiveRiddleAnswer(
                transcript,
                state.activeRiddle,
                baseUrl
            );

            if (!result.handled) {
                logger.info('[Riddle] active riddle ignored: phrase is not an answer, falling through to normal pipeline');
                state.activeRiddle = null;
            } else {
                state.activeRiddle = result.activeRiddle;

                if (!isCurrent()) {
                    logger.info('[Pipeline] superseded after riddle answer — discarding');
                    return;
                }

                sendAudio(result.audio.url, result.audio.durationMs);
                recordUsageSafe(deviceId, result.audio.durationMs);
                recordAnalyticsSafe(deviceId, transcript, 'riddle_answer_feedback', {
                    type: 'riddle',
                    durationMs: result.audio.durationMs,
                    provider: 'riddle_engine',
                });
                logger.info('[Riddle] sent answer feedback audio');

                return;
            }
        }
        const runtime = await parentConfig.getRuntimeState(deviceId, settings);
        if (!runtime.allowed) {
            logger.info(`[Pipeline] runtime blocked: ${runtime.reason}`);
            const reply = runtimeLimitReply(runtime, effectiveLang);
            const audio = await content.ensureCachedReply(reply, {
                baseUrl,
                lang: effectiveLang,
                key: `runtime_${runtime.reason}`,
            });

            if (!isCurrent()) {
                logger.info('[Pipeline] superseded after runtime reply — discarding (child interrupted)');
                return;
            }

            sendAudio(audio.audioUrl, audio.durationMs);
            recordAnalyticsSafe(deviceId, transcript, reply, { type: 'runtime_limit', durationMs: audio.durationMs, provider: 'system' });
            return;
        }
        if (shouldSendBreakReminder(deviceId, runtime, settings)) {
            logger.info('[Pipeline] soft break reminder');
            const reply = breakReminderReply(effectiveLang);
            const audio = await content.ensureCachedReply(reply, {
                baseUrl,
                lang: effectiveLang,
                key: 'break_reminder',
            });

            if (!isCurrent()) {
                logger.info('[Pipeline] superseded after break reminder - discarding');
                return;
            }

            sendAudio(audio.audioUrl, audio.durationMs);
            recordUsageSafe(deviceId, audio.durationMs);
            recordAnalyticsSafe(deviceId, transcript, reply, { type: 'break_reminder', durationMs: audio.durationMs, provider: 'system' });
            return;
        }
        const pendingAnswer = content.checkPendingAnswer(state.pendingContent, transcript);
        if (pendingAnswer?.nextRiddle) {
            state.pendingContent = null;
            const shortContent = await content.tryHandleShortRequest('загадай загадку', {
                baseUrl,
                lang: pendingAnswer.lang || effectiveLang,
            });
            if (shortContent && isContentTypeAllowed(settings, shortContent.item?.type)) {
                if (!isCurrent()) {
                    logger.info('[Pipeline] superseded after next riddle — discarding (child interrupted)');
                    return;
                }
                state.pendingContent = content.pendingFromItem(shortContent.item);
                sendAudio(shortContent.audioUrl, shortContent.durationMs);
                recordUsageSafe(deviceId, shortContent.durationMs);
                recordAnalyticsSafe(deviceId, transcript, shortContent.reply, { type: shortContent.item?.type, durationMs: shortContent.durationMs, provider: 'content_cache' });
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
            recordUsageSafe(deviceId, audio.durationMs);
            recordAnalyticsSafe(deviceId, transcript, pendingAnswer.reply, { type: 'riddle', durationMs: audio.durationMs, provider: 'content_cache' });
            return;
        }

        const clarification = content.getClarification(transcript);
        if (clarification) {
            logger.info('[Pipeline] content clarification requested');
            const audio = await content.ensureCachedReply(clarification.reply, {
                baseUrl,
                lang: clarification.lang || effectiveLang,
                key: 'clarification',
            });

            if (!isCurrent()) {
                logger.info('[Pipeline] superseded after content clarification — discarding (child interrupted)');
                return;
            }

            sendAudio(audio.audioUrl, audio.durationMs);
            recordUsageSafe(deviceId, audio.durationMs);
            recordAnalyticsSafe(deviceId, transcript, clarification.reply, { type: 'clarification', durationMs: audio.durationMs, provider: 'content_cache' });
            return;
        }

        const requestedContentType = content.classifyRequest(transcript);
        if (requestedContentType && !isContentTypeAllowed(settings, requestedContentType)) {
            logger.info(`[Pipeline] parent-disabled content requested: ${requestedContentType}`);
            const reply = disabledContentReply(requestedContentType, effectiveLang);
            const audio = await content.ensureCachedReply(reply, {
                baseUrl,
                lang: effectiveLang,
                key: `disabled_${requestedContentType}`,
            });

            if (!isCurrent()) {
                logger.info('[Pipeline] superseded after disabled content reply — discarding (child interrupted)');
                return;
            }

            sendAudio(audio.audioUrl, audio.durationMs);
            recordUsageSafe(deviceId, audio.durationMs);
            recordAnalyticsSafe(deviceId, transcript, reply, { type: requestedContentType, durationMs: audio.durationMs, provider: 'system' });
            return;
        }

        const shortContent = await content.tryHandleShortRequest(transcript, { baseUrl, lang: effectiveLang });
        if (shortContent && isContentTypeAllowed(settings, shortContent.item?.type)) {
            if (!isCurrent()) {
                logger.info('[Pipeline] superseded after content cache — discarding (child interrupted)');
                return;
            }
            state.pendingContent = content.pendingFromItem(shortContent.item);
            sendAudio(shortContent.audioUrl, shortContent.durationMs);
            recordUsageSafe(deviceId, shortContent.durationMs);
            recordAnalyticsSafe(deviceId, transcript, shortContent.reply, { type: shortContent.item?.type, durationMs: shortContent.durationMs, provider: 'content_cache' });
            logger.info(`[Pipeline] sent cached content audio: ${shortContent.item.id} cached=${shortContent.cached}`);
            return;
        }

        // Hybrid Semantic Intent Pipeline (feature-flagged): включается только когда
        // USE_SEMANTIC_INTENT=true. RegEx-роутинг выше уже отработал и ничего не нашёл
        // (requestedContentType === null) — только тогда дёргаем LLM-классификатор.
        let semanticIntent = null;
        if (USE_SEMANTIC_INTENT && !requestedContentType) {
            try {
                semanticIntent = await content.getSemanticIntent(transcript, state.lastContentMode || '');
                if (semanticIntent) {
                    logger.info(`[Pipeline] Semantic intent detected: ${semanticIntent.intent} (conf: ${semanticIntent.confidence})`);
                }
            } catch (err) {
                logger.warn(`[Pipeline] Semantic intent failed: ${err.message}`);
                semanticIntent = null;
            }
        }

        // confidence <= 0.8 (или классификатор не сработал/выключен) — результат полностью
        // игнорируется: не влияет ни на content-кэш, ни на modelName, ни на контекст llm.chat.
        const semanticConfident = Boolean(semanticIntent && semanticIntent.confidence > 0.8);

        if (semanticConfident) {
            const semanticContent = await content.tryHandleSemanticIntent(semanticIntent, transcript, { baseUrl, lang: effectiveLang });
            if (semanticContent && isContentTypeAllowed(settings, semanticContent.item?.type)) {
                if (!isCurrent()) {
                    logger.info('[Pipeline] superseded after semantic content cache — discarding (child interrupted)');
                    return;
                }
                state.pendingContent = content.pendingFromItem(semanticContent.item);
                sendAudio(semanticContent.audioUrl, semanticContent.durationMs);
                recordUsageSafe(deviceId, semanticContent.durationMs);
                recordAnalyticsSafe(deviceId, transcript, semanticContent.reply, { type: semanticContent.item?.type, durationMs: semanticContent.durationMs, provider: 'content_cache_semantic' });
                logger.info(`[Pipeline] sent cached content audio via semantic intent: ${semanticContent.item.id}`);
                return;
            }
        }

                logger.info('[Pipeline] preparing LLM context…');
        const settingsContext = parentConfig.formatSettingsForPrompt(settings);
        const profile = await memory.getProfile(deviceId);
        const memoryContext = settings.memory_enabled === false ? '' : memory.formatProfileForPrompt(profile);
        const modelName = (semanticConfident && semanticIntent.is_unsafe) ? 'gpt' : parentConfig.modelModeToModelName(settings);
        const story = await storyEngine.buildStoryContext(transcript);

        if (story && !isContentTypeAllowed(settings, 'story')) {
            logger.info('[Pipeline] parent-disabled story requested');
            const reply = disabledContentReply('story', effectiveLang);
            const audio = await content.ensureCachedReply(reply, {
                baseUrl,
                lang: effectiveLang,
                key: 'disabled_story',
            });

            if (!isCurrent()) {
                logger.info('[Pipeline] superseded after disabled story reply — discarding (child interrupted)');
                return;
            }

            sendAudio(audio.audioUrl, audio.durationMs);
            recordUsageSafe(deviceId, audio.durationMs);
            recordAnalyticsSafe(deviceId, transcript, reply, { type: 'story', durationMs: audio.durationMs, provider: 'system' });
            return;
        }

        const followupContext = !story && state.lastContentMode === 'story'
            ? storyEngine.buildStoryFollowupContext(transcript)
            : '';

        const requestedContentContext = contentModeContext(requestedContentType);

        const intent = detectIntent(transcript);
        logger.info(`[Pipeline] detected intent: ${intent}`);

        const delayedThinking = startDelayedThinking({
            intent,
            isCurrent,
            sendAudio,
            delayMs: THINKING_DELAY_MS,
        });

        logger.info('[Pipeline] LLM start…');
        const llmStartedAt = Date.now();

        let reply;

        try {
            reply = story
                ? await llm.chat(ws, story.prompt, effectiveLang, {
                    memoryContext,
                    contentContext: [settingsContext, story.contentContext, requestedContentContext].filter(Boolean).join('\n\n'),
                    maxTokens: story.maxTokens,
                    model: modelName,
                    routingText: transcript,
                    isStory: true,
                    topic: semanticConfident ? semanticIntent.topic : undefined,
                    sentiment: semanticConfident ? semanticIntent.sentiment : undefined,
                    languageMismatch,
                })
                : await llm.chat(ws, transcript, effectiveLang, {
                    memoryContext,
                    contentContext: [settingsContext, followupContext, requestedContentContext].filter(Boolean).join('\n\n'),
                    languageMismatch,
                    model: modelName,
                    routingText: transcript,
                    topic: semanticConfident ? semanticIntent.topic : undefined,
                    sentiment: semanticConfident ? semanticIntent.sentiment : undefined,
                });
        } catch (err) {
            delayedThinking.cancel();
            throw err;
        }

        logger.info(`[Pipeline] reply: "${reply}"`);
        logger.info(`[Pipeline][${reqId}] stage=llm_done duration_ms=${Date.now() - llmStartedAt}`);

        if (!isCurrent()) {
            delayedThinking.cancel();
            logger.info('[Pipeline] superseded after LLM — discarding (child interrupted)');
            return;
        }

        logger.info('[Pipeline] TTS start…');
        const outputPath = path.join(DIR_AUDIO, `response_${ts}.pcm`);
        const ttsStartedAt = Date.now();
        const replyVoiceConfig = buildVoiceConfig(settings);

        let durationMs;

        try {
            durationMs = await tts.synthesize(reply, outputPath, effectiveLang === 'auto' ? null : effectiveLang, { voiceSpeed: settings.voice_speed, voiceConfig: replyVoiceConfig });
        } catch (err) {
            delayedThinking.cancel();
            throw err;
        }

        logger.info(`[Pipeline] TTS saved: ${outputPath}, ~${durationMs}ms`);
        logger.info(`[Pipeline][${reqId}] stage=tts_done duration_ms=${Date.now() - ttsStartedAt}`);
        logger.info(`[ReplyTTS] lang=${effectiveLang} provider=${replyVoiceConfig?.provider || 'auto'} voice=${replyVoiceConfig?.id || 'auto'} speed=${settings.voice_speed}`);

        if (!isCurrent()) {
            delayedThinking.cancel();
            logger.info('[Pipeline] superseded after TTS — discarding (child interrupted)');
            return;
        }

        const audioUrl = `${baseUrl}/audio/response_${ts}.wav`;

        await delayedThinking.cancelAndWait();

        if (!isCurrent()) {
            logger.info('[Pipeline] superseded before sending final audio — discarding (child interrupted)');
            return;
        }

        sendAudio(audioUrl, durationMs);
        logger.info(`[Pipeline] sent audio command: ${audioUrl}`);
        recordUsageSafe(deviceId, durationMs);
        recordAnalyticsSafe(deviceId, transcript, reply, { type: story ? 'story' : requestedContentType, durationMs, provider: 'llm' });
        state.lastContentMode = story ? 'story' : null;
        if (settings.memory_enabled !== false) {
            memory.rememberFromText(deviceId, transcript, profile)
                .catch(err => logger.warn(`[Memory] auto-update failed: ${err.message}`));
        }

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


// ── Named system audio assets (greeting/retry) ────────────────────────────────
// Имя файла на диске больше не хардкодится тут — его вычисляет tts.getAssetPath()
// из (type, lang, gender). Ленивая генерация: если ассета ещё нет, tts.js сам
// его создаст при первом реальном обращении, а не заранее при старте сервера.
const GREETING_TEXTS = {
    'ru-RU': 'Привет! Я - Луми, твой друг! Нажми кнопку и давай поговорим!',
    'ro-RO': 'Salut! Eu sunt Lumi, prietenul tău! Apasă butonul și hai să vorbim!',
    'en-US': "Hi! I am Lumi, your friend! Press the button and let's talk!",
    'es-ES': '¡Hola! Soy Lumi, tu amigo! ¡Presiona el botón y vamos a hablar!',
    'fr-FR': 'Salut ! Je suis Lumi, ton ami ! Appuie sur le bouton et parlons ensemble !',
    'it-IT': 'Ciao! Sono Lumi, il tuo amico! Premi il pulsante e parliamo!',
};

// Тёплая просьба повторить — играется когда нажатие слишком короткое
// или речь не распозналась. Lumi не выдаёт сухую ошибку, а ласково просит ещё разок.
const RETRY_TEXTS = {
    'ru-RU': 'Ой! Скажи ещё раз, пожалуйста! Я не расслышал!',
    'ro-RO': 'Ups! Poți să spui din nou, te rog! Nu am auzit bine!',
    'en-US': 'Oops! Can you say that again, please! I did not hear you!',
    'es-ES': '¡Uy! ¿Puedes decirlo otra vez, por favor? ¡No te escuché bien!',
    'fr-FR': "Oups ! Tu peux répéter, s'il te plaît ? Je n'ai pas bien entendu !",
    'it-IT': 'Ops! Puoi ripetere, per favore? Non ho sentito bene!',
};

// Если для языка нет текста (не должно случаться для поддерживаемых языков, но на
// случай неожиданного кода) — фолбэк на en-US, а не на ru-RU: английский нейтральнее
// как аварийный вариант, чем язык, которого ребёнок может вообще не знать.
function resolveSystemPhraseLang(lang) {
    if (lang && GREETING_TEXTS[lang]) return lang;
    return 'en-US';
}

// Собирает команду воспроизведения retry-аудио, генерируя его лениво под
// конкретные язык/пол игрушки, если ещё не закэшировано. На ошибке генерации
// возвращает null — вызывающий код просто пропускает эту реплику, не падая.
async function retryAudioCommand(lang, gender, voiceConfig = null) {
    const baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
    const effectiveLang = resolveSystemPhraseLang(lang);
    const asset = await tts.synthesizeAsset('retry', RETRY_TEXTS[effectiveLang], effectiveLang, gender, { voiceConfig });
    if (!asset) return null;
    return { url: `${baseUrl}/audio/${path.basename(asset.wavPath)}`, durationMs: asset.durationMs };
}


// ── Context-aware delayed thinking phrases ───────────────────────────────────
//
// Эти короткие фразы играются не сразу, а только если основной LLM-ответ
// не успевает подготовиться быстро.

const THINKING_CHANCE = 0.75;          // 0.75 = примерно в 75% случаев
const THINKING_DELAY_MS = 500;         // пауза перед filler-фразой
const THINKING_END_GRACE_MS = 300;     // маленький запас перед основным ответом

const THINKING_BY_INTENT = {
    story: [
        { text: 'Сказку? Сейчас придумаю...', file: 'thinking_story_1_ru', weight: 4 },
        { text: 'О, сказка будет хорошая...', file: 'thinking_story_2_ru', weight: 3 },
        { text: 'Сейчас найду...', file: 'thinking_story_3_ru', weight: 3 },
        { text: 'Так, начинаем...', file: 'thinking_story_4_ru', weight: 2 },
        { text: 'Сейчас будет история...', file: 'thinking_story_5_ru', weight: 2 },
        { text: 'Угу, сказку я люблю...', file: 'thinking_story_6_ru', weight: 1 },
    ],

    tongue_twister: [
        { text: 'Скороговорку? ..', file: 'thinking_twister_1_ru', weight: 4 },
        { text: 'Так, готовлю ...', file: 'thinking_twister_2_ru', weight: 3 },
        { text: 'Хорошо -  скороговорка...', file: 'thinking_twister_3_ru', weight: 2 },
        { text: 'Сейчас выберу...', file: 'thinking_twister_4_ru', weight: 3 },
        { text: 'Держись, язык сейчас побежит...', file: 'thinking_twister_5_ru', weight: 1 },
        { text: 'Хм, нужна смешная...', file: 'thinking_twister_6_ru', weight: 2 },
    ],

    game: [
        { text: 'Поиграем? ...', file: 'thinking_game_1_ru', weight: 4 },
        { text: 'Ура, игра! ...', file: 'thinking_game_2_ru', weight: 3 },
        { text: 'Так, во что бы нам сыграть...', file: 'thinking_game_3_ru', weight: 3 },
        { text: 'Сейчас найду игру...', file: 'thinking_game_4_ru', weight: 3 },
        { text: 'О, играть я люблю...', file: 'thinking_game_5_ru', weight: 2 },
        { text: 'Сейчас выберу...', file: 'thinking_game_6_ru', weight: 2 },
    ],

    riddle: [
        { text: 'Загадку? Сейчас найду...', file: 'thinking_riddle_1_ru', weight: 4 },
        { text: 'О, загадки я люблю...', file: 'thinking_riddle_2_ru', weight: 3 },
        { text: 'Сейчас будет...', file: 'thinking_riddle_3_ru', weight: 3 },
        { text: 'Так, нужна не слишком лёгкая...', file: 'thinking_riddle_4_ru', weight: 2 },
        { text: 'Хм, какую бы загадать...', file: 'thinking_riddle_5_ru', weight: 3 },
        { text: 'Сейчас найду загадку с секретом...', file: 'thinking_riddle_6_ru', weight: 1 },
    ],

    song: [
        { text: 'Песенку? Сейчас...', file: 'thinking_song_1_ru', weight: 4 },
        { text: 'Так, готовлю голос...', file: 'thinking_song_2_ru', weight: 3 },
        { text: 'Сейчас будет песенка...', file: 'thinking_song_3_ru', weight: 2 },
        { text: 'О, песенки это хорошо...', file: 'thinking_song_4_ru', weight: 2 },
        { text: 'Минуточку, ищу мелодию...', file: 'thinking_song_5_ru', weight: 2 },
        { text: 'Секунду...', file: 'thinking_song_6_ru', weight: 1 },
    ],

    joke: [
        { text: 'Шутку? Сейчас вспомню...', file: 'thinking_joke_1_ru', weight: 4 },
        { text: 'О, сейчас попробую рассмешить...', file: 'thinking_joke_2_ru', weight: 3 },
        { text: 'Так, нужна шутка...', file: 'thinking_joke_3_ru', weight: 3 },
        { text: 'Сейчас будет смешинка...', file: 'thinking_joke_4_ru', weight: 2 },
        { text: 'Хм, какую бы шутку сказать...', file: 'thinking_joke_5_ru', weight: 2 },
        { text: 'Готовлю смешной ответ...', file: 'thinking_joke_6_ru', weight: 1 },
    ],

    explain: [
        { text: 'Сейчас объясню ...', file: 'thinking_explain_1_ru', weight: 4 },
        { text: 'Хороший вопрос ...', file: 'thinking_explain_2_ru', weight: 3 },
        { text: 'Так, надо объяснить ...', file: 'thinking_explain_3_ru', weight: 4 },
        { text: 'Сейчас разберёмся...', file: 'thinking_explain_4_ru', weight: 3 },
        { text: 'Хм, интересно ...', file: 'thinking_explain_5_ru', weight: 2 },
        { text: 'Сейчас найду ответ...', file: 'thinking_explain_6_ru', weight: 3 },
    ],

    facts: [
        { text: 'Сейчас вспомню...', file: 'thinking_fact_1_ru', weight: 4 },
        { text: 'О, сейчас будет интересное...', file: 'thinking_fact_2_ru', weight: 3 },
        { text: 'Так, ищу любопытный факт...', file: 'thinking_fact_3_ru', weight: 3 },
        { text: 'Сейчас расскажу...', file: 'thinking_fact_4_ru', weight: 2 },
        { text: 'Хм, это правда интересно...', file: 'thinking_fact_5_ru', weight: 2 },
        { text: 'Минуточку, вспоминаю...', file: 'thinking_fact_6_ru', weight: 3 },
    ],

    emotion_sad: [
        { text: 'Я рядом. Все хорошо...', file: 'thinking_sad_1_ru', weight: 4 },
        { text: 'Понимаю. Дай я подумаю...', file: 'thinking_sad_2_ru', weight: 3 },
        { text: 'Сейчас скажу тебе мягко...', file: 'thinking_sad_3_ru', weight: 3 },
        { text: 'Мне хочется тебя поддержать...', file: 'thinking_sad_4_ru', weight: 2 },
        { text: 'Давай чуть-чуть побудем вместе...', file: 'thinking_sad_5_ru', weight: 2 },
        { text: 'Я слышу тебя. Сейчас отвечу...', file: 'thinking_sad_6_ru', weight: 3 },
    ],

    fear: [
        { text: 'Страшно? Я рядом...', file: 'thinking_fear_1_ru', weight: 4 },
        { text: 'Сейчас поговорим спокойно...', file: 'thinking_fear_2_ru', weight: 4 },
        { text: 'Давай разберёмся вместе...', file: 'thinking_fear_3_ru', weight: 3 },
        { text: 'Я с тобой. Все хорошо...', file: 'thinking_fear_4_ru', weight: 3 },
        { text: 'Сейчас скажу помягче...', file: 'thinking_fear_5_ru', weight: 2 },
        { text: 'Давай подумаем вместе...', file: 'thinking_fear_6_ru', weight: 2 },
    ],

    repeat: [
        { text: 'Повторить? Конечно...', file: 'thinking_repeat_1_ru', weight: 4 },
        { text: 'Сейчас скажу ещё раз...', file: 'thinking_repeat_2_ru', weight: 4 },
        { text: 'Угу, повторяю...', file: 'thinking_repeat_3_ru', weight: 3 },
        { text: 'Хорошоу, повторю...', file: 'thinking_repeat_4_ru', weight: 2 },
        { text: 'Давай ещё раз...', file: 'thinking_repeat_5_ru', weight: 3 },
        { text: 'Сейчас скажу понятнее...', file: 'thinking_repeat_6_ru', weight: 2 },
    ],

    default: [
        { text: 'Секундочку...', file: 'thinking_default_1_ru', weight: 5 },
        { text: 'Хм, дай-ка подумаю...', file: 'thinking_default_2_ru', weight: 4 },
        { text: 'Сейчас отвечу...', file: 'thinking_default_3_ru', weight: 4 },
        { text: 'Ага ...', file: 'thinking_default_4_ru', weight: 4 },
        { text: 'Так...', file: 'thinking_default_5_ru', weight: 3 },
        { text: 'Я уже думаю...', file: 'thinking_default_6_ru', weight: 3 },
    ],
};

// Компактный, НЕ привязанный к intent набор thinking-фраз для всех языков, кроме
// русского (у RO/EN/ES/FR/IT никогда не было переведённых по-интентно фраз — делать
// полный перевод всех 12 интентов × 6 фраз на 5 языков непропорционально этой filler-фиче).
// Используется thinkingAudioCommand, когда lang !== 'ru-RU'.
const THINKING_GENERIC = {
    'ro-RO': [
        { text: 'O secundă...', file: 'generic_1', weight: 4 },
        { text: 'Mă gândesc...', file: 'generic_2', weight: 3 },
        { text: 'Acum răspund...', file: 'generic_3', weight: 3 },
        { text: 'Așa...', file: 'generic_4', weight: 2 },
    ],
    'en-US': [
        { text: 'One second...', file: 'generic_1', weight: 4 },
        { text: 'Let me think...', file: 'generic_2', weight: 3 },
        { text: 'Coming up...', file: 'generic_3', weight: 3 },
        { text: 'So...', file: 'generic_4', weight: 2 },
    ],
    'es-ES': [
        { text: 'Un segundo...', file: 'generic_1', weight: 4 },
        { text: 'Déjame pensar...', file: 'generic_2', weight: 3 },
        { text: 'Ahora te digo...', file: 'generic_3', weight: 3 },
        { text: 'A ver...', file: 'generic_4', weight: 2 },
    ],
    'fr-FR': [
        { text: 'Une seconde...', file: 'generic_1', weight: 4 },
        { text: 'Je réfléchis...', file: 'generic_2', weight: 3 },
        { text: 'Je te réponds...', file: 'generic_3', weight: 3 },
        { text: 'Alors...', file: 'generic_4', weight: 2 },
    ],
    'it-IT': [
        { text: 'Un secondo...', file: 'generic_1', weight: 4 },
        { text: 'Fammi pensare...', file: 'generic_2', weight: 3 },
        { text: 'Ora ti dico...', file: 'generic_3', weight: 3 },
        { text: 'Allora...', file: 'generic_4', weight: 2 },
    ],
};

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function detectIntent(text) {
    const t = String(text || '').toLowerCase();

    if (/(страшно|боюсь|испугался|испугалась|темно|монстр|кошмар|ужасно)/.test(t)) return 'fear';
    if (/(грустно|обидно|плачу|скучно|одиноко|меня обидели|поссорился|поссорилась|плохо на душе)/.test(t)) return 'emotion_sad';
    if (/(повтори|ещё раз|еще раз|снова скажи|не понял|не поняла|погромче|медленнее|повторить)/.test(t)) return 'repeat';
    if (/(сказк|истори|расскажи историю|придумай историю|волшебн|жили-были|жили были)/.test(t)) return 'story';
    if (/(скороговорк|быстро скажи|язык слома|сложн.*сказать)/.test(t)) return 'tongue_twister';
    if (/(поигра|игра|давай играть|сыграем|во что играть|играть хочу)/.test(t)) return 'game';
    if (/(загадк|загадай|угадай|отгадай)/.test(t)) return 'riddle';
    if (/(песн|спой|петь|колыбельн|мелоди|напой)/.test(t)) return 'song';
    if (/(шутк|анекдот|рассмеши|смешн|пошути)/.test(t)) return 'joke';
    if (/(почему|зачем|как работает|что такое|объясни|расскажи почему|как это|откуда)/.test(t)) return 'explain';
    if (/(факт|интересное|расскажи про|знаешь что|удивительн|любопытн)/.test(t)) return 'facts';

    return 'default';
}

function pickWeightedPhrase(list) {
    const totalWeight = list.reduce((sum, item) => sum + (item.weight || 1), 0);
    let random = Math.random() * totalWeight;

    for (const item of list) {
        random -= item.weight || 1;
        if (random <= 0) return item;
    }

    return list[list.length - 1];
}

async function thinkingAudioCommand(intent = 'default') {
    if (Math.random() >= THINKING_CHANCE) return null;

    const list = THINKING_BY_INTENT[intent] || THINKING_BY_INTENT.default;
    const phrase = pickWeightedPhrase(list);
    // 'thinking_story_1_ru' -> 'story_1' — язык/пол больше не зашиты в имени файла,
    // их отдаёт вызывающая сторона (см. serverPipelinePatch.js), тут остаётся
    // только устойчивый ключ варианта фразы внутри интента.
    const variant = phrase.file.replace(/^thinking_/, '').replace(/_ru$/, '');

    const baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
    const asset = await tts.synthesizeAsset('thinking', phrase.text, 'ru-RU', 'female', { variant });
    if (!asset) return null;

    return { url: `${baseUrl}/audio/${path.basename(asset.wavPath)}`, durationMs: asset.durationMs };
}

function startDelayedThinking({ intent, isCurrent, sendAudio, delayMs = THINKING_DELAY_MS }) {
    let cancelled = false;
    let sentAt = 0;
    let sentDurationMs = 0;

    (async () => {
        await delay(delayMs);

        if (cancelled) return;
        if (!isCurrent()) return;

        const thinking = thinkingAudioCommand(intent);
        if (!thinking) return;
        if (cancelled) return;
        if (!isCurrent()) return;

        sentAt = Date.now();
        sentDurationMs = thinking.durationMs || 0;

        sendAudio(thinking.url, thinking.durationMs);
        logger.info(`[Thinking] sent filler intent=${intent} lang=${lang} provider=${voiceConfig?.provider || 'auto'} voice=${voiceConfig?.id || 'auto'} cache_hit=${Boolean(thinking.cached)} duration_ms=${thinking.durationMs}`);
    })();

    return {
        cancel: () => {
            cancelled = true;
        },

        cancelAndWait: async () => {
            cancelled = true;

            if (!sentAt || !sentDurationMs) return;

            const elapsed = Date.now() - sentAt;
            const remaining = sentDurationMs + THINKING_END_GRACE_MS - elapsed;
            const waitMs = Math.max(0, Math.min(remaining, 1200));

            if (waitMs > 0 && isCurrent()) {
                logger.info(`[Thinking] waiting ${waitMs}ms before main answer to avoid cutting filler`);
                await delay(waitMs);
            }
        },
    };
}

// ── Start ─────────────────────────────────────────────────────────────────────
// Greeting/retry/thinking больше не прогреваются заранее при старте — сервер
// поднимается мгновенно, а каждый ассет генерируется лениво через
// tts.synthesizeAsset() при первом реальном обращении под конкретные язык/пол.
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    logger.info(`Lunara TOY server listening on port ${PORT}`);
    await memory.init();
    await parentConfig.init();
    await content.init({ audioDir: DIR_CONTENT_AUDIO });
    await riddleEngine.init({
        audioDir: DIR_AUDIO,
        tts,
        logger,
    });
    // cleaner.js удаляет только файлы response_*.pcm/.wav (см. TRANSIENT_AUDIO_RE) —
    // именованные ассеты greeting/retry/thinking под этот паттерн не попадают
    // в принципе, отдельный keep-list им не требуется.
    cleaner.start(DIR_AUDIO, 10 * 60 * 1000);
});
