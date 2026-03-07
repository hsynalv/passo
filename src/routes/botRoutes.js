const express = require('express');
const router = express.Router();
const { startBot, startBotAsync, registerCAccount, requestFinalize, getRunStatus } = require('../controllers/botController');
const { botRateLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');

router.post('/start-bot', botRateLimiter, startBot);
router.post('/start-bot-async', botRateLimiter, startBotAsync);

router.get('/logs/stream', (req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    try { res.flushHeaders && res.flushHeaders(); } catch {}

    const writeEvent = (event, data) => {
        try {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch {}
    };

    // Send a snapshot first so the UI has context.
    try {
        const recent = logger.getRecentLogs(300);
        writeEvent('snapshot', recent);
    } catch {}

    const unsub = logger.subscribeLogs((entry) => {
        writeEvent('log', entry);
    });

    const keepAlive = setInterval(() => {
        try { res.write(': ping\n\n'); } catch {}
    }, 25000);

    req.on('close', () => {
        try { clearInterval(keepAlive); } catch {}
        try { unsub && unsub(); } catch {}
        try { res.end(); } catch {}
    });
});

router.get('/run/:runId/status', getRunStatus);
router.post('/run/:runId/c/register', registerCAccount);
router.post('/run/:runId/finalize', requestFinalize);

module.exports = router;
