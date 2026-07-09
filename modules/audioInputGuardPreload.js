'use strict';

const fs = require('fs');
const path = require('path');

const originalReadFileSync = fs.readFileSync;
const serverPath = path.resolve(__dirname, '..', 'server.js');

// Keep this low enough for real short replies like "да", "угу", "ага".
// At 16kHz mono 16-bit, 6000 bytes is ~0.19s. It blocks micro-clicks like 4096 bytes
// but lets normal short confirmations reach STT.
const MIN_STT_PCM_BYTES = Number(process.env.MIN_STT_PCM_BYTES || 6000);

function normalizeText(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[.,!?;:()[\]{}"«»“”]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function hasCyrillic(text) {
    return /[а-я]/i.test(String(text || ''));
}

function isTooShortPcm(byteLength) {
    const bytes = Number(byteLength || 0);
    return bytes > 0 && bytes < MIN_STT_PCM_BYTES;
}

function hasRepeatedPhrase(text) {
    const t = normalizeText(text);
    const words = t.split(' ').filter(Boolean);
    if (words.length < 8) return false;

    const chunks = new Map();
    for (let i = 0; i <= words.length - 3; i++) {
        const chunk = words.slice(i, i + 3).join(' ');
        chunks.set(chunk, (chunks.get(chunk) || 0) + 1);
        if (chunks.get(chunk) >= 4) return true;
    }

    return false;
}

function isSuspiciousTranscript(text) {
    const raw = String(text || '').trim();
    const t = normalizeText(raw);
    if (!t) return false;

    // Common Whisper hallucinations when input is too short, noisy or silent.
    if (/редактор субтитров|корректор|субтитры|субтитров/.test(t)) return true;
    if (/спасибо за просмотр|подписывайтесь|ставьте лайк|до новых встреч/.test(t)) return true;
    if (/ответы на вопросы/.test(t) && hasRepeatedPhrase(t)) return true;
    if (hasRepeatedPhrase(t) && t.length > 160) return true;

    if (!hasCyrillic(raw)) {
        if (/^(you|thank you|thanks|thank you very much|yeah boss|yes boss|subtitles|bye bye)$/.test(t)) return true;
        if (/\b(o que|que me|interessa|isso|voce|voces|obrigado|obrigada)\b/.test(t)) return true;
        if (/\b(c etait|abidjan|merci|bonjour|bonsoir|gracias|hola)\b/.test(t)) return true;

        const words = t.split(' ').filter(Boolean);
        const isTargetEnglishCommand = /\b(riddles?|stor(?:y|ies)|games?)\b/.test(t);
        if (words.length <= 3 && /^[a-z\s']+$/.test(t) && !isTargetEnglishCommand) return true;
    }

    return false;
}

function isSuspiciousForeignTranscript(text) {
    return isSuspiciousTranscript(text);
}

function replaceOnce(source, from, to, label) {
    if (!source.includes(from)) {
        throw new Error(`[AudioInputGuardPreload] missing patch point: ${label}`);
    }
    return source.replace(from, to);
}

function patchServerSource(source) {
    let patched = source;

    patched = replaceOnce(
        patched,
        "const THINKING_END_GRACE_MS = 300;     // маленький запас перед основным ответом\n",
        "const THINKING_END_GRACE_MS = 300;     // маленький запас перед основным ответом\nconst MIN_STT_PCM_BYTES = Number(process.env.MIN_STT_PCM_BYTES || 6000);\n\nfunction isTooShortForStt(pcmBuffer) {\n    const bytes = pcmBuffer?.length || 0;\n    return bytes > 0 && bytes < MIN_STT_PCM_BYTES;\n}\n\nfunction normalizeTranscriptForGuard(text) {\n    return String(text || '')\n        .toLowerCase()\n        .normalize('NFD')\n        .replace(/[\\u0300-\\u036f]/g, '')\n        .replace(/[.,!?;:()[\\]{}\\\"«»“”]/g, ' ')\n        .replace(/\\s+/g, ' ')\n        .trim();\n}\n\nfunction hasRepeatedTranscriptPhrase(text) {\n    const t = normalizeTranscriptForGuard(text);\n    const words = t.split(' ').filter(Boolean);\n    if (words.length < 8) return false;\n    const chunks = new Map();\n    for (let i = 0; i <= words.length - 3; i++) {\n        const chunk = words.slice(i, i + 3).join(' ');\n        chunks.set(chunk, (chunks.get(chunk) || 0) + 1);\n        if (chunks.get(chunk) >= 4) return true;\n    }\n    return false;\n}\n\nfunction isSuspiciousTranscript(text) {\n    const raw = String(text || '').trim();\n    const t = normalizeTranscriptForGuard(raw);\n    if (!t) return false;\n    if (/редактор субтитров|корректор|субтитры|субтитров/.test(t)) return true;\n    if (/спасибо за просмотр|подписывайтесь|ставьте лайк|до новых встреч/.test(t)) return true;\n    if (/ответы на вопросы/.test(t) && hasRepeatedTranscriptPhrase(t)) return true;\n    if (hasRepeatedTranscriptPhrase(t) && t.length > 160) return true;\n    if (!/[а-я]/i.test(raw)) {\n        if (/^(you|thank you|thanks|thank you very much|yeah boss|yes boss|subtitles|bye bye)$/.test(t)) return true;\n        if (/\\b(o que|que me|interessa|isso|voce|voces|obrigado|obrigada)\\b/.test(t)) return true;\n        if (/\\b(c etait|abidjan|merci|bonjour|bonsoir|gracias|hola)\\b/.test(t)) return true;\n        const words = t.split(' ').filter(Boolean);\n        const isTargetEnglishCommand = /\\b(riddles?|stor(?:y|ies)|games?)\\b/.test(t);\n        if (words.length <= 3 && /^[a-z\\s']+$/.test(t) && !isTargetEnglishCommand) return true;\n    }\n    return false;\n}\n\nfunction isSuspiciousForeignTranscript(text) {\n    return isSuspiciousTranscript(text);\n}\n",
        'audio input guard helpers'
    );

    patched = replaceOnce(
        patched,
        "        logger.info(`[Pipeline] saved input PCM: ${pcmBuffer.length} bytes`);\n\n        // 3. STT — Whisper",
        "        logger.info(`[Pipeline] saved input PCM: ${pcmBuffer.length} bytes`);\n\n        if (isTooShortForStt(pcmBuffer)) {\n            logger.info(`[AudioInputGuard] skipped STT: pcm_too_short bytes=${pcmBuffer.length} min=${MIN_STT_PCM_BYTES}`);\n            const r = retryAudioCommand();\n            sendAudio(r.url, r.durationMs);\n            return;\n        }\n\n        // 3. STT — Whisper",
        'short pcm guard before stt'
    );

    patched = replaceOnce(
        patched,
        "        if (!transcript || transcript.trim().length === 0) {\n            logger.info('[Pipeline] empty transcript — Lumi gently asks to repeat');\n            const r = retryAudioCommand();\n            sendAudio(r.url, r.durationMs);\n            return; // finally{} сбросит state в IDLE и удалит upload\n        }\n\n        // 4. LLM — Claude",
        "        if (!transcript || transcript.trim().length === 0) {\n            logger.info('[Pipeline] empty transcript — Lumi gently asks to repeat');\n            const r = retryAudioCommand();\n            sendAudio(r.url, r.durationMs);\n            return; // finally{} сбросит state в IDLE и удалит upload\n        }\n\n        if (isSuspiciousTranscript(transcript)) {\n            logger.info(`[AudioInputGuard] skipped LLM: suspicious_transcript chars=${String(transcript || '').length}`);\n            const r = retryAudioCommand();\n            sendAudio(r.url, r.durationMs);\n            return;\n        }\n\n        // 4. LLM — Claude",
        'suspicious transcript guard before llm'
    );

    return patched;
}

fs.readFileSync = function patchedReadFileSync(filePath, options) {
    const data = originalReadFileSync.apply(this, arguments);
    if (path.resolve(String(filePath)) !== serverPath) return data;

    const encoding = typeof options === 'string' ? options : options?.encoding;
    if (encoding && String(encoding).toLowerCase() !== 'utf8' && String(encoding).toLowerCase() !== 'utf-8') {
        return data;
    }

    const source = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    const patched = patchServerSource(source);
    console.log('[AudioInputGuardPreload] audio input guards injected into server.js');
    return Buffer.isBuffer(data) ? Buffer.from(patched, 'utf8') : patched;
};

module.exports = {
    MIN_STT_PCM_BYTES,
    isTooShortPcm,
    isSuspiciousTranscript,
    isSuspiciousForeignTranscript,
};
