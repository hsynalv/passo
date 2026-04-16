'use strict';

/**
 * probe-passoweb-session.js
 * ─────────────────────────────────────────────────────────────────
 * Snipe / SeatCoordinator ile aynı fikir: ticketingweb oturumunda
 * çerez + localStorage JWT + sayfa içi getseatstatus sonucunu tek seferde döker.
 *
 * Kullanım:
 *   node scripts/probe-passoweb-session.js "<www_etkinlik_url>" [blockId]
 *
 * Örnek:
 *   node scripts/probe-passoweb-session.js "https://www.passo.com.tr/tr/etkinlik/fb-rize/11396319" 87335
 *
 * Akış:
 *   1) Tarayıcı açılır → Passo’da manuel giriş yap → ENTER
 *   2) Etkinlik www URL’sinde kalınır (ticketingweb HTML çoğu path’te 403/404)
 *   3) Çerezleri (www + ticketingweb jar) birleştirir, storage’dan JWT arar
 *   4) getseatstatus: mutlak https://ticketingweb.../api/... (CORS+credentials) ile dener
 *
 * Çıktı: logs/probe-passoweb-session-<timestamp>.json (tam Cookie + JWT — paylaşma)
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { connect } = require('puppeteer-real-browser');

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

const TICKETING_API_BASE = 'https://ticketingweb.passo.com.tr';

function mergeCookieHeader(cookieArrays) {
  const byName = new Map();
  for (const arr of cookieArrays) {
    for (const c of arr || []) {
      if (c && c.name) byName.set(c.name, `${c.name}=${c.value}`);
    }
  }
  return Array.from(byName.values()).join('; ');
}

async function evaluateTokenAndTestFetch(page, eventId, serieId, blockId, apiRoot) {
  const bIdForBrowser =
    blockId != null && !Number.isNaN(Number(blockId)) ? Number(blockId) : 0;
  return page.evaluate(
    async (eId, sId, bId, apiBase) => {
      function enc(v) {
        return encodeURIComponent(String(v == null ? '' : v));
      }
      function extractTokenString(v) {
        const s = String(v == null ? '' : v).trim();
        if (!s) return '';
        if (s.charAt(0) === '{') {
          try {
            const o = JSON.parse(s);
            const t =
              o.access_token ||
              o.token ||
              o.accessToken ||
              o.jwt ||
              o.inComingToken ||
              o.InComingToken;
            return t ? String(t) : '';
          } catch {
            return '';
          }
        }
        if (s.length > 40 && s.includes('.') && s.split('.').length >= 3) return s;
        return '';
      }
      function scan(store) {
        let best = { key: '', len: 0, token: '' };
        try {
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            if (!k) continue;
            const lk = k.toLowerCase();
            if (!lk.includes('token') && !lk.includes('auth') && !lk.includes('jwt')) continue;
            const t = extractTokenString(store.getItem(k));
            const L = t ? t.length : 0;
            if (L > best.len) best = { key: k, len: L, token: t };
          }
        } catch {}
        return best;
      }
      let token = '';
      let tokenKeyHint = '';
      const fixed = [
        'access_token',
        'token',
        'jwt',
        'id_token',
        'accessToken',
        'authToken',
        'passo_token',
        'passoToken',
        'pb_token',
        'pb-token',
      ];
      try {
        for (const fk of fixed) {
          const t0 = extractTokenString(
            localStorage.getItem(fk) || sessionStorage.getItem(fk) || ''
          );
          if (t0) {
            token = t0;
            tokenKeyHint = fk;
            break;
          }
        }
        if (!token) {
          const sl = scan(localStorage);
          const ss = scan(sessionStorage);
          if (ss.len > sl.len && ss.token) {
            token = ss.token;
            tokenKeyHint = ss.key || 'session_scan';
          } else if (sl.token) {
            token = sl.token;
            tokenKeyHint = sl.key || 'local_scan';
          }
        }
        if (!token) {
          for (let j = 0; j < localStorage.length; j++) {
            const k2 = localStorage.key(j);
            if (!k2) continue;
            const t2 = extractTokenString(localStorage.getItem(k2));
            if (t2 && t2.length > 50) {
              token = t2;
              tokenKeyHint = k2;
              break;
            }
          }
        }
      } catch {}

      var root = String(apiBase || '').replace(/\/+$/, '');
      var pathQs =
        '/api/passoweb/getseatstatus?eventId=' +
        enc(eId) +
        '&serieId=' +
        enc(sId) +
        '&blockId=' +
        Number(bId);
      var url = root ? root + pathQs : pathQs;
      let fetchResult = null;
      if (bId) {
        try {
          const hdrs = {};
          if (token) {
            hdrs.Authorization = 'Bearer ' + token;
            hdrs.IncomingToken = token;
            hdrs.InComingToken = token;
          }
          const init = { credentials: 'include', cache: 'no-store' };
          if (Object.keys(hdrs).length) init.headers = hdrs;
          const r = await fetch(url, init);
          const txt = await r.text();
          fetchResult = {
            httpStatus: r.status,
            bodyPreview: txt.slice(0, 4000),
            bodyLen: txt.length,
          };
        } catch (e) {
          fetchResult = { error: e && e.message ? String(e.message) : 'fetch_failed' };
        }
      }

      return {
        pageHref: location.href,
        userAgent: navigator.userAgent,
        token,
        tokenKeyHint,
        tokenLen: token ? token.length : 0,
        fetchResult,
      };
    },
    eventId,
    serieId || '',
    bIdForBrowser,
    apiRoot || ''
  );
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
  console.log('API kökü      :', TICKETING_API_BASE, '(mutlak URL + CORS, tw HTML acilmiyor)');
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

  console.log('\n[*] www etkinlik sayfasi (kalici)...');
  await page.goto(eventUrlWww, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(3500);

  let cookiesWww = [];
  let cookiesTw = [];
  try {
    cookiesWww = await page.cookies('https://www.passo.com.tr/');
  } catch {}
  try {
    cookiesTw = await page.cookies('https://ticketingweb.passo.com.tr/');
  } catch {}
  const cookieHeader = mergeCookieHeader([cookiesWww, cookiesTw]);
  const inner = await evaluateTokenAndTestFetch(
    page,
    eventId,
    '',
    blockIdArg != null && !Number.isNaN(blockIdArg) ? blockIdArg : null,
    TICKETING_API_BASE
  );

  const base = TICKETING_API_BASE;
  const bId =
    blockIdArg != null && !Number.isNaN(blockIdArg)
      ? blockIdArg
      : null;
  const getSeatUrl = bId
    ? `${base}/api/passoweb/getseatstatus?eventId=${encodeURIComponent(
        eventId
      )}&serieId=&blockId=${bId}`
    : null;

  const bundle = {
    generatedAt: new Date().toISOString(),
    eventUrlWww,
    pollMode: 'www_page_absolute_ticketing_api',
    ticketingApiBase: TICKETING_API_BASE,
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
    inPageFetchGetseatstatus: inner.fetchResult,
    postman: {
      method: 'GET',
      url: getSeatUrl,
      headers: {
        Cookie: cookieHeader,
        ...(inner.token
          ? {
              Authorization: `Bearer ${inner.token}`,
              InComingToken: inner.token,
              Accept: 'application/json, text/plain, */*',
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
  if (inner.fetchResult) {
    console.log('getseatstatus   :', JSON.stringify(inner.fetchResult).slice(0, 500));
  }
  console.log('\nTam JSON:', outPath);
  console.log('Tarayiciyi kendin kapatabilirsin.\n');

  try {
    await browser.close();
  } catch {}
})();
