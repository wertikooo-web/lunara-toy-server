'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const originalJsLoader = Module._extensions['.js'];
const serverPath = path.resolve(__dirname, '..', 'server.js');

function replaceOnce(source, from, to, label) {
    if (!source.includes(from)) {
        throw new Error(`[ServerPipelinePatch] missing patch point: ${label}`);
    }
    return source.replace(from, to);
}

function replaceAllChecked(source, pattern, to, label) {
    const next = source.replace(pattern, to);
    if (next === source) {
        throw new Error(`[ServerPipelinePatch] missing patch point: ${label}`);
    }
    return next;
}

function patchServerSource(source) {
    let patched = source;

    patched = replaceOnce(
        patched,
        "const riddleEngine = require('./modules/riddleEngine');\n",
        "const riddleEngine = require('./modules/riddleEngine');\nconst conversationOrchestrator = require('./modules/conversationOrchestrator');\nconst riddleIntentClassifier = require('./modules/riddleIntentClassifier');\n",
        'require conversationOrchestrator and riddleIntentClassifier'
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
        "        // Active riddle mode: classify the child's intent first.\n        // This prevents phrases like \"я сдаюсь\" from being treated as a guess\n        // or as an emotional chat message.\n        if (state.activeRiddle) {\n            logger.info(`[Riddle] active answer check: \"${pipelineText}\"`);\n\n            const riddleIntent = await riddleIntentClassifier.classifyRiddleTurn({\n                transcript: pipelineText,\n                activeRiddle: state.activeRiddle,\n                lastRiddle: state.conversation?.currentRiddle,\n                history: state.conversation?.riddleHistory,\n            });\n            logger.info(`[RiddleIntent] intent=${riddleIntent.intent} confidence=${riddleIntent.confidence} source=${riddleIntent.source} reason=${riddleIntent.reason}`);\n\n            if (riddleIntent.intent === 'off_topic') {\n                logger.info('[Riddle] active riddle closed: user changed topic');\n                state.activeRiddle = null;\n            } else if (riddleIntent.intent === 'stop_riddle_game') {\n                state.activeRiddle = null;\n                const reply = 'Хорошо, закончим загадки. Можем просто поболтать.';\n                const audio = await content.ensureCachedReply(reply, {\n                    baseUrl,\n                    lang: effectiveLang,\n                    key: 'riddle_stop_game',\n                });\n                if (!isCurrent()) {\n                    logger.info('[Pipeline] superseded after riddle stop — discarding');\n                    return;\n                }\n                sendAudio(audio.audioUrl, audio.durationMs);\n                recordUsageSafe(deviceId, audio.durationMs);\n                recordAnalyticsSafe(deviceId, transcript, reply, { type: 'riddle', durationMs: audio.durationMs, provider: 'riddle_intent' });\n                rememberBotReply(reply, 'chat');\n                return;\n            } else if (riddleIntent.intent === 'next_riddle') {\n                state.activeRiddle = null;\n                logger.info('[Riddle] intent requested next riddle');\n                const result = await riddleEngine.startRiddle(baseUrl, 'загадай загадку');\n                state.activeRiddle = result.riddle;\n                if (!isCurrent()) {\n                    logger.info('[Pipeline] superseded after next riddle intent — discarding');\n                    return;\n                }\n                sendAudio(result.audio.url, result.audio.durationMs);\n                conversationOrchestrator.rememberRiddle(state.conversation, result.riddle, result.audio, { requestText: pipelineText, source: 'riddle_engine' });\n                rememberBotReply('Слушай загадку.', 'riddle');\n                recordUsageSafe(deviceId, result.audio.durationMs);\n                recordAnalyticsSafe(deviceId, transcript, 'riddle_started', { type: 'riddle', durationMs: result.audio.durationMs, provider: 'riddle_engine' });\n                logger.info(`[Riddle] sent ${result.riddle.id}`);\n                return;\n            } else if (riddleIntent.intent === 'repeat_riddle') {\n                const item = conversationOrchestrator.getRiddleFromHistory(state.conversation, 'current');\n                if (item?.audioUrl) {\n                    if (item.activeRiddle) state.activeRiddle = { ...item.activeRiddle, attempts: 0 };\n                    sendAudio(item.audioUrl, item.durationMs || 2500);\n                    recordUsageSafe(deviceId, item.durationMs || 2500);\n                    recordAnalyticsSafe(deviceId, transcript, 'Повторяю загадку.', { type: 'riddle', durationMs: item.durationMs || 2500, provider: 'orchestrator' });\n                    logger.info(`[RiddleIntent] repeated current riddle=${item.id || 'unknown'}`);\n                    return;\n                }\n                const reply = 'Я пока не могу повторить эту загадку. Давай загадаю новую?';\n                const audio = await content.ensureCachedReply(reply, { baseUrl, lang: effectiveLang, key: 'riddle_repeat_missing' });\n                sendAudio(audio.audioUrl, audio.durationMs);\n                recordUsageSafe(deviceId, audio.durationMs);\n                rememberBotReply(reply, 'riddle');\n                return;\n            } else if (riddleIntent.intent === 'unclear') {\n                const reply = 'Я не совсем поняла. Ты хочешь ответить, сдаться или повторить загадку?';\n                const audio = await content.ensureCachedReply(reply, { baseUrl, lang: effectiveLang, key: 'riddle_unclear_turn' });\n                if (!isCurrent()) {\n                    logger.info('[Pipeline] superseded after riddle unclear — discarding');\n                    return;\n                }\n                sendAudio(audio.audioUrl, audio.durationMs);\n                recordUsageSafe(deviceId, audio.durationMs);\n                recordAnalyticsSafe(deviceId, transcript, reply, { type: 'riddle', durationMs: audio.durationMs, provider: 'riddle_intent' });\n                rememberBotReply(reply, 'riddle');\n                return;\n            } else {\n                const answerText = riddleIntent.intent === 'reveal_answer' ? 'скажи ответ' : pipelineText;\n                const result = await riddleEngine.handleActiveRiddleAnswer(\n                    answerText,\n                    state.activeRiddle,\n                    baseUrl\n                );\n\n                if (!result.handled) {\n                    logger.info('[Riddle] active riddle ignored after classifier, falling through to normal pipeline');\n                    state.activeRiddle = null;\n                } else {\n                    state.activeRiddle = result.activeRiddle;\n\n                    if (!isCurrent()) {\n                        logger.info('[Pipeline] superseded after riddle answer — discarding');\n                        return;\n                    }\n\n                    sendAudio(result.audio.url, result.audio.durationMs);\n                    rememberBotReply(riddleIntent.intent === 'reveal_answer' ? 'Хочешь ещё одну загадку?' : 'Слушай внимательно.', 'riddle');\n                    recordUsageSafe(deviceId, result.audio.durationMs);\n                    recordAnalyticsSafe(deviceId, transcript, 'riddle_answer_feedback', {\n                        type: 'riddle',\n                        durationMs: result.audio.durationMs,\n                        provider: 'riddle_engine',\n                    });\n                    logger.info('[Riddle] sent answer feedback audio');\n\n                    return;\n                }\n            }\n        }",
        'active riddle intent classifier block'
    );

    patched = replaceAllChecked(patched, /riddleEngine\.isRiddleRequest\(transcript\)/g, 'riddleEngine.isRiddleRequest(pipelineText)', 'riddle request text');
    patched = replaceAllChecked(patched, /riddleEngine\.startRiddle\(baseUrl, transcript\)/g, 'riddleEngine.startRiddle(baseUrl, pipelineText)', 'start riddle text');
    patched = replaceAllChecked(patched, /content\.checkPendingAnswer\(state\.pendingContent, transcript\)/g, 'content.checkPendingAnswer(state.pendingContent, pipelineText)', 'pending content text');
    patched = replaceAllChecked(patched, /content\.getClarification\(transcript\)/g, 'content.getClarification(pipelineText)', 'clarification text');
    patched = replaceAllChecked(patched, /content\.classifyRequest\(transcript\)/g, 'content.classifyRequest(pipelineText)', 'classify text');
    patched = replaceAllChecked(patched, /content\.tryHandleShortRequest\(transcript, \{ baseUrl, lang: effectiveLang \}\)/g, 'content.tryHandleShortRequest(pipelineText, { baseUrl, lang: effectiveLang })', 'short content text');
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
    if (path.resolve(filename) !== serverPath) {
        return originalJsLoader(module, filename);
    }

    const source = fs.readFileSync(filename, 'utf8');
    const patched = patchServerSource(source);
    console.log('[ServerPipelinePatch] conversation orchestrator injected into server.js');
    return module._compile(patched, filename);
};
