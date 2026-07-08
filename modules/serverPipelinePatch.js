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
        "const riddleEngine = require('./modules/riddleEngine');\nconst conversationOrchestrator = require('./modules/conversationOrchestrator');\n",
        'require conversationOrchestrator'
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
        "        const effectiveLang = settings.language && settings.language !== 'auto' ? settings.language : 'auto';\n        const conversationDecision = conversationOrchestrator.detectDecision(transcript, state.conversation);\n        const pipelineText = conversationDecision.rewrittenText || transcript;\n        logger.info(`[Orchestrator] action=${conversationDecision.action} type=${conversationDecision.type} reason=${conversationDecision.reason}`);\n        const rememberBotReply = (reply, type) => {\n            const offer = conversationOrchestrator.rememberBotReply(state.conversation, reply, { type });\n            if (offer) logger.info(`[Orchestrator] pending offer=${offer.type}`);\n        };\n        if (conversationDecision.action === 'clarify' || conversationDecision.action === 'reply') {\n            const reply = conversationDecision.reply;\n            const audio = await content.ensureCachedReply(reply, {\n                baseUrl,\n                lang: effectiveLang,\n                key: `orchestrator_${conversationDecision.action}_${conversationDecision.type || 'chat'}`,\n            });\n            if (!isCurrent()) {\n                logger.info('[Pipeline] superseded after orchestrator reply — discarding');\n                return;\n            }\n            sendAudio(audio.audioUrl, audio.durationMs);\n            recordUsageSafe(deviceId, audio.durationMs);\n            recordAnalyticsSafe(deviceId, transcript, reply, {\n                type: conversationDecision.type || 'chat',\n                durationMs: audio.durationMs,\n                provider: 'orchestrator',\n            });\n            rememberBotReply(reply, conversationDecision.type || 'chat');\n            return;\n        }\n",
        'orchestrator decision after settings'
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
        "sendAudio(result.audio.url, result.audio.durationMs);\n$1rememberBotReply(result.reply || (riddleEngine.isRevealRequest?.(transcript) ? 'Хочешь ещё одну загадку?' : 'Слушай загадку.'), 'riddle');\n$1recordUsageSafe(deviceId, result.audio.durationMs);",
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
        "        sendAudio(audioUrl, durationMs);\n        rememberBotReply(reply, story ? 'story' : requestedContentType || conversationDecision.type || 'chat');\n        logger.info(`[Pipeline] sent audio command: ${audioUrl}`);",
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
