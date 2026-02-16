/**
 * Structured JSON Logger
 */
const logger = (level, context, data) => {
    console.log(JSON.stringify({
        level,
        context,
        timestamp: new Date().toISOString(),
        ...data
    }));
};

module.exports = {
    info: (context, data) => logger('info', context, data),
    warn: (context, data) => logger('warn', context, data),
    error: (context, data) => logger('error', context, data)
};
