const express = require('express');
const path = require('path');
const cfg = require('./config');
const botRoutes = require('./routes/botRoutes');
const logger = require('./utils/logger');

const app = express();
app.use(express.json());

// Web UI
app.use(express.static(path.join(process.cwd(), 'public')));
app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/', botRoutes);

app.listen(cfg.PORT, () => {
    logger.info(`Bot sunucusu http://localhost:${cfg.PORT} üzerinde çalışıyor`);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.errorSafe('Unhandled Rejection', reason, { promise });
});
