const express = require('express');
const path = require('path');
const readline = require('readline');
const cfg = require('./config');
const { connectMongo } = require('./db/mongo');
const logger = require('./utils/logger');

function waitForEnterInExe() {
    if (!process.pkg) return;
    console.log('\nUygulama kapatilmadi. Cikmak icin Enter tusuna basin...');
    try {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question('', () => rl.close());
    } catch {}
}

process.on('unhandledRejection', (reason, promise) => {
    try {
        logger.errorSafe('Unhandled Rejection', reason, { promise });
    } catch {}
    console.error('\n[UnhandledRejection]', reason);
    waitForEnterInExe();
});

process.on('uncaughtException', (err) => {
    try {
        logger.errorSafe('Uncaught Exception', err);
    } catch {}
    console.error('\n[UncaughtException]', err);
    waitForEnterInExe();
});

async function start() {
    const botRoutes = require('./routes/botRoutes');
    const app = express();
    app.use(express.json());

    try {
        await connectMongo();
    } catch (error) {
        logger.warnSafe('MongoDB bağlantısı başlatılırken hata oluştu; yönetim APIleri kısıtlı olabilir', {
            error: error?.message || String(error)
        });
    }

    // Web UI: in .exe mode process.cwd() can be arbitrary; resolve robustly.
    const publicCandidates = [
        path.join(process.cwd(), 'public'),
        path.join(__dirname, '..', 'public')
    ];
    const fs = require('fs');
    const publicDir = publicCandidates.find((dir) => {
        try {
            return fs.existsSync(dir);
        } catch {
            return false;
        }
    });
    if (publicDir) app.use(express.static(publicDir));

    app.get('/health', (req, res) => res.json({ ok: true }));

    app.use('/', botRoutes);

    app.listen(cfg.PORT, () => {
        logger.info(`Bot sunucusu http://localhost:${cfg.PORT} üzerinde çalışıyor`);
        console.log(`Bot sunucusu http://localhost:${cfg.PORT} uzerinde calisiyor`);
        console.log('Durdurmak icin Ctrl+C basin.');
    });
}

// Terminal prompt gelmesin: stdin açık tutulsun (foreground'da çalışsın)
if (process.stdin.isTTY) {
    process.stdin.resume();
}

start().catch((error) => {
    logger.errorSafe('Sunucu başlatılamadı', error);
    console.error('\n[StartupError]', error);
    waitForEnterInExe();
});
