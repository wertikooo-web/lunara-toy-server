'use strict';

const riddleEngine = require('./riddleEngine');
const content = require('./content');
const llm = require('./llm');

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.,!?;:()[\]{}"«»]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRiddleLike(text) {
  const t = normalizeText(text);
  return t.includes('загадк') || t.includes('загадай') || t.includes('отгадай') || t.includes('riddle') || t.includes('ghicitoare');
}

function hasTopicRequest(text) {
  const t = normalizeText(text);
  return /\bпро\s+\S+/.test(t) || /\bо\s+\S+/.test(t) || /\bоб\s+\S+/.test(t) || /\bна\s+тему\s+\S+/.test(t) || /\babout\s+\S+/.test(t) || /\bdespre\s+\S+/.test(t);
}

function hasCreativeWords(text) {
  const t = normalizeText(text);
  return /придумай|сочини|выдумай|новую|свою|сложн|хитр|необычн|странн|несуществ|воображ|фантаст|мифическ|невидан|original riddle|new riddle|hard riddle/.test(t);
}

function shouldRouteToLlm(text) {
  const t = normalizeText(text);
  if (!isRiddleLike(t)) return false;
  return hasTopicRequest(t) || hasCreativeWords(t);
}

function creativeRiddleContext() {
  return [
    'CREATIVE RIDDLE MODE:',
    '- Create ONE short original riddle suitable for a child aged 3-8.',
    '- Respect the requested topic if one is provided.',
    '- Do not reveal the answer immediately.',
    '- Keep it playful, kind, simple, and not scary.',
    '- End with a short question like: "Как думаешь, что это?"',
  ].join('\n');
}

const originalIsRiddleRequest = riddleEngine.isRiddleRequest;
if (typeof originalIsRiddleRequest === 'function') {
  riddleEngine.isRiddleRequest = function patchedIsRiddleRequest(text) {
    if (shouldRouteToLlm(text)) {
      console.log(`[TopicRiddle] routing to LLM: ${JSON.stringify(String(text || '').slice(0, 120))}`);
      return false;
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
    return originalClassifyRequest.call(this, text);
  };
}

const originalChat = llm.chat;
if (typeof originalChat === 'function') {
  llm.chat = async function patchedChat(sessionRef, text, lang, options = {}) {
    const routingText = options?.routingText || text;
    if (shouldRouteToLlm(routingText)) {
      console.log(`[TopicRiddle] LLM context attached: ${JSON.stringify(String(routingText || '').slice(0, 120))}`);
      const nextOptions = {
        ...options,
        contentContext: [options.contentContext, creativeRiddleContext()].filter(Boolean).join('\n\n'),
      };
      return originalChat.call(this, sessionRef, text, lang, nextOptions);
    }
    return originalChat.call(this, sessionRef, text, lang, options);
  };
}

console.log('[TopicRiddle] topic riddle routing patch loaded');
