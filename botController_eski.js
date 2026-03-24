const {connect} = require('puppeteer-real-browser');
const axios = require('axios');
const ac = require('@antiadmin/anticaptchaofficial');
const { botRequestSchema } = require('../validators/botRequest');

const cfg = require('../config');
const delay = require('../utils/delay');
const logger = require('../utils/logger');
const { formatError } = require('../utils/messages');
const { BasketTimer, checkBasketTimeoutFromPage } = require('../utils/basketTimer');
const {confirmSwalYes, clickRemoveFromCartAndConfirm, attachAutoDialogHandler, autoConfirmAnyModal} = require('../helpers/swal');
const {
    ensurePage, captureSeatIdFromNetwork, readBasketData, readCatBlock, setCatBlockOnB,
    openSeatMapStrict, clickContinueInsidePage
} = require('../helpers/page');
const {pickRandomSeatWithVerify, pickExactSeatWithVerify_Locked, waitForTargetSeatReady, pickExactSeatWithVerify_ReleaseAware} = require('../helpers/seat');

ac.setAPIKey(cfg.ANTICAPTCHA_KEY || '');

async function ensureTurnstileTokenOnPage(page, email, label) {
    if (!page) return { attempted: false };
    try {
        const pageUrl = (() => { try { return page.url(); } catch { return cfg.PASSO_LOGIN; } })();
        const state = await page.evaluate(() => {
            const bodyText = (document.body?.innerText || '').toLowerCase();
            const hasVerifyHuman = bodyText.includes('verify you are human');
            const widget = document.querySelector('.cf-turnstile');
            const hasWidget = !!widget;
            const siteKey = widget?.getAttribute('data-sitekey') || null;
            const input = document.querySelector('input[name="cf-turnstile-response"]');
            const hasTokenField = !!input;
            const tokenLen = input?.value ? input.value.length : 0;
            return { hasVerifyHuman, hasWidget, siteKey, hasTokenField, tokenLen };
        });

        logger.info('turnstile:state', { email, label, state });

        const shouldSolve = (state.hasVerifyHuman || state.hasWidget || state.hasTokenField) && state.tokenLen <= 0;
        if (!shouldSolve) return { attempted: false, state };

        const effectiveSiteKey = state.siteKey || cfg.PASSO_SITE_KEY || null;
        if (!effectiveSiteKey || !cfg.ANTICAPTCHA_KEY) {
            logger.warn('turnstile:cannot_solve_missing_keys', {
                email,
                label,
                hasSiteKey: !!effectiveSiteKey,
                hasAntiCaptchaKey: !!cfg.ANTICAPTCHA_KEY
            });
            return { attempted: false, state, missingKeys: true };
        }

        logger.warn('turnstile:solve_attempt', { email, label });
        const solveStart = Date.now();
        const tok = await ac.solveTurnstileProxyless(pageUrl, effectiveSiteKey);
        logger.info('turnstile:solve_result', {
            email,
            label,
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
        logger.info('turnstile:inject_check', { email, label, after });
        return { attempted: true, state, after };
    } catch (e) {
        logger.warn('turnstile:ensure_failed', { email, label, error: e?.message || String(e) });
        return { attempted: false, error: e?.message || String(e) };
    }
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

async function launchAndLogin({email, password, userDataDir, proxyHost, proxyPort, proxyUsername, proxyPassword}) {
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
    attachAutoDialogHandler(page);
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
    await page.goto(cfg.PASSO_LOGIN, {waitUntil: 'networkidle2'});
    await autoConfirmAnyModal(page, 1200).catch(() => {});
    try {
        const snap0 = await page.evaluate(() => {
            const bodyText = (document.body?.innerText || '').toLowerCase();
            const hasVerifyHuman = bodyText.includes('verify you are human');
            const hasTurnstileWidget = !!document.querySelector('.cf-turnstile');
            const hasTurnstileTokenField = !!document.querySelector('input[name="cf-turnstile-response"]');
            const title = document.title;
            return { title, hasVerifyHuman, hasTurnstileWidget, hasTurnstileTokenField };
        });
        logger.info('launchAndLogin: login sayfası yüklendi', { email, snap: snap0 });
    } catch {}

    // Turnstile/Verify Human: solve+inject if needed (even if token field exists but empty)
    await ensureTurnstileTokenOnPage(page, email, 'launchAndLogin.beforeSubmit');

    // Bazı durumlarda Passo, oturum zaten açıksa /giris yerine home'a redirect edebiliyor.
    // Bu durumda login input'ları bulunmadığı için type() patlamasın.
    const hasLoginForm = await page.evaluate(() => {
        const u = document.querySelector('input[autocomplete="username"], input[type="email"], input[name*="email"], input[name*="user"]');
        const p = document.querySelector('input[autocomplete="current-password"], input[type="password"]');
        return !!(u && p);
    }).catch(() => false);

    if (!hasLoginForm) {
        // Session açık (veya login sayfası farklı render) olabilir; crash yerine devam.
        try {
            const snap = await page.evaluate(() => {
                const txt = (document.body?.innerText || '').toLowerCase();
                return {
                    title: document.title,
                    url: location.href,
                    hasLogoutHint: txt.includes('çıkış') || txt.includes('cikis') || !!document.querySelector('a[href*="cikis"],a[href*="logout"],.user-name,.account,.profile')
                };
            });
            logger.warn('launchAndLogin: login form bulunamadı, oturum açık kabul ediliyor', { email, snap });
        } catch {
            logger.warn('launchAndLogin: login form bulunamadı, oturum açık kabul ediliyor', { email });
        }
        return { browser, page };
    }

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

    try {
        await page.evaluate(() => {
            const u = document.querySelector('input[autocomplete="username"], input[type="email"], input[name*="email"], input[name*="user"]');
            const p = document.querySelector('input[autocomplete="current-password"], input[type="password"]');
            if (u) u.value = '';
            if (p) p.value = '';
        });
    } catch {}

    try {
        await page.type('input[autocomplete="username"], input[type="email"], input[name*="email"], input[name*="user"]', String(email || ''), { delay: 10 });
        await page.type('input[autocomplete="current-password"], input[type="password"]', String(password || ''), { delay: 10 });
    } catch {
        // fall back to original selectors
        await page.type('input[autocomplete="username"]', String(email || ''), { delay: 10 });
        await page.type('input[autocomplete="current-password"]', String(password || ''), { delay: 10 });
    }

    await page.evaluate(() => {
        const b = [...document.querySelectorAll('button.black-btn, button, [role="button"]')].find(x => (x.innerText || '').trim().toUpperCase() === 'GİRİŞ');
        b?.click();
    }).catch(() => {});
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

async function reloginIfRedirected(page, email, password, opts = null) {
    if (!page) return false;
    attachAutoDialogHandler(page);

    const depth = opts?.depth || 0;

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
    await autoConfirmAnyModal(page, 1200).catch(() => {});

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

    // SPA / form submit farkları için ikinci bir tetik (Enter)
    await page.keyboard.press('Enter').catch(() => {});

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

    // Login olmuş olmayı gösterebilecek elementleri de bekle (URL değişmeyebiliyor)
    const loginSignal = await Promise.race([
        page.waitForFunction(() => {
            const url = location.href;
            if (!/\/giris(\?|$)/i.test(url)) return true;
            const txt = (document.body?.innerText || '').toLowerCase();
            if (txt.includes('çıkış') || txt.includes('cikis')) return true;
            if (document.querySelector('a[href*="cikis"], a[href*="logout"], .user-name, .account, .profile')) return true;
            return false;
        }, { timeout: 8000 }).then(() => true).catch(() => false),
        delay(8000).then(() => false)
    ]);

    const afterUrl = (() => {
        try { return page.url(); } catch { return ''; }
    })();

    logger.info('reloginIfRedirected: login submit sonrası', {
        email,
        navRes,
        loginSignal,
        afterUrl
    });

    // returnUrl varsa, login sonrası URL kalmış olsa bile returnUrl'e zorla gitmeyi dene
    if (returnUrl) {
        logger.info('reloginIfRedirected: returnUrl sayfasına zorla gidiliyor', { email, returnUrl });
        const tryGotoReturn = async (label) => {
            await page.goto(returnUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
            await delay(800);

            // returnUrl'e gerçekten gelindi mi? (bazen home'a atıyor)
            const ok = await page.evaluate((ru) => {
                const url = location.href;
                if (ru && url === ru) return true;
                if (/\/koltuk-secim/i.test(url)) return true;
                // seat/category UI sinyali
                if (document.querySelector('.custom-select-box, #blocks, #custom_seat_button, .ticket-type-title, circle.seat-circle')) return true;
                return false;
            }, returnUrl).catch(() => false);

            logger.info('reloginIfRedirected: returnUrl kontrolü', {
                email,
                label,
                ok,
                url: (() => { try { return page.url(); } catch { return ''; } })()
            });
            return ok;
        };

        const ok1 = await tryGotoReturn('try1');
        if (!ok1) {
            // Bir kez daha daha "strong" load beklemesi ile dene
            await page.goto(returnUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
            await delay(1000);
            const ok2 = await tryGotoReturn('try2');
            if (!ok2) {
                // Passo bazen deep-link returnUrl'i home'a atıyor; event akışını yeniden tetikle
                let eventUrl = null;
                try {
                    eventUrl = String(returnUrl).replace(/\/koltuk-secim.*$/i, '');
                } catch {}

                if (eventUrl && /^https?:\/\//i.test(eventUrl)) {
                    logger.warn('reloginIfRedirected: returnUrl deep-link başarısız, event sayfasından BUY ile recovery deneniyor', {
                        email,
                        eventUrl,
                        returnUrl,
                        currentUrl: (() => { try { return page.url(); } catch { return ''; } })()
                    });

                    await page.goto(eventUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
                    await delay(800);

                    // Event sayfasında da modal/verify çıkabiliyor
                    await autoConfirmAnyModal(page, 1200).catch(() => {});
                    await ensureTurnstileTokenOnPage(page, email, 'reloginIfRedirected.recovery.eventPage');

                    // BUY butonu bazen geç geliyor
                    await page.waitForFunction(() => {
                        const norm = (s) => (s || '').toString().trim().toLowerCase();
                        const els = Array.from(document.querySelectorAll('button, a, [role="button"], .btn, button.red-btn'));
                        return els.some(el => {
                            const t = norm(el.innerText || el.textContent);
                            return t.includes('satın al') || t.includes('satin al') || t.includes('bilet al');
                        });
                    }, { timeout: 8000 }).catch(() => {});

                    const clicked = await clickBuy(page);
                    if (clicked) {
                        const pre = (() => { try { return page.url(); } catch { return ''; } })();
                        await Promise.race([
                            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => null),
                            page.waitForFunction((p) => location.href !== p, { timeout: 12000 }, pre).catch(() => null),
                            delay(12000)
                        ]);
                        await delay(800);

                        const ok3 = await page.evaluate((ru) => {
                            const url = location.href;
                            if (ru && url === ru) return true;
                            if (/\/koltuk-secim/i.test(url)) return true;
                            if (document.querySelector('.custom-select-box, #blocks, #custom_seat_button, .ticket-type-title, circle.seat-circle')) return true;
                            return false;
                        }, returnUrl).catch(() => false);

                        logger.info('reloginIfRedirected: recovery sonrası kontrol', {
                            email,
                            ok: ok3,
                            url: (() => { try { return page.url(); } catch { return ''; } })()
                        });

                        if (ok3) return true;

                        const afterRecoveryUrl = (() => { try { return page.url(); } catch { return ''; } })();
                        if (/\/giris(\?|$)/i.test(afterRecoveryUrl) && depth < 1) {
                            logger.warn('reloginIfRedirected: recovery sonrası tekrar giris sayfasına düştü, bir kez daha relogin deneniyor', {
                                email,
                                afterRecoveryUrl,
                                depth
                            });
                            return await reloginIfRedirected(page, email, password, { depth: depth + 1 });
                        }
                    } else {
                        logger.warn('reloginIfRedirected: recovery BUY click başarısız', { email, eventUrl });
                    }
                }

                throw new Error('reloginIfRedirected: returnUrl sayfasına dönülemedi');
            }
        }
    }

    const finalUrl = (() => { try { return page.url(); } catch { return afterUrl || ''; } })();
    if (/\/giris(\?|$)/i.test(finalUrl)) {
        const possibleErrors = await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('.error, .alert, .toast, .swal2-html-container, .validation, .invalid-feedback'))
                .slice(0, 5);
            return els.map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean);
        }).catch(() => []);

        logger.warn('reloginIfRedirected: yeniden login sonrası hala giris sayfasında', {
            email,
            finalUrl,
            possibleErrors
        });

        throw new Error('reloginIfRedirected: login başarısız veya redirect gerçekleşmedi; hala giris sayfasında');
    }

    return true;
}

async function clickBuy(page) {
    for (let i = 0; i < cfg.TIMEOUTS.CLICK_BUY_RETRIES; i++) {
        const ok = await page.evaluate(() => {
            const norm = (s) => (s || '').toString().trim().toLowerCase();
            const isVisible = (el) => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            };

            const candidates = [
                ...document.querySelectorAll('button.red-btn, button, a, [role="button"], .btn')
            ].filter(isVisible);

            const texts = ['satın al', 'satin al', 'bilet al', 'satınal', 'satin-al'];
            const pick = candidates.find(el => {
                const t = norm(el.innerText || el.textContent);
                return texts.some(x => t === x || t.includes(x));
            });

            const b = pick || candidates.find(el => norm(el.getAttribute('aria-label')).includes('sat'));
            if (b) {
                b.scrollIntoView({ block: 'center', inline: 'center' });
                const r = b.getBoundingClientRect();
                ['pointerover', 'pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click'].forEach((type) => {
                    b.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
                });
                return true;
            }
            return false;
        });
        if (ok) return true;
        await delay(cfg.TIMEOUTS.CLICK_BUY_DELAY);
    }
    return false;
}

async function chooseCategoryAndRandomBlock(page, categoryType, alternativeCategory) {
    // Sayfa hazır olana kadar bekle (kategori dropdown'ının görünür olması için)
    for (let i = 0; i < cfg.TIMEOUTS.CATEGORY_SELECTION_RETRIES; i++) {
        const ok = await page.evaluate(() => {
            const selectBox = document.querySelector('.custom-select-box');
            return selectBox && selectBox.offsetParent !== null; // Görünür olup olmadığını kontrol et
        });
        if (ok) break;
        await delay(cfg.DELAYS.CATEGORY_SELECTION);
    }

    await page.waitForSelector('.custom-select-box', {visible: true});
    await page.evaluate(() => document.querySelector('.custom-select-box')?.click());
    await page.waitForSelector('.dropdown-option:not(.disabled)', {visible: true});

    const options = await page.$$eval('.dropdown-option:not(.disabled)', els => els.map(el => el.innerText.trim()));
    const esc = s => (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const selectedText = options.find(text =>
        new RegExp(`^${esc(categoryType)}\\b`, 'i').test(text) ||
        new RegExp(`^${esc(alternativeCategory)}\\b`, 'i').test(text)
    );
    if (!selectedText) throw new Error(formatError('CATEGORY_NOT_FOUND'));
    const idx = options.findIndex(t => t === selectedText);
    const optEls = await page.$$('.dropdown-option:not(.disabled)');
    await optEls[idx].click();

    await page.waitForFunction(() => {
        const s = document.querySelector('select#blocks');
        return s && s.options.length > 1;
    }, {timeout: cfg.TIMEOUTS.BLOCKS_WAIT_TIMEOUT});
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
            return await page.evaluate((lbl) => {
                const bodyText = (document.body?.innerText || '').toLowerCase();
                const title = document.title;
                const url = location.href;
                const hasVerifyHuman = bodyText.includes('verify you are human');
                const hasTurnstileWidget = !!document.querySelector('.cf-turnstile');
                const hasTurnstileTokenField = !!document.querySelector('input[name="cf-turnstile-response"]');
                const seatCount = document.querySelectorAll('circle.seat-circle').length;
                const selectedCount = document.querySelectorAll('circle.seat-circle.selected, circle.seat-circle[aria-pressed="true"], [data-selected="true"]').length;
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
            }, label);
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
        await pageA.goto(String(eventAddress), {waitUntil: 'networkidle2'});
        setStep('A.gotoEvent.done', { snap: await snapshotPage(pageA, 'A.afterEventGoto') });

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

        setStep('A.postBuy.reloginCheck.start');
        const aRelog = await reloginIfRedirected(pageA, email, password);
        setStep('A.postBuy.reloginCheck.done', { relogged: aRelog, snap: await snapshotPage(pageA, 'A.afterReloginCheck') });

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

        setStep('A.categoryBlock.select.start', { categoryType, alternativeCategory });
        await chooseCategoryAndRandomBlock(pageA, categoryType, alternativeCategory);
        setStep('A.categoryBlock.select.done', { snap: await snapshotPage(pageA, 'A.afterCategoryBlock') });

        setStep('A.seat.pickRandom.start');
        // Koltuk seçim ekranında Turnstile çıkabiliyor ve koltuk tıklamalarını bloklayabiliyor
        await ensureTurnstileTokenOnPage(pageA, email, 'A.beforeSeatPick');
        const seatSelectionUrlA = (() => { try { return pageA.url(); } catch { return null; } })();
        const netSeatA = captureSeatIdFromNetwork(pageA, cfg.TIMEOUTS.NETWORK_CAPTURE_TIMEOUT);
        const seatInfoA = await require('../helpers/seat').pickRandomSeatWithVerify(
            pageA,
            cfg.TIMEOUTS.SEAT_SELECTION_MAX,
            {
                context: 'A',
                maxSelected: 1,
                expectedUrlIncludes: '/koltuk-secim',
                recoveryUrl: seatSelectionUrlA
            }
        );
        const sidNet = await netSeatA;
        if (sidNet && !seatInfoA.seatId) seatInfoA.seatId = sidNet;
        setStep('A.seat.pickRandom.done', { seatInfoA, sidNet, snap: await snapshotPage(pageA, 'A.afterSeatPick') });
        
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
        await pageB.goto(String(eventAddress), {waitUntil: 'networkidle2'});
        setStep('B.gotoEvent.done', { snap: await snapshotPage(pageB, 'B.afterEventGoto') });

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

        setStep('B.postBuy.reloginCheck.start');
        const bRelog = await reloginIfRedirected(pageB, email2, password2);
        setStep('B.postBuy.reloginCheck.done', { relogged: bRelog, snap: await snapshotPage(pageB, 'B.afterReloginCheck') });

        setStep('B.catBlock.sync.start');
        const catBlockA = await require('../helpers/page').readCatBlock(pageA);
        await require('../helpers/page').setCatBlockOnB(pageB, catBlockA);
        setStep('B.catBlock.sync.done', { catBlockA, snap: await snapshotPage(pageB, 'B.afterCatBlockSet') });
        logger.info('B hesabı kategori/blok ayarlandı', { catBlockA });

        setStep('B.target.ready.start', { targetSeat: seatInfoA });
        // B tarafında da /koltuk-secim üzerinde Turnstile çıkabiliyor
        await ensureTurnstileTokenOnPage(pageB, email2, 'B.beforeTargetReady');
        const ready = await waitForTargetSeatReady(pageB, seatInfoA, 15000);
        if (!ready) logger.warn('B hesabı hedef koltuk DOM\'da bulunamadı, yine de denenecek');
        setStep('B.target.ready.done', { ready, snap: await snapshotPage(pageB, 'B.afterReady') });

        setStep('B.target.grabLoop.start', { targetSeat: seatInfoA });
        await ensureTurnstileTokenOnPage(pageB, email2, 'B.beforeGrabLoop');
        const waitPickB = (async () => {
            const got = await pickExactSeatWithVerify_ReleaseAware(pageB, seatInfoA, cfg.TIMEOUTS.SEAT_PICK_EXACT_MAX);
            return got;
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
            
            // Sepet timeout'undan önce kaldırma zamanı geldi mi kontrol et
            if (basketTimer.shouldRemoveBeforeTimeout() && !shouldRemoveNow) {
                shouldRemoveNow = true;
                clearInterval(basketMonitor);
                
                const remaining = status.remainingSeconds;
                logger.info('Sepette tutma süresine göre optimize edilmiş zamanlama', {
                    remainingSeconds: remaining,
                    removeBeforeTimeout: cfg.BASKET.REMOVE_BEFORE_TIMEOUT,
                    message: `${remaining} saniye kala koltuğu sepetten kaldırılıyor`
                });
                
                // A hesabı koltuğu sepetten kaldır
                logger.debug('A hesabı koltuğu sepetten kaldırıyor (dinamik zamanlama)');
                const removed = await require('../helpers/swal').clickRemoveFromCartAndConfirm(pageA, cfg.TIMEOUTS.REMOVE_FROM_CART_TIMEOUT);
                if (!removed) throw new Error(formatError('REMOVE_FROM_CART_FAILED'));
                logger.info('A hesabı koltuğu sepetten kaldırdı (dinamik zamanlama)', {
                    remainingSeconds: remaining,
                    elapsedSeconds: status.elapsedSeconds
                });
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

        // Eğer dinamik zamanlama tetiklenmediyse, B grab loop aktifken A kaldırmayı başlat (daha deterministik transfer)
        let seatInfoB;
        try {
            // B grab loop'u başlatıldı; A kaldırmayı da başlatıp iki tarafı paralel koşturuyoruz.
            // Not: A kaldırma öncesinde B'nin "ready" olması hedeflenir.
            const removeFromA = async () => {
                if (shouldRemoveNow) return true;
                const status = basketTimer.getStatus();
                setStep('A.removeFromCart.start', { basketStatus: status });
                const removed = await clickRemoveFromCartAndConfirm(pageA, cfg.TIMEOUTS.REMOVE_FROM_CART_TIMEOUT);
                if (!removed) throw new Error(formatError('REMOVE_FROM_CART_FAILED'));
                setStep('A.removeFromCart.done', { removed, snap: await snapshotPage(pageA, 'A.afterRemove') });
                logger.info('A hesabı koltuğu sepetten kaldırdı (transfer)', {
                    elapsedSeconds: status.elapsedSeconds,
                    remainingSeconds: status.remainingSeconds
                });
                return true;
            };

            // A kaldırmayı başlat, B aynı anda available olduğunda yakalayacak.
            const pickPromise = Promise.race([waitPickB, abortOnIntervalError, abortOnDynamicTimingError]);
            await Promise.all([removeFromA(), pickPromise]);
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

        // B devam sonrası login redirect olabiliyor (oturum düşmesi / returnUrl)
        setStep('B.postContinue.reloginCheck.start');
        const bRelog2 = await reloginIfRedirected(pageB, email2, password2).catch((e) => {
            logger.warn('B.postContinue.reloginCheck.error', { email: email2, error: e?.message || String(e) });
            throw e;
        });
        setStep('B.postContinue.reloginCheck.done', { relogged: bRelog2, snap: await snapshotPage(pageB, 'B.afterContinueRelog') });

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
            lastStep
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

module.exports = {startBot};
