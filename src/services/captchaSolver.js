const axios = require('axios');
const ac = require('@antiadmin/anticaptchaofficial');

const PROVIDER_COOLDOWN_MS = 5 * 60 * 1000;
const providerCooldownUntil = new Map();

function normalizeProviderName(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  if (s === '2captcha' || s === 'two-captcha' || s === 'two_captcha') return '2captcha';
  return s;
}

function buildProviderChain(cfg) {
  const primary = normalizeProviderName(cfg?.CAPTCHA_PROVIDER || 'anticaptcha') || 'anticaptcha';
  const fallbackRaw = String(cfg?.CAPTCHA_PROVIDER_FALLBACKS || '')
    .split(',')
    .map((x) => normalizeProviderName(x))
    .filter(Boolean);
  return Array.from(new Set([primary, ...fallbackRaw]));
}

function nowMs() {
  return Date.now();
}

function getProviderCooldownUntil(provider) {
  const until = Number(providerCooldownUntil.get(provider) || 0);
  return Number.isFinite(until) ? until : 0;
}

function isProviderCoolingDown(provider) {
  return getProviderCooldownUntil(provider) > nowMs();
}

function setProviderCooldown(provider, ms = PROVIDER_COOLDOWN_MS) {
  const ttl = Math.max(5000, Number(ms) || PROVIDER_COOLDOWN_MS);
  providerCooldownUntil.set(provider, nowMs() + ttl);
}

function classifyProviderError(message) {
  const m = String(message || '').toLowerCase();
  if (!m) return { cooldown: false };
  if (m.includes('_key_missing')) return { cooldown: true, reason: 'key_missing' };
  if (m.includes('status code 401')) return { cooldown: true, reason: 'unauthorized' };
  if (m.includes('error_key_does_not_exist') || m.includes('error wrong user key') || m.includes('invalid key')) {
    return { cooldown: true, reason: 'invalid_key' };
  }
  return { cooldown: false };
}

function buildEffectiveProviderChain(cfg) {
  const chain = buildProviderChain(cfg);
  const active = chain.filter((provider) => !isProviderCoolingDown(provider));
  if (active.length > 0) return { chain: active, skipped: chain.filter((x) => !active.includes(x)) };
  return { chain, skipped: [] };
}

function getPollConfig(cfg) {
  const first = Number(cfg?.CAPTCHA_FIRST_POLL_SEC ?? cfg?.ANTICAPTCHA_FIRST_POLL_SEC ?? 2);
  const normal = Number(cfg?.CAPTCHA_POLL_SEC ?? cfg?.ANTICAPTCHA_POLL_SEC ?? 1);
  return {
    firstSec: Number.isFinite(first) && first > 0 ? first : 2,
    normalSec: Number.isFinite(normal) && normal > 0 ? normal : 1
  };
}

function hasCredentialsForProvider(provider, cfg) {
  if (provider === 'anticaptcha') return !!String(cfg?.ANTICAPTCHA_KEY || '').trim();
  if (provider === 'capsolver') return !!String(cfg?.CAPSOLVER_KEY || '').trim();
  if (provider === '2captcha') return !!String(cfg?.TWOCAPTCHA_KEY || '').trim();
  return false;
}

function hasCaptchaSolverCredentials(cfg) {
  const chain = buildProviderChain(cfg);
  return chain.some((provider) => hasCredentialsForProvider(provider, cfg));
}

function configureAnticaptcha(cfg) {
  ac.setAPIKey(String(cfg?.ANTICAPTCHA_KEY || '').trim());
  try {
    if (typeof ac.settings === 'object' && ac.settings) {
      const p = getPollConfig(cfg);
      ac.settings.firstAttemptWaitingInterval = p.firstSec;
      ac.settings.normalWaitingInterval = p.normalSec;
    }
  } catch {}
}

async function capsolverCreateTask(clientKey, task) {
  const { data } = await axios.post('https://api.capsolver.com/createTask', { clientKey, task }, { timeout: 15000 });
  if (data?.errorId) {
    throw new Error(`CAPSOLVER_CREATE_TASK_FAILED_${data?.errorCode || 'UNKNOWN'}`);
  }
  if (!data?.taskId) throw new Error('CAPSOLVER_CREATE_TASK_NO_TASK_ID');
  return String(data.taskId);
}

async function capsolverWaitResult(clientKey, taskId, cfg) {
  const poll = getPollConfig(cfg);
  await delaySeconds(poll.firstSec);
  while (true) {
    const { data } = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey, taskId }, { timeout: 15000 });
    if (data?.errorId) {
      throw new Error(`CAPSOLVER_RESULT_FAILED_${data?.errorCode || 'UNKNOWN'}`);
    }
    if (data?.status === 'ready') {
      const token = data?.solution?.token || data?.solution?.gRecaptchaResponse || null;
      if (!token) throw new Error('CAPSOLVER_RESULT_READY_NO_TOKEN');
      return String(token);
    }
    if (data?.status !== 'processing') {
      throw new Error(`CAPSOLVER_RESULT_UNEXPECTED_STATUS_${String(data?.status || 'unknown')}`);
    }
    await delaySeconds(poll.normalSec);
  }
}

async function twoCaptchaCreate({ method, key, pageUrl, siteKey, invisible }) {
  const params = {
    key,
    method,
    json: 1,
    pageurl: String(pageUrl || ''),
    ...(method === 'turnstile' ? { sitekey: String(siteKey || '') } : { googlekey: String(siteKey || '') })
  };
  if (method === 'userrecaptcha' && invisible === true) params.invisible = 1;
  const { data } = await axios.get('https://2captcha.com/in.php', { params, timeout: 15000 });
  if (Number(data?.status) !== 1 || !data?.request) {
    throw new Error(`TWOCAPTCHA_CREATE_FAILED_${String(data?.request || 'UNKNOWN')}`);
  }
  return String(data.request);
}

async function twoCaptchaWaitResult({ key, requestId, cfg }) {
  const poll = getPollConfig(cfg);
  await delaySeconds(poll.firstSec);
  while (true) {
    const { data } = await axios.get('https://2captcha.com/res.php', {
      params: { key, action: 'get', id: requestId, json: 1 },
      timeout: 15000
    });
    if (Number(data?.status) === 1 && data?.request) return String(data.request);
    const req = String(data?.request || '');
    if (req === 'CAPCHA_NOT_READY') {
      await delaySeconds(poll.normalSec);
      continue;
    }
    throw new Error(`TWOCAPTCHA_RESULT_FAILED_${req || 'UNKNOWN'}`);
  }
}

function delaySeconds(sec) {
  const ms = Math.max(0, Number(sec) || 0) * 1000;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function solveTurnstileWithProvider(provider, { url, siteKey, cfg }) {
  if (provider === 'anticaptcha') {
    if (!hasCredentialsForProvider(provider, cfg)) throw new Error('ANTICAPTCHA_KEY_MISSING');
    configureAnticaptcha(cfg);
    const token = await ac.solveTurnstileProxyless(String(url), String(siteKey));
    return String(token || '');
  }
  if (provider === 'capsolver') {
    const key = String(cfg?.CAPSOLVER_KEY || '').trim();
    if (!key) throw new Error('CAPSOLVER_KEY_MISSING');
    const taskId = await capsolverCreateTask(key, {
      type: 'AntiTurnstileTaskProxyLess',
      websiteURL: String(url),
      websiteKey: String(siteKey)
    });
    return await capsolverWaitResult(key, taskId, cfg);
  }
  if (provider === '2captcha') {
    const key = String(cfg?.TWOCAPTCHA_KEY || '').trim();
    if (!key) throw new Error('TWOCAPTCHA_KEY_MISSING');
    const reqId = await twoCaptchaCreate({
      method: 'turnstile',
      key,
      pageUrl: String(url),
      siteKey: String(siteKey)
    });
    return await twoCaptchaWaitResult({ key, requestId: reqId, cfg });
  }
  throw new Error(`CAPTCHA_PROVIDER_UNSUPPORTED_${provider}`);
}

async function solveRecaptchaV2WithProvider(provider, { url, siteKey, invisible, cfg }) {
  if (provider === 'anticaptcha') {
    if (!hasCredentialsForProvider(provider, cfg)) throw new Error('ANTICAPTCHA_KEY_MISSING');
    configureAnticaptcha(cfg);
    const token = await ac.solveRecaptchaV2Proxyless(String(url), String(siteKey), !!invisible);
    return String(token || '');
  }
  if (provider === 'capsolver') {
    const key = String(cfg?.CAPSOLVER_KEY || '').trim();
    if (!key) throw new Error('CAPSOLVER_KEY_MISSING');
    const taskId = await capsolverCreateTask(key, {
      type: 'ReCaptchaV2TaskProxyLess',
      websiteURL: String(url),
      websiteKey: String(siteKey),
      isInvisible: !!invisible
    });
    return await capsolverWaitResult(key, taskId, cfg);
  }
  if (provider === '2captcha') {
    const key = String(cfg?.TWOCAPTCHA_KEY || '').trim();
    if (!key) throw new Error('TWOCAPTCHA_KEY_MISSING');
    const reqId = await twoCaptchaCreate({
      method: 'userrecaptcha',
      key,
      pageUrl: String(url),
      siteKey: String(siteKey),
      invisible: !!invisible
    });
    return await twoCaptchaWaitResult({ key, requestId: reqId, cfg });
  }
  throw new Error(`CAPTCHA_PROVIDER_UNSUPPORTED_${provider}`);
}

async function solveWithChain(chain, solveOneFn) {
  const errors = [];
  for (const provider of chain) {
    try {
      const token = await solveOneFn(provider);
      if (!token) throw new Error('EMPTY_TOKEN');
      if (providerCooldownUntil.has(provider)) providerCooldownUntil.delete(provider);
      return { token: String(token), provider };
    } catch (e) {
      const errMsg = e?.message || String(e);
      const cls = classifyProviderError(errMsg);
      if (cls.cooldown) setProviderCooldown(provider);
      errors.push({ provider, error: errMsg, cooldown: !!cls.cooldown, reason: cls.reason || '' });
    }
  }
  const detail = errors.map((x) => `${x.provider}:${x.error}${x.cooldown ? ':cooldown' : ''}`).join(' | ');
  throw new Error(`CAPTCHA_SOLVE_ALL_PROVIDERS_FAILED ${detail}`);
}

async function solveTurnstileProxyless({ url, siteKey, cfg }) {
  const effective = buildEffectiveProviderChain(cfg);
  return await solveWithChain(effective.chain, async (provider) => solveTurnstileWithProvider(provider, { url, siteKey, cfg }));
}

async function solveRecaptchaV2Proxyless({ url, siteKey, invisible, cfg }) {
  const effective = buildEffectiveProviderChain(cfg);
  return await solveWithChain(effective.chain, async (provider) => solveRecaptchaV2WithProvider(provider, { url, siteKey, invisible, cfg }));
}

module.exports = {
  buildProviderChain,
  hasCaptchaSolverCredentials,
  solveTurnstileProxyless,
  solveRecaptchaV2Proxyless
};
