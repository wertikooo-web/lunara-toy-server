'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const originalJsLoader = Module._extensions['.js'];
const serverPath = path.resolve(__dirname, '..', 'server.js');
const parentConfigPath = path.resolve(__dirname, 'parentConfig.js');

const PARENT_THINKING_UI_HTML = `
        <div>
          <label id="thinkingPhrasesLabel">Thinking-фразы</label>
          <label class="inline-check">
            <input id="thinking_phrases_enabled" type="checkbox" checked>
            <span id="thinkingPhrasesEnabledLabel">Включены</span>
          </label>
          <p class="small">Промежуточные фразы вроде «секундочку...» перед долгим LLM-ответом. На заготовки/кеш они не нужны.</p>
        </div>
        <div>
          <label id="thinkingFrequencyLabel">Частота thinking-фраз</label>
          <select id="thinking_frequency">
            <option value="rare">Редко</option>
            <option value="normal">Иногда</option>
            <option value="often">Часто</option>
          </select>
          <p class="small" id="thinkingFrequencyHelp">Для демо лучше: редко или выключено.</p>
        </div>
`;

const PARENT_THINKING_UI_SCRIPT = `
<script>
(function installThinkingSettingsPatch() {
  function byId(id) { return document.getElementById(id); }
  function setThinkingFields(settings) {
    const enabled = byId('thinking_phrases_enabled');
    const freq = byId('thinking_frequency');
    if (enabled) enabled.checked = settings?.thinking_phrases_enabled !== false;
    if (freq) freq.value = ['rare', 'normal', 'often'].includes(settings?.thinking_frequency) ? settings.thinking_frequency : 'normal';
  }
  function getThinkingFields() {
    return {
      thinking_phrases_enabled: byId('thinking_phrases_enabled')?.checked === true,
      thinking_frequency: byId('thinking_frequency')?.value || 'normal',
    };
  }
  const oldApi = window.api || api;
  window.api = api = function patchedApi(path, options = {}) {
    try {
      if (String(path) === '/api/parent/settings' && String(options.method || '').toUpperCase() === 'POST' && options.body) {
        const body = JSON.parse(options.body);
        Object.assign(body, getThinkingFields());
        options = { ...options, body: JSON.stringify(body) };
      }
    } catch (err) {
      console.warn('[Parent] thinking settings injection failed', err);
    }
    return oldApi(path, options);
  };
  const oldLoadState = window.loadState || loadState;
  window.loadState = loadState = async function patchedLoadState() {
    const result = await oldLoadState.apply(this, arguments);
    setThinkingFields(window.lastParentState?.settings || {});
    return result;
  };
  byId('thinking_phrases_enabled')?.addEventListener('change', () => window.updateUnsavedIndicator?.());
  byId('thinking_frequency')?.addEventListener('change', () => window.updateUnsavedIndicator?.());
  setThinkingFields(window.lastParentState?.settings || {});
})();
</script>`;

function replaceOnce(source, from, to, label) {
    if (source.includes(from)) {
        return source.replace(from, to);
    }
    const crlfFrom = from.replace(/\n/g, '\r\n');
    if (source.includes(crlfFrom)) {
        return source.replace(crlfFrom, to.replace(/\n/g, '\r\n'));
    }
    {
        throw new Error(`[ServerPipelinePatch] missing patch point: ${label}`);
    }
}

function replaceAllChecked(source, pattern, to, label) {
    const next = source.replace(pattern, to);
    if (next === source) {
        throw new Error(`[ServerPipelinePatch] missing patch point: ${label}`);
    }
    return next;
}

function patchParentConfigSource(source) {
    let patched = source;

    patched = replaceOnce(
        patched,
        "const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];\n",
        "const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];\nconst THINKING_FREQUENCIES = ['rare', 'normal', 'often'];\n",
        'thinking frequencies const'
    );

    patched = replaceOnce(
        patched,
        "    quiet_hours_end: '07:00',\n    content_enabled:",
        "    quiet_hours_end: '07:00',\n    thinking_phrases_enabled: true,\n    thinking_frequency: 'normal',\n    content_enabled:",
        'default thinking settings'
    );

    patched = replaceOnce(
        patched,
        "    if ('quiet_hours_end' in raw) patch.quiet_hours_end = normalizeTime(raw.quiet_hours_end, DEFAULT_SETTINGS.quiet_hours_end);\n    if ('content_enabled' in raw) {",
        "    if ('quiet_hours_end' in raw) patch.quiet_hours_end = normalizeTime(raw.quiet_hours_end, DEFAULT_SETTINGS.quiet_hours_end);\n    if ('thinking_phrases_enabled' in raw) patch.thinking_phrases_enabled = raw.thinking_phrases_enabled === true || raw.thinking_phrases_enabled === 'true' || raw.thinking_phrases_enabled === 'on';\n    if ('thinking_frequency' in raw) {\n        const value = safeText(raw.thinking_frequency, 16);\n        patch.thinking_frequency = THINKING_FREQUENCIES.includes(value) ? value : DEFAULT_SETTINGS.thinking_frequency;\n    }\n    if ('content_enabled' in raw) {",
        'normalize thinking settings patch'
    );

    patched = replaceOnce(
        patched,
        "            quiet_hours_end TEXT NOT NULL DEFAULT '07:00',\n            content_enabled",
        "            quiet_hours_end TEXT NOT NULL DEFAULT '07:00',\n            thinking_phrases_enabled BOOLEAN NOT NULL DEFAULT true,\n            thinking_frequency TEXT NOT NULL DEFAULT 'normal',\n            content_enabled",
        'device_settings thinking columns'
    );

    patched = replaceOnce(
        patched,
        "    await pool.query(\"ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS quiet_hours_end TEXT NOT NULL DEFAULT '07:00'\");\n",
        "    await pool.query(\"ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS quiet_hours_end TEXT NOT NULL DEFAULT '07:00'\");\n    await pool.query(\"ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS thinking_phrases_enabled BOOLEAN NOT NULL DEFAULT true\");\n    await pool.query(\"ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS thinking_frequency TEXT NOT NULL DEFAULT 'normal'\");\n",
        'alter thinking columns'
    );

    patched = replaceOnce(
        patched,
        "    settings.rest_schedule_enabled = settings.rest_schedule_enabled === true;\n    if (!settings.child_address_names.length)",
        "    settings.rest_schedule_enabled = settings.rest_schedule_enabled === true;\n    settings.thinking_phrases_enabled = settings.thinking_phrases_enabled !== false;\n    if (!THINKING_FREQUENCIES.includes(settings.thinking_frequency)) settings.thinking_frequency = DEFAULT_SETTINGS.thinking_frequency;\n    if (!settings.child_address_names.length)",
        'normalize thinking row'
    );

    return patched;
}

function patchServerSource(source) {
    let patched = source;

    patched = replaceOnce(
        patched,
        "app.get('/parent', (_req, res) => {\n    res.sendFile(path.join(__dirname, 'public', 'parent.html'));\n});",
        `app.get('/parent', (_req, res) => {\n    const parentHtmlPath = path.join(__dirname, 'public', 'parent.html');\n    let html = fs.readFileSync(parentHtmlPath, 'utf8');\n    if (!html.includes('thinking_phrases_enabled')) {\n        html = html.replace(\"        <div>\\n          <label id=\\\"modelModeLabel\\\">Режим модели</label>\\n          <select id=\\\"model_mode\\\">\\n            <option value=\\\"auto\\\">Авто</option>\\n            <option value=\\\"economy\\\">Экономный</option>\\n            <option value=\\\"smart\\\">Умный</option>\\n          </select>\\n        </div>\", \"        <div>\\n          <label id=\\\"modelModeLabel\\\">Режим модели</label>\\n          <select id=\\\"model_mode\\\">\\n            <option value=\\\"auto\\\">Авто</option>\\n            <option value=\\\"economy\\\">Экономный</option>\\n            <option value=\\\"smart\\\">Умный</option>\\n          </select>\\n        </div>\" + ${JSON.stringify(PARENT_THINKING_UI_HTML)});\n        html = html.replace('</body>', ${JSON.stringify(PARENT_THINKING_UI_SCRIPT)} + '\\n</body>');\n    }\n    res.type('html').send(html);\n});`,
        'dynamic parent page thinking ui'
    );

    patched = replaceOnce(
        patched,
        "const riddleEngine = require('./modules/riddleEngine');\n",
        "const riddleEngine = require('./modules/riddleEngine');\nconst conversationOrchestrator = require('./modules/conversationOrchestrator');\nconst riddleIntentClassifier = require('./modules/riddleIntentClassifier');\n",
        'require conversationOrchestrator and riddleIntentClassifier'
    );

    patched = replaceOnce(
        patched,
        "const THINKING_END_GRACE_MS = 300;     // маленький запас перед основным ответом\n",
        "const THINKING_END_GRACE_MS = 300;     // маленький запас перед основным ответом\n\nfunction thinkingChanceForSettings(settings = {}) {\n    if (settings.thinking_phrases_enabled === false) return 0;\n    if (settings.thinking_frequency === 'rare') return 0.12;\n    if (settings.thinking_frequency === 'often') return 0.75;\n    return 0.35;\n}\n\nfunction thinkingDelayForSettings(settings = {}) {\n    if (settings.thinking_frequency === 'rare') return 900;\n    if (settings.thinking_frequency === 'often') return 450;\n    return 700;\n}\n\nfunction noopDelayedThinking() {\n    return {\n        cancel: () => {},\n        cancelAndWait: async () => {},\n    };\n}\n",
        'thinking settings helpers'
    );

    patched = replaceOnce(
        patched,
        "async function thinkingAudioCommand(intent = 'default') {\n    if (Math.random() >= THINKING_CHANCE) return null;",
        "async function thinkingAudioCommand(intent = 'default', chance = THINKING_CHANCE, lang = 'ru-RU', gender = 'female') {\n    if (Math.random() >= chance) return null;",
        'thinking chance argument'
    );

    patched = replaceOnce(
        patched,
        "    const list = THINKING_BY_INTENT[intent] || THINKING_BY_INTENT.default;\n    const phrase = pickWeightedPhrase(list);\n    // 'thinking_story_1_ru' -> 'story_1' — язык/пол больше не зашиты в имени файла,\n    // их отдаёт вызывающая сторона (см. serverPipelinePatch.js), тут остаётся\n    // только устойчивый ключ варианта фразы внутри интента.\n    const variant = phrase.file.replace(/^thinking_/, '').replace(/_ru$/, '');",
        "    const isRussianThinking = !lang || lang.startsWith('ru');\n    const list = isRussianThinking ? (THINKING_BY_INTENT[intent] || THINKING_BY_INTENT.default) : (THINKING_GENERIC[lang] || THINKING_GENERIC['en-US']);\n    const phrase = pickWeightedPhrase(list);\n    // Русские файлы — 'thinking_story_1_ru' -> 'story_1' (intent-специфично). Остальные\n    // языки — плоский generic-набор (см. THINKING_GENERIC), file уже без декораций.\n    const variant = isRussianThinking ? phrase.file.replace(/^thinking_/, '').replace(/_ru$/, '') : phrase.file;",
        'thinking language-aware phrase list'
    );

    patched = replaceOnce(
        patched,
        "tts.synthesizeAsset('thinking', phrase.text, 'ru-RU', 'female', { variant })",
        "tts.synthesizeAsset('thinking', phrase.text, lang, gender, { variant })",
        'thinking asset lang/gender'
    );

    patched = replaceOnce(
        patched,
        "function startDelayedThinking({ intent, isCurrent, sendAudio, delayMs = THINKING_DELAY_MS }) {",
        "function startDelayedThinking({ intent, isCurrent, sendAudio, delayMs = THINKING_DELAY_MS, chance = THINKING_CHANCE, lang = 'ru-RU', gender = 'female' }) {",
        'startDelayedThinking chance argument'
    );

    patched = replaceOnce(
        patched,
        "        const thinking = thinkingAudioCommand(intent);",
        "        const thinking = await thinkingAudioCommand(intent, chance, lang, gender);",
        'thinking command chance use'
    );

    patched = replaceOnce(
        patched,
        "        const delayedThinking = startDelayedThinking({\n            intent,\n            isCurrent,\n            sendAudio,\n            delayMs: THINKING_DELAY_MS,\n        });",
        "        const thinkingChance = thinkingChanceForSettings(settings);\n        const delayedThinking = thinkingChance > 0\n            ? startDelayedThinking({\n                intent,\n                isCurrent,\n                sendAudio,\n                delayMs: thinkingDelayForSettings(settings),\n                chance: thinkingChance,\n                lang: effectiveLang,\n                gender: settings.toyGender || settings.toy_gender,\n            })\n            : noopDelayedThinking();\n        logger.info(`[Thinking] mode=${settings.thinking_phrases_enabled === false ? 'off' : settings.thinking_frequency || 'normal'} chance=${thinkingChance}`);",
        'thinking settings in pipeline'
    );

    patched = replaceOnce(
        patched,
        "        lastContentMode: null,\n    };",
        "        lastContentMode: null,\n        conversation: conversationOrchestrator.createState(),\n    };",
        'ws state conversation'
    );

    patched = replaceOnce(
        patched,
        "            state.lastContentMode = null;\n            llm.resetHistory(ws);",
        "            state.lastContentMode = null;\n            state.conversation = conversationOrchestrator.createState();\n            llm.resetHistory(ws);",
        'reset conversation state'
    );

    patched = replaceOnce(
        patched,
        "        const effectiveLang = settings.language && settings.language !== 'auto' ? settings.language : 'auto';\n",
        "        const effectiveLang = settings.language && settings.language !== 'auto' ? settings.language : 'auto';\n        const conversationDecision = conversationOrchestrator.detectDecision(transcript, state.conversation);\n        const pipelineText = conversationDecision.rewrittenText || transcript;\n        logger.info(`[Orchestrator] action=${conversationDecision.action} type=${conversationDecision.type} reason=${conversationDecision.reason}`);\n        const rememberBotReply = (reply, type) => {\n            const offer = conversationOrchestrator.rememberBotReply(state.conversation, reply, { type });\n            if (offer) logger.info(`[Orchestrator] pending offer=${offer.type}`);\n        };\n        if (conversationDecision.action === 'clarify' || conversationDecision.action === 'reply') {\n            const reply = conversationDecision.reply;\n            const audio = await content.ensureCachedReply(reply, {\n                baseUrl,\n                lang: effectiveLang,\n                key: `orchestrator_${conversationDecision.action}_${conversationDecision.type || 'chat'}`,\n            });\n            if (!isCurrent()) {\n                logger.info('[Pipeline] superseded after orchestrator reply — discarding');\n                return;\n            }\n            sendAudio(audio.audioUrl, audio.durationMs);\n            recordUsageSafe(deviceId, audio.durationMs);\n            recordAnalyticsSafe(deviceId, transcript, reply, {\n                type: conversationDecision.type || 'chat',\n                durationMs: audio.durationMs,\n                provider: 'orchestrator',\n            });\n            rememberBotReply(reply, conversationDecision.type || 'chat');\n            return;\n        }\n        if (conversationDecision.action === 'repeat_riddle') {\n            if (conversationDecision.activeRiddle) {\n                state.activeRiddle = { ...conversationDecision.activeRiddle, attempts: 0 };\n            }\n            sendAudio(conversationDecision.audioUrl, conversationDecision.durationMs);\n            recordUsageSafe(deviceId, conversationDecision.durationMs);\n            recordAnalyticsSafe(deviceId, transcript, conversationDecision.reply || 'Повторяю загадку.', {\n                type: 'riddle',\n                durationMs: conversationDecision.durationMs,\n                provider: 'orchestrator',\n            });\n            rememberBotReply(conversationDecision.reply || 'Повторяю загадку.', 'riddle');\n            logger.info(`[Orchestrator] repeated riddle=${conversationDecision.riddleId || 'unknown'} ref=${conversationDecision.ref || 'current'}`);\n            return;\n        }\n",
        'orchestrator decision after settings'
    );

    patched = replaceOnce(
        patched,
        "        // Если уже есть активная загадка, проверяем только короткие ответы:\n        // \"медведь\", \"это лиса\", \"не знаю\", \"скажи ответ\".\n        // Если фраза не похожа на ответ, отпускаем её дальше в обычный pipeline.\n        if (state.activeRiddle) {\n            logger.info(`[Riddle] active answer check: \"${transcript}\"`);\n\n            const result = await riddleEngine.handleActiveRiddleAnswer(\n                transcript,\n                state.activeRiddle,\n                baseUrl\n            );\n\n            if (!result.handled) {\n                logger.info('[Riddle] active riddle ignored: phrase is not an answer, falling through to normal pipeline');\n                state.activeRiddle = null;\n            } else {\n                state.activeRiddle = result.activeRiddle;\n\n                if (!isCurrent()) {\n                    logger.info('[Pipeline] superseded after riddle answer — discarding');\n                    return;\n                }\n\n                sendAudio(result.audio.url, result.audio.durationMs);\n                recordUsageSafe(deviceId, result.audio.durationMs);\n                recordAnalyticsSafe(deviceId, transcript, 'riddle_answer_feedback', {\n                    type: 'riddle',\n                    durationMs: result.audio.durationMs,\n                    provider: 'riddle_engine',\n                });\n                logger.info('[Riddle] sent answer feedback audio');\n\n                return;\n            }\n        }",
        "        // Active riddle mode: classify the child's intent first.\n        // This prevents phrases like \"я сдаюсь\" from being treated as a guess\n        // or as an emotional chat message.\n        if (state.activeRiddle) {\n            logger.info(`[Riddle] active answer check: \"${pipelineText}\"`);\n\n            const riddleIntent = await riddleIntentClassifier.classifyRiddleTurn({\n                transcript: pipelineText,\n                activeRiddle: state.activeRiddle,\n                lastRiddle: state.conversation?.currentRiddle,\n                history: state.conversation?.riddleHistory,\n            });\n            logger.info(`[RiddleIntent] intent=${riddleIntent.intent} confidence=${riddleIntent.confidence} source=${riddleIntent.source} reason=${riddleIntent.reason}`);\n\n            if (riddleIntent.intent === 'off_topic') {\n                logger.info('[Riddle] active riddle closed: user changed topic');\n                state.activeRiddle = null;\n            } else if (riddleIntent.intent === 'stop_riddle_game') {\n                state.activeRiddle = null;\n                const reply = 'Хорошо, закончим загадки. Можем просто поболтать.';\n                const audio = await content.ensureCachedReply(reply, { baseUrl, lang: effectiveLang, key: 'riddle_stop_game' });\n                if (!isCurrent()) return;\n                sendAudio(audio.audioUrl, audio.durationMs);\n                recordUsageSafe(deviceId, audio.durationMs);\n                recordAnalyticsSafe(deviceId, transcript, reply, { type: 'riddle', durationMs: audio.durationMs, provider: 'riddle_intent' });\n                rememberBotReply(reply, 'chat');\n                return;\n            } else if (riddleIntent.intent === 'next_riddle') {\n                state.activeRiddle = null;\n                logger.info('[Riddle] intent requested next riddle');\n                const result = await riddleEngine.startRiddle(baseUrl, 'загадай загадку');\n                state.activeRiddle = result.riddle;\n                if (!isCurrent()) return;\n                sendAudio(result.audio.url, result.audio.durationMs);\n                conversationOrchestrator.rememberRiddle(state.conversation, result.riddle, result.audio, { requestText: pipelineText, source: 'riddle_engine' });\n                rememberBotReply('Слушай загадку.', 'riddle');\n                recordUsageSafe(deviceId, result.audio.durationMs);\n                recordAnalyticsSafe(deviceId, transcript, 'riddle_started', { type: 'riddle', durationMs: result.audio.durationMs, provider: 'riddle_engine' });\n                logger.info(`[Riddle] sent ${result.riddle.id}`);\n                return;\n            } else if (riddleIntent.intent === 'repeat_riddle') {\n                const item = conversationOrchestrator.getRiddleFromHistory(state.conversation, 'current');\n                if (item?.audioUrl) {\n                    if (item.activeRiddle) state.activeRiddle = { ...item.activeRiddle, attempts: 0 };\n                    sendAudio(item.audioUrl, item.durationMs || 2500);\n                    recordUsageSafe(deviceId, item.durationMs || 2500);\n                    recordAnalyticsSafe(deviceId, transcript, 'Повторяю загадку.', { type: 'riddle', durationMs: item.durationMs || 2500, provider: 'orchestrator' });\n                    logger.info(`[RiddleIntent] repeated current riddle=${item.id || 'unknown'}`);\n                    return;\n                }\n                const reply = 'Я пока не могу повторить эту загадку. Давай загадаю новую?';\n                const audio = await content.ensureCachedReply(reply, { baseUrl, lang: effectiveLang, key: 'riddle_repeat_missing' });\n                sendAudio(audio.audioUrl, audio.durationMs);\n                recordUsageSafe(deviceId, audio.durationMs);\n                rememberBotReply(reply, 'riddle');\n                return;\n            } else if (riddleIntent.intent === 'unclear') {\n                const reply = 'Я не совсем поняла. Ты хочешь ответить, сдаться или повторить загадку?';\n                const audio = await content.ensureCachedReply(reply, { baseUrl, lang: effectiveLang, key: 'riddle_unclear_turn' });\n                if (!isCurrent()) return;\n                sendAudio(audio.audioUrl, audio.durationMs);\n                recordUsageSafe(deviceId, audio.durationMs);\n                recordAnalyticsSafe(deviceId, transcript, reply, { type: 'riddle', durationMs: audio.durationMs, provider: 'riddle_intent' });\n                rememberBotReply(reply, 'riddle');\n                return;\n            } else {\n                const answerText = riddleIntent.intent === 'reveal_answer' ? 'скажи ответ' : pipelineText;\n                const result = await riddleEngine.handleActiveRiddleAnswer(answerText, state.activeRiddle, baseUrl, { childGender: state.childGender });\n\n                if (!result.handled) {\n                    logger.info('[Riddle] active riddle ignored after classifier, falling through to normal pipeline');\n                    state.activeRiddle = null;\n                } else {\n                    state.activeRiddle = result.activeRiddle;\n                    if (!isCurrent()) return;\n                    sendAudio(result.audio.url, result.audio.durationMs);\n                    rememberBotReply(riddleIntent.intent === 'reveal_answer' ? 'Хочешь ещё одну загадку?' : 'Слушай внимательно.', 'riddle');\n                    recordUsageSafe(deviceId, result.audio.durationMs);\n                    recordAnalyticsSafe(deviceId, transcript, 'riddle_answer_feedback', { type: 'riddle', durationMs: result.audio.durationMs, provider: 'riddle_engine' });\n                    logger.info('[Riddle] sent answer feedback audio');\n                    return;\n                }\n            }\n        }",
        'active riddle intent classifier block'
    );

    patched = replaceAllChecked(patched, /riddleEngine\.isRiddleRequest\(transcript\)/g, 'riddleEngine.isRiddleRequest(pipelineText)', 'riddle request text');
    patched = replaceAllChecked(patched, /riddleEngine\.startRiddle\(baseUrl, transcript\)/g, 'riddleEngine.startRiddle(baseUrl, pipelineText)', 'start riddle text');
    patched = replaceAllChecked(patched, /content\.checkPendingAnswer\(state\.pendingContent, transcript\)/g, 'content.checkPendingAnswer(state.pendingContent, pipelineText)', 'pending content text');
    patched = replaceAllChecked(patched, /content\.getClarification\(transcript\)/g, 'content.getClarification(pipelineText)', 'clarification text');
    patched = replaceAllChecked(patched, /content\.classifyRequest\(transcript\)/g, 'content.classifyRequest(pipelineText)', 'classify text');
    patched = replaceAllChecked(patched, /content\.tryHandleShortRequest\(transcript, \{ baseUrl, lang: effectiveLang \}\)/g, 'content.tryHandleShortRequest(pipelineText, { baseUrl, lang: effectiveLang })', 'short content text');
    patched = replaceAllChecked(patched, /content\.getSemanticIntent\(transcript, state\.lastContentMode \|\| ''\)/g, "content.getSemanticIntent(pipelineText, state.lastContentMode || '')", 'semantic intent text');
    patched = replaceAllChecked(patched, /content\.tryHandleSemanticIntent\(semanticIntent, transcript, \{ baseUrl, lang: effectiveLang \}\)/g, 'content.tryHandleSemanticIntent(semanticIntent, pipelineText, { baseUrl, lang: effectiveLang })', 'semantic content text');
    patched = replaceAllChecked(patched, /storyEngine\.buildStoryContext\(transcript\)/g, 'storyEngine.buildStoryContext(pipelineText)', 'story text');
    patched = replaceAllChecked(patched, /storyEngine\.buildStoryFollowupContext\(transcript\)/g, 'storyEngine.buildStoryFollowupContext(pipelineText)', 'story followup text');
    patched = replaceAllChecked(patched, /detectIntent\(transcript\)/g, 'detectIntent(pipelineText)', 'intent text');
    patched = replaceAllChecked(patched, /llm\.chat\(ws, transcript, effectiveLang/g, 'llm.chat(ws, pipelineText, effectiveLang', 'llm text');
    patched = replaceAllChecked(patched, /routingText: transcript/g, 'routingText: pipelineText', 'llm routing text');

    patched = replaceAllChecked(
        patched,
        /sendAudio\(result\.audio\.url, result\.audio\.durationMs\);\n(\s*)recordUsageSafe\(deviceId, result\.audio\.durationMs\);/g,
        "sendAudio(result.audio.url, result.audio.durationMs);\n$1if (result.riddle) {\n$1    conversationOrchestrator.rememberRiddle(state.conversation, result.riddle, result.audio, { requestText: pipelineText, source: 'riddle_engine' });\n$1}\n$1rememberBotReply(result.reply || (riddleEngine.isRevealRequest?.(pipelineText) ? 'Хочешь ещё одну загадку?' : 'Слушай загадку.'), 'riddle');\n$1recordUsageSafe(deviceId, result.audio.durationMs);",
        'remember riddle result'
    );

    patched = replaceAllChecked(
        patched,
        /sendAudio\(shortContent\.audioUrl, shortContent\.durationMs\);\n(\s*)recordUsageSafe\(deviceId, shortContent\.durationMs\);/g,
        "sendAudio(shortContent.audioUrl, shortContent.durationMs);\n$1rememberBotReply(shortContent.reply, shortContent.item?.type || conversationDecision.type || 'chat');\n$1recordUsageSafe(deviceId, shortContent.durationMs);",
        'remember short content'
    );

    patched = replaceOnce(
        patched,
        "        sendAudio(audioUrl, durationMs);\n        logger.info(`[Pipeline] sent audio command: ${audioUrl}`);",
        "        sendAudio(audioUrl, durationMs);\n        if (conversationDecision.type === 'riddle') {\n            conversationOrchestrator.rememberGeneratedRiddle(state.conversation, reply, { audioUrl, durationMs }, { requestText: pipelineText, source: 'llm' });\n        }\n        rememberBotReply(reply, story ? 'story' : requestedContentType || conversationDecision.type || 'chat');\n        logger.info(`[Pipeline] sent audio command: ${audioUrl}`);",
        'remember llm reply'
    );

    return patched;
}

Module._extensions['.js'] = function patchedJsLoader(module, filename) {
    const resolved = path.resolve(filename);
    if (resolved === parentConfigPath) {
        const source = fs.readFileSync(filename, 'utf8');
        const patched = patchParentConfigSource(source);
        console.log('[ServerPipelinePatch] thinking settings injected into parentConfig.js');
        return module._compile(patched, filename);
    }
    if (resolved === serverPath) {
        const source = fs.readFileSync(filename, 'utf8');
        const patched = patchServerSource(source);
        console.log('[ServerPipelinePatch] conversation orchestrator injected into server.js');
        return module._compile(patched, filename);
    }
    return originalJsLoader(module, filename);
};
