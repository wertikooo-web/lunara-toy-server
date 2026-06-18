'use strict';

/**
 * Cleaner — auto-delete old PCM files from /audio/ directory.
 * Runs on an interval, removes files older than ttlMs.
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const INTERVAL_MS = 60 * 1000;   // run every 60 seconds

/**
 * Start the cleaner.
 * @param {string} dir   — directory to clean
 * @param {number} ttlMs — max file age in milliseconds (default 10 min)
 * @param {string[]} keepFiles — file names that should never be deleted
 */
function start(dir, ttlMs = 10 * 60 * 1000, keepFiles = []) {
    const keep = new Set(keepFiles);
    logger.info(`[Cleaner] started — watching ${dir}, TTL=${ttlMs / 1000}s`);

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
            if (!file.endsWith('.pcm') && !file.endsWith('.wav')) continue;
            if (keep.has(file)) continue;

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
            logger.info(`[Cleaner] deleted ${deleted} old file(s) from ${dir}`);
        }
    }, INTERVAL_MS);
}

module.exports = { start };
