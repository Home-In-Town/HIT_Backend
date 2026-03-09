module.exports = (err, req, res, next) => {
    // Log the error for internal tracking
    console.error(`[Error] ${req.method} ${req.url}:`, err.stack);

    const isProd = process.env.NODE_ENV === 'production';

    // Hardened response: mask details in production
    res.status(err.status || 500).json({
        error: isProd ? 'Internal Server Error' : err.message,
        // Only include stack trace in dev/local
        ...(!isProd && { stack: err.stack })
    });
};
