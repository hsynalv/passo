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
  
  // Sepette tutma süresi ayarları (saniye)
  BASKET: {
    // Passo'nun sepette tutma süresi (varsayılan: 10 dakika = 600 saniye)
    HOLDING_TIME_SECONDS: parseInt(process.env.BASKET_HOLDING_TIME_SECONDS || '600', 10),
    // Sepet timeout'undan önce ne kadar süre kala uyarı verilecek (saniye)
    WARNING_BEFORE_TIMEOUT: parseInt(process.env.BASKET_WARNING_BEFORE_TIMEOUT || '60', 10),
    // Sepet timeout'undan önce ne kadar süre kala koltuğu sepetten kaldırılacak (saniye)
    REMOVE_BEFORE_TIMEOUT: parseInt(process.env.BASKET_REMOVE_BEFORE_TIMEOUT || '30', 10),
  },
  
  // Timeout değerleri (milisaniye)
  TIMEOUTS: {
    TURNSTILE_DETECTION: parseInt(process.env.TURNSTILE_DETECTION_TIMEOUT || '7000', 10),
    CLICK_BUY_RETRIES: parseInt(process.env.CLICK_BUY_RETRIES || '12', 10),
    CLICK_BUY_DELAY: parseInt(process.env.CLICK_BUY_DELAY || '400', 10),
    SEAT_SELECTION_MAX: parseInt(process.env.SEAT_SELECTION_MAX_MS || '50000', 10),
    SEAT_PICK_EXACT_MAX: parseInt(process.env.SEAT_PICK_EXACT_MAX_MS || '90000', 10),
    NETWORK_CAPTURE_TIMEOUT: parseInt(process.env.NETWORK_CAPTURE_TIMEOUT || '20000', 10),
    SWAL_CONFIRM_TIMEOUT: parseInt(process.env.SWAL_CONFIRM_TIMEOUT || '10000', 10),
    REMOVE_FROM_CART_TIMEOUT: parseInt(process.env.REMOVE_FROM_CART_TIMEOUT || '15000', 10),
    CATEGORY_SELECTION_RETRIES: parseInt(process.env.CATEGORY_SELECTION_RETRIES || '12', 10),
    BLOCKS_WAIT_TIMEOUT: parseInt(process.env.BLOCKS_WAIT_TIMEOUT || '6000', 10),
    ORDER_LOG_TIMEOUT: parseInt(process.env.ORDER_LOG_TIMEOUT || '15000', 10),
  },
  
  // Delay değerleri (milisaniye)
  DELAYS: {
    TURNSTILE_CHECK: parseInt(process.env.TURNSTILE_CHECK_DELAY || '600', 10),
    AFTER_LOGIN: parseInt(process.env.AFTER_LOGIN_DELAY || '1200', 10),
    AFTER_CONTINUE: parseInt(process.env.AFTER_CONTINUE_DELAY || '800', 10),
    SEAT_SELECTION: parseInt(process.env.SEAT_SELECTION_DELAY || '200', 10),
    CATEGORY_SELECTION: parseInt(process.env.CATEGORY_SELECTION_DELAY || '500', 10),
    CLEANUP_DELAY: parseInt(process.env.CLEANUP_DELAY || '5000', 10),
  }
};

module.exports = cfg;
