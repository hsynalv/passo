const express = require('express');
const router = express.Router();
const { startBot } = require('../controllers/botController');
const { botRateLimiter } = require('../middleware/rateLimiter');

router.post('/start-bot', botRateLimiter, startBot);

module.exports = router;
