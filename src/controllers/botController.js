const {connect} = require('puppeteer-real-browser');
const axios = require('axios');
const ac = require('@antiadmin/anticaptchaofficial');

const cfg = require('../config');
const delay = require('../utils/delay');
const {confirmSwalYes, clickRemoveFromCartAndConfirm} = require('../helpers/swal');
const {
    ensurePage, captureSeatIdFromNetwork, readBasketData, readCatBlock, setCatBlockOnB,
    openSeatMapStrict, clickContinueInsidePage
} = require('../helpers/page');
const {pickRandomSeatWithVerify, pickExactSeatWithVerify_Locked} = require('../helpers/seat');

ac.setAPIKey(cfg.ANTICAPTCHA_KEY || '');

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
    if (proxyApplied && proxyUsername && proxyPassword) {
        try {
            await page.authenticate({username: String(proxyUsername), password: String(proxyPassword)});
        } catch {
        }
    }

    await page.goto(cfg.PASSO_LOGIN, {waitUntil: 'networkidle2'});

    // Try to detect Turnstile; if not present in ~7s solve via AntiCaptcha and inject
    let cf = false;
    const t0 = Date.now();
    while (!cf && Date.now() - t0 < 7000) {
        cf = await page.evaluate(() => !!document.querySelector('.cf-turnstile, input[name="cf-turnstile-response"]'));
        if (!cf) await delay(600);
    }
    if (!cf && cfg.PASSO_SITE_KEY && cfg.ANTICAPTCHA_KEY) {
        try {
            const tok = await ac.solveTurnstileProxyless(cfg.PASSO_LOGIN, cfg.PASSO_SITE_KEY);
            await page.evaluate(token => {
                const f = document.querySelector('form');
                if (!f) return;
                let i = f.querySelector('input[name="cf-turnstile-response"]');
                if (!i) {
                    i = document.createElement('input');
                    i.type = 'hidden';
                    i.name = 'cf-turnstile-response';
                    f.appendChild(i);
                }
                i.value = token;
            }, tok);
        } catch {
        }
    }

    await page.type('input[autocomplete="username"]', String(email || ''));
    await page.type('input[autocomplete="current-password"]', String(password || ''));
    await page.evaluate(() => {
        const b = [...document.querySelectorAll('button.black-btn')].find(x => (x.innerText || '').trim() === 'GİRİŞ');
        b?.click();
    });
    await delay(1200);

    return {browser, page};
}

async function clickBuy(page) {
    for (let i = 0; i < 12; i++) {
        const ok = await page.evaluate(() => {
            const b = [...document.querySelectorAll('button.red-btn')].find(el => (el.innerText || '').trim() === 'SATIN AL');
            if (b) {
                b.scrollIntoView({block: 'center'});
                b.click();
                return true;
            }
            return false;
        });
        if (ok) return true;
        await delay(400);
    }
    return false;
}

async function chooseCategoryAndRandomBlock(page, categoryType, alternativeCategory) {
    for (let i = 0; i < 12; i++) {
        const ok = await page.evaluate(()=>{



            return false;
        });
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
    if (!selectedText) throw new Error("❌ Uygun kategori bulunamadı.");
    const idx = options.findIndex(t => t === selectedText);
    const optEls = await page.$$('.dropdown-option:not(.disabled)');
    await optEls[idx].click();

    await page.waitForFunction(() => {
        const s = document.querySelector('select#blocks');
        return s && s.options.length > 1;
    }, {timeout: 6000});
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
    const {
        team, ticketType, eventAddress, categoryType, alternativeCategory,
        prioritySale, fanCardCode, identity,
        email, password, cardHolder, cardNumber, expiryMonth, expiryYear, cvv,
        proxyHost, proxyPort, proxyUsername, proxyPassword,
        email2, password2
    } = req.body;

    if (!team || !ticketType) return res.status(400).json({error: 'team ve ticketType (combined | regular) zorunludur.'});
    if (!email2 || !password2) return res.status(400).json({error: 'email2 & password2 zorunlu (2. hesap).'});

    let browserA, pageA, browserB, pageB;

    try {
        // A: Launch + Login
        ({browser: browserA, page: pageA} = await launchAndLogin({
            email, password, userDataDir: cfg.USER_DATA_DIR_A, proxyHost, proxyPort, proxyUsername, proxyPassword
        }));

        // B: Launch + Login
        ({browser: browserB, page: pageB} = await launchAndLogin({
            email: email2,
            password: password2,
            userDataDir: cfg.USER_DATA_DIR_B,
            proxyHost,
            proxyPort,
            proxyUsername,
            proxyPassword
        }));

        // A: go event -> BUY -> ticket type (if present) -> category/block -> random seat
        await pageA.goto(String(eventAddress), {waitUntil: 'networkidle2'});
        const clickedA = await clickBuy(pageA);
        if (!clickedA) throw new Error('❌ SATIN AL tıklanamadı (A)');
        await pageA.waitForNavigation({waitUntil: 'domcontentloaded'}).catch(() => {
        });

        const hasTicketType = await pageA.$('.ticket-type-title');
        if (hasTicketType) {
            await pageA.evaluate(() => {
                const titles = Array.from(document.querySelectorAll('.ticket-type-title'));
                const target = titles.find(el => (el.innerText || '').includes('Passolig E-Bilet'));
                target?.click();
            });
        }

        await chooseCategoryAndRandomBlock(pageA, categoryType, alternativeCategory);

        const netSeatA = captureSeatIdFromNetwork(pageA, 20000);
        const seatInfoA = await require('../helpers/seat').pickRandomSeatWithVerify(pageA, 50000);
        const sidNet = await netSeatA;
        if (sidNet && !seatInfoA.seatId) seatInfoA.seatId = sidNet;

        // B: go event -> BUY -> same category & block -> target seat (locked strategy)
        await pageB.goto(String(eventAddress), {waitUntil: 'networkidle2'});
        const clickedB = await clickBuy(pageB);
        if (!clickedB) throw new Error('❌ SATIN AL tıklanamadı (B)');
        await pageB.waitForNavigation({waitUntil: 'domcontentloaded'}).catch(() => {
        });

        const catBlockA = await require('../helpers/page').readCatBlock(pageA);
        await require('../helpers/page').setCatBlockOnB(pageB, catBlockA);

        const waitPickB = (async () => {
            const got = await require('../helpers/seat').pickExactSeatWithVerify_Locked(pageB, seatInfoA, 90000);
            if (!got) throw new Error('B hedef koltuğu zamanında alamadı.');
            return got;
        })();

        const removed = await require('../helpers/swal').clickRemoveFromCartAndConfirm(pageA, 15000);
        if (!removed) throw new Error('A sepetten kaldıramadı.');

        const seatInfoB = await waitPickB;

        await clickContinueInsidePage(pageB);
        await delay(800);

        // Optional external log
        if (cfg.ORDER_LOG_URL) {
            try {
                await axios.post(cfg.ORDER_LOG_URL, {
                    link: eventAddress,
                    seat: seatInfoB.combined,
                    name: cardHolder,
                    email: email2,
                    total_basket_time: 600,
                    current_basket_time: 600,
                    status: "Wait For Payment (B)"
                }, {headers: {'Content-Type': 'application/json'}, timeout: 15000});
            } catch {
            }
        }

        return res.json({success: true, grabbedBy: email2, seatA: seatInfoA, seatB: seatInfoB, catBlockA});
    } catch (err) {
        console.error('❌ Hata:', err);
        return res.status(500).json({error: String(err)});
    } finally {
        // Do not close browsers automatically; caller may want to inspect. If needed, uncomment:
        // try { await browserA?.close(); } catch {}
        // try { await browserB?.close(); } catch {}
    }
}

module.exports = {startBot};
