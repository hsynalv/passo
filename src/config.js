require('dotenv').config();

const DEFAULTS = {
  PORT: '2222',
  MONGODB_URI: '',
  MONGODB_DB_NAME: 'passobot',
  MONGODB_CONNECT_TIMEOUT_MS: '10000',
  CREDENTIAL_SECRET_KEY: 'passobot-local-dev-secret-change-me',
  PASSO_LOGIN: 'https://www.passo.com.tr/tr/giris',
  TICKETING_API_BASE: 'https://ticketingweb.passo.com.tr',
  PASSO_SITE_KEY: '0x4AAAAAAA4rK8-JCAhwWhV4',
  /** 1 ise /koltuk-secim'de site key DOM'dan gelmezse PASSO_SITE_KEY ile Turnstile çözülür (anahtarı .env'de güncel tutun). */
  PASSO_TURNSTILE_ALLOW_SEAT_FALLBACK: '0',
  CAPTCHA_PROVIDER: 'anticaptcha',
  CAPTCHA_PROVIDER_FALLBACKS: '',
  CAPSOLVER_KEY: '',
  TWOCAPTCHA_KEY: '',
  CAPTCHA_FIRST_POLL_SEC: '2',
  CAPTCHA_POLL_SEC: '1',
  ANTICAPTCHA_KEY: '889906595a44af06f21717a07edf34e9',
  ANTICAPTCHA_FIRST_POLL_SEC: '2',
  ANTICAPTCHA_POLL_SEC: '1',
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
  MULTI_A_CONCURRENCY: '10',
  MULTI_B_CONCURRENCY: '10',
  MULTI_STAGGER_MS: '400',
  SEAT_SELECTION_CYCLES: '200',
  SEAT_SNIPE_MAX_MS: '15000',
  SEAT_SNIPE_POLL_MS: '200',
  CATEGORY_ROAM_EVERY_CYCLES: '4',
  BROWSER_MINIMAL_ARGS: '0',
  BASKET_HOLDING_TIME_SECONDS: '600',
  BASKET_REMOVE_MIN_AFTER_BASKET_MS: '30000',
  BASKET_WARNING_BEFORE_TIMEOUT: '60',
  BASKET_REMOVE_BEFORE_TIMEOUT: '30',
  PASSIVE_SESSION_CHECK_MS: '45000',
  /** 1 ise A sepetteyken B /koltuk-secim beklerken periyodik hafif scroll (idle algısı için deneysel). */
  PASSIVE_SEAT_SCROLL_KEEPALIVE: '0',
  TURNSTILE_SOLVE_TIMEOUT_MS: '120000',
  TURNSTILE_SOLVE_CONCURRENCY: '5',
  TURNSTILE_MAX_ATTEMPTS: '2',
  TURNSTILE_SEAT_SITEKEY_POLL_MS: '12000',
  SEAT_WAIT_UNTIL_FOUND: '0',
  SEAT_WAIT_MAX_MINUTES: '90',
  SVG_CATEGORY_ROAM_MS: '10000'
};

for (const [key, value] of Object.entries(DEFAULTS)) {
  if (typeof process.env[key] === 'undefined' || process.env[key] === '') {
    process.env[key] = String(value);
  }
}

/** Arayüzden düzenlenebilir env anahtarları (whitelist) — yalnızca bilet alım akışı. */
const PANEL_ENV_KEYS = [
  'TURNSTILE_DETECTION_TIMEOUT',
  'CLICK_BUY_RETRIES',
  'CLICK_BUY_DELAY',
  'SEAT_SELECTION_MAX_MS',
  'SEAT_PICK_EXACT_MAX_MS',
  'NETWORK_CAPTURE_TIMEOUT',
  'SWAL_CONFIRM_TIMEOUT',
  'REMOVE_FROM_CART_TIMEOUT',
  'CATEGORY_SELECTION_RETRIES',
  'BLOCKS_WAIT_TIMEOUT',
  'ORDER_LOG_TIMEOUT',
  'TURNSTILE_CHECK_DELAY',
  'AFTER_LOGIN_DELAY',
  'AFTER_CONTINUE_DELAY',
  'SEAT_SELECTION_DELAY',
  'CATEGORY_SELECTION_DELAY',
  'CLEANUP_DELAY',
  'EXPERIMENTAL_A_READD_ON_THRESHOLD',
  'EXPERIMENTAL_A_READD_THRESHOLD_SECONDS',
  'EXPERIMENTAL_A_READD_COOLDOWN_SECONDS',
  'BASKET_LOOP_ENABLED',
  'BASKET_LOOP_MAX_HOPS',
  'MULTI_A_CONCURRENCY',
  'MULTI_B_CONCURRENCY',
  'MULTI_STAGGER_MS',
  'SEAT_SELECTION_CYCLES',
  'SEAT_WAIT_UNTIL_FOUND',
  'SEAT_WAIT_MAX_MINUTES',
  'SEAT_SNIPE_MAX_MS',
  'SEAT_SNIPE_POLL_MS',
  'CATEGORY_ROAM_EVERY_CYCLES',
  'TURNSTILE_SOLVE_CONCURRENCY',
  'PASSIVE_SESSION_CHECK_MS'
];

const PANEL_KEY_SET = new Set(PANEL_ENV_KEYS);

function envOrDefaultFrom(env, key) {
  const v = env[key];
  if (v === undefined || v === '') {
    if (DEFAULTS[key] !== undefined) return String(DEFAULTS[key]);
    return '';
  }
  return String(v);
}

function buildConfigFromEnv(env = process.env) {
  const envOrDefault = (key) => envOrDefaultFrom(env, key);

  const ticketingBase = (env.TICKETING_API_BASE && String(env.TICKETING_API_BASE).trim())
    ? String(env.TICKETING_API_BASE).trim()
    : 'https://ticketingweb.passo.com.tr';

  return {
    PORT: parseInt(envOrDefault('PORT'), 10),
    MONGODB_URI: envOrDefault('MONGODB_URI'),
    MONGODB_DB_NAME: envOrDefault('MONGODB_DB_NAME') || 'passobot',
    MONGODB_CONNECT_TIMEOUT_MS: parseInt(envOrDefault('MONGODB_CONNECT_TIMEOUT_MS') || '10000', 10),
    CREDENTIAL_SECRET_KEY: envOrDefault('CREDENTIAL_SECRET_KEY'),
    PASSO_LOGIN: envOrDefault('PASSO_LOGIN'),
    TICKETING_API_BASE: ticketingBase.replace(/\/$/, ''),
    PASSO_SITE_KEY: envOrDefault('PASSO_SITE_KEY'),
    PASSO_TURNSTILE_ALLOW_SEAT_FALLBACK:
      String(envOrDefault('PASSO_TURNSTILE_ALLOW_SEAT_FALLBACK') || '0').trim() === '1',
    CAPTCHA_PROVIDER: envOrDefault('CAPTCHA_PROVIDER') || 'anticaptcha',
    CAPTCHA_PROVIDER_FALLBACKS: envOrDefault('CAPTCHA_PROVIDER_FALLBACKS') || '',
    CAPSOLVER_KEY: envOrDefault('CAPSOLVER_KEY'),
    TWOCAPTCHA_KEY: envOrDefault('TWOCAPTCHA_KEY'),
    CAPTCHA_FIRST_POLL_SEC: parseFloat(envOrDefault('CAPTCHA_FIRST_POLL_SEC') || envOrDefault('ANTICAPTCHA_FIRST_POLL_SEC') || '2'),
    CAPTCHA_POLL_SEC: parseFloat(envOrDefault('CAPTCHA_POLL_SEC') || envOrDefault('ANTICAPTCHA_POLL_SEC') || '1'),
    ANTICAPTCHA_KEY: envOrDefault('ANTICAPTCHA_KEY'),
    ANTICAPTCHA_FIRST_POLL_SEC: parseFloat(envOrDefault('ANTICAPTCHA_FIRST_POLL_SEC') || '2'),
    ANTICAPTCHA_POLL_SEC: parseFloat(envOrDefault('ANTICAPTCHA_POLL_SEC') || '1'),
    CHROME_PATH: envOrDefault('CHROME_PATH') || undefined,
    USER_DATA_DIR_A: envOrDefault('USER_DATA_DIR_A'),
    USER_DATA_DIR_B: envOrDefault('USER_DATA_DIR_B'),
    ORDER_LOG_URL: envOrDefault('ORDER_LOG_URL') || null,

    BROWSER_WINDOW_SIZE: (env.BROWSER_WINDOW_SIZE && String(env.BROWSER_WINDOW_SIZE).trim())
      ? String(env.BROWSER_WINDOW_SIZE).trim()
      : '1280,720',

    FLAGS: {
      KEEP_BROWSERS_OPEN: String(envOrDefault('KEEP_BROWSERS_OPEN') || '').toLowerCase() === 'true',
      BROWSER_MINIMAL_ARGS: String(envOrDefault('BROWSER_MINIMAL_ARGS') || '').trim() === '1'
    },

    BASKET: {
      HOLDING_TIME_SECONDS: parseInt(env.BASKET_HOLDING_TIME_SECONDS || '600', 10),
      REMOVE_MIN_AFTER_BASKET_MS: parseInt(env.BASKET_REMOVE_MIN_AFTER_BASKET_MS || '30000', 10),
      WARNING_BEFORE_TIMEOUT: parseInt(env.BASKET_WARNING_BEFORE_TIMEOUT || '60', 10),
      REMOVE_BEFORE_TIMEOUT: parseInt(env.BASKET_REMOVE_BEFORE_TIMEOUT || '30', 10),
      EXPERIMENTAL_A_READD_ON_THRESHOLD: String(env.EXPERIMENTAL_A_READD_ON_THRESHOLD || '').trim() === '1',
      EXPERIMENTAL_A_READD_THRESHOLD_SECONDS: parseInt(env.EXPERIMENTAL_A_READD_THRESHOLD_SECONDS || '90', 10),
      EXPERIMENTAL_A_READD_COOLDOWN_SECONDS: parseInt(env.EXPERIMENTAL_A_READD_COOLDOWN_SECONDS || '60', 10),
      LOOP_ENABLED: String(env.BASKET_LOOP_ENABLED || '').trim() === '1',
      LOOP_MAX_HOPS: parseInt(env.BASKET_LOOP_MAX_HOPS || '12', 10),
      PASSIVE_SESSION_CHECK_MS: parseInt(env.PASSIVE_SESSION_CHECK_MS || '45000', 10),
      PASSIVE_SEAT_SCROLL_KEEPALIVE: String(env.PASSIVE_SEAT_SCROLL_KEEPALIVE || '0').trim() === '1'
    },

    MULTI: {
      A_CONCURRENCY: parseInt(env.MULTI_A_CONCURRENCY || '4', 10),
      B_CONCURRENCY: parseInt(env.MULTI_B_CONCURRENCY || '2', 10),
      STAGGER_MS: parseInt(env.MULTI_STAGGER_MS || '0', 10)
    },

    TIMEOUTS: {
      TURNSTILE_DETECTION: parseInt(env.TURNSTILE_DETECTION_TIMEOUT || '7000', 10),
      TURNSTILE_SOLVE_TIMEOUT: parseInt(env.TURNSTILE_SOLVE_TIMEOUT_MS || '120000', 10),
      TURNSTILE_SOLVE_CONCURRENCY: parseInt(env.TURNSTILE_SOLVE_CONCURRENCY || '2', 10),
      TURNSTILE_MAX_ATTEMPTS: parseInt(env.TURNSTILE_MAX_ATTEMPTS || '2', 10),
      TURNSTILE_SEAT_SITEKEY_POLL_MS: parseInt(env.TURNSTILE_SEAT_SITEKEY_POLL_MS || '12000', 10),
      CLICK_BUY_RETRIES: parseInt(env.CLICK_BUY_RETRIES || '12', 10),
      CLICK_BUY_DELAY: parseInt(env.CLICK_BUY_DELAY || '400', 10),
      SEAT_SELECTION_MAX: parseInt(env.SEAT_SELECTION_MAX_MS || '90000', 10),
      SEAT_PICK_EXACT_MAX: parseInt(env.SEAT_PICK_EXACT_MAX_MS || '90000', 10),
      SEAT_SELECTION_CYCLES: parseInt(env.SEAT_SELECTION_CYCLES || '60', 10),
      SEAT_WAIT_UNTIL_FOUND: String(env.SEAT_WAIT_UNTIL_FOUND || '').trim() === '1',
      SEAT_WAIT_MAX_MINUTES: parseInt(env.SEAT_WAIT_MAX_MINUTES || '90', 10),
      SEAT_SNIPE_MAX_MS: parseInt(env.SEAT_SNIPE_MAX_MS || '12000', 10),
      SEAT_SNIPE_POLL_MS: parseInt(env.SEAT_SNIPE_POLL_MS || '350', 10),
      CATEGORY_ROAM_EVERY_CYCLES: parseInt(env.CATEGORY_ROAM_EVERY_CYCLES || '6', 10),
      SVG_CATEGORY_ROAM_MS: parseInt(env.SVG_CATEGORY_ROAM_MS || '10000', 10),
      NETWORK_CAPTURE_TIMEOUT: parseInt(env.NETWORK_CAPTURE_TIMEOUT || '20000', 10),
      SWAL_CONFIRM_TIMEOUT: parseInt(env.SWAL_CONFIRM_TIMEOUT || '10000', 10),
      REMOVE_FROM_CART_TIMEOUT: parseInt(env.REMOVE_FROM_CART_TIMEOUT || '15000', 10),
      CATEGORY_SELECTION_RETRIES: parseInt(env.CATEGORY_SELECTION_RETRIES || '12', 10),
      BLOCKS_WAIT_TIMEOUT: parseInt(env.BLOCKS_WAIT_TIMEOUT || '6000', 10),
      ORDER_LOG_TIMEOUT: parseInt(env.ORDER_LOG_TIMEOUT || '15000', 10)
    },

    DELAYS: {
      TURNSTILE_CHECK: parseInt(env.TURNSTILE_CHECK_DELAY || '600', 10),
      AFTER_LOGIN: parseInt(env.AFTER_LOGIN_DELAY || '1200', 10),
      AFTER_CONTINUE: parseInt(env.AFTER_CONTINUE_DELAY || '800', 10),
      SEAT_SELECTION: parseInt(env.SEAT_SELECTION_DELAY || '200', 10),
      CATEGORY_SELECTION: parseInt(env.CATEGORY_SELECTION_DELAY || '500', 10),
      CLEANUP_DELAY: parseInt(env.CLEANUP_DELAY || '5000', 10)
    }
  };
}

function getPanelDefaultsFlat() {
  const o = {};
  for (const k of PANEL_ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined && v !== '') o[k] = String(v);
    else if (DEFAULTS[k] !== undefined) o[k] = String(DEFAULTS[k]);
    else o[k] = '';
  }
  return o;
}

function pickPanelOverrides(overrides) {
  const out = {};
  if (!overrides || typeof overrides !== 'object') return out;
  for (const [k, v] of Object.entries(overrides)) {
    if (!PANEL_KEY_SET.has(k)) continue;
    if (v === undefined || v === null) continue;
    out[k] = String(v).trim();
  }
  return out;
}

function createRunConfigFromOverrides(overrides) {
  const picked = pickPanelOverrides(overrides);
  const env = { ...process.env };
  for (const [k, v] of Object.entries(picked)) {
    if (v === '') delete env[k];
    else env[k] = v;
  }
  return buildConfigFromEnv(env);
}

const cfg = buildConfigFromEnv(process.env);
cfg.buildConfigFromEnv = buildConfigFromEnv;
cfg.getPanelDefaultsFlat = getPanelDefaultsFlat;
cfg.createRunConfigFromOverrides = createRunConfigFromOverrides;
cfg.pickPanelOverrides = pickPanelOverrides;
cfg.DEFAULTS = DEFAULTS;
cfg.PANEL_ENV_KEYS = PANEL_ENV_KEYS;

module.exports = cfg;
