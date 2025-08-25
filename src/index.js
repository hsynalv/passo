const express = require('express');
const cfg = require('./config');
const botRoutes = require('./routes/botRoutes');

const app = express();
app.use(express.json());
app.use('/', botRoutes);

app.listen(cfg.PORT, ()=> console.log(`✅ Bot sunucusu http://localhost:${cfg.PORT} üzerinde çalışıyor`));

process.on('unhandledRejection', r => console.error('❌ Unhandled Rejection:', r));
