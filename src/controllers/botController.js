const {connect} = require('puppeteer-real-browser');
const axios = require('axios');
const ac = require('@antiadmin/anticaptchaofficial');
const { randomUUID } = require('crypto');
const { botRequestSchema } = require('../validators/botRequest');

const cfg = require('../config');
const delay = require('../utils/delay');
const logger = require('../utils/logger');
const { formatError, formatSuccess } = require('../utils/messages');
const { BasketTimer, checkBasketTimeoutFromPage } = require('../utils/basketTimer');
const {confirmSwalYes, clickRemoveFromCartAndConfirm} = require('../helpers/swal');
const { captureSeatIdFromNetwork, readBasketData, readCatBlock, setCatBlockOnB, openSeatMapStrict, clickContinueInsidePage, gotoWithRetry, ensureUrlContains, SEAT_NODE_SELECTOR, ensureTcAssignedOnBasket, clickBasketDevamToOdeme, dismissPaymentInfoModalIfPresent, fillInvoiceTcAndContinue, acceptAgreementsAndContinue, fillNkolayPaymentIframe } = require('../helpers/page');
const { pickRandomSeatWithVerify, pickExactSeatWithVerify_Locked, waitForTargetSeatReady, pickExactSeatWithVerify_ReleaseAware } = require('../helpers/seat');

ac.setAPIKey(cfg.ANTICAPTCHA_KEY || '');

async function selectSvgBlockById(page, blockId) {
    const safeId = String(blockId || '').trim();
    if (!safeId) return false;

    try {
        await page.evaluate((bid) => {
            try { window.__passobotLastSvgBlockId = String(bid || ''); } catch {}
        }, safeId);
    } catch {}

    const clickPoint = await page.evaluate((targetId) => {
        const el = document.getElementById(targetId);
        if (!el) return { ok: false, id: targetId, reason: 'not_found' };
        const asEl = /** @type {Element} */ (el);
        try { asEl.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}

        let rect = null;
        try {
            if (typeof asEl.getBoundingClientRect === 'function') rect = asEl.getBoundingClientRect();
        } catch {}

        if (!rect || !rect.width || !rect.height) {
            try {
                const svgEl = /** @type {any} */ (asEl);
                if (typeof svgEl.getBBox === 'function') {
                    const b = svgEl.getBBox();
                    const ctm = svgEl.getScreenCTM && svgEl.getScreenCTM();
                    if (ctm) {
                        const x = (b.x + (b.width / 2)) * ctm.a + ctm.e;
                        const y = (b.y + (b.height / 2)) * ctm.d + ctm.f;
                        return { ok: true, id: targetId, tag: asEl.tagName, x, y, method: 'getBBox' };
                    }
                }
            } catch {}
        }

        if (!rect) return { ok: false, id: targetId, reason: 'no_rect', tag: asEl.tagName };
        const x = rect.left + (rect.width / 2);
        const y = rect.top + (rect.height / 2);
        const pe = (() => {
            try {
                const s = window.getComputedStyle(asEl);
                return s?.pointerEvents || null;
            } catch {
                return null;
            }
        })();
        const top = (() => {
            try {
                const t = document.elementFromPoint(x, y);
                if (!t) return null;
                return {
                    tag: t.tagName,
                    id: t.getAttribute('id') || t.id || null,
                    className: (t.getAttribute('class') || '').toString().slice(0, 120)
                };
            } catch {
                return null;
            }
        })();
        return { ok: true, id: targetId, tag: asEl.tagName, x, y, method: 'getBoundingClientRect', top, pe };
    }, safeId).catch(() => ({ ok: false, id: safeId, reason: 'eval_failed' }));

    if (!clickPoint || !clickPoint.ok || !Number.isFinite(clickPoint.x) || !Number.isFinite(clickPoint.y)) return false;

    // If the target block (or its subtree) is not hit-testable, force pointer-events back.
    try {
        if (String(clickPoint?.pe || '').toLowerCase() === 'none') {
            await page.evaluate((bid) => {
                try {
                    const el = document.getElementById(String(bid || ''));
                    const t = /** @type {any} */ (el);
                    if (t && t.style) {
                        try { t.style.setProperty('pointer-events', 'auto', 'important'); } catch {}
                    }
                    try {
                        const p = el?.closest('g.block, .svgBlock, [class*="block" i]');
                        if (p && p.style) {
                            try { p.style.setProperty('pointer-events', 'auto', 'important'); } catch {}
                        }
                    } catch {}
                } catch {}
            }, safeId);
        }
    } catch {}

    // Some overlays (cookie consent etc.) can sit on top of the SVG and swallow clicks.
    // If elementFromPoint doesn't look like our target, try to disable obvious blockers once.
    try {
        const top = clickPoint?.top || null;
        const topTag = String(top?.tag || '').toUpperCase();
        const topClass = String(top?.className || '');
        const looksLikeBlocker = (
            topTag.startsWith('EFILLI') ||
            topClass.toLowerCase().includes('efilli') ||
            topClass.toLowerCase().includes('cookie') ||
            topClass.toLowerCase().includes('consent')
        );
        if (looksLikeBlocker) {
            await page.evaluate((x, y) => {
                try {
                    const t = document.elementFromPoint(x, y);
                    const disable = (el) => {
                        if (!el || !el.style) return;
                        try { el.style.setProperty('pointer-events', 'none', 'important'); } catch {}
                        try { el.style.setProperty('visibility', 'hidden', 'important'); } catch {}
                        try { el.style.setProperty('display', 'none', 'important'); } catch {}
                    };
                    disable(t);
                    try { disable(t?.closest('efilli-layout-dynamic, efilli-layout, efilli-consent, [class*="cookie" i], [class*="consent" i]')); } catch {}
                } catch {}
            }, clickPoint.x, clickPoint.y);
        }
    } catch {}

    try {
        // Move like a real user (hover tooltip already appears in some UIs)
        await page.mouse.move(clickPoint.x, clickPoint.y, { steps: 14 });
        await delay(60);
        // Some UIs require pointerover/move to arm the click handler
        try {
            await page.evaluate((x, y) => {
                const hit = document.elementFromPoint(x, y);
                const target = hit?.closest('g.block, .svgBlock') || hit;
                if (!target) return;
                const fire = (el, type) => {
                    try {
                        const base = {
                            bubbles: true,
                            cancelable: true,
                            view: window,
                            clientX: x,
                            clientY: y,
                            button: 0,
                            buttons: 0
                        };
                        const usePointer = String(type || '').toLowerCase().startsWith('pointer') && (typeof PointerEvent !== 'undefined');
                        const ev = usePointer
                            ? new PointerEvent(type, { pointerId: 1, isPrimary: true, pointerType: 'mouse', ...base })
                            : new MouseEvent(type, base);
                        el.dispatchEvent(ev);
                    } catch {}
                };
                fire(target, 'pointerover');
                fire(target, 'mouseover');
                fire(target, 'pointermove');
                fire(target, 'mousemove');
            }, clickPoint.x, clickPoint.y);
        } catch {}

        // Prefer down/up with realistic delays; some handlers ignore .click()
        await page.mouse.down();
        await delay(90);
        await page.mouse.up();
        await delay(40);
        // Extra click as a fallback
        await page.mouse.click(clickPoint.x, clickPoint.y, { delay: 55 });
    } catch {
        return false;
    }

    // Some SVG implementations listen to pointer events on the element rather than DOM click.
    // Dispatch a full pointer/mouse event sequence on the hit-tested element (or its closest block).
    try {
        await page.evaluate((x, y) => {
            const fire = (el, type, extra = {}) => {
                try {
                    const base = {
                        bubbles: true,
                        cancelable: true,
                        view: window,
                        clientX: x,
                        clientY: y,
                        button: 0,
                        buttons: 1,
                        ...extra
                    };
                    const usePointer = String(type || '').toLowerCase().startsWith('pointer') && (typeof PointerEvent !== 'undefined');
                    const ev = usePointer
                        ? new PointerEvent(type, { pointerId: 1, isPrimary: true, pointerType: 'mouse', ...base })
                        : new MouseEvent(type, base);
                    el.dispatchEvent(ev);
                } catch {}
            };
            try {
                const hit = document.elementFromPoint(x, y);
                const target = hit?.closest('g.block, .svgBlock') || hit;
                if (!target) return;
                // ensure hit-testable
                try { target.style?.setProperty('pointer-events', 'auto', 'important'); } catch {}
                fire(target, 'pointerdown');
                fire(target, 'mousedown');
                fire(target, 'pointerup');
                fire(target, 'mouseup');
                fire(target, 'click');
            } catch {}
        }, clickPoint.x, clickPoint.y);
    } catch {}

    try { await openSeatMapStrict(page); } catch {}
    try {
        await page.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, { timeout: 20000 }, SEAT_NODE_SELECTOR);
    } catch {}
    return true;
}

async function applyCategoryBlockSelection(page, selectionMode, catBlock, seatInfo) {
    const mode = String(selectionMode || 'legacy').toLowerCase();
    if (mode === 'svg') {
        // IMPORTANT:
        // - `catBlock.svgBlockId` is a DOM id like "block40396" (works with document.getElementById).
        // - `seatInfo.blockId` is a backend numeric id (e.g. "61336") and is NOT a DOM id.
        // Prefer DOM svgBlockId; fall back to last-known svgBlockId stored on seatInfo.
        const svgBlockId =
            (catBlock && catBlock.svgBlockId ? String(catBlock.svgBlockId) : '') ||
            (seatInfo && seatInfo.svgBlockId ? String(seatInfo.svgBlockId) : '') ||
            '';
        if (!svgBlockId) return true;
        return await selectSvgBlockById(page, svgBlockId);
    }
    await setCatBlockOnB(page, catBlock);
    return true;
}

const runStore = (() => {
    const runs = new Map();
    const nowIso = () => {
        try { return new Date().toISOString(); } catch { return null; }
    };
    const safeRunId = (v) => {
        const s = String(v || '').trim();
        if (!s) return null;
        if (!/^[a-zA-Z0-9._:-]{6,120}$/.test(s)) return null;
        return s;
    };
    const get = (id) => runs.get(id) || null;
    const upsert = (id, patch) => {
        const rid = safeRunId(id);
        if (!rid) return null;
        const prev = runs.get(rid) || { runId: rid, createdAt: nowIso() };
        const next = { ...prev, ...patch, updatedAt: nowIso() };
        runs.set(rid, next);
        return next;
    };
    const remove = (id) => {
        const rid = safeRunId(id);
        if (!rid) return false;
        return runs.delete(rid);
    };
    const list = () => Array.from(runs.values());
    const listRunning = () => list().filter(r => r.status === 'running');
    const killAllRunning = () => {
        const running = listRunning();
        running.forEach(r => {
            upsert(r.runId, { status: 'killed', killedAt: nowIso() });
        });
        return running.map(r => r.runId);
    };
    return { get, upsert, remove, safeRunId, list, listRunning, killAllRunning };
})();

async function startBotAsync(req, res) {
    let validatedData;
    try {
        validatedData = botRequestSchema.parse(req.body);
    } catch (error) {
        if (error.issues && Array.isArray(error.issues)) {
            logger.warnSafe('Validation hatası', { errors: error.issues, body: req.body });
            return res.status(400).json({
                error: formatError('VALIDATION_ERROR'),
                details: error.issues.map(e => ({ path: e.path.join('.'), message: e.message, code: e.code }))
            });
        }
        logger.errorSafe('Validation hatası (beklenmeyen format)', error, { body: req.body });
        return res.status(400).json({ error: formatError('INVALID_REQUEST_DATA') });
    }

    const runId = (() => {
        try { return randomUUID(); } catch { return `${Date.now()}_${Math.random().toString(16).slice(2)}`; }
    })();

    runStore.upsert(runId, {
        status: 'running',
        finalizeRequested: false,
        finalizeRequestedAt: null,
        cAccount: null,
        result: null,
        error: null
    });

    res.json({ success: true, runId, status: 'running' });

    const reqLike = {
        body: validatedData,
        get: (h) => {
            try {
                if (String(h || '').toLowerCase() === 'x-run-id') return runId;
            } catch {}
            return null;
        }
    };
    const resLike = {
        status: () => resLike,
        json: (payload) => {
            runStore.upsert(runId, { status: 'completed', result: payload || null, error: null });
            return payload;
        }
    };

    Promise.resolve()
        .then(() => startBot(reqLike, resLike))
        .catch((e) => {
            runStore.upsert(runId, { status: 'error', error: e?.message || String(e) });
        });
}

async function registerCAccount(req, res) {
    const runId = runStore.safeRunId(req?.params?.runId);
    if (!runId) return res.status(400).json({ error: 'Invalid runId' });
    const email = String(req?.body?.email || '').trim();
    const password = String(req?.body?.password || '').trim();
    if (!email || !password) return res.status(400).json({ error: 'email/password required' });
    const cur = runStore.get(runId);
    if (!cur) return res.status(404).json({ error: 'runId not found' });
    runStore.upsert(runId, { cAccount: { email, password } });
    return res.json({ success: true, runId });
}

async function requestFinalize(req, res) {
    const runId = runStore.safeRunId(req?.params?.runId);
    if (!runId) return res.status(400).json({ error: 'Invalid runId' });
    const cur = runStore.get(runId);
    if (!cur) return res.status(404).json({ error: 'runId not found' });
    const identity = req?.body?.identity != null ? String(req.body.identity).trim() : null;
    const cardHolder = req?.body?.cardHolder != null ? String(req.body.cardHolder).trim() : null;
    const cardNumber = req?.body?.cardNumber != null ? String(req.body.cardNumber).trim() : null;
    const expiryMonth = req?.body?.expiryMonth != null ? String(req.body.expiryMonth).trim() : null;
    const expiryYear = req?.body?.expiryYear != null ? String(req.body.expiryYear).trim() : null;
    const cvv = req?.body?.cvv != null ? String(req.body.cvv).trim() : null;
    const autoPay = (() => {
        const v = req?.body?.autoPay;
        if (v === true || v === 'true' || v === 1 || v === '1' || v === 'on') return true;
        return false;
    })();
    runStore.upsert(runId, {
        finalizeRequested: true,
        finalizeRequestedAt: new Date().toISOString(),
        finalizeMeta: {
            identity: identity || null,
            cardHolder: cardHolder || null,
            cardNumber: cardNumber || null,
            expiryMonth: expiryMonth || null,
            expiryYear: expiryYear || null,
            cvv: cvv || null,
            autoPay
        }
    });
    return res.json({ success: true, runId });
}

async function getRunStatus(req, res) {
    const runId = runStore.safeRunId(req?.params?.runId);
    if (!runId) return res.status(400).json({ error: 'Invalid runId' });
    const cur = runStore.get(runId);
    if (!cur) return res.status(404).json({ error: 'runId not found' });
    const safe = { ...cur };
    try {
        if (safe?.cAccount?.password) safe.cAccount = { ...safe.cAccount, password: '***' };
    } catch {}
    try {
        if (safe?.finalizeMeta) {
            const fm = { ...(safe.finalizeMeta || {}) };
            if (fm.cardNumber) fm.cardNumber = '***';
            if (fm.cvv) fm.cvv = '***';
            safe.finalizeMeta = fm;
        }
    } catch {}
    return res.json({ success: true, run: safe });
}

async function killSessions(req, res) {
    const running = runStore.listRunning();
    const killedRunIds = runStore.killAllRunning();
    
    // Log separator for visual distinction in logs
    logger.info('==================================================');
    logger.info('KILL_SESSIONS: Aktif oturumlar kapatılıyor', { 
        runningCount: running.length, 
        killedRunIds,
        timestamp: new Date().toISOString()
    });
    logger.info('==================================================');
    
    // Also emit a special log entry that UI can detect
    logger.info('[SEPARATOR] ------------------- OTURUMLAR KAPATILDI -------------------');
    
    return res.json({ 
        success: true, 
        killedCount: killedRunIds.length, 
        killedRunIds,
        runningCount: running.length
    });
}

module.exports = { startBot, startBotAsync, registerCAccount, requestFinalize, getRunStatus, killSessions };

// Global semaphore to avoid hammering captcha provider with too many parallel solves.
// This helps reduce queueing and long tail solve times in multi-account runs.
const createSemaphore = (max) => {
    const limit = Math.max(1, Number(max) || 1);
    let active = 0;
    const q = [];
    const acquire = async () => {
        if (active < limit) {
            active += 1;
            return;
        }
        await new Promise((resolve) => q.push(resolve));
        active += 1;
    };
    const release = () => {
        active = Math.max(0, active - 1);
        const next = q.shift();
        if (next) next();
    };
    const stats = () => ({ limit, active, queued: q.length });
    return { acquire, release, stats };
};

const turnstileSolveSem = createSemaphore(cfg?.TIMEOUTS?.TURNSTILE_SOLVE_CONCURRENCY || 2);

async function ensureTurnstileTokenOnPage(page, email, label, options) {
    if (!page) return { attempted: false };

    const opts = (options && typeof options === 'object') ? options : {};
    const background = !!opts.background;

    // Cache in-flight solves per Page to avoid starting multiple expensive captcha requests.
    const getCache = () => {
        try {
            if (!page.__turnstileCache) page.__turnstileCache = { inFlight: null, startedAt: 0 };
            return page.__turnstileCache;
        } catch {
            return { inFlight: null, startedAt: 0 };
        }
    };
    const cache = getCache();

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const state = await page.evaluate(() => {
                const bodyText = (document.body?.innerText || '').toLowerCase();
                const hasVerifyHuman = bodyText.includes('verify you are human');
                const hasWidget = !!document.querySelector('.cf-turnstile');
                const input = document.querySelector('input[name="cf-turnstile-response"]');
                const hasTokenField = !!input;
                const tokenLen = input?.value ? input.value.length : 0;
                return { hasVerifyHuman, hasWidget, hasTokenField, tokenLen };
            });

            logger.info('turnstile:state', { email, label, attempt, state, background });

            const shouldSolve = (state.hasVerifyHuman || state.hasWidget || state.hasTokenField) && state.tokenLen <= 0;
            if (!shouldSolve) return { attempted: false, state };

            if (!cfg.PASSO_SITE_KEY || !cfg.ANTICAPTCHA_KEY) {
                logger.warn('turnstile:cannot_solve_missing_keys', {
                    email,
                    label,
                    hasSiteKey: !!cfg.PASSO_SITE_KEY,
                    hasAntiCaptchaKey: !!cfg.ANTICAPTCHA_KEY
                });
                return { attempted: false, state, missingKeys: true };
            }

            // If a solve is already in-flight, reuse it.
            if (cache?.inFlight) {
                logger.info('turnstile:reuse_inflight', { email, label, attempt, background });
                if (background) return { attempted: false, state, inFlight: true, background: true };
                return await cache.inFlight;
            }

            const solveWork = (async () => {
                logger.warn('turnstile:solve_attempt', { email, label, attempt });
                const solveStart = Date.now();

                const semStart = Date.now();
                await turnstileSolveSem.acquire();
                const waitedMs = Date.now() - semStart;
                if (waitedMs > 250) {
                    logger.info('turnstile:semaphore_wait', { email, label, waitedMs, sem: turnstileSolveSem.stats() });
                }

                let tok;
                try {
                    const solveTimeoutMs = Math.max(15000, Number(cfg?.TIMEOUTS?.TURNSTILE_SOLVE_TIMEOUT) || 120000);
                    tok = await Promise.race([
                        ac.solveTurnstileProxyless(cfg.PASSO_LOGIN, cfg.PASSO_SITE_KEY),
                        delay(solveTimeoutMs).then(() => {
                            throw new Error(`TURNSTILE_SOLVE_TIMEOUT_${solveTimeoutMs}`);
                        })
                    ]);
                } finally {
                    turnstileSolveSem.release();
                }
                logger.info('turnstile:solve_result', {
                    email,
                    label,
                    attempt,
                    solveMs: Date.now() - solveStart,
                    tokenLength: tok ? String(tok).length : 0
                });

                await page.evaluate((token) => {
                    const f = document.querySelector('form') || document.body;
                    if (!f) return;
                    let i = document.querySelector('input[name="cf-turnstile-response"]');
                    if (!i) {
                        i = document.createElement('input');
                        i.type = 'hidden';
                        i.name = 'cf-turnstile-response';
                        f.appendChild(i);
                    }
                    i.value = token;
                    i.dispatchEvent(new Event('input', { bubbles: true }));
                    i.dispatchEvent(new Event('change', { bubbles: true }));
                }, tok);

                const after = await page.evaluate(() => {
                    const input = document.querySelector('input[name="cf-turnstile-response"]');
                    return { hasTokenField: !!input, tokenLen: input?.value ? input.value.length : 0 };
                });
                logger.info('turnstile:inject_check', { email, label, attempt, after });
                return { attempted: true, state, after };
            })();

            try {
                cache.inFlight = solveWork;
                cache.startedAt = Date.now();
            } catch {}

            if (background) {
                // do not block main flow; caller will await on next ensure call if needed
                solveWork.catch(() => {}).finally(() => {
                    try { if (cache) cache.inFlight = null; } catch {}
                });
                return { attempted: false, state, started: true, background: true };
            }

            try {
                const res = await solveWork;
                return res;
            } finally {
                try { if (cache) cache.inFlight = null; } catch {}
            }
        } catch (e) {
            const msg = e?.message || String(e);
            logger.warn('turnstile:ensure_failed', { email, label, attempt, background, error: msg });

            try { if (cache) cache.inFlight = null; } catch {}

            const transient = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg);
            if (!transient || attempt >= maxAttempts) {
                return { attempted: false, error: msg, attempt };
            }
            const backoff = 900 * attempt;
            await delay(backoff);
        }
    }

    return { attempted: false, error: 'unknown', attempt: maxAttempts };
}

function buildProxyArgs(proxyHost, proxyPort) {
    const args = ['--window-size=1920,1080'];
    let proxyApplied = false;
    if (proxyHost && proxyPort) {
        let host = String(proxyHost).trim();
        if (!/^(http|https|socks4|socks5):\/\//i.test(host)) host = `http://${host}`;
        const u = new URL(host);
        u.port = String(proxyPort);
        args.push(`--proxy-server=${u.protocol}//${u.hostname}:${u.port}`);
        proxyApplied = true;
    }
    return {args, proxyApplied};
}

async function launchAndLogin(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const email = opts.email;
    const password = opts.password;
    const userDataDir = opts.userDataDir;
    const proxyHost = opts.proxyHost;
    const proxyPort = opts.proxyPort;
    const proxyUsername = opts.proxyUsername;
    const proxyPassword = opts.proxyPassword;

    const {args, proxyApplied} = buildProxyArgs(proxyHost, proxyPort);
    logger.debug('launchAndLogin: browser connect başlıyor', {
        email,
        userDataDir,
        proxyApplied
    });
    const ret = await connect({
        executablePath: cfg.CHROME_PATH,
        userDataDir,
        headless: false,
        turnstile: false,
        args,
        defaultViewport: null
    });
    const browser = ret.browser;
    const page = ret.page || await ensurePage(browser);
    try {
        logger.debug('launchAndLogin: browser/page hazır', {
            email,
            hasInitialPage: !!ret.page,
            currentUrl: (() => {
                try { return page.url(); } catch { return null; }
            })()
        });
    } catch {}
    if (proxyApplied && proxyUsername && proxyPassword) {
        try {
            await page.authenticate({username: String(proxyUsername), password: String(proxyPassword)});
            logger.debug('launchAndLogin: proxy authentication uygulandı', { email });
        } catch {
            logger.warn('launchAndLogin: proxy authentication başarısız/atlanıyor', { email });
        }
    }

    logger.debug('launchAndLogin: login sayfasına gidiliyor', { email, url: cfg.PASSO_LOGIN });

    // Capture main document response info for /giris
    let lastLoginDoc = null;
    const onResp = (resp) => {
        try {
            const req = resp.request();
            const rt = req?.resourceType?.();
            const url = resp.url?.() || '';
            if (rt === 'document' && /\/tr\/giris(\?|$)/i.test(url)) {
                lastLoginDoc = {
                    url,
                    status: resp.status?.(),
                    ok: resp.ok?.(),
                    fromCache: resp.fromCache?.(),
                    fromServiceWorker: resp.fromServiceWorker?.()
                };
            }
        } catch {}
    };
    try { page.on('response', onResp); } catch {}
    let gotoRes = await gotoWithRetry(page, cfg.PASSO_LOGIN, {
        retries: 2,
        waitUntil: 'domcontentloaded',
        expectedUrlIncludes: '/giris',
        timeoutMs: 45000,
        backoffMs: 400
    });
    if (!gotoRes?.ok) {
        logger.warn('launchAndLogin: login goto başarısız, networkidle2 ile fallback deneniyor', {
            email,
            goto: gotoRes,
            currentUrl: (() => { try { return page.url(); } catch { return null; } })()
        });
        gotoRes = await gotoWithRetry(page, cfg.PASSO_LOGIN, {
            retries: 1,
            waitUntil: 'networkidle2',
            expectedUrlIncludes: '/giris',
            timeoutMs: 60000,
            backoffMs: 450
        });
    }
    logger.info('launchAndLogin: login goto sonucu', {
        email,
        goto: gotoRes,
        currentUrl: (() => { try { return page.url(); } catch { return null; } })()
    });

    try {
        logger.info('launchAndLogin: login document response', { email, doc: lastLoginDoc });
    } catch {}

    try {
        const snap0 = await page.evaluate(() => {
            const bodyText = (document.body?.innerText || '').toLowerCase();
            const hasVerifyHuman = bodyText.includes('verify you are human');
            const hasTurnstileWidget = !!document.querySelector('.cf-turnstile');
            const hasTurnstileTokenField = !!document.querySelector('input[name="cf-turnstile-response"]');
            const title = document.title;
            const inputCount = document.querySelectorAll('input').length;
            const formCount = document.querySelectorAll('form').length;
            const scriptCount = document.querySelectorAll('script').length;
            const linkCount = document.querySelectorAll('link[rel="stylesheet"], link[as="style"], style').length;
            const bodyHtmlLen = (document.body?.innerHTML || '').length;
            const docHtmlLen = (document.documentElement?.outerHTML || '').length;
            return { title, hasVerifyHuman, hasTurnstileWidget, hasTurnstileTokenField, inputCount, formCount, scriptCount, linkCount, bodyHtmlLen, docHtmlLen };
        });
        logger.info('launchAndLogin: login sayfası yüklendi', { email, snap: snap0 });

        // If page is basically empty (no inputs/forms) try a stronger reload
        if ((snap0.inputCount || 0) === 0 && (snap0.formCount || 0) === 0 && (snap0.bodyHtmlLen || 0) < 500) {
            logger.warn('launchAndLogin: login sayfası boş görünüyor, reload(networkidle2) deneniyor', { email, snap: snap0 });
            try { await page.reload({ waitUntil: 'networkidle2', timeout: 60000 }); } catch {}
            await delay(800);
            const snap1 = await page.evaluate(() => {
                const bodyText = (document.body?.innerText || '').toLowerCase();
                const hasVerifyHuman = bodyText.includes('verify you are human');
                const hasTurnstileWidget = !!document.querySelector('.cf-turnstile');
                const hasTurnstileTokenField = !!document.querySelector('input[name="cf-turnstile-response"]');
                const title = document.title;
                const inputCount = document.querySelectorAll('input').length;
                const formCount = document.querySelectorAll('form').length;
                const scriptCount = document.querySelectorAll('script').length;
                const linkCount = document.querySelectorAll('link[rel="stylesheet"], link[as="style"], style').length;
                const bodyHtmlLen = (document.body?.innerHTML || '').length;
                const docHtmlLen = (document.documentElement?.outerHTML || '').length;
                return { title, hasVerifyHuman, hasTurnstileWidget, hasTurnstileTokenField, inputCount, formCount, scriptCount, linkCount, bodyHtmlLen, docHtmlLen };
            });
            logger.info('launchAndLogin: login reload sonrası snapshot', { email, snap: snap1 });
        }
    } catch {}

    // Start Turnstile solving ASAP (background), so form fill + other waits overlap with captcha time.
    await ensureTurnstileTokenOnPage(page, email, 'launchAndLogin.warmup', { background: true });

    // Turnstile/Verify Human: ensure token before submit (will reuse in-flight warmup if present)
    await ensureTurnstileTokenOnPage(page, email, 'launchAndLogin.beforeSubmit');

    try { page.removeListener('response', onResp); } catch {}

    try {
        const preLoginSnap = await page.evaluate(() => {
            const bodyText = (document.body?.innerText || '').toLowerCase();
            const hasVerifyHuman = bodyText.includes('verify you are human');
            const hasTurnstileTokenField = !!document.querySelector('input[name="cf-turnstile-response"]');
            const tokenLen = document.querySelector('input[name="cf-turnstile-response"]')?.value?.length || 0;
            const title = document.title;
            return { title, hasVerifyHuman, hasTurnstileTokenField, tokenLen };
        });
        logger.debug('launchAndLogin: login submit öncesi snapshot', { email, snap: preLoginSnap });
    } catch {}

    const userSel = 'input[autocomplete="username"], input[type="email"], input[name*="email"], input[name*="user"], input[id*="user"], input[id*="email"]';
    const passSel = 'input[autocomplete="current-password"], input[type="password"], input[name*="pass"], input[id*="pass"]';

    const findLoginContext = async () => {
        const directUser = await page.$(userSel).catch(() => null);
        const directPass = await page.$(passSel).catch(() => null);
        if (directUser && directPass) return { frame: null, userEl: directUser, passEl: directPass };

        const frames = (() => {
            try { return page.frames(); } catch { return []; }
        })();
        for (const fr of frames) {
            if (!fr || fr === page.mainFrame()) continue;
            const u = await fr.$(userSel).catch(() => null);
            const p = await fr.$(passSel).catch(() => null);
            if (u && p) return { frame: fr, userEl: u, passEl: p };
        }
        return null;
    };

    const tryEnsureLoginForm = async (timeoutMs = 8000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const ctx = await findLoginContext();
            if (ctx) return ctx;
            await delay(500);
        }
        return null;
    };

    const ensureLoginFormWithReload = async () => {
        for (let attempt = 1; attempt <= 5; attempt++) {
            const ctx = await tryEnsureLoginForm(8000);
            if (ctx) return ctx;

            try {
                await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
            } catch {}

            const backoff = 600 * attempt;
            try { await delay(backoff); } catch {}

            const u = (() => { try { return page.url(); } catch { return ''; } })();
            if (!/\/tr\/giris(\?|$)/i.test(String(u || ''))) {
                try {
                    await gotoWithRetry(page, cfg.PASSO_LOGIN, {
                        retries: 1,
                        waitUntil: 'domcontentloaded',
                        expectedUrlIncludes: '/giris',
                        backoffMs: 350
                    });
                } catch {}
            }
        }
        return null;
    };

    let loginCtx = await ensureLoginFormWithReload();
    
    if (!loginCtx) {
        const u = (() => { try { return page.url(); } catch { return ''; } })();
        // Login formu yoksa ve /giris'te değilsek, büyük ihtimalle zaten girişli/redirect olmuştur.
        if (!/\/giris(\?|$)/i.test(u)) {
            logger.warn('launchAndLogin: login formu bulunamadı, zaten girişli/redirect kabul ediliyor', { email, url: u });
            return { browser, page };
        }
        try {
            const diag = await page.evaluate(() => {
                const inputs = Array.from(document.querySelectorAll('input'))
                    .slice(0, 40)
                    .map(i => ({
                        type: i.getAttribute('type') || '',
                        name: i.getAttribute('name') || '',
                        id: i.getAttribute('id') || '',
                        autocomplete: i.getAttribute('autocomplete') || ''
                    }));
                const forms = Array.from(document.querySelectorAll('form'))
                    .slice(0, 10)
                    .map(f => ({
                        id: f.getAttribute('id') || '',
                        name: f.getAttribute('name') || '',
                        action: f.getAttribute('action') || ''
                    }));
                return { inputCount: document.querySelectorAll('input').length, inputs, formCount: document.querySelectorAll('form').length, forms };
            });
            const frameInfo = (() => {
                try {
                    return page.frames().map(fr => ({
                        url: (() => { try { return fr.url(); } catch { return null; } })()
                    }));
                } catch {
                    return [];
                }
            })();
            logger.warn('launchAndLogin: login formu bulunamadı (diagnostic)', { email, url: u, diag, frames: frameInfo });
        } catch {}
        throw new Error('Login formu bulunamadı');
    }

    const target = loginCtx.frame || page;
    const userEl = loginCtx.userEl;
    const passEl = loginCtx.passEl;
    if (!userEl || !passEl) throw new Error('Login inputları bulunamadı');
    await userEl.click({ clickCount: 3 }).catch(() => {});
    await target.type(userSel, String(email || ''), { delay: 10 }).catch(async () => {
        await userEl.type(String(email || ''), { delay: 10 }).catch(() => {});
    });
    await passEl.click({ clickCount: 3 }).catch(() => {});
    await target.type(passSel, String(password || ''), { delay: 10 }).catch(async () => {
        await passEl.type(String(password || ''), { delay: 10 }).catch(() => {});
    });

    await page.evaluate(() => {
        const norm = (s) => (s || '').toString().trim().toLowerCase();
        const btns = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a'));
        const b = btns.find(x => {
            const t = norm(x.innerText || x.textContent || x.value || '');
            return t === 'giriş' || t === 'girış' || t.includes('giriş') || t.includes('login');
        });
        try { b?.click(); } catch {}
    });
    logger.debug('launchAndLogin: GİRİŞ butonu click gönderildi', { email });
    await delay(cfg.DELAYS.AFTER_LOGIN);

    try {
        const postLogin = await page.evaluate(() => {
            const bodyText = (document.body?.innerText || '').toLowerCase();
            const hasVerifyHuman = bodyText.includes('verify you are human');
            const hasTurnstileWidget = !!document.querySelector('.cf-turnstile');
            const hasTurnstileTokenField = !!document.querySelector('input[name="cf-turnstile-response"]');
            const title = document.title;
            const url = location.href;
            const possibleErrors = Array.from(document.querySelectorAll('.error, .alert, .toast, .swal2-html-container, .validation, .invalid-feedback'))
                .slice(0, 5)
                .map(el => (el.innerText || el.textContent || '').trim())
                .filter(Boolean);
            return { title, url, hasVerifyHuman, hasTurnstileWidget, hasTurnstileTokenField, possibleErrors };
        });
        logger.info('launchAndLogin: login sonrası snapshot', { email, snap: postLogin });
    } catch {}

    return {browser, page};
}

async function reloginIfRedirected(page, email, password) {
    if (!page) return false;

    const currentUrl = (() => {
        try { return page.url(); } catch { return ''; }
    })();

    if (!/\/giris(\?|$)/i.test(currentUrl)) return false;

    let returnUrl = null;
    try {
        const u = new URL(currentUrl);
        returnUrl = u.searchParams.get('returnUrl');
        if (returnUrl) {
            try { returnUrl = decodeURIComponent(returnUrl); } catch {}
            if (!/^https?:\/\//i.test(returnUrl)) {
                returnUrl = `https://www.passo.com.tr${returnUrl.startsWith('/') ? '' : '/'}${returnUrl}`;
            }
        }
    } catch {
    }

    logger.warn('reloginIfRedirected: login redirect tespit edildi, yeniden login denenecek', {
        email,
        currentUrl,
        returnUrl
    });

    // Warmup turnstile solve in background first, then ensure before submit (reuses in-flight if present)
    await ensureTurnstileTokenOnPage(page, email, 'reloginIfRedirected.warmup', { background: true });
    // If we are on a human verification page, try to solve turnstile before attempting login.
    await ensureTurnstileTokenOnPage(page, email, 'reloginIfRedirected.beforeSubmit');

    try {
        await page.waitForSelector('input[autocomplete="username"], input[type="email"], input[name*="email"], input[name*="user"]', { timeout: 10000 });
    } catch {
    }

    try {
        await page.evaluate(() => {
            const u = document.querySelector('input[autocomplete="username"], input[type="email"], input[name*="email"], input[name*="user"]');
            const p = document.querySelector('input[autocomplete="current-password"], input[type="password"]');
            if (u) u.value = '';
            if (p) p.value = '';
        });
    } catch {
    }

    try {
        await page.type('input[autocomplete="username"], input[type="email"], input[name*="email"], input[name*="user"]', String(email || ''), { delay: 10 });
        await page.type('input[autocomplete="current-password"], input[type="password"]', String(password || ''), { delay: 10 });
    } catch {
        // fall back to original selectors
        try {
            await page.type('input[autocomplete="username"]', String(email || ''), { delay: 10 });
            await page.type('input[autocomplete="current-password"]', String(password || ''), { delay: 10 });
        } catch {}
    }

    await page.evaluate(() => {
        const b = [...document.querySelectorAll('button.black-btn, button, [role="button"]')].find(x => (x.innerText || '').trim().toUpperCase() === 'GİRİŞ');
        b?.click();
    }).catch(() => {});

    try { await delay(350); } catch {}

    const preUrl = currentUrl;
    const navRes = await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).then(() => ({ type: 'nav_ok' })).catch((e) => ({ type: 'nav_error', message: e?.message || String(e) })),
        delay(30000).then(() => ({ type: 'timeout' }))
    ]);

    // Re-check URL after navigation settles (even if timeout)
    await delay(500);
    const afterUrl = (() => {
        try { return page.url(); } catch { return ''; }
    })();

    logger.info('reloginIfRedirected: login submit sonrası', {
        email,
        navRes,
        afterUrl
    });

    // Check for login error messages on the page
    const loginError = await page.evaluate(() => {
        const errorSelectors = [
            '.alert-danger', '.error-message', '.field-validation-error',
            '[class*="error"]', '[class*="hata"]',
            '.swal2-title', '.swal2-html-container',
            '.toast-message', '.notification-error'
        ];
        for (const sel of errorSelectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent) {
                return { selector: sel, text: el.textContent.trim() };
            }
        }
        // Check for specific error texts
        const bodyText = document.body?.innerText || '';
        const errorKeywords = ['hatalı', 'yanlış', 'geçersiz', 'bulunamadı', 'şifre', 'kilit', 'bloke', 'hesap', 'ban'];
        for (const kw of errorKeywords) {
            if (bodyText.toLowerCase().includes(kw)) {
                return { keyword: kw, text: bodyText.substring(0, 200) };
            }
        }
        return null;
    }).catch(() => null);

    if (loginError) {
        logger.error('reloginIfRedirected: login hatası tespit edildi', { email, loginError });
    }

    // Check if we ended up on home page (login failed)
    const isHomePage = afterUrl === 'https://www.passo.com.tr/' || afterUrl === 'https://www.passo.com.tr' || afterUrl?.endsWith('passo.com.tr/');
    if (isHomePage) {
        logger.error('reloginIfRedirected: login başarısız, ana sayfaya yönlendirildi', { email, afterUrl, loginError, navRes });
        // Don't proceed with returnUrl navigation if login failed
        return false;
    }

    // Force navigation to returnUrl (if any) to re-enter the flow.
    if (returnUrl) {
        logger.info('reloginIfRedirected: returnUrl sayfasına dönülüyor', { email, returnUrl });
        await gotoWithRetry(page, returnUrl, {
            retries: 2,
            waitUntil: 'domcontentloaded',
            expectedUrlIncludes: '/koltuk-secim',
            rejectIfHome: false,
            backoffMs: 400
        }).catch(() => {});
        
        // Check URL again after returnUrl navigation
        await delay(500);
        const finalUrl = (() => {
            try { return page.url(); } catch { return ''; }
        })();
        
        const isStillHomePage = finalUrl === 'https://www.passo.com.tr/' || finalUrl === 'https://www.passo.com.tr' || finalUrl?.endsWith('passo.com.tr/');
        if (isStillHomePage) {
            logger.error('reloginIfRedirected: returnUrl navigation sonrası hala ana sayfadayız', { email, finalUrl, originalAfterUrl: afterUrl });
            return false;
        }
    }

    const afterReturnUrl = (() => {
        try { return page.url(); } catch { return ''; }
    })();

    if (/\/giris(\?|$)/i.test(afterReturnUrl)) {
        logger.warn('reloginIfRedirected: yeniden login sonrası hala giris sayfasında', {
            email,
            afterUrl: afterReturnUrl
        });
        return true;
    }

    return true;
}

async function clickBuy(page, eventAddress = null) {
    const retries = Number.isFinite(cfg.TIMEOUTS.CLICK_BUY_RETRIES) ? cfg.TIMEOUTS.CLICK_BUY_RETRIES : 12;
    for (let i = 0; i < retries; i++) {
        const found = await page.evaluate(() => {
            const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
            const strip = (s) => {
                try {
                    return String(s || '').normalize('NFD').replace(/\p{Diacritic}+/gu, '');
                } catch {
                    return String(s || '');
                }
            };
            const norm2 = (s) => norm(strip(s));

            const isVisible = (el) => {
                try {
                    const st = window.getComputedStyle(el);
                    if (!el) return false;
                    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
                    const r = el.getBoundingClientRect();
                    if (!r || r.width <= 1 || r.height <= 1) return false;
                    return true;
                } catch {
                    return false;
                }
            };

            try {
                const swal = document.querySelector('.swal2-container.swal2-shown');
                if (swal) {
                    const btn = swal.querySelector('button.swal2-confirm, button.swal2-cancel, button');
                    try { btn?.click(); } catch {}
                }
                const cookieBtn = Array.from(document.querySelectorAll('button, a, [role="button"]'))
                    .find(b => {
                        const t = norm2(b.innerText || b.textContent || b.value || b.getAttribute('aria-label') || '');
                        return t.includes('kabul') || t.includes('accept') || t.includes('onay') || t.includes('tamam') || t.includes('anlad');
                    });
                try { cookieBtn?.click(); } catch {}
            } catch {}

            const candidates = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]'))
                .filter(el => isVisible(el) && !el.disabled);

            const looksLikeBuyText = (txt) => {
                const t = norm2(txt);
                if (!t) return false;
                if ((t.includes('satin') && t.includes('al')) || t === 'satin al') return true;
                if (t.includes('bilet') && (t.includes('al') || t.includes('sat'))) return true;
                if (t.includes('hemen') && t.includes('al')) return true;
                return false;
            };

            const pick = candidates.find(el => {
                const txt = el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '';
                if (!looksLikeBuyText(txt)) return false;
                const cls = norm2(el.className || '');
                const looksLikeBuy = cls.includes('red-btn') || cls.includes('buy') || cls.includes('satin') || cls.includes('ticket');
                return looksLikeBuy || norm2(txt).length <= 30;
            }) || null;

            if (!pick) return { ok: false };
            try { pick.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
            let rect = null;
            try { rect = pick.getBoundingClientRect(); } catch {}
            try { pick.click(); } catch {}
            if (!rect) return { ok: true };
            return {
                ok: true,
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2
            };
        }).catch(() => ({ ok: false }));

        if (found && found.ok && Number.isFinite(found.x) && Number.isFinite(found.y)) {
            try {
                await page.mouse.move(found.x, found.y);
                await page.mouse.down();
                await page.mouse.up();
                return true;
            } catch {}
        }

        if (found && found.ok) return true;
        await delay(cfg.TIMEOUTS.CLICK_BUY_DELAY);
    }
    
    // FALLBACK: If button not found/clickable, navigate directly to /koltuk-secim
    if (eventAddress && String(eventAddress).includes('/etkinlik/')) {
        try {
            // Check if URL already ends with /koltuk-secim
            let seatSelectionUrl = String(eventAddress).replace(/\/+$/, '');
            if (!seatSelectionUrl.endsWith('/koltuk-secim')) {
                seatSelectionUrl = seatSelectionUrl + '/koltuk-secim';
            }
            logger.info('clickBuy_fallback_navigating', { 
                reason: 'button_not_found', 
                fallbackUrl: seatSelectionUrl 
            });
            await gotoWithRetry(page, seatSelectionUrl, {
                retries: 2,
                waitUntil: 'networkidle2',
                expectedUrlIncludes: '/koltuk-secim',
                rejectIfHome: false,
                backoffMs: 450
            });
            // Verify we actually reached seat selection
            let currentUrl = '';
            try { currentUrl = page.url(); } catch {}
            if (String(currentUrl).includes('/koltuk-secim')) {
                logger.info('clickBuy_fallback_success', { url: currentUrl });
                return true;
            }
        } catch (e) {
            logger.warn('clickBuy_fallback_failed', { error: e?.message || String(e) });
        }
    }
    
    return false;
}

async function handlePrioritySaleModal(page, opts = null) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const prioritySale = o.prioritySale;
    const fanCardCode = o.fanCardCode;
    const identity = o.identity;

    const desired = (typeof prioritySale === 'string' ? String(prioritySale).trim() : '');
    const shouldTry = prioritySale === true || desired.length > 0;
    if (!shouldTry) return false;

    const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();

    const isOpen = async () => {
        try {
            return await page.evaluate(() => {
                const isVisible = (el) => {
                    if (!el) return false;
                    const st = window.getComputedStyle(el);
                    if (!st) return false;
                    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0) return false;
                    const r = el.getBoundingClientRect?.();
                    if (!r) return true;
                    return (r.width > 4 && r.height > 4);
                };

                const desired = (() => {
                    try { return String(window.__passobotPrioritySaleDesired || '').toLowerCase(); } catch { return ''; }
                })();

                const candidates = [];
                const bs = Array.from(document.querySelectorAll('.modal.show, .modal.fade.show')).filter(isVisible);
                for (const m of bs) candidates.push(m);
                const swal = document.querySelector('.swal2-container.swal2-shown');
                if (isVisible(swal)) candidates.push(swal);
                const roleDlg = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"], [aria-modal="true"]')).filter(isVisible);
                for (const d of roleDlg) candidates.push(d);

                for (const root of candidates) {
                    const txt = (root.innerText || '').toLowerCase();
                    const hasPriorityItems = !!root.querySelector('.priority-sale-select-item');
                    const hasPriorityHints = txt.includes('üyelik') || txt.includes('uyelik') || txt.includes('kampanya') || txt.includes('öncelik') || txt.includes('oncelik');
                    const matchesDesired = desired ? txt.includes(desired) : false;
                    // Treat as open only if it's actually the priority-sale selection dialog.
                    if (hasPriorityItems) return true;
                    if ((hasPriorityHints || matchesDesired) && /\b(devam|g[oö]nder|onayla)\b/i.test(txt)) return true;
                }

                return false;
            });
        } catch {
            return false;
        }
    };

    const waitForModal = async (maxMs = 8000) => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < maxMs) {
            if (await isOpen()) return true;
            try { await delay(250); } catch {}
        }
        return false;
    };

    const trySelect = async () => {
        try {
            return await page.evaluate((want) => {
                const norm2 = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                const normKey = (s) => {
                    const t = norm2(s)
                        .replace(/[ıİ]/g, 'i')
                        .replace(/[şŞ]/g, 's')
                        .replace(/[ğĞ]/g, 'g')
                        .replace(/[üÜ]/g, 'u')
                        .replace(/[öÖ]/g, 'o')
                        .replace(/[çÇ]/g, 'c');
                    return t.replace(/[^a-z0-9]+/g, '');
                };
                const isVisible = (el) => {
                    if (!el) return false;
                    const st = window.getComputedStyle(el);
                    if (!st) return false;
                    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0) return false;
                    const r = el.getBoundingClientRect?.();
                    if (!r) return true;
                    return (r.width > 4 && r.height > 4);
                };

                const pickDialogRoot = () => {
                    // Prefer the modal that actually contains priority sale items
                    const shown = Array.from(document.querySelectorAll('.modal.show, .modal.fade.show')).filter(isVisible);
                    const withItems = shown.find(m => !!m.querySelector('.priority-sale-select-item'));
                    if (withItems) return withItems;
                    const swal = document.querySelector('.swal2-container.swal2-shown');
                    if (isVisible(swal) && swal.querySelector('.priority-sale-select-item')) return swal;
                    const roleDlg = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"], [aria-modal="true"]')).filter(isVisible);
                    const roleWithItems = roleDlg.find(d => !!d.querySelector('.priority-sale-select-item'));
                    if (roleWithItems) return roleWithItems;
                    // Fallback to any visible dialog (last resort)
                    return shown[0] || (isVisible(swal) ? swal : null) || roleDlg[0] || null;
                };

                const root = pickDialogRoot();
                if (!root) return { ok: false };

                const items = Array.from(root.querySelectorAll('.priority-sale-select-item'));
                if (!items.length) return { ok: false, reason: 'no_items' };

                const options = items.map(it => {
                    const txt = it.querySelector('.priority-sale-select-item-title')?.innerText || it.innerText || '';
                    return String(txt || '').trim();
                }).filter(Boolean);

                let target = null;
                const wantText = (want && norm2(want)) ? String(want) : '';
                const wantNorm = wantText ? norm2(wantText) : '';
                const wantK = wantText ? normKey(wantText) : '';
                if (wantText && wantK) {
                    // Strict match: prefer normalized equality, then key-includes.
                    target = items.find(it => {
                        const txt = it.querySelector('.priority-sale-select-item-title')?.innerText || it.innerText || '';
                        return normKey(txt) === wantK;
                    }) || items.find(it => {
                        const txt = it.querySelector('.priority-sale-select-item-title')?.innerText || it.innerText || '';
                        const k = normKey(txt);
                        return k.includes(wantK) || wantK.includes(k) || norm2(txt).includes(wantNorm);
                    }) || null;
                    if (!target) {
                        return { ok: false, reason: 'desired_not_found', want: wantText, options };
                    }
                } else {
                    // boolean/on: select first available
                    target = items[0];
                }
                try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
                try { target.click(); } catch {}

                const pickInput = () => {
                    const all = Array.from(root.querySelectorAll('input, textarea')).filter(Boolean);
                    const vis = all.filter(i => {
                        try {
                            const st = window.getComputedStyle(i);
                            if (!st) return true;
                            if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0) return false;
                            const r = i.getBoundingClientRect?.();
                            if (!r) return true;
                            return (r.width > 4 && r.height > 4);
                        } catch {
                            return true;
                        }
                    });
                    const preferred = vis.find(i => {
                        const key = `${i.getAttribute('name') || ''} ${i.getAttribute('id') || ''} ${i.getAttribute('placeholder') || ''}`.toLowerCase();
                        return key.includes('tc') || key.includes('kimlik') || key.includes('identity') || key.includes('tckn');
                    });
                    return preferred || vis[0] || null;
                };

                const input = pickInput();
                const placeholder = input?.getAttribute('placeholder') || '';
                const name = input?.getAttribute('name') || '';
                const id = input?.getAttribute('id') || '';
                const labelText = (() => {
                    try {
                        if (!input) return '';
                        const lbl = (id && root.querySelector(`label[for="${CSS.escape(id)}"]`)) || input.closest('label');
                        return (lbl?.innerText || '').trim();
                    } catch {
                        return '';
                    }
                })();

                return {
                    ok: true,
                    hasInput: !!input,
                    placeholder,
                    name,
                    id,
                    labelText,
                    selectedTitle: target.querySelector('.priority-sale-select-item-title')?.innerText || '',
                    options
                };
            }, desired);
        } catch {
            return { ok: false };
        }
    };

    const fillInputIfNeeded = async (selInfo) => {
        const placeholder = String(selInfo?.placeholder || '');
        const labelText = String(selInfo?.labelText || '');
        const name = String(selInfo?.name || '');
        const id = String(selInfo?.id || '');

        const hint = norm(`${placeholder} ${labelText} ${name} ${id}`);
        let value = '';
        if (hint.includes('t.c') || hint.includes('tc') || hint.includes('tckn') || hint.includes('kimlik')) value = String(identity || '').trim();
        else value = String(fanCardCode || identity || '').trim();
        if (!value) return false;

        const modalSel = '.modal.show, .modal.fade.show, .swal2-container.swal2-shown, [role="dialog"][aria-modal="true"], [aria-modal="true"]';
        try {
            // Clear the *correct* input inside the same visible modal root
            await page.evaluate((info) => {
                const isVisible = (el) => {
                    if (!el) return false;
                    const st = window.getComputedStyle(el);
                    if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                    const r = el.getBoundingClientRect?.();
                    if (!r) return true;
                    return r.width > 4 && r.height > 4;
                };
                const roots = Array.from(document.querySelectorAll('.modal.show, .modal.fade.show')).filter(isVisible);
                const root = roots.find(r => !!r.querySelector('.priority-sale-select-item')) || roots[0]
                  || document.querySelector('.swal2-container.swal2-shown') || document;

                const pick = () => {
                    const id = String(info?.id || '').trim();
                    const name = String(info?.name || '').trim();
                    const ph = String(info?.placeholder || '').toLowerCase();

                    if (id) {
                        try {
                            const el = root.querySelector(`#${CSS.escape(id)}`);
                            if (el && isVisible(el)) return el;
                        } catch {}
                    }
                    if (name) {
                        try {
                            const el = root.querySelector(`[name="${CSS.escape(name)}"]`);
                            if (el && isVisible(el)) return el;
                        } catch {}
                    }

                    const inputs = Array.from(root.querySelectorAll('input, textarea')).filter(isVisible);
                    const tcLike = inputs.find(i => {
                        const key = `${i.getAttribute('name') || ''} ${i.getAttribute('id') || ''} ${i.getAttribute('placeholder') || ''} ${i.getAttribute('aria-label') || ''}`.toLowerCase();
                        const ml = String(i.getAttribute('maxlength') || '');
                        const is11 = ml === '11' || ml === 11;
                        return (key.includes('tc') || key.includes('kimlik') || key.includes('tckn') || key.includes('identity') || ph.includes('tc') || ph.includes('kimlik')) && (is11 || key.includes('11'));
                    });
                    return tcLike || inputs.find(i => String(i.getAttribute('maxlength') || '') === '11') || inputs[0] || null;
                };

                const input = pick();
                if (!input) return;

                // Clear all tc-like candidates (sometimes the bound field is not the one we picked)
                const allInputs = Array.from(root.querySelectorAll('input, textarea')).filter(Boolean);
                const candidates = allInputs.filter((i) => {
                    const key = `${i.getAttribute('name') || ''} ${i.getAttribute('id') || ''} ${i.getAttribute('placeholder') || ''} ${i.getAttribute('aria-label') || ''}`.toLowerCase();
                    const ml = String(i.getAttribute('maxlength') || '');
                    const tcLike = key.includes('tc') || key.includes('kimlik') || key.includes('tckn') || key.includes('identity') || key.includes('param1');
                    const is11 = ml === '11' || ml === 11;
                    return tcLike || is11;
                });
                for (const el of (candidates.length ? candidates : [input])) {
                    try { el.focus?.(); } catch {}
                    try { el.select?.(); } catch {}
                    try { el.value = ''; } catch {}
                    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
                    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
                }
            }, { id, name, placeholder });
        } catch {}

        try {
            // Wait briefly for input to appear after selecting the option
            try {
                await page.waitForSelector('.modal.show input, .modal.fade.show input, .swal2-container.swal2-shown input, [role="dialog"] input, [aria-modal="true"] input, .modal.show textarea, .modal.fade.show textarea, .swal2-container.swal2-shown textarea', { timeout: 2500 });
            } catch {}

            // Use a targeted selector first (id/name), then fallback to visible modal inputs.
            const selector = id ? `#${CSS.escape(id)}` : (name ? `[name="${name.replace(/"/g, '\\"')}"]` : `${modalSel} input, ${modalSel} textarea`);
            let inputHandle = await page.$(selector);
            if (!inputHandle) {
                inputHandle = await page.$(`${modalSel} input, ${modalSel} textarea`);
            }
            if (inputHandle) {
                for (let k = 1; k <= 2; k++) {
                    try { await inputHandle.click({ clickCount: 3 }); } catch {}
                    try { await inputHandle.type(value, { delay: 10 }); } catch {}
                    try {
                        await page.evaluate((v, info) => {
                            const isVisible = (el) => {
                                if (!el) return false;
                                const st = window.getComputedStyle(el);
                                if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                                const r = el.getBoundingClientRect?.();
                                if (!r) return true;
                                return r.width > 4 && r.height > 4;
                            };
                            const roots = Array.from(document.querySelectorAll('.modal.show, .modal.fade.show')).filter(isVisible);
                            const root = roots.find(r => !!r.querySelector('.priority-sale-select-item')) || roots[0]
                              || document.querySelector('.swal2-container.swal2-shown') || document;

                            const id = String(info?.id || '').trim();
                            const name = String(info?.name || '').trim();
                            let input = null;
                            if (id) {
                                try { input = root.querySelector(`#${CSS.escape(id)}`); } catch {}
                            }
                            if (!input && name) {
                                try { input = root.querySelector(`[name="${CSS.escape(name)}"]`); } catch {}
                            }
                            if (!input) {
                                const inputs = Array.from(root.querySelectorAll('input, textarea')).filter(isVisible);
                                input = inputs.find(i => String(i.getAttribute('maxlength') || '') === '11') || inputs[0] || null;
                            }
                            if (!input) return;

                            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                            const setVal = (el) => {
                                try {
                                    if (setter) setter.call(el, String(v || ''));
                                    else el.value = String(v || '');
                                } catch {
                                    try { el.value = String(v || ''); } catch {}
                                }
                                try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
                                try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
                                try { el.dispatchEvent(new Event('blur', { bubbles: true })); } catch {}
                            };

                            // Set value on the picked input and also any other tc-like candidates (bound field may differ)
                            const allInputs = Array.from(root.querySelectorAll('input, textarea')).filter(isVisible);
                            const candidates = allInputs.filter((i) => {
                                const key = `${i.getAttribute('name') || ''} ${i.getAttribute('id') || ''} ${i.getAttribute('placeholder') || ''} ${i.getAttribute('aria-label') || ''}`.toLowerCase();
                                const ml = String(i.getAttribute('maxlength') || '');
                                const is11 = ml === '11' || ml === 11;
                                return is11 || key.includes('tc') || key.includes('kimlik') || key.includes('tckn') || key.includes('identity') || key.includes('param1');
                            });
                            setVal(input);
                            for (const el of candidates) setVal(el);
                        }, value, { id, name });
                    } catch {}

                    const filledOk = await page.evaluate(() => {
                        const isVisible = (el) => {
                            if (!el) return false;
                            const st = window.getComputedStyle(el);
                            if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                            const r = el.getBoundingClientRect?.();
                            if (!r) return true;
                            return r.width > 4 && r.height > 4;
                        };
                        const roots = Array.from(document.querySelectorAll('.modal.show, .modal.fade.show')).filter(isVisible);
                        const root = roots.find(r => !!r.querySelector('.priority-sale-select-item')) || roots[0]
                          || document.querySelector('.swal2-container.swal2-shown') || document;
                        const inputs = Array.from(root.querySelectorAll('input, textarea')).filter(isVisible);
                        const input = inputs.find(i => String(i.getAttribute('maxlength') || '') === '11') || inputs[0] || null;
                        const val = input ? String(input.value || '').trim() : '';
                        return { ok: !!val, len: val.length };
                    }).catch(() => ({ ok: false, len: 0 }));
                    try { logger.info('prioritySale.input.fill', { ok: !!filledOk?.ok, len: filledOk?.len || 0, attempt: k }); } catch {}

                    // Debug: report what the modal actually contains (helps when UI doesn't show the value)
                    try {
                        const dbg = await page.evaluate(() => {
                            const isVisible = (el) => {
                                if (!el) return false;
                                const st = window.getComputedStyle(el);
                                if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                                const r = el.getBoundingClientRect?.();
                                if (!r) return true;
                                return r.width > 4 && r.height > 4;
                            };
                            const roots = Array.from(document.querySelectorAll('.modal.show, .modal.fade.show')).filter(isVisible);
                            const root = roots.find(r => !!r.querySelector('.priority-sale-select-item')) || roots[0]
                              || document.querySelector('.swal2-container.swal2-shown') || document;
                            const inputs = Array.from(root.querySelectorAll('input, textarea'));
                            return inputs.map((i) => {
                                const key = `${i.getAttribute('name') || ''} ${i.getAttribute('id') || ''} ${i.getAttribute('placeholder') || ''} ${i.getAttribute('aria-label') || ''}`.toLowerCase();
                                return {
                                    name: i.getAttribute('name') || null,
                                    id: i.getAttribute('id') || null,
                                    ph: i.getAttribute('placeholder') || null,
                                    ml: i.getAttribute('maxlength') || null,
                                    type: i.getAttribute('type') || null,
                                    visible: isVisible(i),
                                    key,
                                    len: String(i.value || '').trim().length
                                };
                            });
                        });
                        logger.info('prioritySale.input.debug', { fields: dbg });
                    } catch {}

                    if (filledOk?.ok) break;
                    try { await delay(150); } catch {}
                }
            }
        } catch {}
        return true;
    };

    const waitForPriorityValidation = async (maxMs = 4500) => {
        try {
            const res = await page.waitForResponse((r) => {
                try {
                    const u = String(r?.url?.() || '');
                    if (!/\/api\/passoweb\/priorityvalidationrule(\b|\?|#|\/)/i.test(u)) return false;
                    const req = r.request?.();
                    const m = String(req?.method?.() || '').toUpperCase();
                    if (m && m !== 'POST') return false;
                    return true;
                } catch {
                    return false;
                }
            }, { timeout: maxMs });

            let reqPayload = null;
            try {
                const req = res.request?.();
                const postData = req?.postData?.();
                if (postData) reqPayload = postData;
            } catch {}

            try {
                if (reqPayload) {
                    const parsed = JSON.parse(reqPayload);
                    const p1 = parsed?.param1 != null ? String(parsed.param1) : '';
                    if (!p1 || !p1.trim()) {
                        logger.warn('prioritySale.validation.empty_param1', { request: parsed });
                    }
                }
            } catch {}

            let json = null;
            try { json = await res.json(); } catch {}
            try {
                logger.info('prioritySale.validation.response', {
                    status: (() => { try { return res.status(); } catch { return null; } })(),
                    request: reqPayload,
                    json
                });
            } catch {}
            return { ok: true, status: (() => { try { return res.status(); } catch { return null; } })(), request: reqPayload, json };
        } catch {
            return { ok: false };
        }
    };

    const clickDevam = async () => {
        // Clicking inside page.evaluate() can fail when overlays/interceptors are present.
        // Mark the real button in DOM and click via Puppeteer for reliability.
        let marked = false;
        try {
            marked = await page.evaluate(() => {
                const norm2 = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                const isVisible = (el) => {
                    if (!el) return false;
                    const st = window.getComputedStyle(el);
                    if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                    const r = el.getBoundingClientRect?.();
                    if (!r) return true;
                    return (r.width > 4 && r.height > 4);
                };
                const roots = [];
                const shown = Array.from(document.querySelectorAll('.modal.show, .modal.fade.show')).filter(isVisible);
                for (const m of shown) roots.push(m);
                const swal = document.querySelector('.swal2-container.swal2-shown');
                if (isVisible(swal)) roots.push(swal);
                const roleDlg = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"], [aria-modal="true"]')).filter(isVisible);
                for (const d of roleDlg) roots.push(d);

                const root = roots.find(r => !!r.querySelector('.priority-sale-select-item')) || roots[0] || document;
                const btns = Array.from(root.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]') || []);
                const pick = (re) => btns.find(x => re.test(norm2(x.innerText || x.textContent || x.value || x.getAttribute('aria-label') || '')));
                const b = pick(/^devam$/i) || pick(/devam/i) || pick(/g[oö]nder/i) || pick(/onayla/i) || null;
                if (!b) return false;
                const disabled = (b.getAttribute('disabled') != null) || (b.getAttribute('aria-disabled') === 'true') || (b.classList?.contains('disabled'));
                if (disabled) return false;
                try { b.setAttribute('data-passobot-priority-continue', '1'); } catch {}
                try { b.scrollIntoView?.({ block: 'center', inline: 'center' }); } catch {}
                return true;
            }).catch(() => false);
        } catch {}

        if (!marked) {
            try { await page.evaluate(() => { try { document.querySelector('[data-passobot-priority-continue]')?.removeAttribute('data-passobot-priority-continue'); } catch {} }); } catch {}
            return;
        }

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const btn = await page.$('[data-passobot-priority-continue="1"]');
                if (btn) {
                    try { await btn.click({ delay: 30 }); } catch {}
                }
            } catch {}

            // Fallback: submit enclosing form if click didn't close modal
            try {
                await page.evaluate(() => {
                    const b = document.querySelector('[data-passobot-priority-continue="1"]');
                    const f = b?.closest('form');
                    if (!f) return;
                    try { f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); } catch {}
                    try { (typeof f.requestSubmit === 'function') && f.requestSubmit(b); } catch {}
                });
            } catch {}

            try { await delay(250); } catch {}
            const stillOpen = await isOpen().catch(() => false);
            if (!stillOpen) break;
        }

        try { await page.evaluate(() => { try { document.querySelector('[data-passobot-priority-continue]')?.removeAttribute('data-passobot-priority-continue'); } catch {} }); } catch {}
    };

    const clickTamamIfPresent = async () => {
        try {
            await page.evaluate(() => {
                const norm2 = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                const btns = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
                const b = btns.find(x => {
                    const t = norm2(x.innerText || x.textContent || x.value || x.getAttribute('aria-label') || '');
                    return t === 'tamam' || t.includes('tamam');
                }) || null;
                try { b?.click(); } catch {}
            });
        } catch {}
    };

    try {
        try {
            await page.evaluate((d) => { try { window.__passobotPrioritySaleDesired = String(d || ''); } catch {} }, desired);
        } catch {}

        const seen = await waitForModal(8000);
        if (!seen) {
            try {
                const diag = await page.evaluate(() => {
                    const norm2 = (s) => (s || '').toString().replace(/\s+/g, ' ').trim();
                    const nodes = Array.from(document.querySelectorAll('.modal, .modal-dialog, .swal2-container, [role="dialog"], [aria-modal="true"]')).slice(0, 8);
                    return {
                        url: location.href,
                        dialogCount: nodes.length,
                        dialogSamples: nodes.map(n => ({
                            cls: norm2(n.getAttribute('class') || '').slice(0, 160),
                            text: norm2(n.innerText || '').slice(0, 220)
                        }))
                    };
                }).catch(() => null);
                logger.info('prioritySale.modal.not_seen', { desired: desired || null, url: (() => { try { return page.url(); } catch { return null; } })(), diag });
            } catch {}
            return false;
        }

        try {
            logger.info('prioritySale.modal.detected', { desired: desired || null });
        } catch {}

        for (let attempt = 1; attempt <= 8; attempt++) {
            const opened = await isOpen();
            if (!opened) return true;

            const selInfo = await trySelect();
            if (!selInfo?.ok) {
                if (desired && String(desired).trim()) {
                    try { logger.warn('prioritySale.desired_not_found', { desired, reason: selInfo?.reason || null, options: selInfo?.options || null }); } catch {}
                    return false;
                }
            }
            if (selInfo?.ok) {
                try { logger.info('prioritySale.option.selected', { desired: desired || null, selectedTitle: selInfo?.selectedTitle || null, hasInput: !!selInfo?.hasInput }); } catch {}
            }
            if (selInfo?.ok) {
                if (selInfo?.hasInput) {
                    await fillInputIfNeeded(selInfo);
                }
            }
            const validationWait = waitForPriorityValidation(4500);
            await clickDevam();
            try {
                const v = await validationWait;
                if (v && v.ok) {
                    const isError = (() => {
                        try { return !!v?.json?.isError; } catch { return null; }
                    })();
                    const resultCode = (() => {
                        try { return v?.json?.resultCode; } catch { return null; }
                    })();
                    try { logger.info('prioritySale.validation.result', { isError, resultCode }); } catch {}

                    // Avoid spamming retries when backend says request is bad or asks for cooldown
                    try {
                        const msg = String(v?.json?.message || '');
                        if (isError && (resultCode === 2 || /bad request/i.test(msg))) {
                            logger.warn('prioritySale.validation.bad_request', { resultCode, message: msg });
                            return false;
                        }
                        if (isError && resultCode === 20363) {
                            const m = msg.match(/(\d+)\s*saniye/i);
                            const sec = m ? Number(m[1]) : 0;
                            logger.warn('prioritySale.validation.cooldown', { seconds: sec || null, message: msg });
                            if (sec && Number.isFinite(sec) && sec > 0 && sec < 120) {
                                await delay((sec + 1) * 1000);
                            }
                        }
                    } catch {}
                }
            } catch {}
            await delay(700);
            await clickTamamIfPresent();
            // Give the modal a chance to close; otherwise next loop will re-select repeatedly.
            try {
                await page.waitForFunction(() => {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const st = window.getComputedStyle(el);
                        if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                        const r = el.getBoundingClientRect?.();
                        if (!r) return true;
                        return (r.width > 4 && r.height > 4);
                    };
                    const roots = Array.from(document.querySelectorAll('.modal.show, .modal.fade.show, .swal2-container.swal2-shown, [role="dialog"][aria-modal="true"], [aria-modal="true"]'));
                    const open = roots.filter(isVisible).some(r => !!r.querySelector('.priority-sale-select-item'));
                    return !open;
                }, { timeout: 2500 });
            } catch {}
            await delay(300);
            if (!(await isOpen())) return true;
        }
    } catch {}

    return false;
}

async function chooseCategoryAndRandomBlock(page, categoryType, alternativeCategory, selectionMode = 'legacy') {
    try {
        const u = (() => { try { return page.url(); } catch { return ''; } })();
        if (/\/giris(\?|$)/i.test(String(u || ''))) {
            throw new Error('Kategori/blok seçimi login sayfasında başlatılamaz');
        }
    } catch {}

    const cat = String(categoryType || '').trim();
    const alt = String(alternativeCategory || '').trim();
    const reCat = new RegExp(cat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const reAlt = alt ? new RegExp(alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
    const UNAVAILABLE_TEXT = 'şu anda uygun bilet bulunamamaktadır';

    const mode = String(selectionMode || 'legacy').toLowerCase();

    // New UI: SVG stadium layout block selection
    if (mode === 'svg') {
        const readSeatmapStateAcrossFrames = async () => {
            try {
                const frames = page.frames();
                const results = await Promise.all(frames.map(async (f) => {
                    try {
                        return await f.evaluate((seatSel) => {
                            const seatmapCount = document.querySelectorAll('svg.seatmap-svg').length;
                            const seatRectCount = document.querySelectorAll('svg.seatmap-svg g[id^="seat"] rect').length;
                            const seatNodes = Math.max(
                                document.querySelectorAll(String(seatSel || '')).length,
                                seatRectCount
                            );
                            const bodyText = (document.body?.innerText || '').toLowerCase();
                            const noTicket = bodyText.includes('uygun bilet bulunamamaktadır') || bodyText.includes('uygun koltuk bulunamamaktadır') || bodyText.includes('koltuk bulunamadı');
                            const hasSeatmapSvg = seatmapCount > 0;
                            const hasSeatmapContainer = !!document.querySelector('.seatmap-container, .seat-map, [class*="seatmap"], [id*="seatmap"], #toolTipList');
                            return { ok: true, seatNodes, noTicket, hasSeatmapSvg, hasSeatmapContainer, seatmapCount, seatRectCount, url: location.href };
                        }, SEAT_NODE_SELECTOR);
                    } catch {
                        return { ok: false, seatNodes: 0, noTicket: false, hasSeatmapSvg: false, url: (() => { try { return f.url(); } catch { return null; } })() };
                    }
                }));

                const seatmapFrameHint = await page.evaluate(() => {
                    const frames = Array.from(document.querySelectorAll('iframe'));
                    const visible = (el) => {
                        try {
                            const r = el.getBoundingClientRect();
                            if (!r || !r.width || !r.height) return false;
                            const style = window.getComputedStyle(el);
                            if (!style) return true;
                            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
                        } catch {
                            return false;
                        }
                    };
                    const looksSeat = (src) => {
                        const s = String(src || '').toLowerCase();
                        return s.includes('koltuk') || s.includes('seat') || s.includes('seatmap') || s.includes('venue');
                    };
                    const hits = frames
                        .map(f => ({ src: f.getAttribute('src') || '', id: f.getAttribute('id') || '', name: f.getAttribute('name') || '' }))
                        .filter(x => looksSeat(x.src) || looksSeat(x.id) || looksSeat(x.name));
                    const anyVisible = frames.some(f => visible(f) && (looksSeat(f.getAttribute('src')) || looksSeat(f.getAttribute('id')) || looksSeat(f.getAttribute('name'))));
                    return { anyVisible, count: hits.length, examples: hits.slice(0, 3) };
                }).catch(() => ({ anyVisible: false, count: 0, examples: [] }));

                const agg = {
                    seatNodes: 0,
                    noTicket: false,
                    hasSeatmapSvg: false,
                    hasSeatmapContainer: false,
                    hasSeatmapFrameHint: !!seatmapFrameHint?.anyVisible,
                    seatmapFrameHint,
                    url: (() => { try { return page.url(); } catch { return null; } })(),
                    frameCount: frames.length
                };
                for (const r of results) {
                    if (!r) continue;
                    agg.seatNodes = Math.max(agg.seatNodes, Number(r.seatNodes || 0));
                    agg.noTicket = agg.noTicket || !!r.noTicket;
                    agg.hasSeatmapSvg = agg.hasSeatmapSvg || !!r.hasSeatmapSvg;
                    agg.hasSeatmapContainer = agg.hasSeatmapContainer || !!r.hasSeatmapContainer;
                }
                return agg;
            } catch {
                return { seatNodes: 0, noTicket: false, hasSeatmapSvg: false, hasSeatmapFrameHint: false, seatmapFrameHint: null, url: null, frameCount: 0 };
            }
        };

        const clickDevamAny = async () => {
            try {
                await page.evaluate(() => {
                    const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                    const btns = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
                    const b = btns.find(x => norm(x.innerText || x.textContent || x.value || '').startsWith('devam'));
                    try { b?.click(); } catch {}
                });
            } catch {}
        };

        const dismissMustSelectProductModal = async () => {
            try {
                return await page.evaluate(() => {
                    const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                    const txt = norm(document.body?.innerText || '');
                    if (!txt.includes('lütfen en az bir adet ürün seçiniz')) return { found: false };

                    // Try common modal close buttons.
                    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], .swal2-confirm, .swal2-cancel, .modal-footer button, .modal-header button'));
                    const closeBtn = candidates.find(b => {
                        const t = norm(b.innerText || b.textContent || b.value || '');
                        return t === 'tamam' || t === 'kapat' || t === 'ok' || t.includes('tamam') || t.includes('kapat');
                    }) || candidates.find(b => {
                        const t = norm(b.innerText || b.textContent || b.value || '');
                        return t.includes('tamam') || t.includes('kapat') || t.includes('ok');
                    });
                    try { closeBtn?.click(); } catch {}
                    return { found: true, clicked: !!closeBtn };
                });
            } catch {
                return { found: false };
            }
        };

        const clickSelfSelectAny = async () => {
            const found = await page.evaluate(() => {
                const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                const els = Array.from(document.querySelectorAll('button, a, [role="button"], div[role="button"], input[type="button"], input[type="submit"]'));
                const el = els.find(x => norm(x.innerText || x.textContent || x.value || '').includes('kendim seçmek istiyorum'));
                if (!el) return { ok: false, reason: 'not_found' };
                try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
                const r = el.getBoundingClientRect();
                if (!r || !r.width || !r.height) return { ok: false, reason: 'no_rect' };
                const x = r.left + (r.width / 2);
                const y = r.top + (r.height / 2);
                return { ok: true, x, y };
            }).catch(() => ({ ok: false, reason: 'eval_failed' }));

            if (found && found.ok && Number.isFinite(found.x) && Number.isFinite(found.y)) {
                try {
                    await page.mouse.move(found.x, found.y);
                    await page.mouse.down();
                    await page.mouse.up();
                    return true;
                } catch {}
            }

            try {
                await page.evaluate(() => {
                    const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                    const btns = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
                    const b = btns.find(x => norm(x.innerText || x.textContent || x.value || '').includes('kendim seçmek istiyorum'));
                    try { b?.click(); } catch {}
                });
            } catch {}
            return false;
        };

        // If seatmap is already present on the page, do not reset UI by clicking intermediate buttons.
        // This happens in some flows where both layout + seatmap are visible at the same time.
        try {
            const initial = await readSeatmapStateAcrossFrames();
            // IMPORTANT: some pages render seatmap *containers* before the actual SVG is loaded.
            // Only treat seatmap as ready when we see real seat nodes (rects/nodes) or seatmap SVG.
            const seatmapAlready = (initial?.hasSeatmapSvg && initial?.seatNodes > 0) || (Number(initial?.seatNodes || 0) > 0);
            const ui = await page.evaluate(() => {
                const blocksCount = document.querySelectorAll('svg.svgLayout g.block, svg.svgLayout .svgBlock, .svgLayout g.block, .svgLayout .svgBlock').length;
                const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                const els = Array.from(document.querySelectorAll('button, a, [role="button"], div[role="button"], input[type="button"], input[type="submit"]'));
                const hasSelfSelectBtn = els.some(x => norm(x.innerText || x.textContent || x.value || '').includes('kendim seçmek istiyorum'));
                return { blocksCount, hasSelfSelectBtn };
            }).catch(() => ({ blocksCount: 0, hasSelfSelectBtn: false }));

            // Only skip when we're clearly in seatmap view.
            // If layout blocks AND the "Kendim seçmek istiyorum" button are still visible, we may need to select a block to change the seatmap.
            const clearlySeatmapView = !ui?.blocksCount || !ui?.hasSelfSelectBtn;
            if (seatmapAlready && clearlySeatmapView && !initial?.noTicket) {
                logger.info('categoryBlock:svg_seatmap_already_present_skip', { initial, ui });
                return;
            }
        } catch {}

        // SVG layout can be AB-tested / gated; if not present, fallback to legacy dropdown flow.
        const svgRootOk = await page.waitForSelector('svg.svgLayout, svg .svgLayout, svg[class*="svgLayout"], .svgLayout', { timeout: 15000 }).then(() => true).catch(() => false);
        if (!svgRootOk) {
            logger.warn('categoryBlock:svg_layout_missing_fallback_legacy', {
                url: (() => { try { return page.url(); } catch { return null; } })(),
                title: await page.title().catch(() => null)
            });
            // In svg mode do NOT fallback to legacy: on home/login pages .custom-select-box doesn't exist.
            throw new Error('SVG_LAYOUT_MISSING');
        } else {
            const tried = new Set();
            const maxTries = 40;
            for (let attempt = 1; attempt <= maxTries; attempt++) {
                // This intermediate screen sometimes ignores programmatic clicks. Force a real mouse click and retry.
                let layoutOk = false;
                for (let s = 0; s < 3; s++) {
                    // Only click if blocks are not already present; avoid toggling UI unnecessarily.
                    const blocksExist = await page.evaluate(() => {
                        return document.querySelectorAll('svg.svgLayout g.block, svg.svgLayout .svgBlock, .svgLayout g.block, .svgLayout .svgBlock').length > 0;
                    }).catch(() => false);
                    if (!blocksExist) await clickSelfSelectAny();
                    layoutOk = await page.waitForSelector('svg.svgLayout, svg .svgLayout, svg[class*="svgLayout"], .svgLayout', { timeout: 6000 })
                        .then(() => true)
                        .catch(() => false);
                    if (layoutOk) break;
                    await delay(650);
                }

                if (!layoutOk) {
                    logger.warn('categoryBlock:svg_layout_not_ready_retry', { attempt });
                    await delay(900);
                    continue;
                }

                const blocksOk = await page.waitForSelector('svg.svgLayout g.block, svg.svgLayout .svgBlock, .svgLayout g.block, .svgLayout .svgBlock', { timeout: 15000 })
                    .then(() => true)
                    .catch(() => false);

                if (!blocksOk) {
                    logger.warn('categoryBlock:svg_blocks_missing_retry', { attempt });
                    await delay(900);
                    continue;
                }

                const candidates = await page.evaluate(() => {
                    const blocks = Array.from(document.querySelectorAll('svg.svgLayout g.block, .svgLayout g.block'));
                    const paths = Array.from(document.querySelectorAll('svg.svgLayout .svgBlock, .svgLayout .svgBlock'));
                    const items = (blocks.length ? blocks : paths)
                        .map(el => ({
                            id: el.getAttribute('id') || el.id || null,
                            tag: el.tagName
                        }))
                        .filter(x => !!x.id);
                    return items;
                });

                const remaining = (candidates || []).filter(c => c?.id && !tried.has(c.id));
                if (!remaining.length) break;
                const pick = remaining[Math.floor(Math.random() * remaining.length)];

                const readClickPoint = async () => {
                    return await page.evaluate((targetId) => {
                        const el = document.getElementById(targetId);
                        if (!el) return { ok: false, id: targetId, reason: 'not_found' };

                        const asEl = /** @type {Element} */ (el);
                        try { asEl.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}

                        let rect = null;
                        try {
                            if (typeof asEl.getBoundingClientRect === 'function') rect = asEl.getBoundingClientRect();
                        } catch {}

                        if (!rect || !rect.width || !rect.height) {
                            try {
                                const svgEl = /** @type {any} */ (asEl);
                                if (typeof svgEl.getBBox === 'function') {
                                    const b = svgEl.getBBox();
                                    const ctm = svgEl.getScreenCTM && svgEl.getScreenCTM();
                                    if (ctm) {
                                        const x = (b.x + (b.width / 2)) * ctm.a + ctm.e;
                                        const y = (b.y + (b.height / 2)) * ctm.d + ctm.f;
                                        return { ok: true, id: targetId, tag: asEl.tagName, x, y, method: 'getBBox' };
                                    }
                                }
                            } catch {}
                        }

                        if (!rect) return { ok: false, id: targetId, reason: 'no_rect', tag: asEl.tagName };
                        const x = rect.left + (rect.width / 2);
                        const y = rect.top + (rect.height / 2);
                        const top = (() => {
                            try {
                                const t = document.elementFromPoint(x, y);
                                if (!t) return null;
                                return {
                                    tag: t.tagName,
                                    id: t.getAttribute('id') || t.id || null,
                                    className: (t.getAttribute('class') || '').toString().slice(0, 120)
                                };
                            } catch {
                                return null;
                            }
                        })();
                        return { ok: true, id: targetId, tag: asEl.tagName, x, y, method: 'getBoundingClientRect', top };
                    }, pick.id).catch(() => ({ ok: false, id: pick.id, reason: 'eval_failed' }));
                };

                let clicked = { ok: false, id: pick.id, reason: 'no_point' };
                let lastPoint = null;
                for (let c = 0; c < 3; c++) {
                    const clickPoint = await readClickPoint();
                    lastPoint = clickPoint;
                    if (!clickPoint || !clickPoint.ok || !Number.isFinite(clickPoint.x) || !Number.isFinite(clickPoint.y)) {
                        clicked = { ok: false, id: pick.id, reason: 'no_point_eval' };
                        continue;
                    }

                    const jitter = c === 0 ? { dx: 0, dy: 0 } : (c === 1 ? { dx: 3, dy: -3 } : { dx: -3, dy: 3 });
                    const x = clickPoint.x + jitter.dx;
                    const y = clickPoint.y + jitter.dy;

                    try {
                        // Disable obvious overlays if they are on top of our click point.
                        try {
                            const top = clickPoint?.top || null;
                            const topTag = String(top?.tag || '').toUpperCase();
                            const topClass = String(top?.className || '');
                            const looksLikeBlocker = (
                                topTag.startsWith('EFILLI') ||
                                topClass.toLowerCase().includes('efilli') ||
                                topClass.toLowerCase().includes('cookie') ||
                                topClass.toLowerCase().includes('consent')
                            );
                            if (looksLikeBlocker) {
                                await page.evaluate((x, y) => {
                                    try {
                                        const t = document.elementFromPoint(x, y);
                                        const disable = (el) => {
                                            if (!el || !el.style) return;
                                            try { el.style.setProperty('pointer-events', 'none', 'important'); } catch {}
                                            try { el.style.setProperty('visibility', 'hidden', 'important'); } catch {}
                                            try { el.style.setProperty('display', 'none', 'important'); } catch {}
                                        };
                                        disable(t);
                                        try { disable(t?.closest('efilli-layout-dynamic, efilli-layout, efilli-consent, [class*="cookie" i], [class*="consent" i]')); } catch {}
                                    } catch {}
                                }, x, y);
                            }
                        } catch {}

                        await page.mouse.move(x, y, { steps: 12 });
                        await delay(60);
                        // Arm hover listeners before the click
                        try {
                            await page.evaluate((x, y) => {
                                const hit = document.elementFromPoint(x, y);
                                const target = hit?.closest('g.block, .svgBlock') || hit;
                                if (!target) return;
                                const fire = (el, type) => {
                                    try {
                                        const base = {
                                            bubbles: true,
                                            cancelable: true,
                                            view: window,
                                            clientX: x,
                                            clientY: y,
                                            button: 0,
                                            buttons: 0
                                        };
                                        const usePointer = String(type || '').toLowerCase().startsWith('pointer') && (typeof PointerEvent !== 'undefined');
                                        const ev = usePointer
                                            ? new PointerEvent(type, { pointerId: 1, isPrimary: true, pointerType: 'mouse', ...base })
                                            : new MouseEvent(type, base);
                                        el.dispatchEvent(ev);
                                    } catch {}
                                };
                                fire(target, 'pointerover');
                                fire(target, 'mouseover');
                                fire(target, 'pointermove');
                                fire(target, 'mousemove');
                            }, x, y);
                        } catch {}

                        await page.mouse.down();
                        await delay(90);
                        await page.mouse.up();
                        await delay(40);
                        await page.mouse.click(x, y, { delay: 55 });

                        // Also dispatch pointer/mouse sequence on the hit-tested element.
                        try {
                            await page.evaluate((x, y) => {
                                const fire = (el, type, extra = {}) => {
                                    try {
                                        const base = {
                                            bubbles: true,
                                            cancelable: true,
                                            view: window,
                                            clientX: x,
                                            clientY: y,
                                            button: 0,
                                            buttons: 1,
                                            ...extra
                                        };
                                        const usePointer = String(type || '').toLowerCase().startsWith('pointer') && (typeof PointerEvent !== 'undefined');
                                        const ev = usePointer
                                            ? new PointerEvent(type, { pointerId: 1, isPrimary: true, pointerType: 'mouse', ...base })
                                            : new MouseEvent(type, base);
                                        el.dispatchEvent(ev);
                                    } catch {}
                                };
                                try {
                                    const hit = document.elementFromPoint(x, y);
                                    const target = hit?.closest('g.block, .svgBlock') || hit;
                                    if (!target) return;
                                    try { target.style?.setProperty('pointer-events', 'auto', 'important'); } catch {}
                                    fire(target, 'pointerdown');
                                    fire(target, 'mousedown');
                                    fire(target, 'pointerup');
                                    fire(target, 'mouseup');
                                    fire(target, 'click');
                                } catch {}
                            }, x, y);
                        } catch {}

                        clicked = { ok: true, id: pick.id, tag: clickPoint.tag, method: clickPoint.method, try: c + 1, jitter };
                        break;
                    } catch (e) {
                        clicked = { ok: false, id: pick.id, reason: 'mouse_click_failed', error: e?.message || String(e), try: c + 1, jitter };
                    }
                }

                logger.info('categoryBlock:svg_clicked', { attempt, clicked, clickPoint: lastPoint });

                // Stabilization: after clicking a block Passo often shows a loader overlay.
                // Do not attempt to leave / change blocks while loader is visible, otherwise we thrash the UI.
                try {
                    await page.waitForFunction(() => {
                        const isVisible = (el) => {
                            if (!el) return false;
                            const st = window.getComputedStyle(el);
                            if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                            const r = el.getBoundingClientRect?.();
                            if (!r) return true;
                            return r.width > 4 && r.height > 4;
                        };
                        const loader = document.querySelector('.loader, .loading, .spinner, [class*="loader" i], [class*="spinner" i]');
                        if (isVisible(loader)) return false;
                        // Also avoid continuing while the click point is still covered by a loader.
                        const anyLoaderOnTop = (() => {
                            try {
                                const els = Array.from(document.querySelectorAll('.loader, .loading, .spinner, [class*="loader" i], [class*="spinner" i]'));
                                const vis = els.filter(isVisible);
                                if (!vis.length) return false;
                                // If any loader is visible, treat as blocking.
                                return true;
                            } catch {
                                return false;
                            }
                        })();
                        return !anyLoaderOnTop;
                    }, { timeout: 15000 });
                } catch {}

                let seatCheck = { seatNodes: 0, noTicket: false, hasSeatmapSvg: false, url: null, frameCount: 0 };
                let uiReady = false;
                for (let t = 0; t < 4; t++) {
                    // Do not click 'Devam' while still on category/layout view. It triggers "ürün seçiniz" modal.
                    const ui = await page.evaluate(() => {
                        const blocksCount = document.querySelectorAll('svg.svgLayout g.block, svg.svgLayout .svgBlock, .svgLayout g.block, .svgLayout .svgBlock').length;
                        const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                        const els = Array.from(document.querySelectorAll('button, a, [role="button"], div[role="button"], input[type="button"], input[type="submit"]'));
                        const hasSelfSelectBtn = els.some(x => norm(x.innerText || x.textContent || x.value || '').includes('kendim seçmek istiyorum'));
                        return { blocksCount, hasSelfSelectBtn };
                    }).catch(() => ({ blocksCount: 0, hasSelfSelectBtn: false }));

                    const isStillOnLayout = (ui?.blocksCount > 0) && !!ui?.hasSelfSelectBtn;
                    if (!isStillOnLayout) {
                        await clickDevamAny();
                    }
                    const modalDismiss = await dismissMustSelectProductModal();
                    if (modalDismiss?.found) {
                        logger.warn('categoryBlock:devam_modal_dismissed', { t, modalDismiss, ui });
                    }
                    await delay(900 + (t * 450));
                    seatCheck = await readSeatmapStateAcrossFrames();
                    uiReady = (seatCheck.hasSeatmapSvg || seatCheck.seatNodes > 0 || seatCheck.noTicket || seatCheck.hasSeatmapFrameHint);
                    if (uiReady) break;
                }

                const hasSeats = (seatCheck.seatNodes > 0) || seatCheck.hasSeatmapSvg;
                if (uiReady && (hasSeats || seatCheck.hasSeatmapFrameHint) && !seatCheck.noTicket) {
                    logger.info('categoryBlock:svg_block_ok', { attempt, blockId: pick.id, seatCheck });
                    try {
                        await page.evaluate((bid) => {
                            try { window.__passobotLastSvgBlockId = String(bid || ''); } catch {}
                        }, pick.id);
                    } catch {}
                    return { svgBlockId: pick.id };
                }

                tried.add(pick.id);
                logger.info('categoryBlock:svg_block_no_seat', { attempt, blockId: pick.id, seatCheck, triedCount: tried.size });

                // Passo flow: when there are no seats (or seatmap didn't load), "Seçimi değiştir" sends user back to the beginning
                // where "Kendim seçmek istiyorum" is shown again.
                const changed = await page.evaluate(() => {
                    const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                    const btns = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
                    const b = btns.find(x => norm(x.innerText || x.textContent || x.value || '') === 'seçimi değiştir');
                    if (!b) return false;
                    try { b.click(); } catch { return false; }
                    return true;
                }).catch(() => false);

                if (changed) {
                    await page.waitForSelector('button, a, [role="button"], div[role="button"], input[type="button"], input[type="submit"]', { timeout: 15000 })
                        .then(async () => {
                            await page.waitForFunction(() => {
                                const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                                const els = Array.from(document.querySelectorAll('button, a, [role="button"], div[role="button"], input[type="button"], input[type="submit"]'));
                                return els.some(x => norm(x.innerText || x.textContent || x.value || '').includes('kendim seçmek istiyorum'));
                            }, { timeout: 15000 }).catch(() => {});
                        })
                        .catch(() => {});
                } else {
                    await delay(800);
                }
            }

            throw new Error('SVG bloklarında uygun koltuk bulunamadı');
        }
    }

    // Sayfa hazır olana kadar bekle (kategori dropdown'ının görünür olması için)
    for (let i = 0; i < cfg.TIMEOUTS.CATEGORY_SELECTION_RETRIES; i++) {
        const ok = await page.evaluate(() => {
            const selectBox = document.querySelector('.custom-select-box');
            return selectBox && selectBox.offsetParent !== null; // Görünür olup olmadığını kontrol et
        });
        if (ok) break;
        await delay(cfg.DELAYS.CATEGORY_SELECTION);
    }

    await page.waitForSelector('.custom-select-box', { visible: true, timeout: 15000 });

    // open dropdown + choose category
    const optSel = '.dropdown-option:not(.disabled), .dropdown-option, [role="option"], .dropdown-menu [role="menuitem"], .dropdown-menu .dropdown-item';
    for (let attempt = 0; attempt < 3; attempt++) {
        // Kategori dropdown'ının açılmasını engelleyebilecek overlay/modal'ları kapatmayı dene
        try {
            await page.evaluate(() => {
                // swal2 modal
                const swal = document.querySelector('.swal2-container.swal2-shown');
                if (swal) {
                    const btn = swal.querySelector('button.swal2-confirm, button.swal2-cancel, button');
                    try { btn?.click(); } catch {}
                }
                // cookie/consent
                const cookieBtn = Array.from(document.querySelectorAll('button, a'))
                    .find(b => {
                        const t = (b.innerText || b.textContent || '').trim().toLowerCase();
                        return t.includes('kabul') || t.includes('accept') || t.includes('anladım') || t.includes('tamam');
                    });
                try { cookieBtn?.click(); } catch {}

                // EFILLI cookie overlay (custom element + shadow DOM) can block clicks.
                const norm = (s) => (s || '').toString().trim().toLowerCase();
                const isActionText = (t) => {
                    const x = norm(t);
                    return (
                        x.includes('kabul') ||
                        x.includes('accept') ||
                        x.includes('onay') ||
                        x.includes('tamam') ||
                        x.includes('agree') ||
                        x.includes('allow') ||
                        x.includes('kapat') ||
                        x.includes('close')
                    );
                };
                const walkShadow = (root, visit) => {
                    if (!root) return;
                    visit(root);
                    const all = Array.from(root.querySelectorAll('*'));
                    for (const el of all) {
                        const sr = el && el.shadowRoot;
                        if (sr) walkShadow(sr, visit);
                    }
                };

                const tryClickActions = (root) => {
                    if (!root) return false;
                    const btns = Array.from(root.querySelectorAll('button, a, div[role="button"], span[role="button"], [aria-label]'));
                    for (const el of btns) {
                        const t = el.innerText || el.textContent || el.getAttribute('aria-label') || '';
                        if (!isActionText(t)) continue;
                        try { el.click(); } catch {}
                        return true;
                    }
                    return false;
                };

                const disableOverlayEl = (el) => {
                    if (!el || !el.style) return;
                    try { el.style.setProperty('pointer-events', 'none', 'important'); } catch {}
                    try { el.style.setProperty('visibility', 'hidden', 'important'); } catch {}
                    try { el.style.setProperty('display', 'none', 'important'); } catch {}
                };

                const efs = Array.from(document.querySelectorAll('efilli-layout-dynamic, efilli-layout, efilli-consent, [id*="efilli" i], [class*="efilli" i]'));
                let clicked = false;
                for (const ef of efs) {
                    if (!clicked) {
                        clicked = tryClickActions(ef.shadowRoot) || false;
                        if (!clicked) {
                            try {
                                walkShadow(ef.shadowRoot, (sr) => {
                                    if (!clicked) clicked = tryClickActions(sr) || clicked;
                                });
                            } catch {}
                        }
                    }
                    // Always disable; overlay sometimes re-mounts or ignores click
                    disableOverlayEl(ef);
                }

                if (!clicked) {
                    // If still blocking the center point, disable that element too.
                    const box = document.querySelector('.custom-select-box');
                    const r = box ? box.getBoundingClientRect() : null;
                    const cx = r ? (r.left + r.width / 2) : null;
                    const cy = r ? (r.top + r.height / 2) : null;
                    const topEl = (cx != null && cy != null) ? document.elementFromPoint(cx, cy) : null;
                    if (topEl && /^EFILLI/i.test(topEl.tagName || '')) {
                        disableOverlayEl(topEl);
                        try { disableOverlayEl(topEl.closest('efilli-layout-dynamic, efilli-layout, efilli-consent')); } catch {}
                    }
                }
            });
        } catch {}

        // ESC fallback: bazı overlay/modallar click yemeden kapanıyor
        try { await page.keyboard.press('Escape'); } catch {}

        // .custom-select-box'a gerçek mouse click (SPA handler için daha stabil)
        let optTexts = [];
        let options = [];
        try {
            const box = await page.$('.custom-select-box');
            const bb = box ? await box.boundingBox() : null;
            if (bb) {
                await page.mouse.move(bb.x + (bb.width / 2), bb.y + (bb.height / 2));
                await page.mouse.down();
                await page.mouse.up();
            } else {
                await page.click('.custom-select-box', { delay: 30 });
            }
        } catch {}
        try {
            await page.waitForSelector(optSel, { visible: true, timeout: 5000 });
            optTexts = await page.$$eval(optSel, els => els.map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean));
            options = await page.$$(optSel);
        } catch (e) {
            logger.warn('categoryBlock:dropdown_options_missing', { attempt: attempt + 1, error: e?.message || String(e) });
        }

        if (!options || !options.length || !optTexts || !optTexts.length) {
            await delay(600);
            continue;
        }

        let selectedText = null;
        let idx = -1;
        if (mode === 'scan') {
            idx = optTexts.findIndex((text) => {
                const t = String(text || '').trim().toLowerCase();
                if (!t) return false;
                if (t === 'kategori') return false;
                if (t.includes(UNAVAILABLE_TEXT)) return false;
                return true;
            });
            if (idx < 0) {
                await delay(600);
                continue;
            }
            selectedText = optTexts[idx];
            logger.info('categoryBlock:scan_selected', { idx, selectedText });
        } else {
            selectedText = optTexts.find(text => reCat.test(text) || (reAlt ? reAlt.test(text) : false));
            if (!selectedText) {
                await delay(600);
                continue;
            }
            idx = optTexts.findIndex(t => t === selectedText);
            logger.info('categoryBlock:legacy_selected', { idx, selectedText, categoryType: cat, alternativeCategory: alt || null });
        }

        const btn = options[idx] || null;
        if (!btn) {
            await delay(600);
            continue;
        }
        try { await btn.click(); } catch {}
        try {
            const bb = await btn.boundingBox();
            if (bb) {
                await page.mouse.move(bb.x + (bb.width / 2), bb.y + (bb.height / 2));
                await page.mouse.down();
                await page.mouse.up();
            }
        } catch {}

        // Seçim UI'ya yansıdı mı? ("Kategori" gibi placeholder'dan çıkmalı)
        let selectionOk = false;
        try {
            await page.waitForFunction((txt) => {
                const sel = document.querySelector('.custom-select-box .selected-option');
                const v = (sel?.innerText || sel?.textContent || '').trim().toLowerCase();
                if (!v) return false;
                if (v === 'kategori') return false;
                return v.includes(String(txt || '').trim().toLowerCase());
            }, { timeout: 9000 }, selectedText);
            selectionOk = true;
        } catch (e) {
            const diag = await page.evaluate(() => {
                const sel = document.querySelector('.custom-select-box .selected-option');
                return {
                    url: location.href,
                    title: document.title,
                    selectedOption: (sel?.innerText || sel?.textContent || '').trim(),
                    hasTurnstileWidget: !!document.querySelector('.cf-turnstile'),
                    hasTurnstileTokenField: !!document.querySelector('input[name="cf-turnstile-response"]')
                };
            }).catch(() => null);
            logger.warn('categoryBlock:selected_option_verify_failed', { attempt: attempt + 1, error: e?.message || String(e), diag });
        }

        // Kategori seçildikten sonra UI'nin devamını bekle: blocks veya seat button veya seatmap.
        const uiReady = await page.waitForFunction(() => {
            const blocks = document.querySelector('select#blocks');
            const blocksOk = !!(blocks && blocks.options && blocks.options.length > 1);
            const seatBtn = !!document.getElementById('custom_seat_button');
            const seatNodes = document.querySelectorAll('svg.seatmap-svg g[id^="seat"] rect').length;
            return blocksOk || seatBtn || seatNodes > 0;
        }, { timeout: 12000 }).then(() => true).catch(() => false);

        if (selectionOk && uiReady) break;

        const diag = await page.evaluate(() => {
            const blocks = document.querySelector('select#blocks');
            return {
                url: location.href,
                title: document.title,
                selectedOption: (document.querySelector('.custom-select-box .selected-option')?.textContent || '').trim(),
                hasBlocksSelect: !!blocks,
                blocksOptionLen: blocks?.options?.length || 0,
                hasSeatButton: !!document.getElementById('custom_seat_button'),
                seatNodeCount: document.querySelectorAll('svg.seatmap-svg g[id^="seat"] rect').length
            };
        }).catch(() => null);
        logger.warn('categoryBlock:cycle_retry', { attempt: attempt + 1, selectionOk, uiReady, diag });
        await delay(600);
    }

    const blocksTimeout = Math.max(cfg.TIMEOUTS.BLOCKS_WAIT_TIMEOUT || 0, 10000);
    logger.info('categoryBlock:waiting_for_blocks', { blocksTimeout });
    let blocksReady = false;
    let lastBlocksDiag = null;
    for (let a = 0; a < 2; a++) {
        try {
            await page.waitForFunction(() => {
                const s = document.querySelector('select#blocks');
                return s && s.options && s.options.length > 1;
            }, { timeout: blocksTimeout });
            blocksReady = true;
            break;
        } catch (e) {
            lastBlocksDiag = await page.evaluate(() => {
                const s = document.querySelector('select#blocks');
                return {
                    hasBlocksSelect: !!s,
                    optionLen: s?.options?.length || 0,
                    firstValues: s ? Array.from(s.options).slice(0, 5).map(o => String(o.value || '')) : [],
                    url: location.href,
                    title: document.title,
                    hasTurnstileWidget: !!document.querySelector('.cf-turnstile'),
                    hasTurnstileTokenField: !!document.querySelector('input[name="cf-turnstile-response"]')
                };
            });
            logger.warn('categoryBlock:blocks_wait_timeout', { attempt: a + 1, blocksTimeout, diag: lastBlocksDiag, error: e?.message || String(e) });
            await delay(600);
        }
    }

    if (!blocksReady) {
        logger.warn('categoryBlock:blocks_not_ready_continue', { diag: lastBlocksDiag });
        return;
    }

    await page.evaluate(() => {
        const s = document.querySelector('select#blocks');
        if (!s) return;
        const valid = [...s.options].filter(o => o.value && !/0:\s*null/i.test(o.value));
        if (valid.length) {
            const r = valid[Math.floor(Math.random() * valid.length)];
            s.value = r.value;
            s.dispatchEvent(new Event('change', {bubbles: true}));
        }
    });
}

async function startBot(req, res) {
    // Input validation
    let validatedData;
    try {
        validatedData = botRequestSchema.parse(req.body);
    } catch (error) {
        // Zod validation hatası
        if (error.issues && Array.isArray(error.issues)) {
            logger.warnSafe('Validation hatası', { 
                errors: error.issues,
                body: req.body 
            });
            return res.status(400).json({
                error: formatError('VALIDATION_ERROR'),
                details: error.issues.map(e => ({
                    path: e.path.join('.'),
                    message: e.message,
                    code: e.code
                }))
            });
        }
        logger.errorSafe('Validation hatası (beklenmeyen format)', error, { body: req.body });
        return res.status(400).json({error: formatError('INVALID_REQUEST_DATA')});
    }

    const {
        team, ticketType, eventAddress, categoryType, alternativeCategory,
        categorySelectionMode,
        transferTargetEmail,
        extendWhenRemainingSecondsBelow,
        prioritySale, fanCardCode, identity,
        email, password,
        cardHolder = null, cardNumber = null, expiryMonth = null, expiryYear = null, cvv = null,
        proxyHost, proxyPort, proxyUsername, proxyPassword,
        email2, password2,
        aAccounts, bAccounts
    } = validatedData;

    const a0 = Array.isArray(aAccounts) && aAccounts.length ? aAccounts[0] : null;
    const b0 = Array.isArray(bAccounts) && bAccounts.length ? bAccounts[0] : null;

    // Backward compatible mapping: if multi-account arrays provided, use their first entries
    const emailA = (a0?.email || email || '').toString();
    const passwordA = (a0?.password || password || '').toString();
    const emailB = (b0?.email || email2 || '').toString();
    const passwordB = (b0?.password || password2 || '').toString();

    const aList = (Array.isArray(aAccounts) && aAccounts.length)
        ? aAccounts.map(a => ({
            email: String(a.email || ''),
            password: String(a.password || ''),
            identity: (a && Object.prototype.hasOwnProperty.call(a, 'identity')) ? a.identity : null,
            fanCardCode: (a && Object.prototype.hasOwnProperty.call(a, 'fanCardCode')) ? a.fanCardCode : null
        }))
        : [{ email: emailA, password: passwordA, identity: identity ?? null, fanCardCode: fanCardCode ?? null }];
    const bList = (Array.isArray(bAccounts) && bAccounts.length)
        ? bAccounts.map(b => ({
            email: String(b.email || ''),
            password: String(b.password || ''),
            identity: (b && Object.prototype.hasOwnProperty.call(b, 'identity')) ? b.identity : null,
            fanCardCode: (b && Object.prototype.hasOwnProperty.call(b, 'fanCardCode')) ? b.fanCardCode : null
        }))
        : [{ email: emailB, password: passwordB, identity: identity ?? null, fanCardCode: fanCardCode ?? null }];

    const isMulti = (aList.length > 1) || (bList.length > 1);

    const runId = (() => {
        try {
            const header = (typeof req?.get === 'function') ? req.get('x-run-id') : null;
            const safe = runStore.safeRunId(header);
            if (safe) return safe;
        } catch {}
        try { return randomUUID(); } catch { return `${Date.now()}_${Math.random().toString(16).slice(2)}`; }
    })();
    const audit = (event, meta = {}, level = 'info') => {
        const payload = {
            runId,
            event,
            ts: new Date().toISOString(),
            ...meta
        };
        try {
            if (level === 'warn') return logger.warnSafe('audit', payload);
            if (level === 'error') return logger.errorSafe('audit', meta?.error || payload?.error || 'error', payload);
            return logger.infoSafe('audit', payload);
        } catch {
            try { logger.info('audit', payload); } catch {}
        }
    };

    let currentHolder = null; // 'A' | 'B'
    let currentSeatInfo = null;
    let currentCatBlock = null;
    const setHolder = (role, seatInfo, catBlock) => {
        currentHolder = role;
        if (seatInfo) currentSeatInfo = seatInfo;
        if (catBlock) currentCatBlock = catBlock;
        try { audit('holder_updated', { holder: currentHolder, seatId: currentSeatInfo?.seatId || null }); } catch {}
    };

    const getFinalizeRequest = () => {
        try {
            const st = runStore.get(runId);
            if (!st) return { requested: false };
            return { requested: !!st.finalizeRequested, cAccount: st.cAccount || null, finalizeMeta: st.finalizeMeta || null };
        } catch {
            return { requested: false };
        }
    };

    const finalizeToC = async () => {
        const fin = getFinalizeRequest();
        if (!fin?.requested) return null;
        const cAcc = fin?.cAccount;
        const finMeta = fin?.finalizeMeta || null;
        if (!cAcc?.email || !cAcc?.password) throw new Error('FINALIZE_C_ACCOUNT_MISSING');
        if (!currentSeatInfo?.seatId) throw new Error('FINALIZE_SEATID_MISSING');
        if (!currentHolder) throw new Error('FINALIZE_HOLDER_UNKNOWN');

        // Prefer finalize payload sensitive fields (identity/card) over initial request values.
        const identityFinal = (finMeta?.identity != null && String(finMeta.identity).trim()) ? String(finMeta.identity).trim() : (identity != null ? String(identity).trim() : null);
        const cardFinal = {
            cardHolder: (finMeta?.cardHolder != null && String(finMeta.cardHolder).trim()) ? String(finMeta.cardHolder).trim() : (cardHolder != null ? String(cardHolder).trim() : null),
            cardNumber: (finMeta?.cardNumber != null && String(finMeta.cardNumber).trim()) ? String(finMeta.cardNumber).trim() : (cardNumber != null ? String(cardNumber).trim() : null),
            expiryMonth: (finMeta?.expiryMonth != null && String(finMeta.expiryMonth).trim()) ? String(finMeta.expiryMonth).trim() : (expiryMonth != null ? String(expiryMonth).trim() : null),
            expiryYear: (finMeta?.expiryYear != null && String(finMeta.expiryYear).trim()) ? String(finMeta.expiryYear).trim() : (expiryYear != null ? String(expiryYear).trim() : null),
            cvv: (finMeta?.cvv != null && String(finMeta.cvv).trim()) ? String(finMeta.cvv).trim() : (cvv != null ? String(cvv).trim() : null)
        };
        const autoPayFinal = !!(finMeta && finMeta.autoPay === true);

        audit('finalize_start', { holder: currentHolder, seatId: currentSeatInfo?.seatId || null, cEmail: cAcc.email });
        logger.warn('Finalize requested: transferring seat to C', { holder: currentHolder, seatId: currentSeatInfo?.seatId || null, cEmail: cAcc.email });

        const holderPage = (currentHolder === 'A') ? pageA : pageB;
        const holderEmail = (currentHolder === 'A') ? emailA : emailB;
        const holderPass = (currentHolder === 'A') ? passwordA : passwordB;

        setStep('C.launchAndLogin.start', { email: cAcc.email });
        ({ browser: browserC, page: pageC } = await launchAndLogin({
            email: cAcc.email,
            password: cAcc.password,
            userDataDir: `${cfg.USER_DATA_DIR_B}_C`,
            proxyHost,
            proxyPort,
            proxyUsername,
            proxyPassword
        }));
        try { multiBrowsers.push(browserC); } catch {}
        setStep('C.launchAndLogin.done', { email: cAcc.email, snap: await snapshotPage(pageC, 'C.afterLogin') });

        const eventPathIncludes = (() => {
            try {
                const u = new URL(String(eventAddress));
                return u.pathname || null;
            } catch {
                return null;
            }
        })();

        setStep('C.gotoEvent.start');
        await gotoWithRetry(pageC, String(eventAddress), {
            retries: 3,
            waitUntil: 'networkidle2',
            expectedUrlIncludes: eventPathIncludes,
            rejectIfHome: true,
            backoffMs: 450
        });
        setStep('C.gotoEvent.done', { snap: await snapshotPage(pageC, 'C.afterEventGoto') });

        setStep('C.clickBuy.start');
        await clickBuy(pageC, eventAddress);
        setStep('C.clickBuy.done');

        await handlePrioritySaleModal(pageC, { prioritySale, fanCardCode, identity });

        await ensureUrlContains(pageC, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 });
        try { await reloginIfRedirected(pageC, cAcc.email, cAcc.password); } catch {}
        // For finalize flow, do NOT open seat map / categories before holder releases; the seat will appear unavailable.
        // We only ensure C is logged in and on /koltuk-secim, and (if needed) Turnstile is solved.
        // Turnstile must be blocking here; background solving can lead to race conditions.
        try {
            setStep('C.turnstile.preRelease.waitMount.start');
            // Turnstile widget/token field can mount late after route transitions.
            // If we proceed to release before it mounts, C may start solving AFTER release -> critical delay.
            await pageC.waitForFunction(() => {
                try {
                    return !!document.querySelector('.cf-turnstile') || !!document.querySelector('input[name="cf-turnstile-response"]');
                } catch {
                    return false;
                }
            }, { timeout: 12000 }).catch(() => {});
            setStep('C.turnstile.preRelease.waitMount.done');
        } catch {}

        try {
            setStep('C.turnstile.preRelease.ensure.start');
            await ensureTurnstileTokenOnPage(pageC, cAcc.email, 'C.seatSelection', { background: false });
            setStep('C.turnstile.preRelease.ensure.done');
        } catch {}

        try {
            const tokenState = await pageC.evaluate(() => {
                const input = document.querySelector('input[name="cf-turnstile-response"]');
                const tokenLen = input?.value ? input.value.length : 0;
                const hasWidget = !!document.querySelector('.cf-turnstile');
                return { hasWidget, tokenLen };
            }).catch(() => null);
            audit('finalize_c_turnstile_pre_release', { cEmail: cAcc.email, seatId: currentSeatInfo?.seatId || null, tokenState });
        } catch {}

        // IMPORTANT: Do not remove from holder until C is ready on category/seat selection.
        audit('finalize_c_ready_for_release', {
            cEmail: cAcc.email,
            holder: currentHolder,
            seatId: currentSeatInfo?.seatId || null,
            urlC: (() => { try { return pageC.url(); } catch { return null; } })()
        });

        audit('finalize_holder_remove_start', { holder: currentHolder, holderEmail, seatId: currentSeatInfo?.seatId || null });
        try { await reloginIfRedirected(holderPage, holderEmail, holderPass); } catch {}
        try {
            await gotoWithRetry(holderPage, 'https://www.passo.com.tr/tr/sepet', {
                retries: 2,
                waitUntil: 'networkidle2',
                expectedUrlIncludes: '/sepet',
                rejectIfHome: false,
                backoffMs: 450
            });
            await holderPage.waitForSelector('.basket-list-detail, .basket-list, .basket, [data-testid*="basket" i], [data-testid*="sepet" i]', { timeout: 8000 }).catch(() => {});
        } catch {}

        let removed = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (removed) break;
            removed = await clickRemoveFromCartAndConfirm(holderPage, cfg.TIMEOUTS.REMOVE_FROM_CART_TIMEOUT);
            if (removed) break;
            try {
                await gotoWithRetry(holderPage, 'https://www.passo.com.tr/tr/sepet', {
                    retries: 0,
                    waitUntil: 'networkidle2',
                    expectedUrlIncludes: '/sepet',
                    rejectIfHome: false,
                    backoffMs: 0
                });
                await delay(2500);
            } catch {}
        }
        if (!removed) throw new Error('FINALIZE_HOLDER_REMOVE_FAILED');
        audit('finalize_holder_remove_done', { holder: currentHolder, holderEmail, seatId: currentSeatInfo?.seatId || null });

        const exactMaxMs = Math.max(30000, Math.min(cfg.TIMEOUTS.SEAT_PICK_EXACT_MAX || 0, 180000));
        try { await delay(350); } catch {}
        try { await reloginIfRedirected(pageC, cAcc.email, cAcc.password); } catch {}
        try { await ensureUrlContains(pageC, '/koltuk-secim', { retries: 1, waitMs: 9000, backoffMs: 450 }); } catch {}
        try { await ensureTurnstileTokenOnPage(pageC, cAcc.email, 'C.seatSelection', { background: false }); } catch {}

        try {
            if (currentSeatInfo && !currentSeatInfo.svgBlockId) {
                const sb = currentCatBlock?.svgBlockId || null;
                if (sb) currentSeatInfo.svgBlockId = String(sb);
            }
        } catch {}

        const ensureSeatmapMountedOnC = async () => {
            const svgBid = (currentSeatInfo?.svgBlockId || currentCatBlock?.svgBlockId || null);
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    setStep('C.seatmap.ensure.applyCategory.start', { attempt, mode: categorySelectionMode || null, svgBid: svgBid || null });
                    await applyCategoryBlockSelection(pageC, categorySelectionMode, (currentCatBlock || null), currentSeatInfo);
                    setStep('C.seatmap.ensure.applyCategory.done', { attempt });
                } catch (e) {
                    try { audit('finalize_c_apply_category_failed', { attempt, mode: categorySelectionMode || null, svgBid: svgBid || null, error: e?.message || String(e) }, 'warn'); } catch {}
                }

                try {
                    setStep('C.seatmap.ensure.openSeatmap.start', { attempt });
                    await openSeatMapStrict(pageC);
                    setStep('C.seatmap.ensure.openSeatmap.done', { attempt });
                } catch (e) {
                    try { audit('finalize_c_open_seatmap_failed', { attempt, error: e?.message || String(e) }, 'warn'); } catch {}
                }
                try {
                    await pageC.waitForFunction((sel) => {
                        try { return document.querySelectorAll(sel).length > 0; } catch { return false; }
                    }, { timeout: 20000 }, SEAT_NODE_SELECTOR);
                    return true;
                } catch {}
                if (String(categorySelectionMode || '').toLowerCase() === 'svg' && svgBid) {
                    try { await selectSvgBlockById(pageC, String(svgBid)); } catch {}
                }
                try { await delay(350 + (attempt * 300)); } catch {}
            }
            return false;
        };

        setStep('C.seatmap.ensure.start');
        const seatmapOk = await ensureSeatmapMountedOnC().catch((e) => {
            try { audit('finalize_c_seatmap_ensure_failed', { error: e?.message || String(e) }, 'warn'); } catch {}
            return false;
        });
        setStep('C.seatmap.ensure.done', { ok: !!seatmapOk, snap: await snapshotPage(pageC, 'C.afterSeatmapEnsure') });
        if (!seatmapOk) throw new Error('FINALIZE_C_SEATMAP_MOUNT_FAILED');

        const seatInfoC = await pickExactSeatWithVerify_ReleaseAware(pageC, currentSeatInfo, exactMaxMs);
        audit('finalize_c_exact_pick_done', { cEmail: cAcc.email, seatId: currentSeatInfo?.seatId || null, pickedSeatId: seatInfoC?.seatId || null });

        setStep('C.clickContinue.start');
        await clickContinueInsidePage(pageC);
        await delay(cfg.DELAYS.AFTER_CONTINUE);
        setStep('C.clickContinue.done', { snap: await snapshotPage(pageC, 'C.afterContinue') });

        // Payment / TCKN flow (best-effort; does not click final PAY)
        const paymentMeta = { tcAssigned: false, invoiceTcFilled: false, agreementsAccepted: false, iframeFilled: false, payClicked: false, autoPay: autoPayFinal };
        try {
            setStep('C.payment.gotoBasket.start');
            await gotoWithRetry(pageC, 'https://www.passo.com.tr/tr/sepet', {
                retries: 2,
                waitUntil: 'networkidle2',
                expectedUrlIncludes: '/sepet',
                rejectIfHome: false,
                backoffMs: 450
            });
            await pageC.waitForSelector('.basket-list-detail, .basket-list, .basket, [data-testid*="basket" i], [data-testid*="sepet" i], input[placeholder="T.C. Kimlik No"][maxlength="11"], button', { timeout: 15000 }).catch(() => {});
            setStep('C.payment.gotoBasket.done', { url: (() => { try { return pageC.url(); } catch { return null; } })() });
        } catch {}

        try {
            if (identityFinal && String(identityFinal).trim().length === 11) {
                setStep('C.payment.tcAssign.start');
                const okTc = await ensureTcAssignedOnBasket(pageC, String(identityFinal).trim(), { preferAssignToMyId: true, maxAttempts: 3 });
                paymentMeta.tcAssigned = !!okTc;
                audit('c_payment_tc_assign', { ok: !!okTc, cEmail: cAcc.email, seatId: currentSeatInfo?.seatId || null });
                setStep('C.payment.tcAssign.done', { ok: !!okTc });
            }
        } catch {}

        try {
            setStep('C.payment.devamToOdeme.start');
            await clickBasketDevamToOdeme(pageC);
            await pageC.waitForFunction(() => /\/odeme(\b|\/|\?|#)/i.test(String(location.href || '')), { timeout: 30000 }).catch(() => {});
            setStep('C.payment.devamToOdeme.done', { url: (() => { try { return pageC.url(); } catch { return null; } })() });
        } catch {}

        try {
            setStep('C.payment.dismissInfoModal.start');
            const didDismiss = await dismissPaymentInfoModalIfPresent(pageC);
            setStep('C.payment.dismissInfoModal.done', { didDismiss: !!didDismiss });
        } catch {}

        try {
            if (identityFinal && String(identityFinal).trim().length === 11) {
                setStep('C.payment.invoiceTc.start');
                const okInv = await fillInvoiceTcAndContinue(pageC, String(identityFinal).trim());
                paymentMeta.invoiceTcFilled = !!okInv;
                audit('c_payment_invoice_tc', { ok: !!okInv, cEmail: cAcc.email, seatId: currentSeatInfo?.seatId || null });
                setStep('C.payment.invoiceTc.done', { ok: !!okInv });
            }
        } catch {}

        try {
            setStep('C.payment.agreements.start');
            const okAg = await acceptAgreementsAndContinue(pageC);
            paymentMeta.agreementsAccepted = !!okAg;
            audit('c_payment_agreements', { ok: !!okAg, cEmail: cAcc.email, seatId: currentSeatInfo?.seatId || null });
            setStep('C.payment.agreements.done', { ok: !!okAg });
        } catch {}

        try {
            if (cardFinal.cardHolder && cardFinal.cardNumber && cardFinal.expiryMonth && cardFinal.expiryYear && cardFinal.cvv) {
                setStep('C.payment.iframeFill.start');
                const okFrame = await fillNkolayPaymentIframe(pageC, cardFinal, { clickPay: autoPayFinal });
                if (autoPayFinal) {
                    paymentMeta.iframeFilled = !!(okFrame && okFrame.ok);
                    paymentMeta.payClicked = !!(okFrame && okFrame.payClicked);
                } else {
                    paymentMeta.iframeFilled = !!okFrame;
                }
                audit('c_payment_iframe_filled', { ok: !!paymentMeta.iframeFilled, payClicked: !!paymentMeta.payClicked, autoPay: autoPayFinal, cEmail: cAcc.email, seatId: currentSeatInfo?.seatId || null });
                setStep('C.payment.iframeFill.done', { ok: !!paymentMeta.iframeFilled, payClicked: !!paymentMeta.payClicked, autoPay: autoPayFinal });
            }
        } catch {}

        finalizedToCResult = { success: true, grabbedBy: cAcc.email, seatC: seatInfoC, seatId: currentSeatInfo?.seatId || null, payment: paymentMeta };
        audit('finalize_done', { grabbedBy: cAcc.email, seatId: currentSeatInfo?.seatId || null });
        return finalizedToCResult;
    };

    const ensureFinalizeWatcher = () => {
        if (finalizeWatch) return;
        finalizeWatch = setInterval(() => {
            try {
                if (finalizeInFlight) return;
                const fin = getFinalizeRequest();
                if (!fin?.requested) return;
                if (!fin?.cAccount?.email || !fin?.cAccount?.password) return;
                if (!currentSeatInfo?.seatId || !currentHolder) return;
                finalizeInFlight = Promise.resolve()
                    .then(finalizeToC)
                    .catch((e) => {
                        try { audit('finalize_failed', { error: e?.message || String(e), seatId: currentSeatInfo?.seatId || null }, 'warn'); } catch {}
                        throw e;
                    });
            } catch {}
        }, 1000);
    };

    let browserA, pageA, browserB, pageB;
    let browserC, pageC;
    let multiBrowsers = [];
    let basketTimer;
    let basketMonitor;
    let dynamicTimingCheck;
    let finalizeWatch;
    let finalizeInFlight;
    let finalizedToCResult;
    let lastStep = 'init';
    const setStep = (s, meta = {}) => {
        lastStep = s;
        logger.info(`step:${s}`, meta);
    };
    const snapshotPage = async (page, label) => {
        if (!page) return null;
        try {
            return await page.evaluate((lbl, seatSel) => {
                const bodyText = (document.body?.innerText || '').toLowerCase();
                const title = document.title;
                const url = location.href;
                const hasVerifyHuman = bodyText.includes('verify you are human');
                const hasTurnstileWidget = !!document.querySelector('.cf-turnstile');
                const hasTurnstileTokenField = !!document.querySelector('input[name="cf-turnstile-response"]');
                const seatCount = document.querySelectorAll(seatSel).length;
                const selectedCount = document.querySelectorAll(
                    'circle.seat-circle.selected, circle.seat-circle[aria-pressed="true"], [data-selected="true"], svg.seatmap-svg g.selected rect, svg.seatmap-svg rect.selected, svg.seatmap-svg g[class*="selected"] rect'
                ).length;
                const possibleErrors = Array.from(document.querySelectorAll('.error, .alert, .toast, .swal2-html-container, .validation, .invalid-feedback'))
                    .slice(0, 5)
                    .map(el => (el.innerText || el.textContent || '').trim())
                    .filter(Boolean);
                return {
                    label: lbl,
                    title,
                    url,
                    hasVerifyHuman,
                    hasTurnstileWidget,
                    hasTurnstileTokenField,
                    seatCount,
                    selectedCount,
                    possibleErrors
                };
            }, label, SEAT_NODE_SELECTOR);
        } catch (e) {
            return { label, error: e?.message || String(e) };
        }
    };

    logger.infoSafe('Bot başlatılıyor', {
        team,
        ticketType,
        eventAddress,
        email: emailA,
        email2: emailB,
        categoryType,
        multi: isMulti,
        aCount: aList.length,
        bCount: bList.length
    });

    audit('run_start', {
        team,
        ticketType,
        eventAddress,
        categoryType,
        alternativeCategory,
        categorySelectionMode,
        multi: isMulti,
        aCount: aList.length,
        bCount: bList.length,
        transferTargetEmail: transferTargetEmail || null
    });

    try {
        if (isMulti) {
            const poolMap = async (items, concurrency, handler) => {
                const conc = Math.max(1, Number(concurrency) || 1);
                const results = new Array(items.length);
                let idx = 0;
                const workers = new Array(Math.min(conc, items.length)).fill(null).map(async () => {
                    while (true) {
                        const cur = idx++;
                        if (cur >= items.length) return;
                        results[cur] = await handler(items[cur], cur);
                    }
                });
                await Promise.all(workers);
                return results;
            };

            const eventPathIncludes = (() => {
                try {
                    const u = new URL(String(eventAddress));
                    return u.pathname || null;
                } catch {
                    return null;
                }
            })();

            // 1) Prepare all B accounts to seat selection (ready state)
            const multiAConcurrency = Math.max(1, Number(cfg?.MULTI?.A_CONCURRENCY || 4));
            const multiBConcurrency = Math.max(1, Number(cfg?.MULTI?.B_CONCURRENCY || 2));
            const multiStaggerMs = Math.max(0, Number(cfg?.MULTI?.STAGGER_MS || 0));

            // Prepare B accounts and A holds concurrently (optionally staggered)
            setStep('MULTI.parallel.start', { aCount: aList.length, bCount: bList.length, multiAConcurrency, multiBConcurrency, multiStaggerMs });

            const bCtxPromise = (async () => {
                setStep('MULTI.B.prepare.start', { bCount: bList.length, concurrency: multiBConcurrency, multiStaggerMs });
                audit('multi_b_prepare_start', { bCount: bList.length, concurrency: multiBConcurrency, multiStaggerMs });
                const bCtxList = await poolMap(bList, multiBConcurrency, async (acc, i) => {
                const label = `B${i}`;
                if (multiStaggerMs > 0) {
                    try { await delay(i * multiStaggerMs); } catch {}
                }
                setStep(`${label}.launchAndLogin.start`, { email: acc.email });
                audit('account_launch_start', { role: 'B', idx: i, email: acc.email });
                const userDataDir = `${cfg.USER_DATA_DIR_B}_${i}`;
                const { browser, page } = await launchAndLogin({
                    email: acc.email,
                    password: acc.password,
                    userDataDir,
                    proxyHost,
                    proxyPort,
                    proxyUsername,
                    proxyPassword
                });
                try { multiBrowsers.push(browser); } catch {}
                setStep(`${label}.launchAndLogin.done`, { email: acc.email, snap: await snapshotPage(page, `${label}.afterLogin`) });
                audit('account_launch_done', { role: 'B', idx: i, email: acc.email, url: (() => { try { return page.url(); } catch { return null; } })() });

                setStep(`${label}.gotoEvent.start`, { eventAddress });
                audit('account_goto_event_start', { role: 'B', idx: i, email: acc.email, eventAddress });
                await gotoWithRetry(page, String(eventAddress), {
                    retries: 3,
                    waitUntil: 'networkidle2',
                    expectedUrlIncludes: eventPathIncludes,
                    rejectIfHome: true,
                    backoffMs: 450
                });
                setStep(`${label}.gotoEvent.done`, { snap: await snapshotPage(page, `${label}.afterEventGoto`) });
                audit('account_goto_event_done', { role: 'B', idx: i, email: acc.email, url: (() => { try { return page.url(); } catch { return null; } })() });

                setStep(`${label}.clickBuy.start`);
                audit('account_click_buy_start', { role: 'B', idx: i, email: acc.email });
                const clicked = await clickBuy(page, eventAddress);
                if (!clicked) throw new Error(formatError('BUY_BUTTON_FAILED_B'));
                setStep(`${label}.clickBuy.done`);
                audit('account_click_buy_done', { role: 'B', idx: i, email: acc.email, url: (() => { try { return page.url(); } catch { return null; } })() });

                await handlePrioritySaleModal(page, { prioritySale, fanCardCode: acc?.fanCardCode ?? fanCardCode, identity: acc?.identity ?? identity });

                setStep(`${label}.postBuy.ensureUrl.start`);
                await ensureUrlContains(page, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 });
                setStep(`${label}.postBuy.ensureUrl.done`, { snap: await snapshotPage(page, `${label}.afterEnsureUrl`) });
                audit('account_seat_selection_ready', { role: 'B', idx: i, email: acc.email, url: (() => { try { return page.url(); } catch { return null; } })() });

                setStep(`${label}.postBuy.reloginCheck.start`);
                await reloginIfRedirected(page, acc.email, acc.password);
                setStep(`${label}.postBuy.reloginCheck.done`, { snap: await snapshotPage(page, `${label}.afterReloginCheck`) });

                // Priority sale modal can appear after redirect/login on /koltuk-secim as well.
                const ps2 = await handlePrioritySaleModal(page, { prioritySale, fanCardCode: acc?.fanCardCode ?? fanCardCode, identity: acc?.identity ?? identity });
                if (ps2) {
                    try { await ensureUrlContains(page, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 }); } catch {}
                }

                // Guard: session drift may leave us on / or /giris; ensure we are back on seat selection.
                try {
                    const curUrl = (() => { try { return page.url(); } catch { return ''; } })();
                    let path = '';
                    try { path = new URL(String(curUrl || '')).pathname || ''; } catch { path = String(curUrl || ''); }
                    const isSeatSelection = String(path || '').includes('/koltuk-secim');
                    const isLogin = String(path || '').includes('/giris');
                    if ((!isSeatSelection || isLogin) && String(eventAddress || '').includes('/etkinlik/')) {
                        try {
                            await gotoWithRetry(page, String(eventAddress), {
                                retries: 1,
                                waitUntil: 'domcontentloaded',
                                expectedUrlIncludes: '/etkinlik/',
                                rejectIfHome: false,
                                backoffMs: 450
                            });
                        } catch {}
                        try { await clickBuy(page, eventAddress); } catch {}
                        try { await ensureUrlContains(page, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 }); } catch {}
                    }
                } catch {}

                setStep(`${label}.turnstile.ensure.start`);
                await ensureTurnstileTokenOnPage(page, acc.email, `${label}.seatSelection`, { background: true });
                setStep(`${label}.turnstile.ensure.done`, { snap: await snapshotPage(page, `${label}.afterTurnstileEnsure`) });

                // IMPORTANT: B must be ready with seatmap mounted BEFORE A releases.
                // Open seatmap now so B can immediately click when A releases.
                const seatSelectionUrl = (() => { try { return page.url(); } catch { return null; } })();
                audit('b_prepared', { idx: i, email: acc.email, seatSelectionUrl });

                // Open category/block and seatmap for B before release
                setStep(`${label}.preRelease.categoryBlock.start`);
                try {
                    await applyCategoryBlockSelection(page, categorySelectionMode, null, null);
                    audit('b_pre_release_cat_block', { idx: i, email: acc.email, categorySelectionMode });
                } catch (e) {
                    audit('b_pre_release_cat_block_warn', { idx: i, email: acc.email, error: e?.message }, 'warn');
                }

                setStep(`${label}.preRelease.seatmap.start`);
                let seatmapReady = false;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        await openSeatMapStrict(page);
                        await page.waitForFunction((sel) => {
                            try { return document.querySelectorAll(sel).length > 0; } catch { return false; }
                        }, { timeout: 15000 }, SEAT_NODE_SELECTOR);
                        seatmapReady = true;
                        audit('b_pre_release_seatmap_ready', { idx: i, email: acc.email, attempt });
                        break;
                    } catch (e) {
                        audit('b_pre_release_seatmap_attempt', { idx: i, email: acc.email, attempt, error: e?.message }, 'warn');
                        if (attempt < 3) await delay(500 + (attempt * 300));
                    }
                }

                if (!seatmapReady) {
                    audit('b_pre_release_seatmap_failed', { idx: i, email: acc.email }, 'warn');
                }

                // Keep B on seat selection but ready for immediate pick
                setStep(`${label}.preRelease.ready`, { seatmapReady });
                audit('b_standby_ready', { idx: i, email: acc.email, seatmapReady, url: (() => { try { return page.url(); } catch { return null; } })() });

                return {
                    idx: i,
                    label,
                    email: acc.email,
                    password: acc.password,
                    browser,
                    page,
                    seatSelectionUrl,
                    seatmapReady
                };
                });
                setStep('MULTI.B.prepare.done', { bCount: bCtxList.length });
                audit('multi_b_prepare_done', { bCount: bCtxList.length, bEmails: bCtxList.map(x => x?.email).filter(Boolean) });
                return bCtxList;
            })();

            const aCtxPromise = (async () => {
                // Run A accounts in parallel pool to add seats to basket and park on /sepet
                setStep('MULTI.A.hold.start', { aCount: aList.length, concurrency: multiAConcurrency, multiStaggerMs });
                audit('multi_a_hold_start', { aCount: aList.length, concurrency: multiAConcurrency, multiStaggerMs });
                const aCtxList = await poolMap(aList, multiAConcurrency, async (acc, i) => {
                const label = `A${i}`;
                const userDataDir = `${cfg.USER_DATA_DIR_A}_${i}`;

                if (multiStaggerMs > 0) {
                    try { await delay(i * multiStaggerMs); } catch {}
                }

                setStep(`${label}.launchAndLogin.start`, { email: acc.email });
                audit('account_launch_start', { role: 'A', idx: i, email: acc.email });
                const { browser, page } = await launchAndLogin({
                    email: acc.email,
                    password: acc.password,
                    userDataDir,
                    proxyHost,
                    proxyPort,
                    proxyUsername,
                    proxyPassword
                });
                try { multiBrowsers.push(browser); } catch {}
                setStep(`${label}.launchAndLogin.done`, { email: acc.email, snap: await snapshotPage(page, `${label}.afterLogin`) });
                audit('account_launch_done', { role: 'A', idx: i, email: acc.email, url: (() => { try { return page.url(); } catch { return null; } })() });

                setStep(`${label}.gotoEvent.start`, { eventAddress });
                audit('account_goto_event_start', { role: 'A', idx: i, email: acc.email, eventAddress });
                await gotoWithRetry(page, String(eventAddress), {
                    retries: 3,
                    waitUntil: 'networkidle2',
                    expectedUrlIncludes: eventPathIncludes,
                    rejectIfHome: true,
                    backoffMs: 450
                });
                setStep(`${label}.gotoEvent.done`, { snap: await snapshotPage(page, `${label}.afterEventGoto`) });
                audit('account_goto_event_done', { role: 'A', idx: i, email: acc.email, url: (() => { try { return page.url(); } catch { return null; } })() });

                setStep(`${label}.clickBuy.start`);
                audit('account_click_buy_start', { role: 'A', idx: i, email: acc.email });
                const clicked = await clickBuy(page, eventAddress);
                if (!clicked) throw new Error(formatError('BUY_BUTTON_FAILED_A'));
                setStep(`${label}.clickBuy.done`);
                audit('account_click_buy_done', { role: 'A', idx: i, email: acc.email, url: (() => { try { return page.url(); } catch { return null; } })() });

                await handlePrioritySaleModal(page, { prioritySale, fanCardCode: acc?.fanCardCode ?? fanCardCode, identity: acc?.identity ?? identity });

                setStep(`${label}.postBuy.ensureUrl.start`);
                await ensureUrlContains(page, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 });
                setStep(`${label}.postBuy.ensureUrl.done`, { snap: await snapshotPage(page, `${label}.afterEnsureUrl`) });
                audit('account_seat_selection_ready', { role: 'A', idx: i, email: acc.email, url: (() => { try { return page.url(); } catch { return null; } })() });

                setStep(`${label}.postBuy.reloginCheck.start`);
                await reloginIfRedirected(page, acc.email, acc.password);
                setStep(`${label}.postBuy.reloginCheck.done`, { snap: await snapshotPage(page, `${label}.afterReloginCheck`) });

                // Priority sale modal can appear after redirect/login on /koltuk-secim as well.
                await handlePrioritySaleModal(page, { prioritySale, fanCardCode: acc?.fanCardCode ?? fanCardCode, identity: acc?.identity ?? identity });

                // Guard: session drift may leave us on / or /giris; ensure we are back on seat selection.
                try {
                    const curUrl = (() => { try { return page.url(); } catch { return ''; } })();
                    let path = '';
                    try { path = new URL(String(curUrl || '')).pathname || ''; } catch { path = String(curUrl || ''); }
                    const isSeatSelection = String(path || '').includes('/koltuk-secim');
                    const isLogin = String(path || '').includes('/giris');
                    if ((!isSeatSelection || isLogin) && String(eventAddress || '').includes('/etkinlik/')) {
                        try {
                            await gotoWithRetry(page, String(eventAddress), {
                                retries: 1,
                                waitUntil: 'domcontentloaded',
                                expectedUrlIncludes: '/etkinlik/',
                                rejectIfHome: false,
                                backoffMs: 450
                            });
                        } catch {}
                        try { await clickBuy(page, eventAddress); } catch {}
                        try { await ensureUrlContains(page, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 }); } catch {}
                    }
                } catch {}

                setStep(`${label}.turnstile.ensure.start`);
                await ensureTurnstileTokenOnPage(page, acc.email, `${label}.seatSelection`, { background: true });
                setStep(`${label}.turnstile.ensure.done`, { snap: await snapshotPage(page, `${label}.afterTurnstileEnsure`) });

                // ticket type selection (if present)
                const hasTicketType = await page.$('.ticket-type-title');
                if (hasTicketType) {
                    setStep(`${label}.ticketType.select.start`);
                    await page.evaluate(() => {
                        const titles = Array.from(document.querySelectorAll('.ticket-type-title'));
                        const target = titles.find(el => (el.innerText || '').includes('Passolig E-Bilet'));
                        target?.click();
                    });
                    setStep(`${label}.ticketType.select.done`, { snap: await snapshotPage(page, `${label}.afterTicketType`) });
                }

                setStep(`${label}.categoryBlock.select.start`, { categorySelectionMode });
                const cbStart = Date.now();
                const cbRes = await chooseCategoryAndRandomBlock(page, categoryType, alternativeCategory, categorySelectionMode);
                setStep(`${label}.categoryBlock.select.done`, { snap: await snapshotPage(page, `${label}.afterCategoryBlock`) });
                audit('a_category_block_selected', { idx: i, email: acc.email, mode: categorySelectionMode, ms: Date.now() - cbStart });

                let catBlock = { categoryText: '', blockText: '', blockVal: '' };
                if (cbRes && cbRes.svgBlockId) {
                    try { catBlock = { ...catBlock, svgBlockId: cbRes.svgBlockId }; } catch {}
                }
                for (let r = 0; r < 6; r++) {
                    try {
                        const c = await readCatBlock(page);
                        const catTxt = (c?.categoryText || '').trim();
                        const isPlaceholder = !catTxt || catTxt.toLowerCase() === 'kategori';
                        const blocksOk = !!(c?.blockVal || c?.blockText);
                        if (!isPlaceholder && blocksOk) { catBlock = { ...(c || {}), svgBlockId: catBlock?.svgBlockId }; break; }
                        catBlock = { ...(c || catBlock), svgBlockId: catBlock?.svgBlockId };
                    } catch {}
                    await delay(350);
                }

                setStep(`${label}.seat.pickRandom.start`);
                const seatSelectionUrl = (() => { try { return page.url(); } catch { return null; } })();
                const netSeat = captureSeatIdFromNetwork(page, cfg.TIMEOUTS.NETWORK_CAPTURE_TIMEOUT);
                const seatHelper = require('../helpers/seat');
                let seatInfo = null;
                const seatPickStart = Date.now();
                const maxCycle = Math.max(12, Number(cfg?.TIMEOUTS?.SEAT_SELECTION_CYCLES || 0) || 12);
                let cycleStartedAt = Date.now();
                for (let cycle = 1; cycle <= maxCycle; cycle++) {
                    try {
                        const remaining = Math.max(15000, Number(cfg.TIMEOUTS.SEAT_SELECTION_MAX) - (Date.now() - cycleStartedAt));
                        seatInfo = await seatHelper.pickRandomSeatWithVerify(page, remaining, {
                            context: label,
                            expectedUrlIncludes: '/koltuk-secim',
                            recoveryUrl: seatSelectionUrl,
                            roamCategoryTexts: [categoryType, alternativeCategory].filter(Boolean),
                            email: acc.email,
                            password: acc.password,
                            reloginIfRedirected,
                            ensureTurnstileFn: ensureTurnstileTokenOnPage
                        });
                        break;
                    } catch (e) {
                        const msg = e?.message || String(e);
                        if (/NO_SELECTABLE_SEATS/i.test(msg) || msg.includes('Seçilen blokta boş/aktif koltuk bulunamadı')) {
                            logger.warn(`${label}.seat.noSelectable.retry_block`, { cycle, msg });
                            audit('a_seat_pick_retry_no_selectable', { idx: i, email: acc.email, cycle, error: msg }, 'warn');
                            const roamEvery = Math.max(0, Number(cfg?.TIMEOUTS?.CATEGORY_ROAM_EVERY_CYCLES || 0) || 0);
                            const baseMode = String(categorySelectionMode || 'legacy').toLowerCase();
                            const mode2 = (baseMode === 'svg') ? categorySelectionMode : ((roamEvery > 0 && (cycle % roamEvery) === 0) ? 'scan' : categorySelectionMode);
                            const cbRes2 = await chooseCategoryAndRandomBlock(page, categoryType, alternativeCategory, mode2);
                            if (cbRes2 && cbRes2.svgBlockId) {
                                try { catBlockA = { ...(catBlockA || {}), svgBlockId: cbRes2.svgBlockId }; } catch {}
                            }
                            // Reselect can take time (loader). Reset the seat-pick deadline so we don't fail early.
                            cycleStartedAt = Date.now();
                            continue;
                        }
                        throw e;
                    }
                }
                if (!seatInfo) throw new Error(formatError('SEAT_SELECTION_FAILED_A'));
                // Persist SVG block id onto seatInfo so transfer flows can deterministically mount seatmap.
                try {
                    if (catBlockA && catBlockA.svgBlockId && !seatInfo.svgBlockId) {
                        seatInfo.svgBlockId = String(catBlockA.svgBlockId);
                    }
                } catch {}
                const sidNet = await netSeat;
                if (sidNet) {
                    if (!seatInfo.seatId) seatInfo.seatId = sidNet.seatId;
                    if (!seatInfo.row) seatInfo.row = sidNet.row;
                    if (!seatInfo.seat) seatInfo.seat = sidNet.seat;
                }
                setStep(`${label}.seat.pickRandom.done`, { seatInfo, snap: await snapshotPage(page, `${label}.afterSeatPick`) });
                audit('a_hold_acquired', {
                    idx: i,
                    email: acc.email,
                    seatId: seatInfo?.seatId || null,
                    row: seatInfo?.row || null,
                    seat: seatInfo?.seat || null,
                    categoryText: catBlock?.categoryText || null,
                    blockText: catBlock?.blockText || null,
                    blockVal: catBlock?.blockVal || null,
                    ms: Date.now() - seatPickStart,
                    seatSelectionUrl
                });

                // park on basket
                let basketArrivedAtMs = null;
                try {
                    await gotoWithRetry(page, 'https://www.passo.com.tr/tr/sepet', {
                        retries: 2,
                        waitUntil: 'networkidle2',
                        expectedUrlIncludes: '/sepet',
                        rejectIfHome: false,
                        backoffMs: 450
                    });
                    await page.waitForSelector('.basket-list-detail, .basket-list, .basket, [data-testid*="basket" i], [data-testid*="sepet" i]', { timeout: 15000 }).catch(() => {});
                    basketArrivedAtMs = Date.now();
                } catch {}

                audit('a_hold_in_basket', { idx: i, email: acc.email, seatId: seatInfo?.seatId || null, url: (() => { try { return page.url(); } catch { return null; } })() });

                return {
                    idx: i,
                    label,
                    email: acc.email,
                    password: acc.password,
                    browser,
                    page,
                    seatInfo,
                    catBlock,
                    seatSelectionUrl,
                    basketArrivedAtMs
                };
                });
                setStep('MULTI.A.hold.done', { aCount: aCtxList.length });
                audit('multi_a_hold_done', { aCount: aCtxList.length, aEmails: aCtxList.map(x => x?.email).filter(Boolean) });
                return aCtxList;
            })();

            const [bCtxList, aCtxList] = await Promise.all([bCtxPromise, aCtxPromise]);
            setStep('MULTI.parallel.done', { aCount: aCtxList.length, bCount: bCtxList.length });

            // 3) Transfer phase: A[i] -> B[i] if B exists, otherwise keep A holding.
            setStep('MULTI.transfer.start', { pairs: Math.min(aCtxList.length, bCtxList.length) });
            audit('multi_transfer_start', { pairCount: Math.min(aCtxList.length, bCtxList.length) });
            const results = [];
            const pairCount = Math.min(aCtxList.length, bCtxList.length);
            for (let i = 0; i < pairCount; i++) {
                const aCtx = aCtxList[i];
                const bCtx = bCtxList[i];
                if (!aCtx?.seatInfo?.seatId) {
                    results.push({ idx: i, ok: false, error: 'A seatId yok', seatA: aCtx?.seatInfo || null });
                    audit('transfer_pair_skip_no_seatid', { idx: i, aEmail: aCtx?.email || null, bEmail: bCtx?.email || null }, 'warn');
                    continue;
                }

                setStep(`PAIR${i}.start`, { a: aCtx.email, b: bCtx.email, seatId: aCtx.seatInfo.seatId });
                const pairStart = Date.now();
                audit('transfer_pair_start', {
                    idx: i,
                    seatId: aCtx.seatInfo.seatId,
                    aEmail: aCtx.email,
                    bEmail: bCtx.email,
                    categoryText: aCtx?.catBlock?.categoryText || null,
                    blockText: aCtx?.catBlock?.blockText || null,
                    blockVal: aCtx?.catBlock?.blockVal || null,
                    transferTargetEmail: transferTargetEmail || null
                });

                // attach recovery options for exact pick
                try {
                    aCtx.seatInfo.__recoveryOptions = {
                        context: `B${i}`,
                        expectedUrlIncludes: '/koltuk-secim',
                        recoveryUrl: bCtx.seatSelectionUrl,
                        email: bCtx.email,
                        password: bCtx.password,
                        reloginIfRedirected,
                        ensureTurnstileFn: ensureTurnstileTokenOnPage
                    };
                } catch {}

                // Do NOT mount seatmap pre-release. Just confirm B is on seat selection and ready.
                audit('b_ready_for_exact_pick', { idx: i, bEmail: bCtx.email, seatId: aCtx.seatInfo.seatId, url: (() => { try { return bCtx.page.url(); } catch { return null; } })() });

                // remove from A basket
                const aRemoveStartedAt = Date.now();
                let aRemoveAttempts = 0;
                audit('a_remove_from_basket_flow_start', { idx: i, aEmail: aCtx.email, seatId: aCtx.seatInfo.seatId });

                const ensureRemoveDelayAfterBasket = async () => {
                    const minMsRaw = Number(cfg?.BASKET?.REMOVE_MIN_AFTER_BASKET_MS);
                    const minMs = Number.isFinite(minMsRaw) ? Math.max(0, minMsRaw) : 30000;

                    const sleep = async (ms) => { try { await delay(ms); } catch {} };

                    // Prefer UI countdown on /sepet (mm:ss) to know true basket remaining time.
                    // This avoids relying on our local timestamps when navigation/reloads happen.
                    try {
                        // Wait a bit for the countdown widget to mount
                        try {
                            await aCtx.page.waitForSelector('basket-countdown .basket-remaining-container, .basket-remaining-container', { timeout: 5000 });
                        } catch {}

                        const holdSec = Number(cfg?.BASKET?.HOLDING_TIME_SECONDS);
                        if (Number.isFinite(holdSec) && holdSec > 0) {
                            for (let r = 0; r < 8; r++) {
                                const ui = await checkBasketTimeoutFromPage(aCtx.page);
                                const remSec = Number(ui?.remainingSeconds);
                                if (Number.isFinite(remSec)) {
                                    const elapsedSec = Math.max(0, holdSec - remSec);
                                    const elapsedMs = elapsedSec * 1000;
                                    if (elapsedMs < minMs) {
                                        const waitMs = minMs - elapsedMs;
                                        audit('a_remove_from_basket_wait_min_hold', {
                                            idx: i,
                                            aEmail: aCtx.email,
                                            seatId: aCtx.seatInfo.seatId,
                                            waitMs,
                                            elapsedMs,
                                            minMs,
                                            source: 'ui_timer',
                                            remainingSeconds: remSec
                                        });
                                        await sleep(waitMs);
                                        return;
                                    }
                                    return;
                                }
                                await sleep(400);
                            }
                        }
                    } catch {}

                    // Fallback: local timestamp since we first observed /sepet.
                    const arrivedAt = Number.isFinite(aCtx?.basketArrivedAtMs) ? aCtx.basketArrivedAtMs : null;
                    if (!arrivedAt) {
                        // Last-resort: enforce a conservative wait so we don't remove immediately.
                        if (minMs > 0) {
                            audit('a_remove_from_basket_wait_min_hold', { idx: i, aEmail: aCtx.email, seatId: aCtx.seatInfo.seatId, waitMs: minMs, elapsedMs: 0, minMs, source: 'fallback_sleep' });
                            await sleep(minMs);
                        }
                        return;
                    }
                    const elapsed = Date.now() - arrivedAt;
                    if (elapsed < minMs) {
                        const waitMs = minMs - elapsed;
                        audit('a_remove_from_basket_wait_min_hold', { idx: i, aEmail: aCtx.email, seatId: aCtx.seatInfo.seatId, waitMs, elapsedMs: elapsed, minMs, source: 'timestamp' });
                        await sleep(waitMs);
                    }
                };

                try {
                    await gotoWithRetry(aCtx.page, 'https://www.passo.com.tr/tr/sepet', {
                        retries: 1,
                        waitUntil: 'networkidle2',
                        expectedUrlIncludes: '/sepet',
                        rejectIfHome: false,
                        backoffMs: 350
                    });
                } catch {}
                let removed = false;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    if (removed) break;
                    aRemoveAttempts = attempt;
                    await ensureRemoveDelayAfterBasket();
                    audit('a_remove_from_basket_start', { idx: i, aEmail: aCtx.email, seatId: aCtx.seatInfo.seatId, attempt });
                    removed = await clickRemoveFromCartAndConfirm(aCtx.page, cfg.TIMEOUTS.REMOVE_FROM_CART_TIMEOUT);
                    if (removed) break;
                    try { await delay(1500); } catch {}
                }

                if (!removed) {
                    results.push({ idx: i, ok: false, error: formatError('REMOVE_FROM_CART_FAILED'), seatA: aCtx.seatInfo });
                    audit('a_remove_from_basket_failed', {
                        idx: i,
                        aEmail: aCtx.email,
                        seatId: aCtx.seatInfo.seatId,
                        ms: Date.now() - aRemoveStartedAt,
                        attempts: aRemoveAttempts
                    }, 'warn');
                    continue;
                }

                audit('a_remove_from_basket_done', {
                    idx: i,
                    aEmail: aCtx.email,
                    seatId: aCtx.seatInfo.seatId,
                    ms: Date.now() - aRemoveStartedAt,
                    attempts: aRemoveAttempts
                });

                // B is already on seat selection with seatmap ready - just apply correct category/block
                setStep(`PAIR${i}.b_apply_catblock.start`, { seatmapReady: bCtx.seatmapReady });
                audit('b_apply_catblock_start', { idx: i, bEmail: bCtx.email, seatId: aCtx.seatInfo.seatId, seatmapReady: bCtx.seatmapReady });

                // Apply A's category/block to B for faster exact pick
                try {
                    await applyCategoryBlockSelection(bCtx.page, categorySelectionMode, aCtx.catBlock, aCtx.seatInfo);
                    audit('b_catblock_applied', { idx: i, bEmail: bCtx.email, seatId: aCtx.seatInfo.seatId });
                } catch (e) {
                    audit('b_catblock_apply_warn', { idx: i, bEmail: bCtx.email, error: e?.message }, 'warn');
                }

                // Re-open seatmap to refresh with new block
                if (!bCtx.seatmapReady) {
                    try {
                        await openSeatMapStrict(bCtx.page);
                        await bCtx.page.waitForFunction((sel) => {
                            try { return document.querySelectorAll(sel).length > 0; } catch { return false; }
                        }, { timeout: 10000 }, SEAT_NODE_SELECTOR);
                        audit('b_seatmap_reopened', { idx: i, bEmail: bCtx.email });
                    } catch (e) {
                        audit('b_seatmap_reopen_failed', { idx: i, bEmail: bCtx.email, error: e?.message }, 'warn');
                    }
                }

                setStep(`PAIR${i}.b_apply_catblock.done`);

                // start B exact pick immediately with short timeout for fast response
                const exactMaxMs = Math.max(8000, Math.min(cfg.TIMEOUTS.SEAT_PICK_EXACT_MAX || 0, 30000));

                audit('b_exact_pick_start', { idx: i, bEmail: bCtx.email, seatId: aCtx.seatInfo.seatId, maxMs: exactMaxMs, seatmapReady: bCtx.seatmapReady });
                const exactPromise = pickExactSeatWithVerify_ReleaseAware(bCtx.page, aCtx.seatInfo, exactMaxMs);

                let seatBInfo = null;
                try {
                    seatBInfo = await exactPromise;
                } catch (e) {
                    results.push({ idx: i, ok: false, error: e?.message || String(e), seatA: aCtx.seatInfo });
                    audit('b_exact_pick_failed', { idx: i, bEmail: bCtx.email, seatId: aCtx.seatInfo.seatId, error: e?.message || String(e) }, 'warn');
                    continue;
                }

                audit('b_exact_pick_done', {
                    idx: i,
                    bEmail: bCtx.email,
                    seatId: aCtx.seatInfo.seatId,
                    pickedSeatId: seatBInfo?.seatId || null,
                    row: seatBInfo?.row || null,
                    seat: seatBInfo?.seat || null
                });

                results.push({ idx: i, ok: true, seatA: aCtx.seatInfo, seatB: seatBInfo, aEmail: aCtx.email, bEmail: bCtx.email });
                setStep(`PAIR${i}.done`, { ok: true, seatId: aCtx.seatInfo.seatId });
                audit('transfer_pair_done', {
                    idx: i,
                    ok: true,
                    seatId: aCtx.seatInfo.seatId,
                    aEmail: aCtx.email,
                    bEmail: bCtx.email,
                    ms: Date.now() - pairStart
                });
            }
            setStep('MULTI.transfer.done', { resultsCount: results.length });
            audit('multi_transfer_done', { resultsCount: results.length });

            // Keep A accounts without matching B holding in basket.
            const holdingOnly = aCtxList.slice(pairCount).map(a => ({ idx: a.idx, email: a.email, seatInfo: a.seatInfo }));
            audit('multi_holding_only', { count: holdingOnly.length, holdingOnly: holdingOnly.map(x => ({ idx: x.idx, email: x.email, seatId: x?.seatInfo?.seatId || null })) });

            logger.infoSafe('Bot başarıyla tamamlandı (multi)', {
                grabbedBy: bCtxList.filter(Boolean).map(x => x.email),
                results,
                holdingOnly
            });

            return res.json({
                success: true,
                mode: 'multi',
                results,
                holdingOnly
            });
        }

        // A: Launch + Login
        setStep('A.launchAndLogin.start', { email: emailA });
        audit('account_launch_start', { role: 'A', idx: 0, email: emailA });
        ({browser: browserA, page: pageA} = await launchAndLogin({
            email: emailA, password: passwordA, userDataDir: cfg.USER_DATA_DIR_A, proxyHost, proxyPort, proxyUsername, proxyPassword
        }));
        setStep('A.launchAndLogin.done', { email: emailA, snap: await snapshotPage(pageA, 'A.afterLogin') });
        audit('account_launch_done', { role: 'A', idx: 0, email: emailA, url: (() => { try { return pageA.url(); } catch { return null; } })() });
        logger.info('A hesabı giriş yaptı');

        // B: Launch + Login
        setStep('B.launchAndLogin.start', { email: emailB });
        audit('account_launch_start', { role: 'B', idx: 0, email: emailB });
        ({browser: browserB, page: pageB} = await launchAndLogin({
            email: emailB,
            password: passwordB,
            userDataDir: cfg.USER_DATA_DIR_B,
            proxyHost,
            proxyPort,
            proxyUsername,
            proxyPassword
        }));
        setStep('B.launchAndLogin.done', { email: emailB, snap: await snapshotPage(pageB, 'B.afterLogin') });
        audit('account_launch_done', { role: 'B', idx: 0, email: emailB, url: (() => { try { return pageB.url(); } catch { return null; } })() });
        logger.info('B hesabı giriş yaptı');

        // Start finalize watcher after pages are ready.
        try { ensureFinalizeWatcher(); } catch {}

        // A: go event -> BUY -> ticket type (if present) -> category/block -> random seat
        setStep('A.gotoEvent.start', { eventAddress });
        audit('account_goto_event_start', { role: 'A', idx: 0, email: emailA, eventAddress });
        const eventPathIncludes = (() => {
            try {
                const u = new URL(String(eventAddress));
                return u.pathname || null;
            } catch {
                return null;
            }
        })();
        const aGoto = await gotoWithRetry(pageA, String(eventAddress), {
            retries: 3,
            waitUntil: 'networkidle2',
            expectedUrlIncludes: eventPathIncludes,
            rejectIfHome: true,
            backoffMs: 450
        });
        setStep('A.gotoEvent.done', { goto: aGoto, snap: await snapshotPage(pageA, 'A.afterEventGoto') });
        audit('account_goto_event_done', { role: 'A', idx: 0, email: emailA, url: (() => { try { return pageA.url(); } catch { return null; } })() });

        setStep('A.clickBuy.start');
        audit('account_click_buy_start', { role: 'A', idx: 0, email: emailA });
        const clickedA = await clickBuy(pageA, eventAddress);
        if (!clickedA) throw new Error(formatError('BUY_BUTTON_FAILED_A'));
        setStep('A.clickBuy.done');
        audit('account_click_buy_done', { role: 'A', idx: 0, email: emailA, url: (() => { try { return pageA.url(); } catch { return null; } })() });

        await handlePrioritySaleModal(pageA, { prioritySale, fanCardCode: a0?.fanCardCode ?? fanCardCode, identity: a0?.identity ?? identity });
        logger.info('A hesabı SATIN AL butonuna tıkladı');

        setStep('A.waitNavAfterBuy.start');
        const aPreUrl = (() => { try { return pageA.url(); } catch { return null; } })();
        const aNavResult = await Promise.race([
            pageA.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 })
                .then(() => ({ type: 'navigation' }))
                .catch((e) => ({ type: 'nav_error', message: e?.message })),
            pageA.waitForFunction((pre) => location.href !== pre, { timeout: 10000 }, aPreUrl)
                .then(() => ({ type: 'url_change' }))
                .catch((e) => ({ type: 'url_wait_error', message: e?.message })),
            delay(10000).then(() => ({ type: 'timeout' }))
        ]);
        await pageA.waitForSelector('.custom-select-box, .ticket-type-title, #custom_seat_button', { timeout: 10000 }).catch(() => {});
        setStep('A.waitNavAfterBuy.done', { result: aNavResult, snap: await snapshotPage(pageA, 'A.afterBuyNav') });

        setStep('A.postBuy.ensureUrl.start');
        const aUrlCheck = await ensureUrlContains(pageA, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 });
        setStep('A.postBuy.ensureUrl.done', { urlCheck: aUrlCheck, snap: await snapshotPage(pageA, 'A.afterEnsureUrl') });
        audit('account_seat_selection_ready', { role: 'A', idx: 0, email: emailA, ok: !!aUrlCheck?.ok, url: (() => { try { return pageA.url(); } catch { return null; } })() });

        setStep('A.postBuy.reloginCheck.start');
        const aRelog = await reloginIfRedirected(pageA, emailA, passwordA);
        setStep('A.postBuy.reloginCheck.done', { relogged: aRelog, snap: await snapshotPage(pageA, 'A.afterReloginCheck') });

        const psA2 = await handlePrioritySaleModal(pageA, { prioritySale, fanCardCode: a0?.fanCardCode ?? fanCardCode, identity: a0?.identity ?? identity });
        if (psA2) {
            try { await ensureUrlContains(pageA, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 }); } catch {}
        }

        setStep('A.seatSelection.turnstile.ensure.start');
        await ensureTurnstileTokenOnPage(pageA, emailA, 'A.seatSelection');
        setStep('A.seatSelection.turnstile.ensure.done', { snap: await snapshotPage(pageA, 'A.afterTurnstileEnsure') });

        // Hard guard: compute canonical seat selection URL and force navigation back to /koltuk-secim if we drifted.
        const canonicalSeatUrlA = (() => {
            try {
                const u = new URL(String(eventAddress));
                const p = String(u.pathname || '');
                const seatPath = p.includes('/koltuk-secim') ? p : (p.endsWith('/') ? `${p}koltuk-secim` : `${p}/koltuk-secim`);
                return `${u.origin}${seatPath}`;
            } catch {
                const s = String(eventAddress || '');
                if (!s) return null;
                if (s.includes('/koltuk-secim')) return s;
                return s.endsWith('/') ? `${s}koltuk-secim` : `${s}/koltuk-secim`;
            }
        })();

        try {
            const okNow = await ensureUrlContains(pageA, '/koltuk-secim', { retries: 0, waitMs: 10 });
            if (!okNow?.ok && canonicalSeatUrlA) {
                logger.warn('A.force_goto_canonical_seat_url', {
                    currentUrl: (() => { try { return pageA.url(); } catch { return null; } })(),
                    canonicalSeatUrlA
                });
                try {
                    await gotoWithRetry(pageA, canonicalSeatUrlA, {
                        retries: 3,
                        waitUntil: 'domcontentloaded',
                        expectedUrlIncludes: '/koltuk-secim',
                        rejectIfHome: true,
                        backoffMs: 450
                    });
                } catch {}

                const okAfter = await ensureUrlContains(pageA, '/koltuk-secim', {
                    retries: 1,
                    waitMs: 9000,
                    backoffMs: 450,
                    recoveryUrl: canonicalSeatUrlA
                }).catch(() => null);
                if (!okAfter?.ok) {
                    throw new Error('Seat selection sayfasına gidilemedi (/koltuk-secim)');
                }
            }
        } catch {}

        // If we are still on login page, recover by navigating to decoded returnUrl.
        try {
            const cur = (() => { try { return pageA.url(); } catch { return ''; } })();
            if (/\/giris(\?|$)/i.test(cur)) {
                let returnUrl = null;
                try {
                    const u = new URL(cur);
                    returnUrl = u.searchParams.get('returnUrl');
                    if (returnUrl) {
                        try { returnUrl = decodeURIComponent(returnUrl); } catch {}
                        if (!/^https?:\/\//i.test(returnUrl)) {
                            returnUrl = `https://www.passo.com.tr${returnUrl.startsWith('/') ? '' : '/'}${returnUrl}`;
                        }
                    }
                } catch {}

                if (returnUrl) {
                    logger.warn('A.login_stuck_recover_returnUrl', { cur, returnUrl });
                    await gotoWithRetry(pageA, returnUrl, {
                        retries: 2,
                        waitUntil: 'domcontentloaded',
                        expectedUrlIncludes: '/koltuk-secim',
                        rejectIfHome: false,
                        backoffMs: 450
                    }).catch(() => {});
                }
            }
        } catch {}

        // Guard: page can drift to home due to session/captcha/network issues. Do not continue category selection on wrong page.
        const seatUrlA_forRecover = canonicalSeatUrlA || (() => { try { return pageA.url(); } catch { return null; } })();
        const seatUrlOk = await ensureUrlContains(pageA, '/koltuk-secim', { retries: 1, waitMs: 4000, backoffMs: 350, recoveryUrl: seatUrlA_forRecover });
        if (!seatUrlOk?.ok) {
            logger.warn('A.seatSelection.url_drift_before_category', { urlCheck: seatUrlOk, currentUrl: (() => { try { return pageA.url(); } catch { return null; } })(), seatUrlA_forRecover });
            if (seatUrlA_forRecover) {
                await gotoWithRetry(pageA, String(seatUrlA_forRecover), {
                    retries: 2,
                    waitUntil: 'domcontentloaded',
                    expectedUrlIncludes: '/koltuk-secim',
                    rejectIfHome: true,
                    backoffMs: 450
                }).catch(() => {});
            }
        }

        // Final guard: refuse to run category selection if we are not on seat page.
        const seatUrlOk2 = await ensureUrlContains(pageA, '/koltuk-secim', { retries: 0, waitMs: 10 });
        if (!seatUrlOk2?.ok) {
            throw new Error('Seat selection sayfasına gidilemedi (/koltuk-secim)');
        }

        // Final guard before category selection: do not continue on /giris.
        try {
            const cur = (() => { try { return pageA.url(); } catch { return ''; } })();
            if (/\/giris(\?|$)/i.test(cur)) {
                throw new Error('Login sayfasında kaldı (kategori seçimine geçilemedi)');
            }
        } catch (e) {
            throw e;
        }

        const hasTicketType = await pageA.$('.ticket-type-title');
        if (hasTicketType) {
            setStep('A.ticketType.select.start');
            await pageA.evaluate(() => {
                const titles = Array.from(document.querySelectorAll('.ticket-type-title'));
                const target = titles.find(el => (el.innerText || '').includes('Passolig E-Bilet'));
                target?.click();
            });
            setStep('A.ticketType.select.done', { snap: await snapshotPage(pageA, 'A.afterTicketType') });
        }

        // Capture selected category & block for transfer to B. DOM can be late/placeholder, so retry a bit.
        let catBlockA = { categoryText: '', blockText: '', blockVal: '' };

        setStep('A.categoryBlock.select.start', { categoryType, alternativeCategory, categorySelectionMode });
        const cbResA = await chooseCategoryAndRandomBlock(pageA, categoryType, alternativeCategory, categorySelectionMode);
        if (cbResA && cbResA.svgBlockId) {
            try { catBlockA = { ...catBlockA, svgBlockId: cbResA.svgBlockId }; } catch {}
        }
        setStep('A.categoryBlock.select.done', { snap: await snapshotPage(pageA, 'A.afterCategoryBlock') });

        for (let i = 0; i < 6; i++) {
            try {
                const c = await readCatBlock(pageA);
                const catTxt = (c?.categoryText || '').trim();
                const isPlaceholder = !catTxt || catTxt.toLowerCase() === 'kategori';
                const blocksOk = !!(c?.blockVal || c?.blockText);
                if (!isPlaceholder && blocksOk) { catBlockA = { ...(c || {}), svgBlockId: catBlockA?.svgBlockId }; break; }
                catBlockA = { ...(c || catBlockA), svgBlockId: catBlockA?.svgBlockId };
            } catch {}
            await delay(350);
        }
        logger.info('A hesabı kategori/blok okundu', { catBlockA });

        setStep('A.seat.pickRandom.start');
        const seatSelectionUrlA = (() => { try { return pageA.url(); } catch { return null; } })();
        const netSeatA = captureSeatIdFromNetwork(pageA, cfg.TIMEOUTS.NETWORK_CAPTURE_TIMEOUT);
        const seatHelper = require('../helpers/seat');

        let seatInfoA = null;
        const maxCycle = Math.max(12, Number(cfg?.TIMEOUTS?.SEAT_SELECTION_CYCLES || 0) || 12);
        let cycleStartedAt = Date.now();
        for (let cycle = 1; cycle <= maxCycle; cycle++) {
            try {
                const remaining = Math.max(15000, Number(cfg.TIMEOUTS.SEAT_SELECTION_MAX) - (Date.now() - cycleStartedAt));
                seatInfoA = await seatHelper.pickRandomSeatWithVerify(
                    pageA,
                    remaining,
                    {
                        context: 'A',
                        expectedUrlIncludes: '/koltuk-secim',
                        recoveryUrl: seatSelectionUrlA,
                        roamCategoryTexts: [categoryType, alternativeCategory].filter(Boolean),
                        email: emailA,
                        password: passwordA,
                        reloginIfRedirected,
                        ensureTurnstileFn: ensureTurnstileTokenOnPage
                    }
                );
                break;
            } catch (e) {
                const msg = e?.message || String(e);
                if (/NO_SELECTABLE_SEATS/i.test(msg) || msg.includes('Seçilen blokta boş/aktif koltuk bulunamadı')) {
                    logger.warn('A.seat.noSelectable.retry_block', { cycle, msg });
                    setStep('A.categoryBlock.reselect.start', { cycle });
                    const roamEvery = Math.max(0, Number(cfg?.TIMEOUTS?.CATEGORY_ROAM_EVERY_CYCLES || 0) || 0);
                    const baseMode = String(categorySelectionMode || 'legacy').toLowerCase();
                    const mode2 = (baseMode === 'svg') ? categorySelectionMode : ((roamEvery > 0 && (cycle % roamEvery) === 0) ? 'scan' : categorySelectionMode);
                    const cbResA2 = await chooseCategoryAndRandomBlock(pageA, categoryType, alternativeCategory, mode2);
                    if (cbResA2 && cbResA2.svgBlockId) {
                        try { catBlockA = { ...(catBlockA || {}), svgBlockId: cbResA2.svgBlockId }; } catch {}
                    }
                    setStep('A.categoryBlock.reselect.done', { cycle, snap: await snapshotPage(pageA, `A.afterReselect_${cycle}`) });
                    // Reset the seat-pick deadline after a reselect. Reselect can take significant time (loader/UI),
                    // and we don't want to fail just because we spent time switching blocks with no seats.
                    cycleStartedAt = Date.now();
                    continue;
                }
                throw e;
            }
        }
        if (!seatInfoA) throw new Error(formatError('SEAT_SELECTION_FAILED_A'));
        const sidNet = await netSeatA;
        if (sidNet) {
            if (!seatInfoA.seatId) seatInfoA.seatId = sidNet.seatId;
            if (!seatInfoA.row) seatInfoA.row = sidNet.row;
            if (!seatInfoA.seat) seatInfoA.seat = sidNet.seat;
            logger.info('A koltuk bilgisi networkten alındı', { seatId: seatInfoA.seatId, row: seatInfoA.row, seat: seatInfoA.seat });
        }
        setStep('A.seat.pickRandom.done', { seatInfoA, sidNet, snap: await snapshotPage(pageA, 'A.afterSeatPick') });

        // Used to enforce deterministic remove timing: wait 30s after arriving basket page.
        let aBasketArrivedAtMs = null;

        // Passo sometimes keeps the UI on /koltuk-secim even after basket is created.
        // For transfer flow we need A to be on basket page to remove the item reliably.
        try {
            setStep('A.gotoBasket.start');
            await gotoWithRetry(pageA, 'https://www.passo.com.tr/tr/sepet', {
                retries: 2,
                waitUntil: 'networkidle2',
                expectedUrlIncludes: '/sepet',
                rejectIfHome: false,
                backoffMs: 450
            });
            await pageA.waitForSelector('.basket-list-detail, .basket-list, .basket, [data-testid*="basket" i], [data-testid*="sepet" i]', { timeout: 15000 }).catch(() => {});
            aBasketArrivedAtMs = Date.now();
            setStep('A.gotoBasket.done', { snap: await snapshotPage(pageA, 'A.afterGotoBasket') });
        } catch {}

        const ensureRemoveDelayAfterBasket = async () => {
            const MIN_AFTER_BASKET_MS = 30000;
            if (!aBasketArrivedAtMs) aBasketArrivedAtMs = Date.now();
            const elapsed = Date.now() - aBasketArrivedAtMs;
            if (elapsed < MIN_AFTER_BASKET_MS) {
                const waitMs = MIN_AFTER_BASKET_MS - elapsed;
                logger.info('A.removeFromCart.delayAfterBasket', { waitMs, elapsedMs: elapsed });
                await delay(waitMs);
            }
        };
        
        // Sepette tutma süresi takibini başlat
        basketTimer = new BasketTimer();
        basketTimer.start();

        setHolder('A', seatInfoA, catBlockA);
        
        // Sayfadan sepette tutma süresini okumaya çalış (opsiyonel)
        const pageBasketInfo = await checkBasketTimeoutFromPage(pageA);
        if (pageBasketInfo && pageBasketInfo.foundTimeText) {
            logger.info('Sayfadan sepette tutma süresi okundu', { basketInfo: pageBasketInfo });
        }
        
        const basketStatus = basketTimer.getStatus();
        logger.info('A hesabı koltuk seçti ve sepete eklendi', { 
            seatInfo: seatInfoA,
            basketStatus: basketStatus
        });

        // B: go event -> BUY -> same category & block -> target seat (locked strategy)
        setStep('B.gotoEvent.start', { eventAddress });
        const bGoto = await gotoWithRetry(pageB, String(eventAddress), {
            retries: 3,
            waitUntil: 'networkidle2',
            expectedUrlIncludes: eventPathIncludes,
            rejectIfHome: true,
            backoffMs: 450
        });
        setStep('B.gotoEvent.done', { goto: bGoto, snap: await snapshotPage(pageB, 'B.afterEventGoto') });

        setStep('B.clickBuy.start');
        const clickedB = await clickBuy(pageB, eventAddress);
        if (!clickedB) throw new Error(formatError('BUY_BUTTON_FAILED_B'));
        setStep('B.clickBuy.done');
        logger.info('B hesabı SATIN AL butonuna tıkladı');

        await handlePrioritySaleModal(pageB, { prioritySale, fanCardCode: b0?.fanCardCode ?? fanCardCode, identity: b0?.identity ?? identity });

        setStep('B.waitNavAfterBuy.start');
        const bPreUrl = (() => { try { return pageB.url(); } catch { return null; } })();
        const bNavResult = await Promise.race([
            pageB.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 })
                .then(() => ({ type: 'navigation' }))
                .catch((e) => ({ type: 'nav_error', message: e?.message })),
            pageB.waitForFunction((pre) => location.href !== pre, { timeout: 10000 }, bPreUrl)
                .then(() => ({ type: 'url_change' }))
                .catch((e) => ({ type: 'url_wait_error', message: e?.message })),
            delay(10000).then(() => ({ type: 'timeout' }))
        ]);
        await pageB.waitForSelector('.custom-select-box, .ticket-type-title, #custom_seat_button', { timeout: 10000 }).catch(() => {});
        setStep('B.waitNavAfterBuy.done', { result: bNavResult, snap: await snapshotPage(pageB, 'B.afterBuyNav') });

        setStep('B.postBuy.ensureUrl.start');
        const bUrlCheck = await ensureUrlContains(pageB, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 });
        setStep('B.postBuy.ensureUrl.done', { urlCheck: bUrlCheck, snap: await snapshotPage(pageB, 'B.afterEnsureUrl') });

        setStep('B.postBuy.reloginCheck.start');
        const bRelog = await reloginIfRedirected(pageB, emailB, passwordB);
        setStep('B.postBuy.reloginCheck.done', { relogged: bRelog, snap: await snapshotPage(pageB, 'B.afterReloginCheck') });

        const psB2 = await handlePrioritySaleModal(pageB, { prioritySale, fanCardCode: b0?.fanCardCode ?? fanCardCode, identity: b0?.identity ?? identity });
        if (psB2) {
            try { await ensureUrlContains(pageB, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 }); } catch {}
        }

        setStep('B.seatSelection.turnstile.ensure.start');
        await ensureTurnstileTokenOnPage(pageB, emailB, 'B.seatSelection');
        setStep('B.seatSelection.turnstile.ensure.done', { snap: await snapshotPage(pageB, 'B.afterTurnstileEnsure') });

        // B catBlock seçimi A kaldırdıktan sonra yapılacak
        // setStep('B.catBlock.sync.start');
        // await setCatBlockOnB(pageB, catBlockA);
        // setStep('B.catBlock.sync.done', { catBlockA, snap: await snapshotPage(pageB, 'B.afterCatBlockSet') });
        // logger.info('B hesabı kategori/blok ayarlandı', { catBlockA });

        const seatSelectionUrlB = (() => { try { return pageB.url(); } catch { return null; } })();
        try {
            seatInfoA.__recoveryOptions = {
                context: 'B',
                expectedUrlIncludes: '/koltuk-secim',
                recoveryUrl: seatSelectionUrlB,
                email: emailB,
                password: passwordB,
                reloginIfRedirected,
                ensureTurnstileFn: ensureTurnstileTokenOnPage
            };
        } catch {}

        setStep('B.target.ready.start', { targetSeat: seatInfoA });
        const ready = await waitForTargetSeatReady(pageB, seatInfoA, 15000);
        if (!ready) logger.warn('B hesabı hedef koltuk DOM\'da bulunamadı, yine de denenecek');
        setStep('B.target.ready.done', { ready, snap: await snapshotPage(pageB, 'B.afterReady') });

        // B hazır ama blok seçimi yapmadan bekliyor - A kaldırdıktan sonra yapacak
        let aRemovedResolve;
        const aRemovedPromise = new Promise(resolve => { aRemovedResolve = resolve; });

        setStep('B.target.grabLoop.start', { targetSeat: seatInfoA });
        const waitPickB = (async () => {
            // A kaldırmadan önce bekle
            logger.info('B koltuk seçiminde hazır, A kaldırması bekleniyor');
            audit('b_waiting_a_remove', { aEmail: emailA, bEmail: emailB, seatId: seatInfoA?.seatId || null });
            await aRemovedPromise;
            logger.info('A kaldırdı, B blok seçimi yapıyor');
            audit('b_a_remove_received', { aEmail: emailA, bEmail: emailB, seatId: seatInfoA?.seatId || null });

            // After release, select block & mount seatmap deterministically.
            try { await applyCategoryBlockSelection(pageB, categorySelectionMode, catBlockA, seatInfoA); } catch {}
            const ensureSeatmapMountedOnB = async () => {
                const svgBid = (catBlockA?.svgBlockId || seatInfoA?.svgBlockId || null);
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try { await openSeatMapStrict(pageB); } catch {}
                    try {
                        await pageB.waitForFunction((sel) => {
                            try { return document.querySelectorAll(sel).length > 0; } catch { return false; }
                        }, { timeout: 20000 }, SEAT_NODE_SELECTOR);
                        return true;
                    } catch {}
                    if (svgBid) {
                        try { await selectSvgBlockById(pageB, String(svgBid)); } catch {}
                    }
                    try { await delay(350 + (attempt * 300)); } catch {}
                }
                return false;
            };
            try { await ensureSeatmapMountedOnB(); } catch {}

            logger.info('B blok seçimi tamamlandı, koltuk seçiliyor');
            audit('b_cat_block_set', {
                aEmail: emailA,
                bEmail: emailB,
                seatId: seatInfoA?.seatId || null,
                categoryText: catBlockA?.categoryText || null,
                blockText: catBlockA?.blockText || null,
                blockVal: catBlockA?.blockVal || null,
                svgBlockId: catBlockA?.svgBlockId || seatInfoA?.svgBlockId || null
            });

            // Öncelik: A'nın koltuğunu (aynı seatId) B hesabına aynen yakalat.
            const exactMaxMs = Math.max(30000, Math.min(cfg.TIMEOUTS.SEAT_PICK_EXACT_MAX || 0, 120000));
            logger.info('B hedef koltuğu zorluyor (aynı seatId)', { seatId: seatInfoA?.seatId || null, exactMaxMs });
            audit('b_exact_pick_start', { aEmail: emailA, bEmail: emailB, seatId: seatInfoA?.seatId || null, maxMs: exactMaxMs, seatSelectionUrlB });
            try {
                const gotExact = await pickExactSeatWithVerify_ReleaseAware(pageB, seatInfoA, exactMaxMs);
                if (gotExact) {
                    logger.info('B hedef koltuğu yakaladı (exact)', { seat: gotExact });
                    audit('b_exact_pick_done', { aEmail: emailA, bEmail: emailB, seatId: seatInfoA?.seatId || null, pickedSeatId: gotExact?.seatId || null, row: gotExact?.row || null, seat: gotExact?.seat || null });
                    return gotExact;
                }
            } catch (e) {
                logger.warn('B hedef koltuk exact denemesi başarısız', { error: e?.message || String(e) });
                audit('b_exact_pick_failed', { aEmail: emailA, bEmail: emailB, seatId: seatInfoA?.seatId || null, error: e?.message || String(e) }, 'warn');
            }

            // Fallback: Eğer exact koltuk alınamazsa (başkası aldı vs), random dene.
            logger.warn('B exact seat alınamadı, random fallback', { seatId: seatInfoA?.seatId || null });
            audit('b_random_fallback_start', { aEmail: emailA, bEmail: emailB, seatId: seatInfoA?.seatId || null });
            const randomGot = await pickRandomSeatWithVerify(
                pageB,
                cfg.TIMEOUTS.SEAT_SELECTION_MAX,
                {
                    context: 'B',
                    expectedUrlIncludes: '/koltuk-secim',
                    recoveryUrl: seatSelectionUrlB,
                    email: emailB,
                    password: passwordB,
                    reloginIfRedirected,
                    ensureTurnstileFn: ensureTurnstileTokenOnPage
                }
            );
            logger.info('B rastgele koltuk yakaladı (fallback)', { seat: randomGot });
            audit('b_random_fallback_done', { aEmail: emailA, bEmail: emailB, seatId: seatInfoA?.seatId || null, pickedSeatId: randomGot?.seatId || null, row: randomGot?.row || null, seat: randomGot?.seat || null });
            return randomGot;
        })();

        // Sepette tutma süresini kontrol et ve dinamik zamanlama yap
        const checkBasketStatus = async () => {
            const status = basketTimer.getStatus();
            
            // Sepet timeout'una yaklaşıyor mu kontrol et
            if (basketTimer.isNearExpiry()) {
                logger.warn('Sepette tutma süresi dolmak üzere!', {
                    remaining: status.remainingFormatted,
                    remainingSeconds: status.remainingSeconds
                });
            }
            
            // Sepet timeout olmuş mu kontrol et
            if (basketTimer.isExpired()) {
                logger.error('Sepette tutma süresi doldu!', {
                    elapsedSeconds: status.elapsedSeconds,
                    holdingTimeSeconds: status.holdingTimeSeconds
                });
                throw new Error('Sepette tutma süresi doldu. Koltuk serbest kaldı.');
            }
            
            return status;
        };

        // B hesabı hazır olana kadar sepette tutma süresini kontrol et
        let intervalError;
        const abortOnIntervalError = new Promise((_, reject) => {
            basketMonitor = setInterval(async () => {
                try {
                    await checkBasketStatus();
                } catch (error) {
                    intervalError = error;
                    clearInterval(basketMonitor);
                    reject(error);
                }
            }, 5000); // Her 5 saniyede bir kontrol et
        });

        // Sepette tutma süresine göre dinamik zamanlama
        let shouldRemoveNow = false;
        const removeBeforeTimeout = async () => {
            const status = basketTimer.getStatus();
            
            // Dinamik uzatma: kalan süre eşik değerin altına düştüyse ve hala transfer gerçekleşmediyse,
            // bileti B hesabına geçirip (B sepetinde yeniden süre başlatacak şekilde) yakalat.
            const threshold = Number.isFinite(extendWhenRemainingSecondsBelow)
                ? extendWhenRemainingSecondsBelow
                : 90;
            const remaining = status.remainingSeconds;
            if (status.remainingSeconds <= threshold && !shouldRemoveNow) {
                // Default behavior: transfer to B by removing from A
                shouldRemoveNow = true;
                clearInterval(basketMonitor);

                logger.info('Dinamik uzatma tetiklendi (B hesabına geçiş)', {
                    remainingSeconds: remaining,
                    extendWhenRemainingSecondsBelow: threshold,
                    message: `${remaining} saniye kala koltuk A sepetinden kaldırılıp B hesabına geçiriliyor`
                });
                audit('dynamic_transfer_triggered', { aEmail: emailA, bEmail: emailB, seatId: seatInfoA?.seatId || null, remainingSeconds: remaining, threshold });
                
                // A hesabı koltuğu sepetten kaldır
                logger.debug('A hesabı koltuğu sepetten kaldırıyor (dinamik zamanlama)');
                audit('a_remove_from_basket_start', { aEmail: emailA, bEmail: emailB, seatId: seatInfoA?.seatId || null, reason: 'dynamic_timing' });
                try {
                    try { await reloginIfRedirected(pageA, emailA, passwordA); } catch {}
                    await gotoWithRetry(pageA, 'https://www.passo.com.tr/tr/sepet', {
                        retries: 2,
                        waitUntil: 'networkidle2',
                        expectedUrlIncludes: '/sepet',
                        rejectIfHome: false,
                        backoffMs: 450
                    });
                    aBasketArrivedAtMs = aBasketArrivedAtMs || Date.now();
                } catch {}

                // If we got dumped on home/root, try one more time to reach basket (common when session flaps).
                try {
                    const u = (() => { try { return pageA.url(); } catch { return ''; } })();
                    if (u === 'https://www.passo.com.tr/' || u === 'https://www.passo.com.tr') {
                        try { await reloginIfRedirected(pageA, emailA, passwordA); } catch {}
                        await gotoWithRetry(pageA, 'https://www.passo.com.tr/tr/sepet', {
                            retries: 1,
                            waitUntil: 'networkidle2',
                            expectedUrlIncludes: '/sepet',
                            rejectIfHome: false,
                            backoffMs: 450
                        });
                        aBasketArrivedAtMs = aBasketArrivedAtMs || Date.now();
                    }
                } catch {}

                // Ensure basket DOM is present; if not, one last retry (session drift / partial loads happen).
                try {
                    const ok = await pageA.waitForSelector('.basket-list-detail, .basket-list, .basket, [data-testid*="basket" i], [data-testid*="sepet" i]', { timeout: 8000 }).then(() => true).catch(() => false);
                    if (!ok) {
                        try { await reloginIfRedirected(pageA, emailA, passwordA); } catch {}
                        await gotoWithRetry(pageA, 'https://www.passo.com.tr/tr/sepet', {
                            retries: 1,
                            waitUntil: 'networkidle2',
                            expectedUrlIncludes: '/sepet',
                            rejectIfHome: false,
                            backoffMs: 450
                        }).catch(() => {});
                        await pageA.waitForSelector('.basket-list-detail, .basket-list, .basket, [data-testid*="basket" i], [data-testid*="sepet" i]', { timeout: 8000 }).catch(() => {});
                        aBasketArrivedAtMs = aBasketArrivedAtMs || Date.now();
                    }
                } catch {}

                let removed = false;

                // DOM-based removal only (API/XHR removed per user request)
                await ensureRemoveDelayAfterBasket();

                for (let attempt = 1; attempt <= 3; attempt++) {
                    if (removed) break;
                    removed = await clickRemoveFromCartAndConfirm(pageA, cfg.TIMEOUTS.REMOVE_FROM_CART_TIMEOUT);
                    if (removed) break;
                    try {
                        logger.warn('A.removeFromCart.retry.reload', { attempt });
                        await gotoWithRetry(pageA, 'https://www.passo.com.tr/tr/sepet', {
                            retries: 0,
                            waitUntil: 'networkidle2',
                            expectedUrlIncludes: '/sepet',
                            rejectIfHome: false,
                            backoffMs: 0
                        });
                        await delay(2500);
                    } catch {}
                }
                if (!removed) {
                    audit('a_remove_from_basket_failed', { aEmail: emailA, bEmail: emailB, seatId: seatInfoA?.seatId || null, reason: 'dynamic_timing' }, 'warn');
                    try {
                        try {
                            const frames = (() => {
                                try { return pageA.frames(); } catch { return []; }
                            })();
                            const frameMeta = frames.map(f => {
                                let url = null;
                                let name = null;
                                try { url = f.url(); } catch {}
                                try { name = typeof f.name === 'function' ? f.name() : null; } catch {}
                                return { name, url };
                            });
                            logger.warn('A.removeFromCart.failed.frames', { count: frameMeta.length, frameMeta });
                        } catch {}

                        const diag = await pageA.evaluate(() => {
                            const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim();
                            const pickInfo = (n) => {
                                const t = norm(n.getAttribute?.('aria-label') || n.getAttribute?.('title') || n.innerText || n.textContent || '');
                                const cls = norm(n.getAttribute?.('class') || '');
                                const dt = norm(n.getAttribute?.('data-testid') || '');
                                const id = norm(n.getAttribute?.('id') || '');
                                const href = norm(n.getAttribute?.('href') || '');
                                const type = norm(n.getAttribute?.('type') || '');
                                return { tag: n.tagName, text: t.slice(0, 140), id: id.slice(0, 80), href: href.slice(0, 120), type: type.slice(0, 40), testid: dt.slice(0, 80), className: cls.slice(0, 140) };
                            };

                            const all = [...document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"],img,svg,i,span')].slice(0, 1500);
                            const allBtn = [...document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]')].slice(0, 60);

                            const picks = [];
                            for (const n of all) {
                                const t = norm(n.getAttribute?.('aria-label') || n.getAttribute?.('title') || n.getAttribute?.('alt') || n.innerText || n.textContent || '');
                                const cls = norm(n.getAttribute?.('class') || '');
                                const dt = norm(n.getAttribute?.('data-testid') || '');
                                const id = norm(n.getAttribute?.('id') || '');
                                const key = (t + ' ' + cls + ' ' + dt + ' ' + id).toLowerCase();
                                if (!key) continue;
                                if (/(kald\w*r|sepett\w*\s*ç\w*kar|\bç\w*kar\b|\bsil\b|remove|delete|trash|bin|çöp)/i.test(key)) {
                                    picks.push(pickInfo(n));
                                    if (picks.length >= 25) break;
                                }
                            }

                            const basketRoots = [
                                document.querySelector('.basket-list-detail'),
                                document.querySelector('.basket-list'),
                                document.querySelector('.basket'),
                                document.querySelector('[data-testid*="basket" i]'),
                                document.querySelector('[data-testid*="sepet" i]')
                            ].filter(Boolean);
                            const basketSample = [];
                            if (basketRoots[0]) {
                                const inside = [...basketRoots[0].querySelectorAll('button,a,[role="button"],svg,i,img,span')].slice(0, 300);
                                for (const n of inside) {
                                    const info = pickInfo(n);
                                    if (info.text || info.className || info.testid || info.id) basketSample.push(info);
                                    if (basketSample.length >= 25) break;
                                }
                            }

                            const swal = !!document.querySelector('.swal2-container.swal2-shown');
                            const swalText = norm(document.querySelector('.swal2-container.swal2-shown .swal2-html-container')?.innerText || document.querySelector('.swal2-container.swal2-shown')?.innerText || '');

                            const iframes = [...document.querySelectorAll('iframe')].slice(0, 25).map(f => ({
                                id: norm(f.getAttribute('id') || ''),
                                name: norm(f.getAttribute('name') || ''),
                                src: norm(f.getAttribute('src') || ''),
                                title: norm(f.getAttribute('title') || '')
                            }));
                            return {
                                url: location.href,
                                swal,
                                swalText: swalText.slice(0, 200),
                                nodeCounts: { all: all.length, btnLike: allBtn.length, basketRoots: basketRoots.length },
                                candidates: picks,
                                firstButtons: allBtn.map(pickInfo),
                                basketSample,
                                iframes
                            };
                        });
                        logger.warn('A.removeFromCart.failed.domDiag', diag);
                    } catch {}
                    throw new Error(formatError('REMOVE_FROM_CART_FAILED'));
                }
                logger.info('A hesabı koltuğu sepetten kaldırdı (dinamik zamanlama)', {
                    remainingSeconds: remaining,
                    elapsedSeconds: status.elapsedSeconds
                });

                audit('a_remove_from_basket_done', { aEmail: emailA, bEmail: emailB, seatId: seatInfoA?.seatId || null, reason: 'dynamic_timing' });

                // B tarafı A'nın kaldırmasını bekliyor; sinyal gönder.
                try { aRemovedResolve?.(); } catch {}
            }
        };

        // Dinamik zamanlama kontrolü (her 2 saniyede bir)
        const abortOnDynamicTimingError = new Promise((_, reject) => {
            dynamicTimingCheck = setInterval(async () => {
                try {
                    await removeBeforeTimeout();
                } catch (error) {
                    intervalError = error;
                    clearInterval(dynamicTimingCheck);
                    clearInterval(basketMonitor);
                    reject(error);
                }
            }, 2000);
        });

        // Transfer yakalama B tarafında hazır bekler; A kaldırma işlemi sadece dinamik eşik tetiklendiğinde yapılır.
        let seatInfoB;
        try {
            const pickPromise = Promise.race([
                waitPickB,
                abortOnIntervalError,
                abortOnDynamicTimingError,
                (finalizeInFlight ? finalizeInFlight : new Promise(() => {}))
            ]);
            seatInfoB = await pickPromise;
            setStep('B.target.grabLoop.done', { seatInfoB, snap: await snapshotPage(pageB, 'B.afterGrab') });
            clearInterval(dynamicTimingCheck);
            clearInterval(basketMonitor);
        } catch (error) {
            clearInterval(dynamicTimingCheck);
            clearInterval(basketMonitor);

            // Fallback: eski locked strateji ile bir kez daha dene (özellikle DOM farklıysa)
            try {
                logger.warn('Transfer akışında hata, locked strateji ile fallback deneniyor', { error: error?.message || error });
                const got = await pickExactSeatWithVerify_Locked(pageB, seatInfoA, cfg.TIMEOUTS.SEAT_PICK_EXACT_MAX);
                if (got) {
                    seatInfoB = got;
                    setStep('B.target.grabLoop.fallback.locked.done', { seatInfoB, snap: await snapshotPage(pageB, 'B.afterGrabFallback') });
                } else {
                    throw error;
                }
            } catch {
                throw error;
            }
        }
        logger.info('B hesabı koltuğu yakaladı', { seatInfo: seatInfoB });
        try {
            const cbB = await readCatBlock(pageB).catch(() => null);
            const lastSvgBlockIdB = await pageB.evaluate(() => {
                try { return window.__passobotLastSvgBlockId || null; } catch { return null; }
            }).catch(() => null);
            // Derive the actual svg block id for the picked seat from the seat node itself.
            // window.__passobotLastSvgBlockId can be stale (e.g. preselected block before release).
            const derivedSvgBlockIdB = await pageB.evaluate((sid) => {
                try {
                    const seatId = String(sid || '').trim();
                    if (!seatId) return null;
                    const sel = [
                        `g.g${seatId}`,
                        `g[id="g${seatId}"]`,
                        `#g${seatId}`,
                        `.g${seatId}`,
                        `.block${seatId}`,
                        `rect.block${seatId}`,
                        `rect[id="block${seatId}"]`,
                        `#block${seatId}`
                    ].join(',');
                    const el = document.querySelector(sel);
                    if (!el) return null;
                    const b = el.closest('[id^="block"]');
                    const bid = b && b.id ? String(b.id) : null;
                    return bid && bid.startsWith('block') ? bid : null;
                } catch {
                    return null;
                }
            }, seatInfoB?.seatId || null).catch(() => null);

            if (cbB && (cbB.categoryText || cbB.blockText || cbB.blockVal)) {
                catBlockA = { ...cbB, svgBlockId: derivedSvgBlockIdB || lastSvgBlockIdB || cbB.svgBlockId || catBlockA?.svgBlockId };
            } else if (lastSvgBlockIdB) {
                catBlockA = { ...(catBlockA || {}), svgBlockId: derivedSvgBlockIdB || lastSvgBlockIdB };
            } else if (derivedSvgBlockIdB) {
                catBlockA = { ...(catBlockA || {}), svgBlockId: derivedSvgBlockIdB };
            }
            if (seatInfoB && (derivedSvgBlockIdB || (catBlockA && catBlockA.svgBlockId))) {
                seatInfoB.svgBlockId = String(derivedSvgBlockIdB || catBlockA.svgBlockId);
            }
        } catch {}
        setHolder('B', seatInfoB, catBlockA);

        // If finalize completed during the race, stop here.
        if (finalizedToCResult) {
            try {
                runStore.upsert(runId, { status: 'completed', result: finalizedToCResult });
            } catch {}
            return res.json(finalizedToCResult);
        }

        setStep('B.clickContinue.start');
        await clickContinueInsidePage(pageB);
        await delay(cfg.DELAYS.AFTER_CONTINUE);
        setStep('B.clickContinue.done', { snap: await snapshotPage(pageB, 'B.afterContinue') });

        // Optional: Basket loop (A<->B) to extend holding time by transferring before expiry.
        if (cfg?.BASKET?.LOOP_ENABLED) {
            try {
                const loopThreshold = Number.isFinite(extendWhenRemainingSecondsBelow)
                    ? extendWhenRemainingSecondsBelow
                    : 90;
                const maxHops = Number.isFinite(cfg?.BASKET?.LOOP_MAX_HOPS) ? cfg.BASKET.LOOP_MAX_HOPS : 12;
                const safeMaxHops = Math.max(1, maxHops);
                let hopCount = 1; // initial A->B transfer already happened
                let loopSeatInfo = seatInfoB || seatInfoA;

                audit('basket_loop_enabled', {
                    aEmail: emailA,
                    bEmail: emailB,
                    seatId: loopSeatInfo?.seatId || null,
                    loopThreshold,
                    maxHops: safeMaxHops
                });
                logger.warn('Basket loop enabled', { loopThreshold, maxHops: safeMaxHops });

                // Reset timer for current holder holding period
                try { basketTimer.start(); } catch {}

                while (hopCount < safeMaxHops) {
                    if (finalizeInFlight) {
                        try { await finalizeInFlight; } catch {}
                        if (finalizedToCResult) {
                            try { runStore.upsert(runId, { status: 'completed', result: finalizedToCResult }); } catch {}
                            return res.json(finalizedToCResult);
                        }
                    }

                    const fromRole = currentHolder || 'B';
                    const toRole = (fromRole === 'A') ? 'B' : 'A';
                    const fromPage = (fromRole === 'A') ? pageA : pageB;
                    const toPage = (toRole === 'A') ? pageA : pageB;
                    const fromEmail = (fromRole === 'A') ? emailA : emailB;
                    const fromPass = (fromRole === 'A') ? passwordA : passwordB;
                    const toEmail = (toRole === 'A') ? emailA : emailB;
                    const toPass = (toRole === 'A') ? passwordA : passwordB;

                    audit('basket_loop_hop_plan', { hop: hopCount + 1, from: fromRole, to: toRole, fromEmail, toEmail, seatId: loopSeatInfo?.seatId || null });

                    const prepareReceiverForExactPick = async (ctxLabel) => {
                        const maxAttempts = 3;
                        let lastErr = null;
                        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                            try {
                                try { await reloginIfRedirected(toPage, toEmail, toPass); } catch {}

                                setStep(`${toRole}.loop.${ctxLabel}.gotoEvent.start`, { attempt });
                                await gotoWithRetry(toPage, String(eventAddress), {
                                    retries: 2,
                                    waitUntil: 'networkidle2',
                                    expectedUrlIncludes: eventPathIncludes,
                                    rejectIfHome: true,
                                    backoffMs: 450
                                });
                                setStep(`${toRole}.loop.${ctxLabel}.gotoEvent.done`, { attempt, snap: await snapshotPage(toPage, `${toRole}.loop.${ctxLabel}.afterEventGoto`) });

                                setStep(`${toRole}.loop.${ctxLabel}.clickBuy.start`, { attempt });
                                await clickBuy(toPage, eventAddress);
                                setStep(`${toRole}.loop.${ctxLabel}.clickBuy.done`, { attempt });

                                const toIdentity = (toRole === 'A') ? (a0?.identity ?? identity) : (b0?.identity ?? identity);
                                const toFan = (toRole === 'A') ? (a0?.fanCardCode ?? fanCardCode) : (b0?.fanCardCode ?? fanCardCode);
                                await handlePrioritySaleModal(toPage, { prioritySale, fanCardCode: toFan, identity: toIdentity });

                                await ensureUrlContains(toPage, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 });
                                const u = (() => { try { return String(toPage.url()); } catch { return ''; } })();
                                if (!u.includes('/koltuk-secim')) {
                                    throw new Error(`RECEIVER_NOT_IN_SEAT_SELECTION:${u || 'unknown'}`);
                                }

                                await toPage.waitForSelector('.custom-select-box, .ticket-type-title, #custom_seat_button', { timeout: 12000 }).catch(() => {});
                                audit('basket_loop_receiver_ready', { hop: hopCount + 1, from: fromRole, to: toRole, attempt, url: u, seatId: loopSeatInfo?.seatId || null });
                                return true;
                            } catch (e) {
                                lastErr = e;
                                audit('basket_loop_receiver_prepare_failed', {
                                    hop: hopCount + 1,
                                    from: fromRole,
                                    to: toRole,
                                    attempt,
                                    error: e?.message || String(e),
                                    url: (() => { try { return toPage.url(); } catch { return null; } })(),
                                    seatId: loopSeatInfo?.seatId || null
                                }, 'warn');
                                try { await delay(800 + (attempt * 600)); } catch {}
                            }
                        }
                        throw lastErr || new Error('RECEIVER_PREPARE_FAILED');
                    };

                    // Prepare receiver BEFORE release
                    // If receiver can't reach /koltuk-secim, do NOT release from holder.
                    await prepareReceiverForExactPick('prepare');

                    let releasedResolve;
                    const releasedPromise = new Promise((resolve) => { releasedResolve = resolve; });

                    const waitPickTo = (async () => {
                        audit('basket_loop_receiver_waiting_release', { hop: hopCount + 1, from: fromRole, to: toRole, seatId: loopSeatInfo?.seatId || null });
                        await releasedPromise;

                        // After release, receiver may get redirected to home/login; ensure we are back on /koltuk-secim.
                        await prepareReceiverForExactPick('postRelease');

                        try { await applyCategoryBlockSelection(toPage, categorySelectionMode, (currentCatBlock || catBlockA), loopSeatInfo); } catch {}
                        try { await openSeatMapStrict(toPage); } catch {}
                        const seatSelectionUrl = (() => { try { return toPage.url(); } catch { return null; } })();
                        const exactMaxMs = Math.max(30000, Math.min(cfg.TIMEOUTS.SEAT_PICK_EXACT_MAX || 0, 180000));
                        audit('basket_loop_exact_pick_start', { hop: hopCount + 1, from: fromRole, to: toRole, seatId: loopSeatInfo?.seatId || null, maxMs: exactMaxMs, seatSelectionUrl });
                        // Fix misleading error messages: context must reflect the receiver role.
                        try {
                            const prev = loopSeatInfo.__recoveryOptions || {};
                            loopSeatInfo.__recoveryOptions = { ...prev, context: String(toRole) };
                        } catch {}
                        const got = await pickExactSeatWithVerify_ReleaseAware(toPage, loopSeatInfo, exactMaxMs);
                        audit('basket_loop_exact_pick_done', { hop: hopCount + 1, from: fromRole, to: toRole, seatId: loopSeatInfo?.seatId || null, pickedSeatId: got?.seatId || null, row: got?.row || null, seat: got?.seat || null });
                        return got;
                    })();

                    // Wait threshold on current holder
                    const loopStartMs = Date.now();
                    let triggered = false;
                    while (Date.now() - loopStartMs < (cfg.BASKET.HOLDING_TIME_SECONDS * 1000)) {
                        if (finalizeInFlight) {
                            try { await finalizeInFlight; } catch {}
                            if (finalizedToCResult) {
                                try { runStore.upsert(runId, { status: 'completed', result: finalizedToCResult }); } catch {}
                                return res.json(finalizedToCResult);
                            }
                        }
                        const st = basketTimer.getStatus();
                        const rem = st.remainingSeconds;
                        if (Number.isFinite(rem) && rem <= loopThreshold) {
                            triggered = true;
                            audit('basket_loop_hop_triggered', { hop: hopCount + 1, from: fromRole, to: toRole, seatId: loopSeatInfo?.seatId || null, remainingSeconds: rem, threshold: loopThreshold });
                            break;
                        }
                        await delay(1500);
                    }

                    if (!triggered) {
                        audit('basket_loop_stop_no_trigger', { hop: hopCount + 1, from: fromRole, to: toRole, seatId: loopSeatInfo?.seatId || null }, 'warn');
                        break;
                    }

                    // Release from holder
                    audit('basket_loop_release_start', { hop: hopCount + 1, from: fromRole, to: toRole, fromEmail, seatId: loopSeatInfo?.seatId || null });
                    try { await reloginIfRedirected(fromPage, fromEmail, fromPass); } catch {}
                    try {
                        await gotoWithRetry(fromPage, 'https://www.passo.com.tr/tr/sepet', {
                            retries: 2,
                            waitUntil: 'networkidle2',
                            expectedUrlIncludes: '/sepet',
                            rejectIfHome: false,
                            backoffMs: 450
                        });
                        await fromPage.waitForSelector('.basket-list-detail, .basket-list, .basket, [data-testid*="basket" i], [data-testid*="sepet" i]', { timeout: 8000 }).catch(() => {});
                    } catch {}

                    let removed = false;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        if (removed) break;
                        removed = await clickRemoveFromCartAndConfirm(fromPage, cfg.TIMEOUTS.REMOVE_FROM_CART_TIMEOUT);
                        if (removed) break;
                        try {
                            await gotoWithRetry(fromPage, 'https://www.passo.com.tr/tr/sepet', {
                                retries: 0,
                                waitUntil: 'networkidle2',
                                expectedUrlIncludes: '/sepet',
                                rejectIfHome: false,
                                backoffMs: 0
                            });
                            await delay(2500);
                        } catch {}
                    }
                    if (!removed) throw new Error(formatError('REMOVE_FROM_CART_FAILED_LOOP'));
                    audit('basket_loop_release_done', { hop: hopCount + 1, from: fromRole, to: toRole, fromEmail, seatId: loopSeatInfo?.seatId || null });
                    try { releasedResolve?.(); } catch {}

                    // Receiver should pick now
                    loopSeatInfo = await waitPickTo;
                    setStep(`${toRole}.loop.clickContinue.start`);
                    await clickContinueInsidePage(toPage);
                    await delay(cfg.DELAYS.AFTER_CONTINUE);
                    setStep(`${toRole}.loop.clickContinue.done`, { snap: await snapshotPage(toPage, `${toRole}.loop.afterContinue`) });

                    setHolder(toRole, loopSeatInfo, (currentCatBlock || catBlockA));
                    hopCount += 1;
                    audit('basket_loop_hop_done', { hop: hopCount, holder: toRole, seatId: loopSeatInfo?.seatId || null });

                    // Reset timer for the new holder holding period
                    try { basketTimer.start(); } catch {}
                }

                // For backward compatible response: put the latest seatInfo into seatInfoB variable
                seatInfoB = loopSeatInfo;
            } catch (e) {
                logger.warn('Basket loop failed, continuing without loop', { error: e?.message || String(e) });
                audit('basket_loop_failed', { aEmail: emailA, bEmail: emailB, seatId: seatInfoB?.seatId || seatInfoA?.seatId || null, error: e?.message || String(e) }, 'warn');
            }
        }

        // Optional external log
        if (cfg.ORDER_LOG_URL) {
            try {
                const finalBasketStatus = basketTimer.getStatus();
                logger.debug('Harici log servisine istek gönderiliyor', { orderLogUrl: cfg.ORDER_LOG_URL });
                await axios.post(cfg.ORDER_LOG_URL, {
                    link: eventAddress,
                    seat: seatInfoB.combined,
                    name: cardHolder,
                    email: email2,
                    total_basket_time: finalBasketStatus.holdingTimeSeconds,
                    current_basket_time: finalBasketStatus.elapsedSeconds,
                    remaining_basket_time: finalBasketStatus.remainingSeconds,
                    basket_start_time: finalBasketStatus.startTime,
                    basket_status: {
                        elapsedSeconds: finalBasketStatus.elapsedSeconds,
                        remainingSeconds: finalBasketStatus.remainingSeconds,
                        remainingFormatted: finalBasketStatus.remainingFormatted,
                        isExpired: finalBasketStatus.isExpired,
                        isNearExpiry: finalBasketStatus.isNearExpiry
                    },
                    status: "Wait For Payment (B)"
                }, {headers: {'Content-Type': 'application/json'}, timeout: cfg.TIMEOUTS.ORDER_LOG_TIMEOUT});
                logger.info('Harici log servisine istek gönderildi', {
                    basketStatus: finalBasketStatus
                });
            } catch (logError) {
                logger.warn('Harici log servisine istek gönderilemedi', { error: logError.message });
            }
        }

        const finalBasketStatus = basketTimer.getStatus();
        logger.infoSafe('Bot başarıyla tamamlandı', {
            grabbedBy: emailB,
            seatA: seatInfoA,
            seatB: seatInfoB,
            catBlockA,
            basketStatus: finalBasketStatus
        });
        try {
            runStore.upsert(runId, { status: 'completed', result: { success: true, grabbedBy: emailB, seatA: seatInfoA, seatB: seatInfoB, catBlockA } });
        } catch {}
        return res.json({success: true, grabbedBy: emailB, seatA: seatInfoA, seatB: seatInfoB, catBlockA});
    } catch (err) {
        // Sepette tutma süresi bilgisini hata mesajına ekle (eğer timer başlatıldıysa)
        let basketStatus = null;
        try {
            if (basketTimer) {
                basketStatus = basketTimer.getStatus();
                basketTimer.reset();
            }
        } catch {}
        
        const snapA = await snapshotPage(pageA, 'A.onError');
        const snapB = await snapshotPage(pageB, 'B.onError');
        logger.errorSafe('Bot hatası', err, {
            team,
            ticketType,
            eventAddress,
            email,
            email2,
            basketStatus: basketStatus,
            lastStep,
            snapA,
            snapB
        });
        try {
            runStore.upsert(runId, { status: 'error', error: String(err?.message || err), result: null });
        } catch {}
        return res.status(500).json({
            error: String(err.message || err),
            basketStatus: basketStatus,
            lastStep,
            urlA: (() => { try { return pageA?.url?.(); } catch { return null; } })(),
            urlB: (() => { try { return pageB?.url?.(); } catch { return null; } })()
        });
    } finally {
        try { if (basketMonitor) clearInterval(basketMonitor); } catch {}
        try { if (dynamicTimingCheck) clearInterval(dynamicTimingCheck); } catch {}
        try { if (finalizeWatch) clearInterval(finalizeWatch); } catch {}
        // Cleanup: Tarayıcıları kapat (KEEP_BROWSERS_OPEN=true ise açık bırak)
        const shouldKeepOpen = process.env.KEEP_BROWSERS_OPEN === 'true';
        
        if (!shouldKeepOpen) {
            const cleanupDelay = cfg.DELAYS.CLEANUP_DELAY;
            
            setTimeout(async () => {
                // Multi browsers cleanup
                try {
                    if (Array.isArray(multiBrowsers) && multiBrowsers.length) {
                        const uniq = Array.from(new Set(multiBrowsers.filter(Boolean)));
                        for (const br of uniq) {
                            try {
                                const pages = await br.pages();
                                await Promise.all((pages || []).map(p => p.close().catch(() => {})));
                            } catch {}
                            try { await br.close(); } catch {}
                        }
                    }
                } catch {}

                try {
                    if (browserA) {
                        logger.debug('BrowserA kapatılıyor');
                        const pages = await browserA.pages();
                        await Promise.all(pages.map(p => p.close().catch(() => {})));
                        await browserA.close();
                        logger.debug('BrowserA kapatıldı');
                    }
                } catch (err) {
                    logger.warn('BrowserA kapatılırken hata oluştu', { error: err.message });
                }
                
                try {
                    if (browserB) {
                        logger.debug('BrowserB kapatılıyor');
                        const pages = await browserB.pages();
                        await Promise.all(pages.map(p => p.close().catch(() => {})));
                        await browserB.close();
                        logger.debug('BrowserB kapatıldı');
                    }
                } catch (err) {
                    logger.warn('BrowserB kapatılırken hata oluştu', { error: err.message });
                }
            }, cleanupDelay);
        } else {
            logger.info('Tarayıcılar açık bırakıldı (KEEP_BROWSERS_OPEN=true)');
        }
    }
}
