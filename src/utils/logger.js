const winston = require('winston');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { AsyncLocalStorage } = require('async_hooks');

// logs klasörünü oluştur
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
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
    if (masked.CREDENTIAL_SECRET_KEY) masked.CREDENTIAL_SECRET_KEY = '***';
    if (masked.encryptedPassword) masked.encryptedPassword = '***';
    return masked;
};

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

// Live log stream support (UI)
const logBus = new EventEmitter();
const logContextStore = new AsyncLocalStorage();
const LOG_BUFFER_MAX = parseInt(process.env.LOG_STREAM_BUFFER_MAX || '800', 10);
const logBuffer = [];

const getActiveLogContext = () => {
    try { return logContextStore.getStore() || null; } catch { return null; }
};

const mergeLogContext = (meta) => {
    const ctx = getActiveLogContext();
    if (!ctx || typeof ctx !== 'object') return meta;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
        return { ...ctx, ...meta };
    }
    return { ...ctx };
};

const pushLog = (entry) => {
    try {
        logBuffer.push(entry);
        while (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
    } catch {}
    try { logBus.emit('log', entry); } catch {}
};

// Monkey-patch logger.log to also publish to the UI bus.
// Keep this very lightweight and non-blocking.
try {
    const baseLog = logger.log.bind(logger);
    logger.log = (...callArgs) => {
        try {
            const ctx = getActiveLogContext();
            // Winston supports: logger.log('info', 'msg', meta) and logger.log({ level, message, ...meta })
            if (callArgs.length === 1 && callArgs[0] && typeof callArgs[0] === 'object') {
                const info = ctx ? { ...ctx, ...callArgs[0] } : callArgs[0];
                pushLog({
                    ts: (() => { try { return new Date().toISOString(); } catch { return null; } })(),
                    level: String(info.level || 'info'),
                    message: String(info.message || ''),
                    runId: info.runId ? String(info.runId) : null,
                    meta: maskSensitive(info)
                });
                return baseLog(info);
            }

            const level = callArgs[0];
            const message = callArgs[1];
            const meta = mergeLogContext((callArgs.length >= 3) ? callArgs[2] : undefined);
            pushLog({
                ts: (() => { try { return new Date().toISOString(); } catch { return null; } })(),
                level: String(level || 'info'),
                message: String(message || ''),
                runId: meta?.runId ? String(meta.runId) : (ctx?.runId ? String(ctx.runId) : null),
                meta: maskSensitive(meta)
            });
            if (callArgs.length >= 3) callArgs[2] = meta;
            else if (meta && Object.keys(meta).length) callArgs.push(meta);
        } catch {}
        return baseLog(...callArgs);
    };
} catch {}

const auditEnabled = String(process.env.AUDIT_LOG_ENABLED || 'true').toLowerCase() !== 'false';
if (auditEnabled) {
    const auditOnly = winston.format((info) => {
        if (info && info.message === 'audit') return info;
        return false;
    });
    logger.add(new winston.transports.File({
        filename: path.join(logsDir, 'audit.log'),
        maxsize: 5242880,
        maxFiles: 10,
        format: winston.format.combine(
            auditOnly(),
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.errors({ stack: true }),
            winston.format.splat(),
            winston.format.json()
        )
    }));
}

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

// SSE consumers
logger.getRecentLogs = (limit = 250) => {
    try {
        const n = Math.max(1, Math.min(2000, parseInt(String(limit || 250), 10) || 250));
        return logBuffer.slice(Math.max(0, logBuffer.length - n));
    } catch {
        return [];
    }
};

logger.subscribeLogs = (handler) => {
    if (typeof handler !== 'function') return () => {};
    const fn = (entry) => {
        try { handler(entry); } catch {}
    };
    try { logBus.on('log', fn); } catch {}
    return () => {
        try { logBus.off('log', fn); } catch {}
    };
};

logger.runWithContext = (context, fn) => {
    const nextContext = {
        ...(getActiveLogContext() || {}),
        ...((context && typeof context === 'object') ? context : {})
    };
    return logContextStore.run(nextContext, fn);
};

logger.getContext = () => getActiveLogContext();

module.exports = logger;


