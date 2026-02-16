const express = require('express');
const cfg = require('./config');
const botRoutes = require('./routes/botRoutes');
const logger = require('./utils/logger');

const app = express();
app.use(express.json());
app.use('/', botRoutes);

app.listen(cfg.PORT, () => {
    logger.info(`Bot sunucusu http://localhost:${cfg.PORT} üzerinde çalışıyor`);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.errorSafe('Unhandled Rejection', reason, { promise });
});
