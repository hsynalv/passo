const express = require('express');
const router = express.Router();
const { startBot, startBotAsync, registerCAccount, requestFinalize, getRunStatus, killSessions } = require('../controllers/botController');
const { botRateLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');
const cfg = require('../config');

router.get('/api/panel-settings', (req, res) => {
  try {
    const defaults = cfg.getPanelDefaultsFlat();
    return res.json({ success: true, defaults, keys: cfg.PANEL_ENV_KEYS });
  } catch (e) {
    return res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

router.post('/start-bot', botRateLimiter, startBot);
router.post('/start-bot-async', botRateLimiter, startBotAsync);

router.post('/kill-sessions', botRateLimiter, killSessions);

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
