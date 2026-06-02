'use strict';

function timestamp() {
    return new Date().toISOString();
}

module.exports = {
    info:  (...a) => console.log(`[${timestamp()}] INFO `, ...a),
    warn:  (...a) => console.warn(`[${timestamp()}] WARN `, ...a),
    error: (...a) => console.error(`[${timestamp()}] ERROR`, ...a),
    debug: (...a) => {
        if (process.env.DEBUG) console.log(`[${timestamp()}] DEBUG`, ...a);
    },
};
