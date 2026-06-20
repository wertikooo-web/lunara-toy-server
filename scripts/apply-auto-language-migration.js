'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');

function replaceOnce(text, before, after, label) {
  const count = text.split(before).length - 1;
  if (count === 1) return text.replace(before, after);
  if (count === 0 && text.includes(after)) return text;
  throw new Error(`${label}: expected one source fragment, found ${count}`);
}

function patchParent(text) {
  if (text.includes("auto_language_fallback: 'ru-RU'") && text.includes("['auto', 'ru-RU', 'ro-RO', 'en-US']")) return text;
  text = replaceOnce(text,
    "    language: 'ru-RU',\n    model_mode: 'auto',",
    "    language: 'ru-RU',\n    auto_language_fallback: 'ru-RU',\n    model_mode: 'auto',", 'parent defaults');
  text = replaceOnce(text,
    "        patch.language = ['ru-RU', 'ro-RO', 'en-US'].includes(value) ? value : DEFAULT_SETTINGS.language;\n    }\n    if ('model_mode' in raw) {",
    "        patch.language = ['auto', 'ru-RU', 'ro-RO', 'en-US'].includes(value) ? value : DEFAULT_SETTINGS.language;\n    }\n    if ('auto_language_fallback' in raw) {\n        const value = safeText(raw.auto_language_fallback, 12);\n        patch.auto_language_fallback = ['ru-RU', 'ro-RO', 'en-US'].includes(value) ? value : DEFAULT_SETTINGS.auto_language_fallback;\n    }\n    if ('model_mode' in raw) {", 'parent validation');
  text = replaceOnce(text,
    "            language TEXT NOT NULL DEFAULT 'ru-RU',\n            model_mode TEXT NOT NULL DEFAULT 'auto',",
    "            language TEXT NOT NULL DEFAULT 'ru-RU',\n            auto_language_fallback TEXT NOT NULL DEFAULT 'ru-RU',\n            model_mode TEXT NOT NULL DEFAULT 'auto',", 'parent schema');
  text = replaceOnce(text,
    "    await pool.query(\"UPDATE device_settings SET language = 'ru-RU' WHERE language = 'auto'\");",
    "    await pool.query(\"ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS auto_language_fallback TEXT NOT NULL DEFAULT 'ru-RU'\");", 'parent migration');
  text = replaceOnce(text,
    "    if (!['ru-RU', 'ro-RO', 'en-US'].includes(settings.language)) settings.language = DEFAULT_SETTINGS.language;\n    settings.memory_enabled = settings.memory_enabled !== false;",
    "    if (!['auto', 'ru-RU', 'ro-RO', 'en-US'].includes(settings.language)) settings.language = DEFAULT_SETTINGS.language;\n    if (!['ru-RU', 'ro-RO', 'en-US'].includes(settings.auto_language_fallback)) settings.auto_language_fallback = DEFAULT_SETTINGS.auto_language_fallback;\n    settings.memory_enabled = settings.memory_enabled !== false;", 'parent normalization');
  text = replaceOnce(text,
    "             memory_enabled = $30,\n             updated_at = now()",
    "             memory_enabled = $30,\n             auto_language_fallback = $31,\n             updated_at = now()", 'parent reset sql');
  text = replaceOnce(text,
    "            DEFAULT_SETTINGS.memory_enabled,\n        ]",
    "            DEFAULT_SETTINGS.memory_enabled,\n            DEFAULT_SETTINGS.auto_language_fallback,\n        ]", 'parent reset values');
  text = replaceOnce(text,
    "    const promptLang = s.language || DEFAULT_SETTINGS.language;",
    "    const isAutoLanguage = s.language === 'auto';\n    const promptLang = isAutoLanguage ? (s.auto_language_fallback || DEFAULT_SETTINGS.auto_language_fallback) : (s.language || DEFAULT_SETTINGS.language);", 'parent prompt language');
  text = replaceOnce(text,
    "        `- Main language setting: ${promptLang}` ,".replace('` ,','`,'),
    "        `- Main language setting: ${isAutoLanguage ? 'AUTO' : promptLang}`,\n        isAutoLanguage ? `- AUTO language rule: detect Russian, Romanian, or English from the child current message and reply only in that language. If the message is too short or unclear, use ${promptLang}. Do not switch because of one name, interjection, yes/no word, or borrowed word.` : '',", 'parent prompt rule');
  return text;
}

function patchServer(text) {
  if (
    text.includes("const { resolveConversationLanguage } = require('./modules/language');") &&
    text.includes("app.get('/api/device/language'") &&
    text.includes("app.post('/api/transcribe'")
  ) return text;

  text = replaceOnce(text,
    "const parentConfig = require('./modules/parentConfig');",
    "const parentConfig = require('./modules/parentConfig');\nconst { resolveConversationLanguage } = require('./modules/language');", 'server import');

  text = replaceOnce(text,
    "app.use('/', express.static(path.join(__dirname, 'public')));\napp.get('/parent', (_req, res) => {\n    res.sendFile(path.join(__dirname, 'public', 'parent.html'));\n});\napp.get('/health', (_req, res) => res.json({ status: 'ok' }));",
    "function sendHtmlWithScript(res, fileName, scriptSrc) {\n    const htmlPath = path.join(__dirname, 'public', fileName);\n    const html = fs.readFileSync(htmlPath, 'utf8');\n    const tag = `<script src=\"${scriptSrc}\"></script>`;\n    const output = html.includes(tag) ? html : html.replace('</body>', `${tag}\\n</body>`);\n    res.type('html').send(output);\n}\napp.get('/', (_req, res) => sendHtmlWithScript(res, 'index.html', '/demo-language-control.js'));\napp.get('/parent', (_req, res) => sendHtmlWithScript(res, 'parent.html', '/parent-language-control.js'));\napp.use('/', express.static(path.join(__dirname, 'public')));\napp.get('/health', (_req, res) => res.json({ status: 'ok' }));\napp.get('/api/device/language', async (req, res) => {\n    try {\n        const deviceId = memory.normalizeDeviceId(req.query?.device_id);\n        const settings = await parentConfig.getSettings(deviceId);\n        res.json({ device_id: deviceId, language_mode: settings.language, auto_language_fallback: settings.auto_language_fallback || 'ru-RU', active_language: settings.language === 'auto' ? null : settings.language });\n    } catch (err) {\n        logger.error(`[Device Language] ${err.message}`);\n        res.status(500).json({ error: err.message });\n    }\n});\napp.post('/api/transcribe', express.raw({ type: ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'application/octet-stream'], limit: '8mb' }), async (req, res) => {\n    let uploadPath = null;\n    try {\n        if (!Buffer.isBuffer(req.body) || req.body.length < 1000) {\n            return res.status(400).json({ error: 'audio body is empty' });\n        }\n        const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();\n        const extension = mime === 'audio/ogg' ? '.ogg' : mime === 'audio/mp4' ? '.m4a' : mime === 'audio/wav' || mime === 'audio/x-wav' ? '.wav' : '.webm';\n        uploadPath = path.join(DIR_UPLOADS, `browser_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${extension}`);\n        fs.writeFileSync(uploadPath, req.body);\n        const result = await stt.transcribeFile(uploadPath);\n        if (!result.text) return res.status(422).json({ error: 'speech was not recognized' });\n        res.json({ text: result.text, detected_language: result.language, provider: result.provider, model: result.model });\n    } catch (err) {\n        logger.error(`[Browser STT] ${err.message}`);\n        res.status(500).json({ error: err.message });\n    } finally {\n        if (uploadPath) fs.rmSync(uploadPath, { force: true });\n    }\n});", 'server routes');

  text = replaceOnce(text,
    "    const lang = req.body?.lang || 'ru-RU';",
    "    const lang = req.body?.lang || 'ru-RU';\n    const detectedLanguage = req.body?.detected_language || null;", 'chat detected language input');

  text = replaceOnce(text,
    "        const settings = await parentConfig.getSettings(deviceId);\n        const effectiveLang = settings.language || lang;",
    "        const settings = await parentConfig.getSettings(deviceId);\n        const languageResult = resolveConversationLanguage(sessionRef, settings.language || lang, text, settings.auto_language_fallback || 'ru-RU', detectedLanguage);\n        const effectiveLang = languageResult.language;\n        if (languageResult.changed) { llm.resetHistory(sessionRef); sessionRef.pendingContent = null; sessionRef.lastContentMode = null; }\n        const languageMeta = { language_mode: settings.language || lang, active_language: effectiveLang, detected_language: languageResult.detected_language || null, language_reason: languageResult.reason };", 'chat language');

  const start = text.indexOf("app.post('/chat'");
  const end = text.indexOf('\nfunction cachedModelMeta', start);
  if (start < 0 || end < 0) throw new Error('chat block not found');
  let chat = text.slice(start, end);
  if (!chat.includes('...languageMeta')) chat = chat.replace(/\n(\s+)device_id: deviceId,/g, (_m, i) => `\n${i}device_id: deviceId,\n${i}...languageMeta,`);
  text = text.slice(0, start) + chat + text.slice(end);

  text = replaceOnce(text,
    "        lastContentMode: null,\n    };",
    "        lastContentMode: null,\n        activeLanguage: null,\n        languageCandidate: null,\n        languageCandidateCount: 0,\n    };", 'ws state');
  text = replaceOnce(text,
    "        const settings = await parentConfig.getSettings(deviceId);\n        const effectiveLang = settings.language && settings.language !== 'auto' ? settings.language : 'auto';",
    "        const settings = await parentConfig.getSettings(deviceId);\n        const languageResult = resolveConversationLanguage(state, settings.language, transcript, settings.auto_language_fallback || 'ru-RU');\n        const effectiveLang = languageResult.language;\n        if (languageResult.changed) { llm.resetHistory(ws); state.pendingContent = null; state.lastContentMode = null; }\n        logger.info(`[Language] mode=${settings.language} active=${effectiveLang} detected=${languageResult.detected_language || '-'} reason=${languageResult.reason}`);", 'ws language');
  text = replaceOnce(text,
    "tts.synthesize(reply, outputPath, effectiveLang === 'auto' ? null : effectiveLang, { voiceSpeed: settings.voice_speed })",
    "tts.synthesize(reply, outputPath, effectiveLang, { voiceSpeed: settings.voice_speed })", 'tts language');
  return text;
}

function checkedWrite(file, text) {
  const tmp = `${file}.auto-language.tmp.js`;
  fs.writeFileSync(tmp, text, 'utf8');
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'inherit' });
  fs.renameSync(tmp, file);
}

const parent = path.join(root, 'modules', 'parentConfig.js');
const server = path.join(root, 'server.js');
checkedWrite(parent, patchParent(fs.readFileSync(parent, 'utf8').replace(/\r\n/g, '\n')));
checkedWrite(server, patchServer(fs.readFileSync(server, 'utf8').replace(/\r\n/g, '\n')));
console.log('[AUTO Language] migration applied and syntax checked');
