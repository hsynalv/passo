const {connect} = require('puppeteer-real-browser');
const axios = require('axios');
const ac = require('@antiadmin/anticaptchaofficial');
const { botRequestSchema } = require('../validators/botRequest');

const cfg = require('../config');
const delay = require('../utils/delay');
const logger = require('../utils/logger');
const { formatError, formatSuccess } = require('../utils/messages');
const { BasketTimer, checkBasketTimeoutFromPage } = require('../utils/basketTimer');
const {confirmSwalYes, clickRemoveFromCartAndConfirm} = require('../helpers/swal');
const { captureSeatIdFromNetwork, readBasketData, readCatBlock, setCatBlockOnB, clickContinueInsidePage, gotoWithRetry, ensureUrlContains, SEAT_NODE_SELECTOR } = require('../helpers/page');
const { pickRandomSeatWithVerify, pickExactSeatWithVerify_Locked, waitForTargetSeatReady, pickExactSeatWithVerify_ReleaseAware } = require('../helpers/seat');

ac.setAPIKey(cfg.ANTICAPTCHA_KEY || '');

async function ensureTurnstileTokenOnPage(page, email, label) {
    if (!page) return { attempted: false };

    const maxAttempts = 3;
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

            logger.info('turnstile:state', { email, label, attempt, state });

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

            logger.warn('turnstile:solve_attempt', { email, label, attempt });
            const solveStart = Date.now();
            const tok = await ac.solveTurnstileProxyless(cfg.PASSO_LOGIN, cfg.PASSO_SITE_KEY);
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
        } catch (e) {
            const msg = e?.message || String(e);
            logger.warn('turnstile:ensure_failed', { email, label, attempt, error: msg });

            const transient = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg);
            if (!transient || attempt >= maxAttempts) {
                return { attempted: false, error: msg, attempt };
            }
            const backoff = 1200 * attempt;
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

    // Turnstile/Verify Human: solve+inject if needed (even if token field exists but empty)
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

    const tryEnsureLoginForm = async () => {
        const start = Date.now();
        const timeoutMs = 15000;
        while (Date.now() - start < timeoutMs) {
            const ctx = await findLoginContext();
            if (ctx) return ctx;
            await delay(500);
        }
        return null;
    };

    let loginCtx = await tryEnsureLoginForm();
    if (!loginCtx) {
        // Bazen /giris yerine direkt ana sayfaya redirect olabiliyor. Bir kez daha login'e gitmeyi dene.
        try {
            await gotoWithRetry(page, cfg.PASSO_LOGIN, {
                retries: 1,
                waitUntil: 'domcontentloaded',
                expectedUrlIncludes: '/giris',
                backoffMs: 350
            });
        } catch {}
        loginCtx = await tryEnsureLoginForm();
    }

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

    const preUrl = currentUrl;
    const navRes = await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 })
            .then(() => ({ type: 'navigation' }))
            .catch((e) => ({ type: 'nav_error', message: e?.message })),
        page.waitForFunction((pre) => location.href !== pre, { timeout: 15000 }, preUrl)
            .then(() => ({ type: 'url_change' }))
            .catch((e) => ({ type: 'url_wait_error', message: e?.message })),
        delay(15000).then(() => ({ type: 'timeout' }))
    ]);

    const afterUrl = (() => {
        try { return page.url(); } catch { return ''; }
    })();

    logger.info('reloginIfRedirected: login submit sonrası', {
        email,
        navRes,
        afterUrl
    });

    if (/\/giris(\?|$)/i.test(afterUrl)) {
        logger.warn('reloginIfRedirected: yeniden login sonrası hala giris sayfasında', {
            email,
            afterUrl
        });
        return true;
    }

    if (returnUrl) {
        logger.info('reloginIfRedirected: returnUrl sayfasına dönülüyor', { email, returnUrl });
        await gotoWithRetry(page, returnUrl, { retries: 2, waitUntil: 'networkidle2', backoffMs: 400 });
    }

    return true;
}

async function clickBuy(page) {
    const retries = Number.isFinite(cfg.TIMEOUTS.CLICK_BUY_RETRIES) ? cfg.TIMEOUTS.CLICK_BUY_RETRIES : 12;
    for (let i = 0; i < retries; i++) {
        const ok = await page.evaluate(() => {
            const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
            const isVisible = (el) => {
                try {
                    const st = window.getComputedStyle(el);
                    return !!(el && el.offsetParent !== null) && st && st.display !== 'none' && st.visibility !== 'hidden';
                } catch {
                    return false;
                }
            };

            const candidates = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]'))
                .filter(el => isVisible(el) && !el.disabled);

            const buy = candidates.find(el => {
                const txt = norm(el.innerText || el.textContent || el.value || '');
                if (!txt) return false;
                const hasText = (txt.includes('satin') && txt.includes('al')) || txt === 'satın al';
                const cls = norm(el.className || '');
                const looksLikeBuy = cls.includes('red-btn') || cls.includes('buy') || cls.includes('satin');
                return hasText && (looksLikeBuy || txt.length <= 20);
            });

            if (!buy) return false;
            try { buy.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
            try { buy.click(); } catch {}
            return true;
        }).catch(() => false);

        if (ok) return true;
        await delay(cfg.TIMEOUTS.CLICK_BUY_DELAY);
    }
    return false;
}

async function chooseCategoryAndRandomBlock(page, categoryType, alternativeCategory, selectionMode = 'legacy') {
    const cat = String(categoryType || '').trim();
    const alt = String(alternativeCategory || '').trim();
    const reCat = new RegExp(cat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const reAlt = alt ? new RegExp(alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
    const UNAVAILABLE_TEXT = 'şu anda uygun bilet bulunamamaktadır';

    const mode = String(selectionMode || 'legacy').toLowerCase();

    // New UI: SVG stadium layout block selection
    if (mode === 'svg') {
        const tried = new Set();
        const maxTries = 40;
        for (let attempt = 1; attempt <= maxTries; attempt++) {
            try {
                await page.evaluate(() => {
                    const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                    const btns = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
                    const b = btns.find(x => norm(x.innerText || x.textContent || x.value || '').includes('kendim seçmek istiyorum'));
                    try { b?.click(); } catch {}
                });
            } catch {}

            await page.waitForSelector('svg.svgLayout, svg .svgLayout, svg[class*="svgLayout"], .svgLayout', { timeout: 15000 }).catch(() => {});
            await page.waitForSelector('svg.svgLayout g.block, svg.svgLayout .svgBlock, .svgLayout g.block, .svgLayout .svgBlock', { timeout: 15000 });

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

            const clicked = await page.evaluate((targetId) => {
                const el = document.getElementById(targetId);
                if (!el) return { ok: false, id: targetId, reason: 'not_found' };
                try {
                    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                } catch {
                    try { el.click(); } catch {}
                }
                return { ok: true, id: targetId, tag: el.tagName };
            }, pick.id);
            logger.info('categoryBlock:svg_clicked', { attempt, clicked });

            const uiReady = await page.waitForFunction((seatSel) => {
                const seatBtn = !!document.getElementById('custom_seat_button');
                const seatNodes = document.querySelectorAll(String(seatSel || '')).length;
                const bodyText = (document.body?.innerText || '').toLowerCase();
                const noTicket = bodyText.includes('uygun bilet bulunamamaktadır') || bodyText.includes('uygun koltuk bulunamamaktadır') || bodyText.includes('koltuk bulunamadı');
                return seatBtn || seatNodes > 0 || noTicket;
            }, { timeout: 12000 }, SEAT_NODE_SELECTOR).then(() => true).catch(() => false);

            const seatCheck = await page.evaluate((seatSel) => {
                const seatNodes = document.querySelectorAll(String(seatSel || '')).length;
                const bodyText = (document.body?.innerText || '').toLowerCase();
                const noTicket = bodyText.includes('uygun bilet bulunamamaktadır') || bodyText.includes('uygun koltuk bulunamamaktadır') || bodyText.includes('koltuk bulunamadı');
                const hasSeatButton = !!document.getElementById('custom_seat_button');
                return { seatNodes, noTicket, hasSeatButton, url: location.href };
            }, SEAT_NODE_SELECTOR).catch(() => ({ seatNodes: 0, noTicket: false, hasSeatButton: false }));

            if (uiReady && !(seatCheck.seatNodes > 0) && !seatCheck.noTicket) {
                // Seatmap bazen iframe içinde render olabiliyor; frame'lerde de seat node ara.
                try {
                    const frames = (() => { try { return page.frames(); } catch { return []; } })();
                    for (const f of frames) {
                        try {
                            const okFrame = await f.evaluate((seatSel) => {
                                return document.querySelectorAll(String(seatSel || '')).length > 0;
                            }, SEAT_NODE_SELECTOR);
                            if (okFrame) {
                                seatCheck.seatNodes = 1;
                                break;
                            }
                        } catch {}
                    }
                } catch {}
            }

            const hasSeats = (seatCheck.seatNodes > 0) || seatCheck.hasSeatButton;
            if (uiReady && hasSeats && !seatCheck.noTicket) {
                logger.info('categoryBlock:svg_block_ok', { attempt, blockId: pick.id, seatCheck });
                return;
            }

            tried.add(pick.id);
            logger.info('categoryBlock:svg_block_no_seat', { attempt, blockId: pick.id, seatCheck, triedCount: tried.size });

            const backClicked = await page.evaluate(() => {
                const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                const btns = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
                const b = btns.find(x => norm(x.innerText || x.textContent || x.value || '').includes('geri dön'));
                if (!b) return false;
                try { b.click(); } catch { return false; }
                return true;
            }).catch(() => false);

            if (backClicked) {
                await page.waitForSelector('svg.svgLayout g.block, svg.svgLayout .svgBlock, .svgLayout g.block, .svgLayout .svgBlock', { timeout: 15000 }).catch(() => {});
            } else {
                await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
                await delay(800);
            }
        }

        throw new Error('SVG bloklarında uygun koltuk bulunamadı');
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
            logger.warn('categoryBlock:selected_option_verify_failed', { cycle: cycle + 1, error: e?.message || String(e), diag });
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
        logger.warn('categoryBlock:cycle_retry', { cycle: cycle + 1, selectionOk, uiReady, diag });
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
        email2, password2
    } = validatedData;

    let browserA, pageA, browserB, pageB;
    let basketTimer;
    let basketMonitor;
    let dynamicTimingCheck;
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
        email,
        email2,
        categoryType
    });

    try {
        // A: Launch + Login
        setStep('A.launchAndLogin.start', { email });
        ({browser: browserA, page: pageA} = await launchAndLogin({
            email, password, userDataDir: cfg.USER_DATA_DIR_A, proxyHost, proxyPort, proxyUsername, proxyPassword
        }));
        setStep('A.launchAndLogin.done', { email, snap: await snapshotPage(pageA, 'A.afterLogin') });
        logger.info('A hesabı giriş yaptı');

        // B: Launch + Login
        setStep('B.launchAndLogin.start', { email: email2 });
        ({browser: browserB, page: pageB} = await launchAndLogin({
            email: email2,
            password: password2,
            userDataDir: cfg.USER_DATA_DIR_B,
            proxyHost,
            proxyPort,
            proxyUsername,
            proxyPassword
        }));
        setStep('B.launchAndLogin.done', { email: email2, snap: await snapshotPage(pageB, 'B.afterLogin') });
        logger.info('B hesabı giriş yaptı');

        // A: go event -> BUY -> ticket type (if present) -> category/block -> random seat
        setStep('A.gotoEvent.start', { eventAddress });
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

        setStep('A.clickBuy.start');
        const clickedA = await clickBuy(pageA);
        if (!clickedA) throw new Error(formatError('BUY_BUTTON_FAILED_A'));
        setStep('A.clickBuy.done');
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

        setStep('A.postBuy.reloginCheck.start');
        const aRelog = await reloginIfRedirected(pageA, email, password);
        setStep('A.postBuy.reloginCheck.done', { relogged: aRelog, snap: await snapshotPage(pageA, 'A.afterReloginCheck') });

        setStep('A.seatSelection.turnstile.ensure.start');
        await ensureTurnstileTokenOnPage(pageA, email, 'A.seatSelection');
        setStep('A.seatSelection.turnstile.ensure.done', { snap: await snapshotPage(pageA, 'A.afterTurnstileEnsure') });

        // Guard: page can drift to home due to session/captcha/network issues. Do not continue category selection on wrong page.
        const seatUrlA_forRecover = (() => { try { return pageA.url(); } catch { return null; } })();
        const seatUrlOk = await ensureUrlContains(pageA, '/koltuk-secim', { retries: 1, waitMs: 4000, backoffMs: 350 });
        if (!seatUrlOk?.ok) {
            logger.warn('A.seatSelection.url_drift_before_category', { urlCheck: seatUrlOk, currentUrl: (() => { try { return pageA.url(); } catch { return null; } })(), seatUrlA_forRecover });
            if (seatUrlA_forRecover) {
                await gotoWithRetry(pageA, String(seatUrlA_forRecover), {
                    retries: 2,
                    waitUntil: 'domcontentloaded',
                    expectedUrlIncludes: '/koltuk-secim',
                    rejectIfHome: false,
                    backoffMs: 450
                }).catch(() => {});
            }
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

        setStep('A.categoryBlock.select.start', { categoryType, alternativeCategory, categorySelectionMode });
        await chooseCategoryAndRandomBlock(pageA, categoryType, alternativeCategory, categorySelectionMode);
        setStep('A.categoryBlock.select.done', { snap: await snapshotPage(pageA, 'A.afterCategoryBlock') });

        // Capture selected category & block for transfer to B. DOM can be late/placeholder, so retry a bit.
        let catBlockA = { categoryText: '', blockText: '', blockVal: '' };
        for (let i = 0; i < 6; i++) {
            try {
                const c = await readCatBlock(pageA);
                const catTxt = (c?.categoryText || '').trim();
                const isPlaceholder = !catTxt || catTxt.toLowerCase() === 'kategori';
                const blocksOk = !!(c?.blockVal || c?.blockText);
                if (!isPlaceholder && blocksOk) { catBlockA = c; break; }
                catBlockA = c || catBlockA;
            } catch {}
            await delay(350);
        }
        logger.info('A hesabı kategori/blok okundu', { catBlockA });

        setStep('A.seat.pickRandom.start');
        const seatSelectionUrlA = (() => { try { return pageA.url(); } catch { return null; } })();
        const netSeatA = captureSeatIdFromNetwork(pageA, cfg.TIMEOUTS.NETWORK_CAPTURE_TIMEOUT);
        const seatInfoA = await require('../helpers/seat').pickRandomSeatWithVerify(
            pageA,
            cfg.TIMEOUTS.SEAT_SELECTION_MAX,
            {
                context: 'A',
                expectedUrlIncludes: '/koltuk-secim',
                recoveryUrl: seatSelectionUrlA,
                email,
                password,
                reloginIfRedirected,
                ensureTurnstileFn: ensureTurnstileTokenOnPage
            }
        );
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
        const clickedB = await clickBuy(pageB);
        if (!clickedB) throw new Error(formatError('BUY_BUTTON_FAILED_B'));
        setStep('B.clickBuy.done');
        logger.info('B hesabı SATIN AL butonuna tıkladı');

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
        const bRelog = await reloginIfRedirected(pageB, email2, password2);
        setStep('B.postBuy.reloginCheck.done', { relogged: bRelog, snap: await snapshotPage(pageB, 'B.afterReloginCheck') });

        setStep('B.seatSelection.turnstile.ensure.start');
        await ensureTurnstileTokenOnPage(pageB, email2, 'B.seatSelection');
        setStep('B.seatSelection.turnstile.ensure.done', { snap: await snapshotPage(pageB, 'B.afterTurnstileEnsure') });

        // B catBlock seçimi A kaldırdıktan sonra yapılacak
        // setStep('B.catBlock.sync.start');
        // await setCatBlockOnB(pageB, catBlockA);
        // setStep('B.catBlock.sync.done', { catBlockA, snap: await snapshotPage(pageB, 'B.afterCatBlockSet') });
        // logger.info('B hesabı kategori/blok ayarlandı', { catBlockA });

        // Ensure seatmap is actually mounted on B before waiting for the target seat.
        try {
            await openSeatMapStrict(pageB);
        } catch {}
        try {
            await pageB.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, { timeout: 15000 }, SEAT_NODE_SELECTOR);
        } catch {}

        const seatSelectionUrlB = (() => { try { return pageB.url(); } catch { return null; } })();
        try {
            seatInfoA.__recoveryOptions = {
                context: 'B',
                expectedUrlIncludes: '/koltuk-secim',
                recoveryUrl: seatSelectionUrlB,
                email: email2,
                password: password2,
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
            await aRemovedPromise;
            logger.info('A kaldırdı, B blok seçimi yapıyor');
            
            // Şimdi blok seçimi yap (sayfa yenilenecek, koltuk boşta olacak)
            await setCatBlockOnB(pageB, catBlockA);
            logger.info('B blok seçimi tamamlandı, koltuk seçiliyor');
            
            // Seatmap açık değilse aç
            try { await openSeatMapStrict(pageB); } catch {}
            
            // Direkt rastgele koltuk seç - hedef koltuk zorlaması yok
            logger.info('B rastgele koltuk seçiyor');
            const seatSelectionUrlB = (() => { try { return pageB.url(); } catch { return null; } })();
            const randomGot = await pickRandomSeatWithVerify(
                pageB,
                cfg.TIMEOUTS.SEAT_SELECTION_MAX,
                {
                    context: 'B',
                    expectedUrlIncludes: '/koltuk-secim',
                    recoveryUrl: seatSelectionUrlB,
                    email: email2,
                    password: password2,
                    reloginIfRedirected,
                    ensureTurnstileFn: ensureTurnstileTokenOnPage
                }
            );
            logger.info('B rastgele koltuk yakaladı', { seat: randomGot });
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
            if (status.remainingSeconds <= threshold && !shouldRemoveNow) {
                shouldRemoveNow = true;
                clearInterval(basketMonitor);
                
                const remaining = status.remainingSeconds;
                logger.info('Dinamik uzatma tetiklendi (B hesabına geçiş)', {
                    remainingSeconds: remaining,
                    extendWhenRemainingSecondsBelow: threshold,
                    message: `${remaining} saniye kala koltuk A sepetinden kaldırılıp B hesabına geçiriliyor`
                });
                
                // A hesabı koltuğu sepetten kaldır
                logger.debug('A hesabı koltuğu sepetten kaldırıyor (dinamik zamanlama)');
                try {
                    await gotoWithRetry(pageA, 'https://www.passo.com.tr/tr/sepet', {
                        retries: 2,
                        waitUntil: 'networkidle2',
                        expectedUrlIncludes: '/sepet',
                        rejectIfHome: false,
                        backoffMs: 450
                    });
                    aBasketArrivedAtMs = aBasketArrivedAtMs || Date.now();
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
            const pickPromise = Promise.race([waitPickB, abortOnIntervalError, abortOnDynamicTimingError]);
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

        setStep('B.clickContinue.start');
        await clickContinueInsidePage(pageB);
        await delay(cfg.DELAYS.AFTER_CONTINUE);
        setStep('B.clickContinue.done', { snap: await snapshotPage(pageB, 'B.afterContinue') });

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
            grabbedBy: email2,
            seatA: seatInfoA,
            seatB: seatInfoB,
            catBlockA,
            basketStatus: finalBasketStatus
        });
        return res.json({success: true, grabbedBy: email2, seatA: seatInfoA, seatB: seatInfoB, catBlockA});
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
        // Cleanup: Tarayıcıları kapat (KEEP_BROWSERS_OPEN=true ise açık bırak)
        const shouldKeepOpen = process.env.KEEP_BROWSERS_OPEN === 'true';
        
        if (!shouldKeepOpen) {
            const cleanupDelay = cfg.DELAYS.CLEANUP_DELAY;
            
            setTimeout(async () => {
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

module.exports = {startBot, ensureTurnstileTokenOnPage};
