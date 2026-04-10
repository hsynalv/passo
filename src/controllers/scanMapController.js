const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { ZodError } = require('zod');
const rebrowserPuppeteer = require('rebrowser-puppeteer-core');
const cfg = require('../config');
const categoryRepo = require('../repositories/categoryRepository');
const credentialRepo = require('../repositories/credentialRepository');
const proxyRepo = require('../repositories/proxyRepository');
const scanMapRepo = require('../repositories/scanMapRepository');
const teamRepo = require('../repositories/teamRepository');
const { gotoWithRetry, openSeatMapStrict } = require('../helpers/page');
const { decryptSecret } = require('../utils/credentialCrypto');
const { launchAndLogin, unregisterPassobotBrowser } = require('./botController');
const logger = require('../utils/logger');
const {
  isSoftProxyLoginFailure,
  shouldRetryLoginWithAnotherPoolProxy
} = require('../utils/proxyLoginFailure');
const {
  scanMapClearSchema,
  scanMapQuerySchema,
  scanMapSaveAsCategoriesSchema,
  scanMapScanRequestSchema,
  scanMapSetDefaultSchema,
} = require('../validators/management');

const liveScanRuns = new Map();
const LIVE_SCAN_MAX_LOGS = 400;
const LIVE_SCAN_LOG_DIR = path.join(process.cwd(), 'logs', 'scan-map-live');
const LIVE_RUN_MAP_TTL_MS = 3 * 60 * 1000;

function scheduleLiveRunMapEviction(runId) {
  const rid = String(runId || '').trim();
  if (!rid) return;
  setTimeout(() => {
    try {
      liveScanRuns.delete(rid);
    } catch {}
  }, LIVE_RUN_MAP_TTL_MS);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeProxyHostForLaunch(host, protocol = 'socks5') {
  const h = String(host || '').trim();
  if (!h) return '';
  if (/^[a-z]+:\/\//i.test(h)) return h;
  const p = String(protocol || 'socks5').trim().toLowerCase() || 'socks5';
  return `${p}://${h}`;
}

function createLiveScanRun(payload = {}) {
  const runId = randomUUID();
  const run = {
    runId,
    status: 'running',
    payload,
    logs: [],
    result: null,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  liveScanRuns.set(runId, run);
  return run;
}

function ensureLiveScanLogDir() {
  try {
    if (!fs.existsSync(LIVE_SCAN_LOG_DIR)) fs.mkdirSync(LIVE_SCAN_LOG_DIR, { recursive: true });
  } catch {}
}

function safeRunLogName(runId) {
  return String(runId || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'scan-run';
}

function writeRunLogFile(run, entry) {
  try {
    if (!run?.runId || !entry) return;
    ensureLiveScanLogDir();
    const filePath = path.join(LIVE_SCAN_LOG_DIR, `${safeRunLogName(run.runId)}.log`);
    const line = JSON.stringify(entry);
    fs.appendFile(filePath, `${line}\n`, () => {});
    run.logFilePath = filePath;
  } catch {}
}

function appendLiveScanLog(run, message, meta = null, level = 'info') {
  if (!run) return;
  const entry = {
    at: nowIso(),
    level,
    message: String(message || ''),
    meta: meta && typeof meta === 'object' ? meta : {},
  };
  run.logs.push(entry);
  if (run.logs.length > LIVE_SCAN_MAX_LOGS) {
    run.logs.splice(0, run.logs.length - LIVE_SCAN_MAX_LOGS);
  }
  run.updatedAt = nowIso();
  writeRunLogFile(run, entry);
  try {
    const method = level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'info');
    logger[method](`[scan-map-live] ${entry.message}`, { runId: run.runId, ...entry.meta });
  } catch {}
  scanMapRepo.appendLiveScanLog(run.runId, entry).catch(() => {});
}

function publicRun(run) {
  if (!run) return null;
  return {
    runId: run.runId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    logs: Array.isArray(run.logs) ? run.logs.slice(-200) : [],
    result: run.result || null,
    error: run.error || null,
    logFilePath: run.logFilePath || null,
  };
}

function handleError(res, error) {
  if (error instanceof ZodError) {
    return res.status(400).json({
      success: false,
      error: 'VALIDATION_ERROR',
      details: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  if (error?.message === 'MONGODB_NOT_CONNECTED') {
    return res.status(503).json({ success: false, error: 'MongoDB bağlantısı hazır değil' });
  }
  return res.status(500).json({ success: false, error: error?.message || String(error) });
}

async function ensureTeam(req, res, teamId) {
  const team = await teamRepo.getTeamById(teamId);
  if (!team) {
    res.status(404).json({ success: false, error: 'Takım bulunamadı' });
    return null;
  }
  return team;
}

function resolveBrowserExecutablePath() {
  const preferred = String(cfg.CHROME_PATH || '').trim();
  const candidates = [
    preferred,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const candidate of candidates.filter(Boolean)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

function normalizeSeatUrl(eventAddress) {
  const raw = String(eventAddress || '').trim();
  if (!raw) return '';
  if (/\/koltuk-secim(\b|\/|\?|#)/i.test(raw)) return raw;
  return `${raw.replace(/\/+$/, '')}/koltuk-secim`;
}

function deriveCategoryLabel(tooltipText = '', fallback = '') {
  const t = String(tooltipText || '').replace(/\s+/g, ' ').trim();
  if (!t) return String(fallback || '').trim();
  const m = t.match(/^(.+?)\s*₺/);
  if (m && String(m[1] || '').trim()) return String(m[1]).trim();
  const m2 = t.match(/^(.+?)\s*tl\b/i);
  if (m2 && String(m2[1] || '').trim()) return String(m2[1]).trim();
  return t.split(' ').slice(0, 2).join(' ').trim();
}

async function collectBlocksFromPage(page, { maxProbe = 30, categoryHints = [] } = {}) {
  const traceLog = (typeof categoryHints?.__traceLog === 'function') ? categoryHints.__traceLog : null;
  if (traceLog) traceLog('SVG layout bekleniyor...', { maxProbe });
  await page.waitForSelector('svg.svgLayout, .svgLayout', { timeout: 25000 });

  const blockIds = await page.evaluate((limit) => {
    const ids = Array.from(document.querySelectorAll('svg.svgLayout g[id], svg.svgLayout .svgBlock[id], .svgLayout g[id], .svgLayout .svgBlock[id]'))
      .map((el) => String(el.getAttribute('id') || el.id || '').trim())
      .filter((id) => id && /^block/i.test(id));
    return Array.from(new Set(ids)).slice(0, Math.max(1, Number(limit) || 30));
  }, maxProbe).catch(() => []);
  if (traceLog) traceLog('Block ID listesi çıkarıldı', { count: blockIds.length });

  const out = [];
  for (const blockId of blockIds) {
    const point = await page.evaluate((id) => {
      const el = document.getElementById(String(id || ''));
      if (!el) return null;
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
      const r = el.getBoundingClientRect();
      if (!r || !r.width || !r.height) return null;
      return {
        x: r.left + (r.width / 2),
        y: r.top + (r.height / 2),
      };
    }, blockId).catch(() => null);

    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;

    try { await page.mouse.move(point.x, point.y, { steps: 8 }); } catch {}
    await page.evaluate((x, y) => {
      const hit = document.elementFromPoint(x, y);
      const target = hit?.closest('g.block, .svgBlock, [id^="block"]') || hit;
      if (!target) return;
      const fire = (el, type) => {
        try {
          const ev = new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y });
          el.dispatchEvent(ev);
        } catch {}
      };
      fire(target, 'mouseover');
      fire(target, 'mousemove');
    }, point.x, point.y).catch(() => {});
    await new Promise((res) => setTimeout(res, 90));

    const tooltipText = await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect?.();
        if (!r || r.width < 2 || r.height < 2) return false;
        const st = window.getComputedStyle(el);
        if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
        return true;
      };
      const selectors = ['#toolTipList', '[role="tooltip"]', '[id*="tooltip" i]', '[class*="tooltip" i]', '[class*="popover" i]', '.tippy-box', '.tooltip-inner'];
      const texts = [];
      for (const sel of selectors) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          if (!isVisible(el)) continue;
          const t = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          if (t) texts.push(t);
        }
      }
      texts.sort((a, b) => b.length - a.length);
      return texts[0] || '';
    }).catch(() => '');

    const categoryLabel = deriveCategoryLabel(tooltipText, categoryHints[0] || '');
    const confidence = tooltipText ? 78 : 22;
    if (traceLog) traceLog('Block probe tamam', { blockId, hasTooltip: !!tooltipText, confidence });
    out.push({
      categoryLabel,
      tooltipText,
      legendTitle: '',
      blockId,
      confidence,
      scoreMeta: {
        source: 'tooltip_probe',
        hasTooltip: !!tooltipText,
      },
      isDefault: false,
      isActive: true,
    });
  }
  return out;
}

async function ensureSeatMapReadyForScan(page, eventAddress) {
  const traceLog = arguments[2] && typeof arguments[2] === 'function' ? arguments[2] : null;
  const eventUrl = String(eventAddress || '').trim();
  const seatUrl = normalizeSeatUrl(eventAddress);
  if (!seatUrl) throw new Error('SCAN_EVENT_URL_REQUIRED');
  if (traceLog) traceLog('Seat map hazırlığı başladı', { eventUrl, seatUrl });

  const tryClickBuyOnEventPage = async () => {
    const clicked = await page.evaluate(() => {
      const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
      const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
      const cand = nodes.find((el) => {
        const t = norm(el.innerText || el.textContent || el.value || '');
        if (!t) return false;
        return (
          t.includes('bilet al') ||
          t.includes('satın al') ||
          t.includes('satin al') ||
          t.includes('hemen al') ||
          t.includes('devam et')
        );
      });
      if (!cand) return false;
      try { cand.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
      try { cand.click(); return true; } catch { return false; }
    }).catch(() => false);
    if (clicked) {
      await new Promise((res) => setTimeout(res, 900));
    }
    return !!clicked;
  };

  if (eventUrl) {
    if (traceLog) traceLog('Event sayfasına gidiliyor', { eventUrl });
    await gotoWithRetry(page, eventUrl, {
      retries: 2,
      waitUntil: 'domcontentloaded',
      backoffMs: 550,
    }).catch(() => null);
  }

  if (traceLog) traceLog('Koltuk seçim URL çağrılıyor', { seatUrl });
  await gotoWithRetry(page, seatUrl, {
    retries: 2,
    waitUntil: 'domcontentloaded',
    expectedUrlIncludes: '/koltuk-secim',
    backoffMs: 650,
  }).catch(() => null);

  const cur = (() => {
    try { return String(page.url() || ''); } catch { return ''; }
  })();
  if (traceLog) traceLog('Koltuk seçim URL sonrası durum', { currentUrl: cur });
  if (!/\/koltuk-secim(\b|\/|\?|#)/i.test(cur)) {
    if (traceLog) traceLog('Koltuk seçimde değil, event sayfasında satın al tıklaması deneniyor', { currentUrl: cur }, 'warn');
    await tryClickBuyOnEventPage().catch(() => false);
    await gotoWithRetry(page, seatUrl, {
      retries: 2,
      waitUntil: 'domcontentloaded',
      expectedUrlIncludes: '/koltuk-secim',
      backoffMs: 700,
    });
  }

  if (traceLog) traceLog('openSeatMapStrict çağrılıyor...');
  const seatMapOpened = await openSeatMapStrict(page).catch(() => false);
  if (!seatMapOpened) {
    const svgAlreadyReady = await page.evaluate(() => {
      const root = document.querySelector('svg.svgLayout, .svgLayout, svg.seatmap-svg, #seatmap');
      if (!root) return false;
      try {
        const seatNodes = document.querySelectorAll('svg.svgLayout g[id^="block" i], svg.svgLayout .svgBlock[id], .svgLayout g[id^="block" i], .svgLayout .svgBlock[id], svg.seatmap-svg g[id], #seatmap g[id]');
        if (seatNodes.length > 0) return true;
      } catch {}
      try {
        const r = root.getBoundingClientRect();
        return !!(r && r.width > 80 && r.height > 80);
      } catch {
        return true;
      }
    }).catch(() => false);
    if (svgAlreadyReady) {
      if (traceLog) traceLog('openSeatMapStrict false döndü ama SVG zaten mevcut, taramaya devam ediliyor', null, 'warn');
    } else {
      if (traceLog) traceLog('Seat map açılamadı', { currentUrl: (() => { try { return String(page.url() || ''); } catch { return ''; } })() }, 'error');
      throw new Error('SCAN_SEATMAP_NOT_READY');
    }
  }
  if (traceLog) traceLog('Seat map açıldı, SVG bekleniyor...');
  await page.waitForSelector('svg.svgLayout, .svgLayout', { timeout: 30000 });
  if (traceLog) traceLog('Seat map SVG hazır');
}

async function loginPasso(page, email, password) {
  const gotoPrimary = await gotoWithRetry(page, cfg.PASSO_LOGIN, {
    retries: 2,
    waitUntil: 'domcontentloaded',
    expectedUrlIncludes: '/giris',
    timeoutMs: 45000,
    backoffMs: 500,
  });
  if (!gotoPrimary?.ok) {
    await gotoWithRetry(page, cfg.PASSO_LOGIN, {
      retries: 1,
      waitUntil: 'networkidle2',
      expectedUrlIncludes: '/giris',
      timeoutMs: 60000,
      backoffMs: 550,
    }).catch(() => null);
  }

  await page.evaluate(() => {
    const cookies = document.querySelector('button#onetrust-accept-btn-handler, button[aria-label*="Accept"], .cookie-accept');
    if (cookies) {
      try { cookies.click(); } catch {}
    }
  }).catch(() => {});

  const userSel = 'input[autocomplete="username"], input[type="email"], input[type="text"][placeholder*="E-Posta"], input[name*="email"], input[name*="user"], input[id*="user"], input[id*="email"]';
  const passSel = 'input[autocomplete="current-password"], input[type="password"], input[name*="pass"], input[id*="pass"]';

  const findLoginContext = async () => {
    const directUser = await page.$(userSel).catch(() => null);
    const directPass = await page.$(passSel).catch(() => null);
    if (directUser && directPass) return { frame: null, userEl: directUser, passEl: directPass };
    const frames = (() => { try { return page.frames(); } catch { return []; } })();
    for (const fr of frames) {
      if (!fr || fr === page.mainFrame()) continue;
      const u = await fr.$(userSel).catch(() => null);
      const p = await fr.$(passSel).catch(() => null);
      if (u && p) return { frame: fr, userEl: u, passEl: p };
    }
    return null;
  };

  const tryRevealLoginForm = async () => {
    if (await findLoginContext()) return true;
    await page.evaluate(() => {
      const norm = (s) => (s || '').toString().trim().toLowerCase();
      const btns = document.querySelectorAll('a, button, [role="button"], [role="link"], [onclick], [data-testid], [class*="login" i], [id*="login" i]');
      for (const x of btns) {
        const t = norm(x.innerText || x.textContent || '');
        const href = norm(x.getAttribute?.('href') || '');
        if (
          t.includes('giriş') ||
          t.includes('giris') ||
          t.includes('üye girişi') ||
          t.includes('uye girisi') ||
          t === 'giriş yap' ||
          t === 'giris yap' ||
          href.includes('/tr/giris') ||
          href.includes('/giris') ||
          href.includes('uye-girisi')
        ) {
          try { x.click(); return; } catch {}
        }
      }
    }).catch(() => {});
    await new Promise((res) => setTimeout(res, 1600));
    return !!await findLoginContext();
  };

  const ensureLoginFormWithReload = async () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const ctx = await findLoginContext();
      if (ctx) return ctx;
      await tryRevealLoginForm().catch(() => false);
      const afterReveal = await findLoginContext();
      if (afterReveal) return afterReveal;
      await gotoWithRetry(page, `${cfg.PASSO_LOGIN}${cfg.PASSO_LOGIN.includes('?') ? '&' : '?'}scan_retry=${Date.now()}`, {
        retries: 1,
        waitUntil: 'networkidle2',
        expectedUrlIncludes: '/giris',
        timeoutMs: 60000,
        backoffMs: 450,
      }).catch(() => null);
      await new Promise((res) => setTimeout(res, 450 * attempt));
    }
    return null;
  };

  const loginCtx = await ensureLoginFormWithReload();
  if (!loginCtx?.userEl || !loginCtx?.passEl) {
    throw new Error('LOGIN_FORM_NOT_FOUND');
  }

  await loginCtx.userEl.click({ clickCount: 3 }).catch(() => {});
  await loginCtx.userEl.type(String(email || ''), { delay: 20 }).catch(() => {});
  await loginCtx.userEl.evaluate((node) => { node.dispatchEvent(new Event('blur', { bubbles: true })); }).catch(() => {});

  await loginCtx.passEl.click({ clickCount: 3 }).catch(() => {});
  await loginCtx.passEl.type(String(password || ''), { delay: 20 }).catch(() => {});
  await loginCtx.passEl.evaluate((node) => { node.dispatchEvent(new Event('blur', { bubbles: true })); }).catch(() => {});
  await new Promise((res) => setTimeout(res, 450));

  const submitClicked = await (loginCtx.frame || page).evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const btns = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
    const cand = btns.find((b) => {
      const t = norm(b.innerText || b.textContent || b.value || '');
      return t.includes('giriş') || t.includes('login') || t.includes('oturum aç');
    });
    if (cand) {
      try { cand.click(); } catch {}
      return true;
    }
    return false;
  }).catch(() => {});

  if (!submitClicked) {
    await loginCtx.passEl.press('Enter').catch(() => {});
  }

  await Promise.race([
    page.waitForFunction(() => !/\/giris(\b|\/|\?|#)/i.test(String(location.pathname || '')), { timeout: 90000 }),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => null),
  ]).catch(() => {});
}

async function pickRandomTeamCredential(teamId) {
  const list = await credentialRepo.listCredentialsByTeam(teamId, { includeInactive: false });
  const usable = list.filter((item) => String(item.encryptedPassword || '').trim() && String(item.email || '').trim());
  if (!usable.length) return null;
  const idx = Math.floor(Math.random() * usable.length);
  const selected = usable[idx];
  const password = decryptSecret(selected.encryptedPassword);
  return {
    id: selected.id,
    email: selected.email,
    password,
  };
}

async function scanBlocksViaTooltip({ eventAddress, maxProbe = 30, categoryHints = [] }) {
  const executablePath = resolveBrowserExecutablePath();
  if (!executablePath) {
    throw new Error('SCAN_BROWSER_NOT_FOUND: CHROME_PATH veya tarayıcı kurulumu bulunamadı');
  }

  const seatUrl = normalizeSeatUrl(eventAddress);
  if (!seatUrl) throw new Error('SCAN_EVENT_URL_REQUIRED');

  const browser = await rebrowserPuppeteer.launch({
    headless: true,
    executablePath,
    defaultViewport: { width: 1366, height: 900 },
    args: ['--window-size=1366,900', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await ensureSeatMapReadyForScan(page, eventAddress);
    return collectBlocksFromPage(page, { maxProbe, categoryHints });
  } finally {
    try { await browser.close(); } catch {}
  }
}

async function scanBlocksLive(req, res) {
  try {
    const payload = scanMapScanRequestSchema.parse(req.body || {});
    const team = await ensureTeam(req, res, payload.teamId);
    if (!team) return null;
    const run = createLiveScanRun({
      teamId: payload.teamId,
      eventAddress: payload.eventAddress,
      scopeType: payload.scopeType,
      maxProbe: payload.maxProbe,
      useProxy: payload.useProxy !== false,
    });
    await scanMapRepo.upsertLiveScanRun(run).catch(() => null);
    appendLiveScanLog(run, 'Canlı scan run başlatıldı', {
      teamId: payload.teamId,
      eventAddress: payload.eventAddress,
      maxProbe: payload.maxProbe,
    });

    (async () => {
      let browser = null;
      let liveProfileDir = null;
      let activeProxy = null;
      let loginSucceeded = false;
      const useProxy = payload.useProxy !== false;
      try {
        appendLiveScanLog(run, 'Rastgele takım hesabı seçiliyor...');
        const credential = await pickRandomTeamCredential(payload.teamId);
        if (!credential) {
          throw new Error('Takım için aktif ve şifreli üyelik bulunamadı');
        }
        appendLiveScanLog(run, 'Hesap seçildi', { email: credential.email, credentialId: credential.id });

        const seatUrl = normalizeSeatUrl(payload.eventAddress);
        if (!seatUrl) throw new Error('SCAN_EVENT_URL_REQUIRED');

        liveProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passo-scan-live-'));
        appendLiveScanLog(run, 'Tarayıcı açılıyor (ana bot akışı)...', { profileDir: liveProfileDir });
        appendLiveScanLog(run, 'Passo login + turnstile/captcha çözüm adımları başlatıldı...');

        const maxProxyAttempts = Math.max(
          1,
          Math.min(8, Number(cfg.TIMEOUTS?.PROXY_POOL_LOGIN_MAX_ATTEMPTS) || 3)
        );
        let loginRet = null;

        if (useProxy) {
          let lastLoginErr = null;
          for (let proxyAttempt = 1; proxyAttempt <= maxProxyAttempts; proxyAttempt++) {
            activeProxy = await proxyRepo.acquireNextActiveProxy();
            if (!activeProxy) {
              throw new Error('Aktif proxy bulunamadı (scan map canlı akışı için proxy açık).');
            }
            appendLiveScanLog(run, 'Proxy seçildi', {
              proxyId: activeProxy.id,
              proxy: `${activeProxy.host}:${activeProxy.port}`,
              protocol: activeProxy.protocol,
              proxyAttempt,
              maxProxyAttempts
            });
            try {
              loginRet = await launchAndLogin({
                runId: run.runId,
                email: credential.email,
                password: credential.password,
                userDataDir: liveProfileDir,
                proxyHost: normalizeProxyHostForLaunch(activeProxy.host, activeProxy.protocol || 'socks5'),
                proxyPort: activeProxy.port,
                proxyUsername: activeProxy.username || '',
                proxyPassword: activeProxy.password || ''
              });
              loginSucceeded = true;
              if (activeProxy.id) {
                await proxyRepo.markLoginSuccess(activeProxy.id).catch(() => null);
              }
              break;
            } catch (e) {
              lastLoginErr = e;
              if (activeProxy.id) {
                await proxyRepo.markLoginFailure(activeProxy.id, {
                  threshold: 3,
                  reason: e?.message || 'scan_live_login_failed',
                  soft: isSoftProxyLoginFailure(e?.message)
                }).catch(() => null);
              }
              const retry =
                shouldRetryLoginWithAnotherPoolProxy(e?.message) && proxyAttempt < maxProxyAttempts;
              if (retry) {
                appendLiveScanLog(
                  run,
                  'Proxy ile giriş başarısız; tarayıcı kapatıldı, farklı proxy deneniyor',
                  { proxyAttempt, reason: e?.message || String(e) },
                  'warn'
                );
                continue;
              }
              throw e;
            }
          }
          if (!loginSucceeded) throw lastLoginErr || new Error('SCAN_LIVE_LOGIN_FAILED');
        } else {
          appendLiveScanLog(run, 'Proxy kullanımı kapalı, doğrudan bağlantı deneniyor', null, 'warn');
          loginRet = await launchAndLogin({
            runId: run.runId,
            email: credential.email,
            password: credential.password,
            userDataDir: liveProfileDir
          });
          loginSucceeded = true;
        }
        browser = loginRet?.browser || null;
        const page = loginRet?.page || (browser ? await browser.newPage() : null);
        if (!browser || !page) throw new Error('SCAN_LOGIN_BROWSER_PAGE_NOT_READY');
        appendLiveScanLog(run, 'Login adımı tamamlandı, evente gidiliyor ve koltuk haritası açılıyor...');
        await ensureSeatMapReadyForScan(page, payload.eventAddress, (m, meta, level) => appendLiveScanLog(run, m, meta, level));

        appendLiveScanLog(run, 'Koltuk seçim/SVG harita hazır, block taraması başladı...');
        const items = await collectBlocksFromPage(page, {
          maxProbe: payload.maxProbe,
          categoryHints: Object.assign([], payload.categoryHints || [], { __traceLog: (m, mm, lv) => appendLiveScanLog(run, m, mm, lv) }),
        });

        run.status = 'completed';
        run.result = {
          count: items.length,
          items,
          login: {
            credentialId: credential.id,
            email: credential.email,
            proxyId: activeProxy?.id || null,
            proxy: activeProxy ? `${activeProxy.host}:${activeProxy.port}` : null,
          },
          browserOpen: false,
        };
        run.error = null;
        run.updatedAt = nowIso();
        await scanMapRepo.upsertLiveScanRun(run).catch(() => null);
        try {
          appendLiveScanLog(run, 'Canlı tarama tamamlandı', { count: items.length });
        } catch (logErr) {
          logger.warnSafe('scan-map-live completion log failed', { runId: run.runId, error: logErr?.message || String(logErr) });
        }
      } catch (error) {
        if (activeProxy?.id && !loginSucceeded) {
          await proxyRepo.markLoginFailure(activeProxy.id, {
            threshold: 3,
            reason: error?.message || 'scan_live_login_failed',
            soft: isSoftProxyLoginFailure(error?.message),
          }).catch(() => null);
        }
        run.status = 'failed';
        run.error = error?.message || String(error);
        run.updatedAt = nowIso();
        await scanMapRepo.upsertLiveScanRun(run).catch(() => null);
        try {
          appendLiveScanLog(run, 'Canlı tarama başarısız', { error: run.error }, 'error');
        } catch (logErr) {
          logger.warnSafe('scan-map-live failure log failed', { runId: run.runId, error: logErr?.message || String(logErr) });
        }
      } finally {
        try {
          if (browser && typeof browser.close === 'function') {
            try {
              unregisterPassobotBrowser(browser);
            } catch {}
            await browser.close();
          }
        } catch {}
        if (liveProfileDir) {
          try {
            if (fs.existsSync(liveProfileDir)) {
              fs.rmSync(liveProfileDir, { recursive: true, force: true });
            }
          } catch {}
        }
        scheduleLiveRunMapEviction(run.runId);
      }
    })();

    return res.status(202).json({ success: true, runId: run.runId, status: run.status });
  } catch (error) {
    return handleError(res, error);
  }
}

async function getScanRun(req, res) {
  try {
    const runId = String(req.params.runId || '').trim();
    if (!runId) return res.status(400).json({ success: false, error: 'runId zorunlu' });
    const run = liveScanRuns.get(runId) || await scanMapRepo.getLiveScanRun(runId).catch(() => null);
    if (!run) return res.status(404).json({ success: false, error: 'Run bulunamadı' });
    return res.json({ success: true, run: publicRun(run) });
  } catch (error) {
    return handleError(res, error);
  }
}

async function listMappings(req, res) {
  try {
    const payload = scanMapQuerySchema.parse(req.query || {});
    const team = await ensureTeam(req, res, payload.teamId);
    if (!team) return null;
    const mappings = await scanMapRepo.listMappingsByScope(
      payload.teamId,
      payload.eventAddress,
      payload.scopeType,
      { includeInactive: payload.includeInactive === true }
    );
    return res.json({ success: true, mappings });
  } catch (error) {
    return handleError(res, error);
  }
}

async function saveScanItemsAsTeamCategories(req, res) {
  try {
    const payload = scanMapSaveAsCategoriesSchema.parse(req.body || {});
    const team = await ensureTeam(req, res, payload.teamId);
    if (!team) return null;
    const { created, skipped } = await categoryRepo.createCategoriesFromScanItems(payload.teamId, payload.items);
    return res.status(201).json({
      success: true,
      count: created.length,
      skippedCount: skipped.length,
      skippedBlockIds: skipped,
      categories: created,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

async function scanBlocks(req, res) {
  try {
    const payload = scanMapScanRequestSchema.parse(req.body || {});
    const team = await ensureTeam(req, res, payload.teamId);
    if (!team) return null;
    const items = await scanBlocksViaTooltip({
      eventAddress: payload.eventAddress,
      maxProbe: payload.maxProbe,
      categoryHints: payload.categoryHints,
    });
    return res.json({ success: true, count: items.length, items });
  } catch (error) {
    return handleError(res, error);
  }
}

async function setDefaultMapping(req, res) {
  try {
    const payload = scanMapSetDefaultSchema.parse(req.body || {});
    const team = await ensureTeam(req, res, payload.teamId);
    if (!team) return null;
    const mapping = await scanMapRepo.setDefaultMapping(
      payload.teamId,
      payload.eventAddress,
      payload.scopeType,
      payload.categoryLabel,
      payload.mappingId
    );
    if (!mapping) return res.status(404).json({ success: false, error: 'Kayıt bulunamadı' });
    return res.json({ success: true, mapping });
  } catch (error) {
    return handleError(res, error);
  }
}

async function deleteMapping(req, res) {
  try {
    const ok = await scanMapRepo.deleteMapping(req.params.mappingId);
    if (!ok) return res.status(404).json({ success: false, error: 'Kayıt bulunamadı' });
    return res.json({ success: true });
  } catch (error) {
    return handleError(res, error);
  }
}

async function clearMappings(req, res) {
  try {
    const payload = scanMapClearSchema.parse(req.body || {});
    const team = await ensureTeam(req, res, payload.teamId);
    if (!team) return null;
    const deletedCount = await scanMapRepo.clearMappings(payload.teamId, payload.eventAddress, payload.scopeType);
    return res.json({ success: true, deletedCount });
  } catch (error) {
    return handleError(res, error);
  }
}

module.exports = {
  clearMappings,
  deleteMapping,
  getScanRun,
  listMappings,
  saveScanItemsAsTeamCategories,
  scanBlocks,
  scanBlocksLive,
  setDefaultMapping,
};
