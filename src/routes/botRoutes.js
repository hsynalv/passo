const express = require('express');
const router = express.Router();
const { startBot } = require('../controllers/botController');

router.post('/start-bot', startBot);

module.exports = router;
