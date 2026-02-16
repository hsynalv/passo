const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');
const { formatError, messages } = require('../utils/messages');

// Bot endpoint'i için rate limiter
const botRateLimiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 dakika (varsayılan)
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '5', 10), // Her IP için maksimum 5 istek (varsayılan)
    message: {
        error: formatError('RATE_LIMIT_EXCEEDED'),
        message: formatError('RATE_LIMIT_MESSAGE'),
        retryAfter: Math.ceil(parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10) / 1000 / 60) + ' dakika'
    },
    standardHeaders: true, // `RateLimit-*` header'larını ekle
    legacyHeaders: false, // `X-RateLimit-*` header'larını kaldır
    handler: (req, res) => {
        logger.warn('Rate limit aşıldı', {
            ip: req.ip,
            path: req.path,
            userAgent: req.get('user-agent')
        });
        res.status(429).json({
            error: formatError('RATE_LIMIT_EXCEEDED'),
            message: formatError('RATE_LIMIT_MESSAGE'),
            retryAfter: Math.ceil(parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10) / 1000 / 60) + ' dakika'
        });
    },
    skip: (req) => {
        // Belirli IP'leri rate limit'ten muaf tut (opsiyonel)
        const whitelist = process.env.RATE_LIMIT_WHITELIST?.split(',') || [];
        return whitelist.includes(req.ip);
    }
});

module.exports = { botRateLimiter };

