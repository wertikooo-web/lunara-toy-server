'use strict';

/**
 * LLM — GPT-4o mini (OpenAI)
 *
 * Maintains per-connection dialog history keyed by WebSocket object reference.
 * History is reset when the connection closes or when ESP32 sends { type: "reset" }.
 */

const OpenAI = require('openai');
const logger = require('./logger');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL      = 'gpt-4o-mini';
const MAX_TOKENS = 150;   // короткие ответы для ребёнка

// WeakMap: ws object → messages array
// Автоматически чистится когда ws удаляется из памяти
const histories = new WeakMap();

const SYSTEM_PROMPT = `
Ты — Лунара, добрый и весёлый AI-друг для детей от 3 до 8 лет.
Ты живёшь внутри плюшевого мишки и разговариваешь с ребёнком.

ХАРАКТЕР:
- Тёплый, заботливый, весёлый
- Говоришь простыми короткими предложениями
- Используешь детские слова и выражения
- Любишь истории, загадки, игры

ПРАВИЛА БЕЗОПАСНОСТИ:
- Никогда не обсуждаешь взрослые темы
- Не даёшь личных данных
- Не пугаешь ребёнка
- Если ребёнок грустит — поддерживаешь и предлагаешь рассказать маме или папе
- Не упоминаешь другие AI или технологии

СТИЛЬ ОТВЕТОВ:
- Максимум 2-3 коротких предложения
- Заканчивай вопросом или предложением поиграть
- Иногда используй звуки: "Ой!", "Ух ты!", "Вот это да!"
`.trim();

/**
 * Send a message to GPT-4o mini and get a reply.
 * @param {object} wsRef    — WebSocket instance (used as history key)
 * @param {string} userText — transcribed user message
 * @returns {Promise<string>} — model reply
 */
async function chat(wsRef, userText) {
    if (!histories.has(wsRef)) {
        histories.set(wsRef, []);
    }
    const messages = histories.get(wsRef);

    messages.push({ role: 'user', content: userText });

    // Держим историю ограниченной — последние 20 сообщений (10 обменов)
    if (messages.length > 20) {
        messages.splice(0, messages.length - 20);
    }

    const response = await client.chat.completions.create({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        messages:   [
            { role: 'system', content: SYSTEM_PROMPT },
            ...messages,
        ],
    });

    const reply = response.choices[0]?.message?.content?.trim() ?? '';
    messages.push({ role: 'assistant', content: reply });

    logger.debug(`[LLM] tokens used: ${response.usage?.total_tokens}`);
    return reply;
}

/**
 * Clear dialog history for a connection.
 * @param {object} wsRef
 */
function resetHistory(wsRef) {
    histories.delete(wsRef);
    logger.debug('[LLM] history reset');
}

module.exports = { chat, resetHistory };
