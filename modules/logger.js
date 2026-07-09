'use strict';

// Часовой пояс рынка. Можно переопределить через переменную окружения TZ_MARKET.
const TIMEZONE = process.env.TZ_MARKET || 'Europe/Chisinau';

function timestamp() {
    const now = new Date();
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: TIMEZONE,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false,
        }).formatToParts(now).reduce((acc, part) => {
            acc[part.type] = part.value;
            return acc;
        }, {});
        return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    } catch (_) {
        return now.toISOString();
    }
}

function formatErrorArg(value) {
    return value instanceof Error ? (value.stack || value.message) : value;
}

module.exports = {
    info:  (...a) => console.log(`[${timestamp()}] INFO `, ...a),
    warn:  (...a) => console.warn(`[${timestamp()}] WARN `, ...a),
    error: (...a) => console.error(`[${timestamp()}] ERROR`, ...a.map(formatErrorArg)),
    debug: (...a) => {
        if (process.env.DEBUG) console.log(`[${timestamp()}] DEBUG`, ...a);
    },
};
