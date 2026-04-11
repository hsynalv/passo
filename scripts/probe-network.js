/**
 * probe-network.js
 * ─────────────────────────────────────────────────────────────────
 * Passo seatmap sayfasinda yapilan TUM XHR/Fetch network cagrilarini loglar.
 *
 * Kullanim:
 *   Manuel giris  : node scripts/probe-network.js <url> [sure_sn]
 *   Otomatik giris: node scripts/probe-network.js <url> [sure_sn] <email> <sifre>
 *
 * Ornekler:
 *   node scripts/probe-network.js https://www.passo.com.tr/tr/etkinlik/xxx 90
 *   node scripts/probe-network.js https://www.passo.com.tr/tr/etkinlik/xxx 90 mail@x.com sifre123
 *
 * Cikti: logs/probe-network-<timestamp>.txt dosyasina da kaydedilir.
 */

'use strict';

const path     = require('path');
const fs       = require('fs');
const readline = require('readline');
const { connect } = require('puppeteer-real-browser');

// ─── Argümanlar ───────────────────────────────────────────────────────────────
const eventUrl         = process.argv[2];
const probeDurationSec = parseInt(process.argv[3] || '90', 10);
const loginEmail       = process.argv[4] || null;
const loginPassword    = process.argv[5] || null;
const autoLogin        = !!(loginEmail && loginPassword);

// ─── Brave / Chrome path tespiti ─────────────────────────────────────────────
function findBrowserPath() {
  // .env'deki CHROME_PATH varsa onu kullan
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      const match = envContent.match(/^CHROME_PATH\s*=\s*(.+)$/m);
      if (match) {
        const p = match[1].trim().replace(/^["']|["']$/g, '');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch {}

  const pf   = process.env['ProgramFiles']      || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const lad  = process.env['LOCALAPPDATA']       || '';

  const candidates = [
    // Brave (önce dene)
    path.join(pf,   'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(pf86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(lad,  'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    // Chrome
    path.join(pf,   'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(lad,  'Google', 'Chrome', 'Application', 'chrome.exe'),
    // Edge
    path.join(pf,   'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];

  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

const browserPath = findBrowserPath();

if (!eventUrl || !eventUrl.startsWith('http')) {
  console.error('Kullanim: node scripts/probe-network.js <passo_url> [sure_sn] [email] [sifre]');
  process.exit(1);
}

// ─── Log ─────────────────────────────────────────────────────────────────────
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const logFile   = path.join(logsDir, 'probe-network-' + Date.now() + '.txt');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function log(...args) {
  const line = args.join(' ');
  console.log(line);
  logStream.write(line + '\n');
}

// ─── Yardımcılar ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

// ─── Endpoint sınıflandırma ───────────────────────────────────────────────────
const seenUrls = new Map();

function categorize(url) {
  if (/seat|koltuk|block|blok|plan|svg/i.test(url))       return '🎯 SEAT';
  if (/basket|sepet|booking|addseat/i.test(url))          return '🛒 BASKET';
  if (/event|etkinlik/i.test(url))                        return '📅 EVENT';
  if (/user|account|profile|member/i.test(url))           return '👤 USER';
  if (/captcha|turnstile|recaptcha|challenge/i.test(url)) return '🔐 CAPTCHA';
  return '❓ OTHER';
}

// ─── Ana akış ─────────────────────────────────────────────────────────────────
(async () => {
  log('═══════════════════════════════════════════════════════');
  log('  Passo Network Probe');
  log('  URL   : ' + eventUrl);
  log('  Sure  : ' + probeDurationSec + ' saniye');
  log('  Giris   : ' + (autoLogin ? 'Otomatik (' + loginEmail + ')' : 'Manuel'));
  log('  Browser : ' + (browserPath || 'Bulunamadi!'));
  log('  Log     : ' + logFile);
  log('═══════════════════════════════════════════════════════\n');

  // ─── Browser aç ───────────────────────────────────────────────────────────
  if (!browserPath) {
    log('[HATA] Brave/Chrome/Edge bulunamadi!');
    log('       .env dosyasina CHROME_PATH=C:\\...\\brave.exe ekle veya');
    log('       Brave yuklu oldugundan emin ol.');
    process.exit(1);
  }

  log('[*] Tarayici aciliyor: ' + browserPath);

  let browser, page;
  try {
    const result = await connect({
      headless: false,
      turnstile: true,
      args: ['--window-size=1400,900'],
      customConfig: { chromePath: browserPath },
      connectOption: { defaultViewport: null }
    });
    browser = result.browser;
    page    = result.page;
    log('[OK] Tarayici acildi.\n');
  } catch (e) {
    log('[HATA] Tarayici acilamadi: ' + e.message);
    process.exit(1);
  }

  // ─── Network interceptor (tüm sekmelere bağla) ───────────────────────────
  function attachResponseListener(p, label) {
    p.on('response', async (response) => {
    try {
      const url    = response.url();
      const rtype  = response.request().resourceType();
      const status = response.status();

      // Sadece XHR / fetch
      if (rtype !== 'xhr' && rtype !== 'fetch') return;
      if (status < 200 || status >= 400) return;

      const headers = response.headers ? response.headers() : {};
      const ct = (headers['content-type'] || '').toLowerCase();
      if (!ct.includes('application/json') && !ct.includes('text/plain') && !ct.includes('text/json')) return;

      let bodyText = '';
      let bodyJson = null;
      try { bodyText = await response.text(); } catch {}
      try { bodyJson = JSON.parse(bodyText); } catch {}

      const cat     = categorize(url);
      const snippet = bodyText.slice(0, 500);
      const ts      = new Date().toISOString().slice(11, 23);

      if (!seenUrls.has(url)) {
        seenUrls.set(url, {
          count: 0,
          firstSeen: ts,
          lastSeen: ts,
          category: cat
        });

        log('');
        log('─── [' + ts + '] YENİ ENDPOINT ───────────────────────────────');
        log('  KAT   : ' + cat);
        log('  URL   : ' + url);
        log('  BODY  : ' + snippet + (bodyText.length > 500 ? '...' : ''));

        // SEAT endpoint'i ise full dump
        if (cat === '🎯 SEAT' && bodyJson) {
          log('');
          log('  *** SEAT ENDPOINT - TAM BODY ***');
          log(JSON.stringify(bodyJson, null, 2).slice(0, 3000));
        }
        log('───────────────────────────────────────────────────────');
      } else {
        const entry = seenUrls.get(url);
        entry.count++;
        entry.lastSeen = ts;

        // Her 10 tekrarda bir bildir (interval takibi icin)
        if (entry.count % 10 === 0) {
          log('[' + ts + '] TEKRAR #' + entry.count + ' | ' + cat + ' | ' + url.split('/').slice(-2).join('/'));
        }
      }
    } catch {}
    });
  }

  // Ana sekmeyi dinle
  attachResponseListener(page, 'sekme-1');

  // Yeni açılan sekmeleri de dinle
  browser.on('targetcreated', async (target) => {
    try {
      if (target.type() !== 'page') return;
      const newPage = await target.page();
      if (!newPage) return;
      const tabLabel = 'yeni-sekme-' + Date.now();
      log('[*] Yeni sekme acildi, dinleniyor: ' + tabLabel);
      attachResponseListener(newPage, tabLabel);
    } catch {}
  });

  // ─── Manuel mod ───────────────────────────────────────────────────────────
  if (!autoLogin) {
    log('MANUEL MOD: Asagidaki adimlari yap, sonra Enter a bas:\n');
    log('  1. Chrome penceresinde Passo hesabinla giris yap');
    log('  2. Su URL ye git: ' + eventUrl);
    log('  3. "Satin Al" butonuna tikla');
    log('  4. /koltuk-secim sayfasinda bir kategoriye tikla → seatmap goster');
    log('  5. Istersen baska kategorilere de gec, koltuk sec/cikar\n');
    await waitForEnter('>>> Hazir olunca ENTER a bas: ');
    log('\n[OK] Dinleme basladi.');

  } else {
    // ─── Otomatik giriş ─────────────────────────────────────────────────────
    log('[*] Giris sayfasina gidiliyor...');
    try {
      await page.goto('https://www.passo.com.tr/tr/giris', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2500);

      const emailSel = 'input[type="email"], input[name="email"], input[name="Username"], input[placeholder*="mail" i]';
      const emailInput = await page.$(emailSel);
      if (emailInput) {
        await emailInput.click({ clickCount: 3 });
        await emailInput.type(loginEmail, { delay: 55 });
        log('[*] Email yazildi.');
      } else {
        log('[UYARI] Email input bulunamadi.');
      }

      const passInput = await page.$('input[type="password"]');
      if (passInput) {
        await passInput.click({ clickCount: 3 });
        await passInput.type(loginPassword, { delay: 55 });
        log('[*] Sifre yazildi.');
      }

      await sleep(500);
      const submitBtn = await page.$('button[type="submit"]');
      if (submitBtn) {
        await submitBtn.click();
        log('[*] Giris butonuna tiklandi...');
        await sleep(5000);
        log('[*] Giris sonrasi URL: ' + page.url());
      }
    } catch (e) {
      log('[UYARI] Otomatik giris hatasi: ' + e.message);
      log('[!] Lutfen Chrome uzerinden manuel giris yapin.');
      await waitForEnter('>>> Giris yapinca ENTER a bas: ');
    }

    // Etkinlik sayfasına git
    log('[*] Etkinlik sayfasina gidiliyor...');
    try {
      await page.goto(eventUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
      log('[*] URL: ' + page.url());
    } catch (e) {
      log('[UYARI] ' + e.message);
    }

    // Satın Al
    log('[*] Satin Al butonu aranıyor...');
    try {
      const buyBtn = await page.$([
        'button[data-testid*="buy" i]',
        'button[class*="buy-btn" i]',
        'a[href*="koltuk-secim"]',
        'button[class*="ticket" i]'
      ].join(', '));

      if (buyBtn) {
        await buyBtn.click();
        log('[*] Butona tiklandi, bekleniyor...');
        await sleep(5000);
      } else {
        const ku = eventUrl.replace(/\/$/, '') + '/koltuk-secim';
        log('[*] Buton bulunamadi, direkt URL: ' + ku);
        await page.goto(ku, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);
      }
    } catch (e) {
      log('[UYARI] ' + e.message);
    }

    log('[*] Simdi URL: ' + page.url());
    log('');
    log('[!] Chrome uzerinden bir kategoriye tiklayin → seatmap acilsin.');
    log('[!] Istersen baska kategorilere gec, koltuk sec/cikar.');
    log('');
  }

  // ─── Dinleme süresi ───────────────────────────────────────────────────────
  log('[*] ' + probeDurationSec + ' saniye dinleniyor...\n');
  await sleep(probeDurationSec * 1000);

  // ─── Özet rapor ───────────────────────────────────────────────────────────
  log('\n');
  log('══════════════════════════════════════════════════════════');
  log('  OZET RAPOR');
  log('══════════════════════════════════════════════════════════');
  log('  Toplam unique endpoint: ' + seenUrls.size);
  log('');

  const sorted = Array.from(seenUrls.entries()).sort((a, b) => b[1].count - a[1].count);
  for (const [url, meta] of sorted) {
    log('  ' + meta.category);
    log('    URL   : ' + url);

    const totalCalls = meta.count + 1;
    log('    Cagri : ' + totalCalls + 'x  (ilk: ' + meta.firstSeen + ', son: ' + meta.lastSeen + ')');

    if (meta.count > 0) {
      const firstMs = parseTimeToMs(meta.firstSeen);
      const lastMs  = parseTimeToMs(meta.lastSeen);
      if (lastMs > firstMs) {
        const avgInterval = Math.round((lastMs - firstMs) / meta.count / 1000);
        log('    Interval: ~' + avgInterval + 'sn (polling hizi)');
      }
    }
    log('');
  }

  log('Detayli log: ' + logFile);

  try { await browser.close(); } catch {}
  logStream.end();
})();

function parseTimeToMs(timeStr) {
  try {
    const [h, m, rest] = timeStr.split(':');
    const [s, ms] = rest.split('.');
    return ((+h) * 3600 + (+m) * 60 + (+s)) * 1000 + (+(ms || 0));
  } catch { return 0; }
}
