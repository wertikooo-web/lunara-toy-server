'use strict';

const llmRouter = require('./llmRouter');

const ALLOWED_INTENTS = new Set([
    'answer_guess',
    'reveal_answer',
    'repeat_riddle',
    'next_riddle',
    'stop_riddle_game',
    'off_topic',
    'unclear',
]);

const MODEL_TIMEOUT_MS = Number(process.env.RIDDLE_INTENT_MODEL_TIMEOUT_MS || 1200);
const USE_MODEL_CLASSIFIER = process.env.RIDDLE_INTENT_MODEL !== 'off';

function normalizeText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[.,!?;:()[\]{}"«»]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function wordCount(text) {
    return normalizeText(text).split(' ').filter(Boolean).length;
}

function result(intent, confidence, reason, source = 'rules') {
    return {
        intent: ALLOWED_INTENTS.has(intent) ? intent : 'unclear',
        confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
        reason: String(reason || '').slice(0, 160),
        source,
    };
}

function classifyByRules(text) {
    const t = normalizeText(text);
    if (!t) return result('unclear', 1, 'empty input');

    if (/^(thank you|thanks|thank you very much|yeah boss|yes boss|ok boss|okay boss|subtitles|bye bye)$/.test(t)) {
        return result('unclear', 0.97, 'common STT filler or wrong-language hallucination, not a riddle answer');
    }

    if (/(повтори|повторить|скажи еще раз|скажи ещё раз|еще раз|ещё раз|сначала|первую|прошлую|предыдущую|эту загадк)/.test(t)) {
        return result('repeat_riddle', 0.98, 'repeat riddle request');
    }

    if (/(другую загадк|следующую загадк|новую загадк|еще загадк|ещё загадк|загадай другую|давай другую|давай следующую)/.test(t)) {
        return result('next_riddle', 0.96, 'next riddle request');
    }

    if (/^(хватит|стоп|не хочу|нет не хочу|не надо|нет не надо|надоело|закончим|все|всё|потом|нет спасибо)$/.test(t) || /(не хочу играть|не хочу загадк|хватит загадк|давай без загад)/.test(t)) {
        return result('stop_riddle_game', 0.96, 'stop riddle game request');
    }

    if (/(сдаюсь|я пас|пас|не знаю|не получается|не выходит|не могу отгад|не угадаю|не отгадаю|скажи ответ|дай ответ|какой ответ|ответ скажи|подскажи|раскрой ответ)/.test(t)) {
        return result('reveal_answer', 0.98, 'user asks to reveal answer or gives up');
    }

    if (/^(да|ага|угу|давай|хочу|можно|ок|окей)$/.test(t)) {
        return result('next_riddle', 0.72, 'short yes while riddle is active');
    }

    if (/(кто такая|кто такой|что такое|расскажи про|почему|зачем|как сделать|как работает|поговорим|я хочу рассказать|у меня|мама|папа|бабушка|дедушка)/.test(t) && !/загадк/.test(t)) {
        return result('off_topic', 0.78, 'conversation changed away from riddle');
    }

    const words = wordCount(t);
    if (words <= 4) {
        return result('answer_guess', 0.74, 'short phrase likely answer guess');
    }

    return result('unclear', 0.35, 'ambiguous riddle turn');
}

function extractJson(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (_) {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
            return JSON.parse(match[0]);
        } catch (_) {
            return null;
        }
    }
}

function withTimeout(promise, timeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('riddle intent classifier timeout')), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function classifyByModel({ transcript, activeRiddle }) {
    const answerHint = activeRiddle?.answer ? `Текущий правильный ответ: ${activeRiddle.answer}.` : 'Правильный ответ неизвестен классификатору.';
    const messages = [
        {
            role: 'system',
            content: [
                'Ты классификатор реплики ребёнка во время активной загадки.',
                'Верни только JSON без markdown.',
                'Поле intent должно быть строго одним из:',
                'answer_guess, reveal_answer, repeat_riddle, next_riddle, stop_riddle_game, off_topic, unclear.',
                'Смысл intent:',
                '- answer_guess: ребёнок пробует угадать ответ.',
                '- reveal_answer: ребёнок сдаётся, не знает, просит ответ или подсказку.',
                '- repeat_riddle: просит повторить эту/первую/прошлую загадку.',
                '- next_riddle: хочет другую/следующую загадку.',
                '- stop_riddle_game: не хочет играть в загадки.',
                '- off_topic: сменил тему и говорит не про загадку.',
                '- unclear: непонятно.',
                'Фразы вроде "я сдаюсь", "я пас", "не могу", "не знаю" = reveal_answer, а не эмоция и не плохое самочувствие.',
                'Фразы вроде "thank you", "yeah boss", "subtitles" во время русской загадки чаще являются ошибкой STT = unclear, не answer_guess.',
                answerHint,
                'Формат: {"intent":"...","confidence":0.0,"reason":"..."}',
            ].join('\n'),
        },
        { role: 'user', content: String(transcript || '').slice(0, 300) },
    ];

    const response = await withTimeout(llmRouter.callModel({
        modelName: process.env.RIDDLE_INTENT_MODEL_NAME || 'gpt',
        messages,
        maxTokens: 70,
        routeInput: { text: transcript, contentContext: 'riddle_intent_classifier' },
    }), MODEL_TIMEOUT_MS);

    const parsed = extractJson(response.reply);
    if (!parsed || !ALLOWED_INTENTS.has(parsed.intent)) {
        throw new Error('invalid classifier JSON');
    }

    return result(parsed.intent, parsed.confidence ?? 0.7, parsed.reason || 'model classified', 'model');
}

async function classifyRiddleTurn(input = {}) {
    const transcript = input.transcript || input.text || '';
    const rules = classifyByRules(transcript);

    if (!USE_MODEL_CLASSIFIER) return rules;
    if (rules.confidence >= 0.9) return rules;

    try {
        const model = await classifyByModel({ transcript, activeRiddle: input.activeRiddle });
        if (model.confidence >= 0.55) return model;
    } catch (err) {
        // Do not break the toy because the classifier model failed.
        return {
            ...rules,
            reason: `${rules.reason}; model unavailable: ${String(err.message || err).slice(0, 80)}`,
        };
    }

    return rules;
}

module.exports = {
    classifyRiddleTurn,
    classifyByRules,
    normalizeText,
};
