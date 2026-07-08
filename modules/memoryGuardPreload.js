'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const originalJsLoader = Module._extensions['.js'];
const memoryPath = path.resolve(__dirname, 'memory.js');

function replaceOnce(source, from, to, label) {
    if (!source.includes(from)) {
        throw new Error(`[MemoryGuardPreload] missing patch point: ${label}`);
    }
    return source.replace(from, to);
}

function patchMemorySource(source) {
    let patched = source;

    patched = replaceOnce(
        patched,
        "const logger = require('./logger');\n",
        "const logger = require('./logger');\nconst memoryGuard = require('./memoryGuard');\n",
        'require memoryGuard'
    );

    patched = replaceOnce(
        patched,
        "async function rememberFromText(deviceId, userText, profile = null) {\n    if (!AUTO_UPDATE) return null;\n    if (!ready || !pool) return null;\n\n    const actions = await extractPatchFromText(userText, profile);",
        "async function rememberFromText(deviceId, userText, profile = null) {\n    if (!AUTO_UPDATE) return null;\n    if (!ready || !pool) return null;\n\n    const guard = memoryGuard.shouldRememberUserText(userText);\n    if (!guard.allow) {\n        logger.info(`[MemoryGuard] skipped ${normalizeDeviceId(deviceId)} reason=${guard.reason} chars=${String(userText || '').length}`);\n        return null;\n    }\n\n    const actions = await extractPatchFromText(userText, profile);",
        'rememberFromText pre-extraction guard'
    );

    patched = replaceOnce(
        patched,
        "    const actions = await extractPatchFromText(userText, profile);\n    if (!hasMemoryActions(actions)) {",
        "    const actions = await extractPatchFromText(userText, profile);\n    const filtered = memoryGuard.filterUnsafeActions(actions);\n    if (filtered.removed > 0) {\n        logger.info(`[MemoryGuard] removed unsafe extracted values count=${filtered.removed}`);\n    }\n    if (!hasMemoryActions(filtered.actions)) {",
        'filter unsafe extracted actions'
    );

    patched = replaceOnce(
        patched,
        "    const updated = await applyMemoryActions(deviceId, actions);\n    const keys = [\n        ...Object.keys(actions.set || {}).map((key) => `set.${key}`),\n        ...Object.keys(actions.add || {}).map((key) => `add.${key}`),\n        ...Object.keys(actions.remove || {}).map((key) => `remove.${key}`),",
        "    const updated = await applyMemoryActions(deviceId, filtered.actions);\n    const keys = [\n        ...Object.keys(filtered.actions.set || {}).map((key) => `set.${key}`),\n        ...Object.keys(filtered.actions.add || {}).map((key) => `add.${key}`),\n        ...Object.keys(filtered.actions.remove || {}).map((key) => `remove.${key}`),",
        'use filtered actions'
    );

    return patched;
}

Module._extensions['.js'] = function memoryGuardJsLoader(module, filename) {
    if (path.resolve(filename) !== memoryPath) {
        return originalJsLoader(module, filename);
    }

    const source = fs.readFileSync(filename, 'utf8');
    const patched = patchMemorySource(source);
    console.log('[MemoryGuardPreload] memory guard injected into memory.js');
    return module._compile(patched, filename);
};
