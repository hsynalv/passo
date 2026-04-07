const express = require('express');
const router = express.Router();
const { startBot, startBotAsync, registerCAccount, requestFinalize, getRunStatus, killSessions } = require('../controllers/botController');
const { createTeam, deleteTeam, listTeams, updateTeam } = require('../controllers/teamController');
const { createCategory, deleteCategory, listCategories, updateCategory } = require('../controllers/categoryController');
const { createCredential, deleteCredential, listCredentials, updateCredential } = require('../controllers/credentialController');
const { createProxy, deleteProxy, importProxyBulk, listProxies, restoreProxy, updateProxy } = require('../controllers/proxyController');
const { listOrderRecords, getOrderRecord, streamOrderRecords } = require('../controllers/orderRecordController');
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

router.get('/api/teams', listTeams);
router.post('/api/teams', createTeam);
router.put('/api/teams/:teamId', updateTeam);
router.delete('/api/teams/:teamId', deleteTeam);
router.get('/api/teams/:teamId/categories', listCategories);
router.post('/api/teams/:teamId/categories', createCategory);
router.put('/api/teams/:teamId/categories/:categoryId', updateCategory);
router.delete('/api/teams/:teamId/categories/:categoryId', deleteCategory);
router.get('/api/teams/:teamId/credentials', listCredentials);
router.post('/api/teams/:teamId/credentials', createCredential);
router.put('/api/teams/:teamId/credentials/:credentialId', updateCredential);
router.delete('/api/teams/:teamId/credentials/:credentialId', deleteCredential);
router.get('/api/proxies', listProxies);
router.post('/api/proxies', createProxy);
router.post('/api/proxies/import', importProxyBulk);
router.put('/api/proxies/:proxyId', updateProxy);
router.delete('/api/proxies/:proxyId', deleteProxy);
router.post('/api/proxies/:proxyId/restore', restoreProxy);
router.get('/api/order-records', listOrderRecords);
router.get('/api/order-records/stream', streamOrderRecords);
router.get('/api/order-records/:recordId', getOrderRecord);

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
