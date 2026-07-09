'use strict';

/**
 * Cleaner — auto-delete only transient response audio files from /audio/ directory.
 *
 * Important:
 * - The cleaner runs against the top-level AUDIO_DIR only.
 * - Persistent cache subdirectories such as /audio/content and /audio/riddles are not cleaned here.
 * - Only temporary response_*.pcm / response_*.wav files are eligible for deletion.
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const INTERVAL_MS = 60 * 1000;   // run every 60 seconds
const TRANSIENT_AUDIO_RE = /^response_.*\.(?:pcm|wav)$/i;

function isTransientAudioFile(file) {
    return TRANSIENT_AUDIO_RE.test(String(file || ''));
}

/**
 * Start the cleaner.
 * @param {string} dir   — directory to clean
 * @param {number} ttlMs — max file age in milliseconds (default 10 min)
 * @param {string[]} keepFiles — file names that should never be deleted
 */
function start(dir, ttlMs = 10 * 60 * 1000, keepFiles = []) {
    const keep = new Set(keepFiles);
    logger.info(`[Cleaner] started — watching ${dir}, TTL=${ttlMs / 1000}s, mode=transient-response-only`);

    setInterval(() => {
        const now = Date.now();

        let files;
        try {
            files = fs.readdirSync(dir);
        } catch (e) {
            logger.warn(`[Cleaner] cannot read dir ${dir}: ${e.message}`);
            return;
        }

        let deleted = 0;
        for (const file of files) {
            if (keep.has(file)) continue;
            if (!isTransientAudioFile(file)) continue;

            const filePath = path.join(dir, file);
            try {
                const stat = fs.statSync(filePath);
                if (!stat.isFile()) continue;
                if (now - stat.mtimeMs > ttlMs) {
                    fs.unlinkSync(filePath);
                    deleted++;
                }
            } catch (e) {
                logger.warn(`[Cleaner] cannot stat/delete ${filePath}: ${e.message}`);
            }
        }

        if (deleted > 0) {
            logger.info(`[Cleaner] deleted ${deleted} transient response file(s) from ${dir}`);
        }
    }, INTERVAL_MS);
}

module.exports = { start, isTransientAudioFile };
