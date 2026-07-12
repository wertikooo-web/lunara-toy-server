'use strict';

const OpenAI = require('openai');
const logger = require('./logger');

const GPT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
// Stronger OpenAI tier for corrections / multi-constraint / safety / low-confidence
// routing. Defaults to GPT_MODEL (no behavior change) until a stronger model is
// confirmed available on this account — set OPENAI_COMPLEX_MODEL in Railway once
// verified. Do not guess a model name here.
const OPENAI_COMPLEX_MODEL = process.env.OPENAI_COMPLEX_MODEL || GPT_MODEL;
// DeepSeek Pro is now the default conversational engine (was Flash). Flash stays
// selectable via modelName='deepseek-flash' or a per-device test-mode override.
const DEEPSEEK_MAIN_MODEL = process.env.DEEPSEEK_MAIN_MODEL || 'deepseek-v4-pro';
const DEEPSEEK_FLASH_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const LOW_CONFIDENCE_THRESHOLD = Number(process.env.ROUTER_LOW_CONFIDENCE_THRESHOLD || 0.5);

let openaiClient = null;
let deepseekClient = null;

function getOpenAIClient() {
    if (!openaiClient) {
        openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return openaiClient;
}

function getDeepSeekClient() {
    if (!deepseekClient) {
        deepseekClient = new OpenAI({
            apiKey: process.env.DEEPSEEK_API_KEY,
            baseURL: DEEPSEEK_BASE_URL,
        });
    }
    return deepseekClient;
}

function normalizeModelName(modelName) {
    const value = String(modelName || 'gpt').toLowerCase().trim();
    if (['gpt-complex', 'openai-complex'].includes(value)) return 'gpt-complex';
    if (['gpt', 'openai', 'gpt-4o-mini'].includes(value)) return 'gpt';
    if (['deepseek', 'deepseek-pro', 'deepseek-v4-pro', 'ds'].includes(value)) return 'deepseek';
    if (['deepseek-flash', 'deepseek-v4-flash', 'ds-flash'].includes(value)) return 'deepseek-flash';
    if (['auto', 'router', 'auto-router'].includes(value)) return 'auto';
    return 'gpt';
}

function hasAny(text, patterns) {
    return patterns.some((pattern) => pattern.test(text));
}

// Одиночные корни мама/папа/друг/школ/бабуш/дедуш убраны: они цепляли обычные
// сказки/загадки/игры ("сказка про друга", "посчитай до семь") и без того
// покрыты протоколом тревоги в SYSTEM_PROMPT самого llm.js независимо от модели.
// "Семь" сужен до реальных форм слова "семья", чтобы не ломать счёт до 7.
const SENSITIVE_PATTERNS = [
    /страшн|боюсь|плак|груст|одинок|обид|ссор|ругае|ругал|ругань|удар|бь[ёю]|бил|больно|плохой|не любят|исчез/i,
    /семь[яиею]/i,
    /помнишь|запомни|забыл|что я люблю|мой любим|моя любим|я люблю|я не люблю/i,
    /адрес|телефон|фамили|лекарств|огонь|нож|окн/i,
    /remember|my favorite|i like|i do not like|i don't like/i,
    /scared|afraid|sad|lonely|hurt|fight/i,
    /tine minte|imi place|nu imi place|preferat|preferata/i,
    /frica|trist|singur|doare/i,
];

const SIMPLE_PATTERNS = [
    /загадк|скороговор|сказк|истори|игр|поигра|животн|сколько будет|посчитай/i,
    /riddle|tongue twister|story|game|animal|how much is|count/i,
    /ghicitoare|framantare|poveste|joc|animal|cat face/i,
];

// Signal-based routing (см. routeInput в llm.js): вместо одних только ключевых слов
// в тексте, роутер теперь в первую очередь смотрит на структурные сигналы, которые
// оркестратор/llm.js уже вычислили — исправление ребёнком игрушки, жалоба на
// непонимание, несколько ограничений в одной реплике, ссылка на прошлый ответ,
// явная safety-тема или низкая уверенность оркестратора. Keyword-эвристика (sensitive/
// simple) остаётся как fallback-сигнал поверх этого, а не единственный источник.
function routeAutoModel(input = {}) {
    const text = String(input.text || '').toLowerCase();

    const lowConfidence = typeof input.orchestratorConfidence === 'number'
        && input.orchestratorConfidence < LOW_CONFIDENCE_THRESHOLD;

    const escalate = Boolean(
        input.isCorrection
        || input.isComplaintAboutUnderstanding
        || input.hasMultipleConstraints
        || input.isSafetyRelevant
        || input.needsExactValidation
        || input.referencesPreviousReply
        || lowConfidence
    );

    if (escalate) {
        const reason = input.isCorrection ? 'correction'
            : input.isComplaintAboutUnderstanding ? 'complaint_about_understanding'
            : input.hasMultipleConstraints ? 'multiple_constraints'
            : input.isSafetyRelevant ? 'safety_relevant'
            : input.needsExactValidation ? 'needs_exact_validation'
            : input.referencesPreviousReply ? 'references_previous_reply'
            : 'low_orchestrator_confidence';
        return { key: 'gpt', provider: 'openai', model: OPENAI_COMPLEX_MODEL, reason };
    }

    if (hasAny(text, SENSITIVE_PATTERNS)) {
        return { key: 'gpt', provider: 'openai', model: OPENAI_COMPLEX_MODEL, reason: 'sensitive_keyword' };
    }

    if (hasAny(text, SIMPLE_PATTERNS)) {
        return { key: 'deepseek', provider: 'deepseek', model: DEEPSEEK_MAIN_MODEL, reason: 'simple_keyword' };
    }

    return { key: 'deepseek', provider: 'deepseek', model: DEEPSEEK_MAIN_MODEL, reason: 'default_chat' };
}

function getModelProvider(modelName, input = {}) {
    const normalized = normalizeModelName(modelName);
    if (normalized === 'auto') return routeAutoModel(input);

    // Safety-relevant content always escalates to the complex OpenAI tier, even
    // when a parent has manually pinned the device to DeepSeek/Flash (test-mode
    // override in the parent panel, model_mode='economy'/'deepseek'). A manual
    // mode selection must never bypass the safety escalation that 'auto' mode
    // already gets via routeAutoModel above.
    if (normalized === 'deepseek' || normalized === 'deepseek-flash') {
        const text = String(input.text || '').toLowerCase();
        const forcedSafety = Boolean(input.isSafetyRelevant) || hasAny(text, SENSITIVE_PATTERNS);
        if (forcedSafety) {
            return {
                key: 'gpt-complex',
                provider: 'openai',
                model: OPENAI_COMPLEX_MODEL,
                reason: 'safety_override_manual_mode',
            };
        }
    }

    if (normalized === 'gpt-complex') {
        return {
            key: 'gpt-complex',
            provider: 'openai',
            model: OPENAI_COMPLEX_MODEL,
            reason: 'explicit_gpt_complex',
        };
    }
    if (normalized === 'deepseek') {
        return {
            key: 'deepseek',
            provider: 'deepseek',
            model: DEEPSEEK_MAIN_MODEL,
            reason: 'explicit_deepseek',
        };
    }
    if (normalized === 'deepseek-flash') {
        return {
            key: 'deepseek-flash',
            provider: 'deepseek',
            model: DEEPSEEK_FLASH_MODEL,
            reason: 'explicit_deepseek_flash',
        };
    }
    return {
        key: 'gpt',
        provider: 'openai',
        model: GPT_MODEL,
        reason: 'explicit_gpt',
    };
}

// Prompt caching (OpenAI): подтверждено официальной документацией — для gpt-4o/gpt-4o-mini
// кэширование промпта включается автоматически на промптах от ~1024 токенов и работает по
// точному совпадению префикса сообщений (никакого спец-параметра передавать не нужно).
// Источник: https://platform.openai.com/docs/guides/prompt-caching
// Отсюда и мотивация держать staticSystemPrompt (llm.js) стабильным неизменным префиксом —
// он не даёт эффекта сам по себе (SDK/API решают это по факту совпадения), но без разделения
// static/dynamic контента префикс менялся бы каждый запрос и точно не кэшировался.
async function callOpenAI(messages, maxTokens, model = GPT_MODEL) {
    const response = await getOpenAIClient().chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages,
    });
    return {
        reply: response.choices[0]?.message?.content?.trim() || '',
        model_used: model,
        provider: 'openai',
        finish_reason: response.choices[0]?.finish_reason,
        tokens_used: response.usage?.total_tokens,
    };
}

// TODO(prompt caching, DeepSeek): не подтверждено для ЭТОЙ интеграции. Официальный DeepSeek API
// documented "Context Caching on Disk" (https://api-docs.deepseek.com/guides/kv_cache) для моделей
// deepseek-chat/deepseek-reasoner, но здесь DEEPSEEK_MODEL='deepseek-v4-flash' и DEEPSEEK_BASE_URL
// конфигурируемый — не ясно, официальный ли это endpoint или прокси/агрегатор, и распространяется
// ли документированное поведение на эту модель/провайдера. Не считать кэширование доказанным без
// проверки реального провайдера (счетов/заголовков ответа) — просто держим messages в том же
// стабильном static/dynamic порядке на случай, если кэширование по префиксу всё же работает.
async function callDeepSeek(messages, maxTokens, model = DEEPSEEK_MAIN_MODEL) {
    if (!process.env.DEEPSEEK_API_KEY) {
        throw new Error('DEEPSEEK_API_KEY is not set');
    }
    const response = await getDeepSeekClient().chat.completions.create({
        model,
        max_tokens: Math.max(maxTokens, 260),
        messages,
        thinking: { type: 'disabled' },
    });
    return {
        reply: response.choices[0]?.message?.content?.trim() || '',
        model_used: model,
        provider: 'deepseek',
        finish_reason: response.choices[0]?.finish_reason,
        tokens_used: response.usage?.total_tokens,
    };
}

function looksUnfinished(text, finishReason = '') {
    const value = String(text || '').trim();
    if (!value) return false;
    if (finishReason === 'length') return true;
    if (/[,:;—-]$/.test(value)) return true;
    const lower = value.toLocaleLowerCase('ru-RU');
    const lastWords = lower.split(/\s+/).slice(-2).join(' ');
    const lastWord = lower.split(/\s+/).pop() || '';
    const unfinished = new Set([
        '\u0438', '\u0430', '\u043d\u043e', '\u0438\u043b\u0438',
        '\u0447\u0442\u043e', '\u0447\u0442\u043e\u0431\u044b',
        '\u043f\u043e\u0442\u043e\u043c\u0443 \u0447\u0442\u043e',
        '\u043a\u043e\u0442\u043e\u0440\u044b\u0439',
        '\u043a\u043e\u0442\u043e\u0440\u0430\u044f',
        '\u043a\u043e\u0442\u043e\u0440\u043e\u0435',
        '\u043a\u043e\u0442\u043e\u0440\u044b\u0435',
        '\u043a\u043e\u0442\u043e\u0440\u044b\u043c',
        '\u043a\u043e\u0442\u043e\u0440\u044b\u043c\u0438',
        '\u043a\u0430\u043a', '\u0433\u0434\u0435', '\u0432', '\u043d\u0430',
        '\u0441', '\u0443', '\u0434\u043b\u044f',
        'and', 'or', 'but', 'because', 'that', 'which', 'with', 'for', 'in', 'on',
        'si', 'sau', 'dar', 'pentru', 'care', 'cu',
    ]);
    return unfinished.has(lastWord) || unfinished.has(lastWords);
}

function joinContinuation(reply, continuation) {
    const first = String(reply || '').trim();
    const second = String(continuation || '').trim();
    if (!first) return second;
    if (!second) return first;
    return `${first} ${second}`.replace(/\s+/g, ' ').trim();
}

async function completeDeepSeekIfNeeded(messages, result) {
    if (!looksUnfinished(result.reply, result.finish_reason)) return result;

    logger.warn('[LLM Router] DeepSeek reply looks unfinished; requesting short continuation');
    const continuation = await callDeepSeek([
        ...messages,
        { role: 'assistant', content: result.reply },
        {
            role: 'user',
            content: 'Finish only the previous assistant sentence in the same language. Return only the missing ending, one short phrase. Do not repeat the previous text.',
        },
    ], 90, result.model_used);

    return {
        ...result,
        reply: joinContinuation(result.reply, continuation.reply),
        finish_reason: continuation.finish_reason,
        tokens_used: (result.tokens_used || 0) + (continuation.tokens_used || 0),
        continued: true,
    };
}

async function callModel({ modelName = 'gpt', messages, maxTokens, routeInput = {} }) {
    const started = Date.now();
    const requested = normalizeModelName(modelName);
    const selected = getModelProvider(modelName, routeInput);

    try {
        let result = selected.provider === 'deepseek'
            ? await callDeepSeek(messages, maxTokens, selected.model)
            : await callOpenAI(messages, maxTokens, selected.model);
        if (selected.provider === 'deepseek') {
            result = await completeDeepSeekIfNeeded(messages, result);
        }
        return {
            ...result,
            requested_model: requested,
            router_choice: selected.key,
            routing_reason: selected.reason || null,
            latency_ms: Date.now() - started,
            fallback: false,
        };
    } catch (err) {
        if (selected.provider !== 'deepseek') throw err;
        if (requested !== 'auto') {
            err.message = `DeepSeek failed: ${err.message}`;
            throw err;
        }
        logger.warn(`[LLM Router] DeepSeek unavailable, falling back to GPT: ${err.message}`);
        const fallback = await callOpenAI(messages, maxTokens, OPENAI_COMPLEX_MODEL);
        return {
            ...fallback,
            requested_model: requested,
            router_choice: selected.key,
            routing_reason: selected.reason || null,
            latency_ms: Date.now() - started,
            fallback: true,
            fallback_reason: err.message,
        };
    }
}

module.exports = {
    getModelProvider,
    routeAutoModel,
    callModel,
    normalizeModelName,
    looksUnfinished,
};
