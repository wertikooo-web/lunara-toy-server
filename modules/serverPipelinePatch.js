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

    patched = patched.replace(/riddleEngine\.isRiddleRequest\(transcript\)/g, 'riddleEngine.isRiddleRequest(pipelineText)');
    patched = patched.replace(/riddleEngine\.startRiddle\(baseUrl, transcript\)/g, 'riddleEngine.startRiddle(baseUrl, pipelineText)');
    patched = patched.replace(/content\.checkPendingAnswer\(state\.pendingContent, transcript\)/g, 'content.checkPendingAnswer(state.pendingContent, pipelineText)');
    patched = patched.replace(/content\.getClarification\(transcript\)/g, 'content.getClarification(pipelineText)');
    patched = patched.replace(/content\.classifyRequest\(transcript\)/g, 'content.classifyRequest(pipelineText)');
    patched = patched.replace(/content\.tryHandleShortRequest\(transcript, \{ baseUrl, lang: effectiveLang \}\)/g, 'content.tryHandleShortRequest(pipelineText, { baseUrl, lang: effectiveLang })');
    patched = patched.replace(/storyEngine\.buildStoryContext\(transcript\)/g, 'storyEngine.buildStoryContext(pipelineText)');
    patched = patched.replace(/storyEngine\.buildStoryFollowupContext\(transcript\)/g, 'storyEngine.buildStoryFollowupContext(pipelineText)');
    patched = patched.replace(/detectIntent\(transcript\)/g, 'detectIntent(pipelineText)');
    patched = patched.replace(/llm\.chat\(ws, transcript, effectiveLang/g, 'llm.chat(ws, pipelineText, effectiveLang');
    patched = patched.replace(/routingText: transcript/g, 'routingText: pipelineText');

    patched = patched.replace(
        "            sendAudio(result.audio.url, result.audio.durationMs);\n            recordUsageSafe(deviceId, result.audio.durationMs);",
        "            sendAudio(result.audio.url, result.audio.durationMs);\n            rememberBotReply('Слушай загадку.', 'riddle');\n            recordUsageSafe(deviceId, result.audio.durationMs);"
    );

    patched = patched.replace(
        "            sendAudio(shortContent.audioUrl, shortContent.durationMs);\n            recordUsageSafe(deviceId, shortContent.durationMs);",
        "            sendAudio(shortContent.audioUrl, shortContent.durationMs);\n            rememberBotReply(shortContent.reply, shortContent.item?.type || conversationDecision.type || 'chat');\n            recordUsageSafe(deviceId, shortContent.durationMs);"
    );

    patched = patched.replace(
        "        sendAudio(audioUrl, durationMs);\n        logger.info(`[Pipeline] sent audio command: ${audioUrl}`);",
        "        sendAudio(audioUrl, durationMs);\n        rememberBotReply(reply, story ? 'story' : requestedContentType || conversationDecision.type || 'chat');\n        logger.info(`[Pipeline] sent audio command: ${audioUrl}`);"
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
