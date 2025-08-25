require('dotenv').config();

const cfg = {
  PORT: parseInt(process.env.PORT || '2222', 10),
  PASSO_LOGIN: process.env.PASSO_LOGIN || 'https://www.passo.com.tr/tr/giris',
  PASSO_SITE_KEY: process.env.PASSO_SITE_KEY || '',
  ANTICAPTCHA_KEY: process.env.ANTICAPTCHA_KEY || '',
  CHROME_PATH: process.env.CHROME_PATH || undefined,
  USER_DATA_DIR_A: process.env.USER_DATA_DIR_A || 'C:/passobot/user-data-A',
  USER_DATA_DIR_B: process.env.USER_DATA_DIR_B || 'C:/passobot/user-data-B',
  ORDER_LOG_URL: process.env.ORDER_LOG_URL || null,
};

module.exports = cfg;
