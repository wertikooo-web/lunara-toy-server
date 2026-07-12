'use strict';

const riddleEngine = require('./riddleEngine');
const content = require('./content');
const llm = require('./llm');
const dialogState = require('./dialogState');
const replyValidators = require('./replyValidators');

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
    '- You are generating content for a toy for a child aged 3-8.',
    '- Output ONLY a single JSON object, nothing else — no markdown, no code fences, no explanations before or after.',
    '- JSON shape: {"riddle": "...", "answer": "...", "hint": "..."}',
    '- "riddle": the spoken clue text only (2-3 short simple sentences), starting with a short natural intro (e.g. "Слушай загадку." for Russian, "Ascultă o ghicitoare." for Romanian, "Listen to this riddle." for English) and ending with a short question asking the child to guess.',
    '- "answer": the single correct answer word/short phrase, in the same language as the riddle.',
    '- Do NOT include the answer word anywhere inside "riddle".',
    '- "hint": one short additional clue that does not repeat the answer word — usable later if the child is stuck.',
    '- Use natural, fluent language in the session\'s target language. No broken rhymes, no strange phrases, no fake facts.',
    '- Keep it kind, playful, and not scary.',
    '- If STT misspelled a familiar word, silently correct it. Example (Russian): "кекимора" means "кикимора".',
  ].join('\n');
}

function buildRiddlePrompt(requestText) {
  return [
    'Сгенерируй одну короткую детскую загадку на языке текущей сессии (на том же языке, на котором сейчас общается ребёнок).',
    `Исходный запрос ребенка: "${String(requestText || '').slice(0, 240)}"`,
    '',
    'Верни ТОЛЬКО валидный JSON вида {"riddle": "...", "answer": "...", "hint": "..."}, без другого текста.',
    'Правила:',
    '1. Поле riddle — только текст для озвучки, без слова-ответа внутри.',
    '2. Не говори "Вот загадка про ...".',
    '3. Не раскрывай ответ в самой загадке.',
    '4. Не пиши длинное стихотворение.',
    '5. Не используй кривые рифмы и странные фразы.',
    '6. Не придумывай нелепые детали, если они не помогают загадке.',
    '7. Если тема распознана с ошибкой, исправь ее по смыслу.',
    '8. Соблюдай естественную структуру детской загадки на выбранном языке сессии.',
  ].join('\n');
}

function stricterRiddlePrompt(requestText) {
  return `${buildRiddlePrompt(requestText)}\n\nВАЖНО: строго один JSON-объект, ничего кроме него. Предыдущая попытка была отклонена валидатором — не повторяй ту же ошибку (пустое поле, слишком длинный текст или ответ виден внутри загадки).`;
}

function parseRiddleJson(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

// Used only if the LLM fails structured-output validation twice in a row (raw
// text, malformed JSON, or answer leaked inside the riddle). Keeps the toy from
// ever speaking an unvalidated/broken creative riddle.
const FALLBACK_RIDDLE_BY_LANG = {
  'ru-RU': { riddle: 'Слушай загадку. Круглое и жёлтое, светит на небе днём и греет землю. Как думаешь, что это?', answer: 'солнце', hint: 'оно светит днём на небе' },
  'ro-RO': { riddle: 'Ascultă o ghicitoare. Este rotund și galben, strălucește pe cer ziua și încălzește pământul. Ce crezi că este?', answer: 'soarele', hint: 'straluceste ziua pe cer' },
  'en-US': { riddle: 'Listen to this riddle. It is round and yellow, it shines in the sky during the day and warms the earth. What do you think it is?', answer: 'the sun', hint: 'it shines in the sky during the day' },
  'es-ES': { riddle: 'Escucha una adivinanza. Es redondo y amarillo, brilla en el cielo de día y calienta la tierra. ¿Qué crees que es?', answer: 'el sol', hint: 'brilla en el cielo de dia' },
  'fr-FR': { riddle: "Écoute une devinette. Il est rond et jaune, il brille dans le ciel le jour et réchauffe la terre. Qu'en penses-tu ?", answer: 'le soleil', hint: 'il brille dans le ciel le jour' },
  'it-IT': { riddle: 'Ascolta un indovinello. È rotondo e giallo, splende in cielo di giorno e scalda la terra. Cosa pensi che sia?', answer: 'il sole', hint: 'splende in cielo di giorno' },
};

function fallbackRiddle(lang) {
  return FALLBACK_RIDDLE_BY_LANG[lang] || FALLBACK_RIDDLE_BY_LANG['ru-RU'];
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

      const rawResult = await originalChat.call(this, sessionRef, buildRiddlePrompt(nextRoutingText), lang, nextOptions);
      let payload = parseRiddleJson(resultReply(rawResult));
      let validation = replyValidators.checkRiddlePayload(payload);

      if (!validation.ok) {
        console.log(`[ReplyValidation] riddle_json failed=${validation.reason}; retrying with complex model`);
        const retryOptions = { ...nextOptions, model: 'gpt-complex', needsExactValidation: true };
        const retryResult = await originalChat.call(this, sessionRef, stricterRiddlePrompt(nextRoutingText), lang, retryOptions);
        payload = parseRiddleJson(resultReply(retryResult));
        validation = replyValidators.checkRiddlePayload(payload);
        console.log(`[LLMEscalation] selected=gpt-complex reason=riddle_validation_failed result_ok=${validation.ok}`);
      }

      if (!validation.ok) {
        console.log(`[ReplyValidation] riddle_json failed twice; using safe fallback riddle lang=${lang}`);
        payload = fallbackRiddle(lang);
      }

      if (dialog) {
        dialog.lastRiddleAnswer = payload.answer || null;
        dialog.lastRiddleHint = payload.hint || null;
      }

      result = directResult(payload.riddle, options);
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
