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
      return originalChat.call(this, sessionRef, buildRiddlePrompt(routingText), lang, nextOptions);
    }
    return originalChat.call(this, sessionRef, text, lang, options);
  };
}

console.log('[TopicRiddle] topic riddle routing patch loaded');
