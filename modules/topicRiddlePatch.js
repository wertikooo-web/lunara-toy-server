'use strict';

const riddleEngine = require('./riddleEngine');
const content = require('./content');
const llm = require('./llm');
const dialogState = require('./dialogState');

const dialogBySession = new WeakMap();

function getDialog(sessionRef) {
  if (!sessionRef || (typeof sessionRef !== 'object' && typeof sessionRef !== 'function')) {
    return null;
  }
  if (!dialogBySession.has(sessionRef)) {
    dialogBySession.set(sessionRef, {
      pendingOffer: null,
      lastIntent: '',
      lastBotReply: '',
    });
  }
  return dialogBySession.get(sessionRef);
}

function shouldRouteToLlm(text) {
  return dialogState.shouldRouteRiddleToLlm(text);
}

function resultReply(result) {
  if (typeof result === 'string') return result;
  return String(result?.reply || '');
}

function directResult(reply, options = {}) {
  if (options.returnMeta) {
    return {
      reply,
      model_used: null,
      provider: 'dialog_state',
      latency_ms: 0,
      requested_model: options.model || null,
      router_choice: 'dialog_state',
      fallback: false,
      fallback_reason: null,
      continued: false,
    };
  }
  return reply;
}

function inferTypeFromRequest(text) {
  const t = dialogState.normalizeText(text);
  if (/загадк|riddle|ghicitoare|ghicitori/.test(t)) return 'riddle';
  if (/сказк|истори|story/.test(t)) return 'story';
  if (/игр|поигр|game|play/.test(t)) return 'game';
  if (/факт|интересн/.test(t)) return 'fact';
  return 'chat';
}

function creativeRiddleContext() {
  return [
    'STRICT RIDDLE MODE:',
    '- You are generating speech for a toy for a child aged 3-8.',
    '- Output ONLY the riddle text that should be spoken aloud.',
    '- Do NOT add explanations, titles, Markdown, stage directions, or actions.',
    '- Do NOT say: "Вот загадка про ..." because that often reveals the answer.',
    '- Do NOT reveal the answer immediately.',
    '- Do NOT name the answer inside the riddle.',
    '- Use natural Russian. No broken rhymes. No strange phrases. No fake facts.',
    '- Keep it short: 2-3 simple clue sentences.',
    '- Keep it kind, playful, and not scary.',
    '- Start with: "Слушай загадку."',
    '- End with: "Как думаешь, кто это?" or "Как думаешь, что это?"',
    '- If STT misspelled a familiar Russian word, silently correct it. Example: "кекимора" means "кикимора".',
  ].join('\n');
}

function buildRiddlePrompt(requestText) {
  return [
    'Сгенерируй одну короткую детскую загадку на русском языке.',
    `Исходный запрос ребенка: "${String(requestText || '').slice(0, 240)}"`,
    '',
    'Правила:',
    '1. Ответ должен быть только текстом для озвучки.',
    '2. Не говори "Вот загадка про ...".',
    '3. Не называй ответ в тексте загадки.',
    '4. Не раскрывай ответ сразу.',
    '5. Не пиши длинное стихотворение.',
    '6. Не используй кривые рифмы и странные фразы.',
    '7. Не придумывай нелепые детали, если они не помогают загадке.',
    '8. Если тема распознана с ошибкой, исправь ее по смыслу.',
    '9. Формат: "Слушай загадку. ... Как думаешь, кто это?"',
  ].join('\n');
}

function followupContext() {
  return [
    'DIALOG FOLLOW-UP MODE:',
    '- The child is replying to your previous offer/question.',
    '- Understand short replies like yes, no, да, нет, ещё, дальше, не хочу from the previous context.',
    '- Do not change topic randomly.',
    '- If the child accepted an offer, do exactly that offer.',
    '- If the child refused, accept it warmly and offer one calm alternative.',
  ].join('\n');
}

const originalIsRiddleRequest = riddleEngine.isRiddleRequest;
if (typeof originalIsRiddleRequest === 'function') {
  riddleEngine.isRiddleRequest = function patchedIsRiddleRequest(text) {
    if (shouldRouteToLlm(text)) {
      console.log(`[TopicRiddle] routing to LLM: ${JSON.stringify(String(text || '').slice(0, 120))}`);
      return false;
    }

    if (dialogState.isSimpleCachedRiddleRequest(text)) {
      console.log(`[TopicRiddle] routing to cached riddle: ${JSON.stringify(String(text || '').slice(0, 120))}`);
      return true;
    }

    return originalIsRiddleRequest.call(this, text);
  };
}
riddleEngine.shouldUseLlmRiddle = shouldRouteToLlm;

const originalTryHandleShortRequest = content.tryHandleShortRequest;
if (typeof originalTryHandleShortRequest === 'function') {
  content.tryHandleShortRequest = async function patchedTryHandleShortRequest(text, options) {
    if (shouldRouteToLlm(text)) {
      console.log(`[TopicRiddle] skipping content cache: ${JSON.stringify(String(text || '').slice(0, 120))}`);
      return null;
    }
    return originalTryHandleShortRequest.call(this, text, options);
  };
}

const originalCheckPendingAnswer = content.checkPendingAnswer;
if (typeof originalCheckPendingAnswer === 'function') {
  content.checkPendingAnswer = function patchedCheckPendingAnswer(pendingContent, text) {
    if (shouldRouteToLlm(text)) return null;
    return originalCheckPendingAnswer.call(this, pendingContent, text);
  };
}

const originalClassifyRequest = content.classifyRequest;
if (typeof originalClassifyRequest === 'function') {
  content.classifyRequest = function patchedClassifyRequest(text) {
    if (shouldRouteToLlm(text)) return 'riddle';
    if (dialogState.isSimpleCachedRiddleRequest(text)) return 'riddle';
    return originalClassifyRequest.call(this, text);
  };
}

const originalChat = llm.chat;
if (typeof originalChat === 'function') {
  llm.chat = async function patchedChat(sessionRef, text, lang, options = {}) {
    const routingText = options?.routingText || text;
    const dialog = getDialog(sessionRef);
    let nextText = text;
    let nextRoutingText = routingText;
    let forcedType = '';
    let extraContext = '';

    if (dialog) {
      const followup = dialogState.resolveFollowup(dialog, routingText);
      if (followup?.action === 'clarify') {
        if (!followup.keepPending) dialogState.clearPendingOffer(dialog);
        console.log(`[DialogState] clarifying short reply: ${JSON.stringify(String(routingText || '').slice(0, 120))}`);
        return directResult(followup.reply, options);
      }

      if (followup?.action === 'reject_offer') {
        dialogState.clearPendingOffer(dialog);
        dialogState.markBotReply(dialog, followup.reply, { type: 'chat' });
        console.log(`[DialogState] rejected pending offer=${followup.type}`);
        return directResult(followup.reply, options);
      }

      if (followup?.action === 'accept_offer' || followup?.action === 'continue_last') {
        dialogState.clearPendingOffer(dialog);
        forcedType = followup.type || dialog.lastIntent || '';
        const rewritten = dialogState.rewriteForOffer(forcedType);
        if (rewritten) {
          nextText = rewritten;
          nextRoutingText = rewritten;
          extraContext = followupContext();
          console.log(`[DialogState] ${followup.action}: ${JSON.stringify(String(routingText || '').slice(0, 80))} -> ${forcedType}`);
        }
      }
    }

    const routeAsRiddle = forcedType === 'riddle' || shouldRouteToLlm(nextRoutingText);
    let result;

    if (routeAsRiddle) {
      console.log(`[TopicRiddle] LLM context attached: ${JSON.stringify(String(nextRoutingText || '').slice(0, 120))}`);
      const nextOptions = {
        ...options,
        routingText: nextRoutingText,
        contentContext: [options.contentContext, extraContext, creativeRiddleContext()].filter(Boolean).join('\n\n'),
      };
      result = await originalChat.call(this, sessionRef, buildRiddlePrompt(nextRoutingText), lang, nextOptions);
    } else {
      const nextOptions = {
        ...options,
        routingText: nextRoutingText,
        contentContext: [options.contentContext, extraContext].filter(Boolean).join('\n\n'),
      };
      result = await originalChat.call(this, sessionRef, nextText, lang, nextOptions);
    }

    if (dialog) {
      const reply = resultReply(result);
      const type = forcedType || (routeAsRiddle ? 'riddle' : inferTypeFromRequest(nextRoutingText));
      const offer = dialogState.markBotReply(dialog, reply, { type });
      if (offer) {
        console.log(`[DialogState] pending offer=${offer.type}`);
      }
    }

    return result;
  };
}

const originalResetHistory = llm.resetHistory;
if (typeof originalResetHistory === 'function') {
  llm.resetHistory = function patchedResetHistory(sessionRef) {
    if (sessionRef && (typeof sessionRef === 'object' || typeof sessionRef === 'function')) {
      dialogBySession.delete(sessionRef);
    }
    return originalResetHistory.call(this, sessionRef);
  };
}

console.log('[TopicRiddle] topic riddle routing patch loaded with dialog state');
