'use strict';

const OpenAI = require('openai');
const logger = require('./logger');

const GPT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

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
    if (['gpt', 'openai', 'gpt-4o-mini'].includes(value)) return 'gpt';
    if (['deepseek', 'deepseek-v4-flash', 'ds'].includes(value)) return 'deepseek';
    if (['auto', 'router', 'auto-router'].includes(value)) return 'auto';
    return 'gpt';
}

function hasAny(text, patterns) {
    return patterns.some((pattern) => pattern.test(text));
}

function routeAutoModel(input = {}) {
    const text = String(input.text || '').toLowerCase();

    const sensitive = [
        /страшн|боюсь|плак|груст|одинок|обид|ссор|руга|удар|бьют|больно|плохой|не любят|исчез/i,
        /мама|папа|семь|бабуш|дедуш|школ|друг/i,
        /помнишь|запомни|забыл|что я люблю|мой любим|моя любим|я люблю|я не люблю/i,
        /адрес|телефон|фамили|лекарств|огонь|нож|окн/i,
        /remember|my favorite|i like|i do not like|i don't like/i,
        /scared|afraid|sad|lonely|hurt|fight|family|mother|father|school|friend/i,
        /tine minte|imi place|nu imi place|preferat|preferata/i,
        /frica|trist|singur|doare|familie|mama|tata|scoala|prieten/i,
    ];

    const simple = [
        /загадк|скороговор|сказк|истори|игр|поигра|животн|сколько будет|посчитай/i,
        /riddle|tongue twister|story|game|animal|how much is|count/i,
        /ghicitoare|framantare|poveste|joc|animal|cat face/i,
    ];

    if (hasAny(text, sensitive)) return getModelProvider('gpt');
    if (hasAny(text, simple)) return getModelProvider('deepseek');

    return getModelProvider('deepseek');
}

function getModelProvider(modelName, input = {}) {
    const normalized = normalizeModelName(modelName);
    if (normalized === 'auto') return routeAutoModel(input);
    if (normalized === 'deepseek') {
        return {
            key: 'deepseek',
            provider: 'deepseek',
            model: DEEPSEEK_MODEL,
        };
    }
    return {
        key: 'gpt',
        provider: 'openai',
        model: GPT_MODEL,
    };
}

async function callOpenAI(messages, maxTokens) {
    const response = await getOpenAIClient().chat.completions.create({
        model: GPT_MODEL,
        max_tokens: maxTokens,
        messages,
    });
    return {
        reply: response.choices[0]?.message?.content?.trim() || '',
        model_used: GPT_MODEL,
        provider: 'openai',
        finish_reason: response.choices[0]?.finish_reason,
        tokens_used: response.usage?.total_tokens,
    };
}

async function callDeepSeek(messages, maxTokens) {
    if (!process.env.DEEPSEEK_API_KEY) {
        throw new Error('DEEPSEEK_API_KEY is not set');
    }
    const response = await getDeepSeekClient().chat.completions.create({
        model: DEEPSEEK_MODEL,
        max_tokens: Math.max(maxTokens, 260),
        messages,
        thinking: { type: 'disabled' },
    });
    return {
        reply: response.choices[0]?.message?.content?.trim() || '',
        model_used: DEEPSEEK_MODEL,
        provider: 'deepseek',
        finish_reason: response.choices[0]?.finish_reason,
        tokens_used: response.usage?.total_tokens,
    };
}

async function callModel({ modelName = 'gpt', messages, maxTokens, routeInput = {} }) {
    const started = Date.now();
    const requested = normalizeModelName(modelName);
    const selected = getModelProvider(modelName, routeInput);

    try {
        const result = selected.provider === 'deepseek'
            ? await callDeepSeek(messages, maxTokens)
            : await callOpenAI(messages, maxTokens);
        return {
            ...result,
            requested_model: requested,
            router_choice: selected.key,
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
        const fallback = await callOpenAI(messages, maxTokens);
        return {
            ...fallback,
            requested_model: requested,
            router_choice: selected.key,
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
};
