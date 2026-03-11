require('dotenv').config();

const DEFAULTS = {
  PORT: '2222',
  PASSO_LOGIN: 'https://www.passo.com.tr/tr/giris',
  PASSO_SITE_KEY: '0x4AAAAAAA4rK8-JCAhwWhV4',
  ANTICAPTCHA_KEY: '889906595a44af06f21717a07edf34e9',
  CHROME_PATH: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  USER_DATA_DIR_A: 'C:\\passobot\\user-data-A',
  USER_DATA_DIR_B: 'C:\\passobot\\user-data-B',
  ORDER_LOG_URL: 'http://127.0.0.1:8000/api/order-log',
  KEEP_BROWSERS_OPEN: 'false',
  LOG_LEVEL: 'info',
  RATE_LIMIT_WINDOW_MS: '900000',
  RATE_LIMIT_MAX_REQUESTS: '5',
  RATE_LIMIT_WHITELIST: '',
  TURNSTILE_DETECTION_TIMEOUT: '7000',
  CLICK_BUY_RETRIES: '12',
  CLICK_BUY_DELAY: '400',
  SEAT_SELECTION_MAX_MS: '120000',
  SEAT_PICK_EXACT_MAX_MS: '90000',
  NETWORK_CAPTURE_TIMEOUT: '20000',
  SWAL_CONFIRM_TIMEOUT: '10000',
  REMOVE_FROM_CART_TIMEOUT: '15000',
  CATEGORY_SELECTION_RETRIES: '12',
  BLOCKS_WAIT_TIMEOUT: '6000',
  ORDER_LOG_TIMEOUT: '15000',
  TURNSTILE_CHECK_DELAY: '600',
  AFTER_LOGIN_DELAY: '1200',
  AFTER_CONTINUE_DELAY: '800',
  SEAT_SELECTION_DELAY: '200',
  CATEGORY_SELECTION_DELAY: '500',
  CLEANUP_DELAY: '5000',
  EXPERIMENTAL_A_READD_ON_THRESHOLD: '1',
  EXPERIMENTAL_A_READD_THRESHOLD_SECONDS: '480',
  EXPERIMENTAL_A_READD_COOLDOWN_SECONDS: '60',
  BASKET_LOOP_ENABLED: '1',
  BASKET_LOOP_MAX_HOPS: '4',
  MULTI_A_CONCURRENCY: '4',
  MULTI_B_CONCURRENCY: '2',
  MULTI_STAGGER_MS: '3500',
  SEAT_SELECTION_CYCLES: '200',
  SEAT_SNIPE_MAX_MS: '15000',
  SEAT_SNIPE_POLL_MS: '200',
  CATEGORY_ROAM_EVERY_CYCLES: '4'
};

for (const [key, value] of Object.entries(DEFAULTS)) {
  if (typeof process.env[key] === 'undefined' || process.env[key] === '') {
    process.env[key] = String(value);
  }
}

const envOrDefault = (key) => process.env[key] || DEFAULTS[key];

const cfg = {
  PORT: parseInt(envOrDefault('PORT'), 10),
  PASSO_LOGIN: envOrDefault('PASSO_LOGIN'),
  PASSO_SITE_KEY: envOrDefault('PASSO_SITE_KEY'),
  ANTICAPTCHA_KEY: envOrDefault('ANTICAPTCHA_KEY'),
  CHROME_PATH: envOrDefault('CHROME_PATH') || undefined,
  USER_DATA_DIR_A: envOrDefault('USER_DATA_DIR_A'),
  USER_DATA_DIR_B: envOrDefault('USER_DATA_DIR_B'),
  ORDER_LOG_URL: envOrDefault('ORDER_LOG_URL') || null,
  
  // Sepette tutma süresi ayarları (saniye)
  BASKET: {
    // Passo'nun sepette tutma süresi (varsayılan: 10 dakika = 600 saniye)
    HOLDING_TIME_SECONDS: parseInt(process.env.BASKET_HOLDING_TIME_SECONDS || '600', 10),
    // A sepete düştükten sonra koltuğu kaldırmadan önce minimum beklenecek süre (milisaniye)
    REMOVE_MIN_AFTER_BASKET_MS: parseInt(process.env.BASKET_REMOVE_MIN_AFTER_BASKET_MS || '30000', 10),
    // Sepet timeout'undan önce ne kadar süre kala uyarı verilecek (saniye)
    WARNING_BEFORE_TIMEOUT: parseInt(process.env.BASKET_WARNING_BEFORE_TIMEOUT || '60', 10),
    // Sepet timeout'undan önce ne kadar süre kala koltuğu sepetten kaldırılacak (saniye)
    REMOVE_BEFORE_TIMEOUT: parseInt(process.env.BASKET_REMOVE_BEFORE_TIMEOUT || '30', 10),
    EXPERIMENTAL_A_READD_ON_THRESHOLD: String(process.env.EXPERIMENTAL_A_READD_ON_THRESHOLD || '').trim() === '1',
    EXPERIMENTAL_A_READD_THRESHOLD_SECONDS: parseInt(process.env.EXPERIMENTAL_A_READD_THRESHOLD_SECONDS || '90', 10),
    EXPERIMENTAL_A_READD_COOLDOWN_SECONDS: parseInt(process.env.EXPERIMENTAL_A_READD_COOLDOWN_SECONDS || '60', 10),
    LOOP_ENABLED: String(process.env.BASKET_LOOP_ENABLED || '').trim() === '1',
    LOOP_MAX_HOPS: parseInt(process.env.BASKET_LOOP_MAX_HOPS || '12', 10),
  },

  MULTI: {
    A_CONCURRENCY: parseInt(process.env.MULTI_A_CONCURRENCY || '4', 10),
    B_CONCURRENCY: parseInt(process.env.MULTI_B_CONCURRENCY || '2', 10),
    STAGGER_MS: parseInt(process.env.MULTI_STAGGER_MS || '0', 10)
  },
  
  // Timeout değerleri (milisaniye)
  TIMEOUTS: {
    TURNSTILE_DETECTION: parseInt(process.env.TURNSTILE_DETECTION_TIMEOUT || '7000', 10),
    TURNSTILE_SOLVE_TIMEOUT: parseInt(process.env.TURNSTILE_SOLVE_TIMEOUT_MS || '120000', 10),
    TURNSTILE_SOLVE_CONCURRENCY: parseInt(process.env.TURNSTILE_SOLVE_CONCURRENCY || '2', 10),
    TURNSTILE_MAX_ATTEMPTS: parseInt(process.env.TURNSTILE_MAX_ATTEMPTS || '2', 10),
    CLICK_BUY_RETRIES: parseInt(process.env.CLICK_BUY_RETRIES || '12', 10),
    CLICK_BUY_DELAY: parseInt(process.env.CLICK_BUY_DELAY || '400', 10),
    SEAT_SELECTION_MAX: parseInt(process.env.SEAT_SELECTION_MAX_MS || '90000', 10),
    SEAT_PICK_EXACT_MAX: parseInt(process.env.SEAT_PICK_EXACT_MAX_MS || '90000', 10),
    SEAT_SELECTION_CYCLES: parseInt(process.env.SEAT_SELECTION_CYCLES || '60', 10),
    SEAT_WAIT_UNTIL_FOUND: String(process.env.SEAT_WAIT_UNTIL_FOUND || '').trim() === '1',
    SEAT_WAIT_MAX_MINUTES: parseInt(process.env.SEAT_WAIT_MAX_MINUTES || '90', 10),
    SEAT_SNIPE_MAX_MS: parseInt(process.env.SEAT_SNIPE_MAX_MS || '12000', 10),
    SEAT_SNIPE_POLL_MS: parseInt(process.env.SEAT_SNIPE_POLL_MS || '350', 10),
    CATEGORY_ROAM_EVERY_CYCLES: parseInt(process.env.CATEGORY_ROAM_EVERY_CYCLES || '6', 10),
    SVG_CATEGORY_ROAM_MS: parseInt(process.env.SVG_CATEGORY_ROAM_MS || '10000', 10),
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
