const winston = require('winston');
const path = require('path');
const fs = require('fs');

// logs klasörünü oluştur
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.json()
    ),
    defaultMeta: { service: 'passobot-pro' },
    transports: [
        // Hata logları için ayrı dosya
        new winston.transports.File({ 
            filename: path.join(logsDir, 'error.log'), 
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 5
        }),
        // Tüm loglar için dosya
        new winston.transports.File({ 
            filename: path.join(logsDir, 'combined.log'),
            maxsize: 5242880, // 5MB
            maxFiles: 5
        }),
    ],
});

// Development ortamında console'a da yazdır
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.printf(({ timestamp, level, message, ...meta }) => {
                let msg = `${timestamp} [${level}]: ${message}`;
                const cleaned = { ...meta };
                delete cleaned.service;
                if (Object.keys(cleaned).length > 0) {
                    msg += ` ${JSON.stringify(cleaned)}`;
                }
                return msg;
            })
        )
    }));
} else {
    // Production'da sadece warn ve error'ları console'a yazdır
    logger.add(new winston.transports.Console({
        level: 'warn',
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
        )
    }));
}

// Hassas bilgileri maskeleme helper'ı
const maskSensitive = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const masked = { ...obj };
    if (masked.password) masked.password = '***';
    if (masked.password2) masked.password2 = '***';
    if (masked.cardNumber) masked.cardNumber = masked.cardNumber.replace(/\d(?=\d{4})/g, '*');
    if (masked.cvv) masked.cvv = '***';
    if (masked.proxyPassword) masked.proxyPassword = '***';
    if (masked.ANTICAPTCHA_KEY) masked.ANTICAPTCHA_KEY = '***';
    return masked;
};

// Logger wrapper'ları
logger.infoSafe = (message, meta = {}) => {
    logger.info(message, maskSensitive(meta));
};

logger.warnSafe = (message, meta = {}) => {
    logger.warn(message, maskSensitive(meta));
};

logger.debugSafe = (message, meta = {}) => {
    logger.debug(message, maskSensitive(meta));
};

logger.errorSafe = (message, error, meta = {}) => {
    const errorMeta = {
        ...maskSensitive(meta),
        error: error?.message || error,
        stack: error?.stack
    };
    logger.error(message, errorMeta);
};

module.exports = logger;


