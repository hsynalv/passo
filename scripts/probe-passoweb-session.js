'use strict';

/**
 * probe-passoweb-session.js
 * ─────────────────────────────────────────────────────────────────
 * Snipe ile aynı fikir: www etkinlikte kal, çerez + JWT oku, getseatstatus’u **Node axios**
 * ile ticketingweb’e at (CORS yok; tarayıcıda mutlak fetch www’den bloklanır).
 *
 * Kullanım:
 *   node scripts/probe-passoweb-session.js "<www_etkinlik_url>" [blockId]
 *
 * Örnek:
 *   node scripts/probe-passoweb-session.js "https://www.passo.com.tr/tr/etkinlik/fb-rize/11396319" 87335
 *
 * Akış:
 *   1) Tarayıcı açılır → Passo’da manuel giriş yap → ENTER
 *   2) www etkinlik
 *   3) Çerez + storage JWT
 *   4) getseatstatus: bu script içinde axios (ticketingweb tam URL)
 *
 * Çıktı: logs/probe-passoweb-session-<timestamp>.json (tam Cookie + JWT — paylaşma)
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const axios = require('axios');
const { connect } = require('puppeteer-real-browser');
const {
  pickBestPassoPollToken,
  collectPassoTokenLikeStoragePairsSource,
} = require('../src/helpers/passoPollToken');

const eventUrlWww = process.argv[2] || '';
const blockIdArg = process.argv[3] ? parseInt(process.argv[3], 10) : null;

function findBrowserPath() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      const m = fs.readFileSync(envPath, 'utf8').match(/^CHROME_PATH\s*=\s*(.+)$/m);
      if (m) {
        const p = m[1].trim().replace(/^["']|["']$/g, '');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch {}
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const lad = process.env.LOCALAPPDATA || '';
  for (const c of [
    path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(pf86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(lad, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForEnter(msg) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, () => {
      rl.close();
      resolve();
    });
  });
}

function extractEventId(url) {
  const m = String(url).match(/\/(\d{6,})(?:\/?|$)/);
  return m ? m[1] : null;
}

function mergeCookieHeader(cookieArrays) {
  const byName = new Map();
  for (const arr of cookieArrays) {
    for (const c of arr || []) {
      if (c && c.name) byName.set(c.name, `${c.name}=${c.value}`);
    }
  }
  return Array.from(byName.values()).join('; ');
}

async function evaluateTokenSnapshot(page) {
  const collectFn = new Function(
    `${collectPassoTokenLikeStoragePairsSource()}\nreturn collectPassoTokenLikeStoragePairs();`
  );
  const pairs = await page.evaluate(collectFn);
  const picked = pickBestPassoPollToken(Array.isArray(pairs) ? pairs : []);
  const pageHref = await page.evaluate(() => {
    try {
      return String(location.href || '');
    } catch {
      return '';
    }
  });
  const userAgent = await page.evaluate(() => {
    try {
      return String(navigator.userAgent || '');
    } catch {
      return '';
    }
  });
  return {
    pageHref,
    userAgent,
    token: picked.token || '',
    tokenKeyHint: picked.key || '',
    tokenLen: picked.token ? picked.token.length : 0,
  };
}

(async () => {
  if (!eventUrlWww.startsWith('http')) {
    console.error(
      'Kullanim: node scripts/probe-passoweb-session.js "<www_etkinlik_url>" [blockId]'
    );
    process.exit(1);
  }

  const eventId = extractEventId(eventUrlWww);
  if (!eventId) {
    console.error('[HATA] URL icinden eventId cikarilamadi.');
    process.exit(1);
  }

  const logsDir = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const outPath = path.join(logsDir, `probe-passoweb-session-${Date.now()}.json`);

  const browserPath = findBrowserPath();
  if (!browserPath) {
    console.error('[HATA] CHROME_PATH / tarayici bulunamadi.');
    process.exit(1);
  }

  console.log('Tarayici:', browserPath);
  console.log('Etkinlik (www):', eventUrlWww);
  console.log('eventId       :', eventId);
  console.log('blockId       :', blockIdArg != null && !Number.isNaN(blockIdArg) ? blockIdArg : '(yok — fetch atlanir)');
  console.log('');
  console.log('1) Acilan pencerede Passo giris yap.');
  console.log('2) Hazir olunca asagida ENTER.\n');

  const { browser, page } = await connect({
    headless: false,
    turnstile: true,
    args: ['--window-size=1400,900'],
    customConfig: { chromePath: browserPath },
    connectOption: { defaultViewport: null },
  });

  await page.goto('https://www.passo.com.tr/tr/giris', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await waitForEnter('>>> Giris tamam, ENTER: ');

  console.log('\n[*] www etkinlik...');
  await page.goto(eventUrlWww, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(2500);

  let cookiesWww = [];
  let cookiesTw = [];
  try {
    cookiesWww = await page.cookies('https://www.passo.com.tr/');
  } catch {}
  try {
    cookiesTw = await page.cookies('https://ticketingweb.passo.com.tr/');
  } catch {}
  const cookieHeader = mergeCookieHeader([cookiesWww, cookiesTw]);
  const inner = await evaluateTokenSnapshot(page);

  const base = 'https://ticketingweb.passo.com.tr';
  const bId =
    blockIdArg != null && !Number.isNaN(blockIdArg)
      ? blockIdArg
      : null;
  const getSeatUrl = bId
    ? `${base}/api/passoweb/getseatstatus?eventId=${encodeURIComponent(
        eventId
      )}&serieId=&blockId=${bId}`
    : null;

  let nodeAxiosGetseatstatus = null;
  if (getSeatUrl) {
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'text/plain',
      Currentculture: 'tr-TR',
      Referer: 'https://www.passo.com.tr/',
      Origin: 'https://www.passo.com.tr',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    };
    if (inner.token) {
      headers.Authorization = `Bearer ${inner.token}`;
      headers.InComingToken = inner.token;
      headers.IncomingToken = inner.token;
    }
    try {
      const res = await axios.get(getSeatUrl, {
        headers,
        timeout: 20000,
        validateStatus: () => true,
        responseType: 'text',
      });
      const txt = typeof res.data === 'string' ? res.data : String(res.data || '');
      nodeAxiosGetseatstatus = {
        httpStatus: res.status,
        bodyPreview: txt.slice(0, 4000),
        bodyLen: txt.length,
      };
    } catch (e) {
      nodeAxiosGetseatstatus = { error: e && e.message ? String(e.message) : 'axios_failed' };
    }
  }

  const bundle = {
    generatedAt: new Date().toISOString(),
    eventUrlWww,
    pollMode: 'www_page_node_axios',
    eventId,
    blockId: bId,
    getSeatStatusUrl: getSeatUrl,
    cookieHeader,
    cookieHeaderLen: cookieHeader.length,
    cookieJarMeta: {
      wwwCount: cookiesWww.length,
      ticketingwebCount: cookiesTw.length,
      wwwNames: cookiesWww.map((c) => c.name),
      twNames: cookiesTw.map((c) => c.name),
    },
    jwtFromStorage: inner.token || '',
    tokenKeyHint: inner.tokenKeyHint || '',
    tokenLen: inner.tokenLen || 0,
    authorizationHeader: inner.token ? `Bearer ${inner.token}` : '',
    incomingTokenHeader: inner.token || '',
    pageHref: inner.pageHref,
    userAgent: inner.userAgent,
    nodeAxiosGetseatstatus,
    postman: {
      method: 'GET',
      url: getSeatUrl,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'text/plain',
        Currentculture: 'tr-TR',
        Referer: 'https://www.passo.com.tr/',
        Origin: 'https://www.passo.com.tr',
        Cookie: cookieHeader,
        ...(inner.token
          ? {
              Authorization: `Bearer ${inner.token}`,
              InComingToken: inner.token,
            }
          : {}),
      },
    },
  };

  fs.writeFileSync(outPath, JSON.stringify(bundle, null, 2), 'utf8');

  console.log('\n=== OZET ===');
  console.log('cookieHeaderLen :', bundle.cookieHeaderLen);
  console.log('tokenLen        :', bundle.tokenLen);
  console.log('tokenKeyHint    :', bundle.tokenKeyHint || '(yok)');
  if (nodeAxiosGetseatstatus) {
    console.log('getseatstatus   :', JSON.stringify(nodeAxiosGetseatstatus).slice(0, 500));
  }
  console.log('\nTam JSON:', outPath);
  console.log('Tarayiciyi kendin kapatabilirsin.\n');

  try {
    await browser.close();
  } catch {}
})();
