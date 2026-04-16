'use strict';
/**
 * ticketingweb koltuk listesi GET — Node axios (CORS yok).
 *
 * Tek istek: PASSO_TEST_URL veya argv[2] (tam URL).
 *
 * Çoklu blok: PASSO_BLOCK_IDS=87388,88348,87390
 *   - Şablon: PASSO_TEST_URL / argv[2] içinde zaten bir blockId= olsun; her blok için aynı URL’de
 *     sadece blockId değiştirilir (eventId, seatCategoryId aynı kalır — tarayıcıdan kopyaladığın şablon iyi).
 *   - Ya da: PASSO_EVENT_ID + PASSO_BLOCK_IDS (+ isteğe PASSO_SEAT_CATEGORY_ID boş olabilir, PASSO_SERIE_ID).
 *
 * PASSO_DELAY_MS — bloklar arası bekleme (varsayılan 400).
 *
 * Cloudflare 403 HTML = edge; çoklu istekte rate / imza riski artar.
 *
 *   set PASSO_COOKIE=...
 *   set PASSO_TOKEN=...
 *   set PASSO_BLOCK_IDS=87388,88348
 *   node scripts/test-passoweb-seat-http.js "https://ticketingweb...blockId=87388..."
 */

const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');

/** Örnek şablon URL; PASSO_BLOCK_IDS ile birlikte kullanıldığında blockId değişir. */
const DEBUG_SNAPSHOT = {
  url:
    'https://ticketingweb.passo.com.tr/api/passoweb/getseatsbyblockid?eventId=11396319&serieId=&seatCategoryId=12882429&blockId=87388&campaignId=undefined',
  cookie: '',
  token: '',
};

const templateUrl = String(process.argv[2] || process.env.PASSO_TEST_URL || DEBUG_SNAPSHOT.url).trim();
const cookie = String(process.env.PASSO_COOKIE || DEBUG_SNAPSHOT.cookie).trim();
const tokenRaw = String(process.env.PASSO_TOKEN || DEBUG_SNAPSHOT.token).trim();
const token = tokenRaw.replace(/^Bearer\s+/i, '').trim();
const socks = String(process.env.PASSO_SOCKS || '').trim();
const delayMs = Math.max(0, parseInt(String(process.env.PASSO_DELAY_MS || '400'), 10) || 0);

const blockIdsRaw = String(process.env.PASSO_BLOCK_IDS || '').trim();
const blockIds = blockIdsRaw
  ? blockIdsRaw
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  : [];

const eventId = String(process.env.PASSO_EVENT_ID || '').trim();
const serieId = String(process.env.PASSO_SERIE_ID ?? '').trim();
const seatCategoryId = String(process.env.PASSO_SEAT_CATEGORY_ID ?? '').trim();

const userAgent =
  String(process.env.PASSO_USER_AGENT || '').trim() ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const secChUa =
  String(process.env.PASSO_SEC_CH_UA || '').trim() ||
  '"Brave";v="147", "Not.A/Brand";v="8", "Chromium";v="147"';

/**
 * @returns {string[]}
 */
function resolveUrls() {
  if (!blockIds.length) {
    if (!templateUrl.startsWith('http')) {
      console.error('Geçersiz URL. PASSO_TEST_URL veya argv[2] ver.');
      process.exit(1);
    }
    return [templateUrl];
  }

  if (eventId) {
    const base = 'https://ticketingweb.passo.com.tr/api/passoweb/getseatsbyblockid';
    return blockIds.map((bid) => {
      const n = Number(bid);
      if (!Number.isFinite(n) || n <= 0) {
        console.error('Geçersiz blockId:', bid);
        process.exit(1);
      }
      const p = new URLSearchParams();
      p.set('eventId', eventId);
      p.set('serieId', serieId);
      p.set('seatCategoryId', seatCategoryId);
      p.set('blockId', String(n));
      p.set('campaignId', 'undefined');
      return `${base}?${p.toString()}`;
    });
  }

  if (!templateUrl.startsWith('http')) {
    console.error(
      'Çoklu blok: ya PASSO_EVENT_ID + PASSO_BLOCK_IDS, ya da şablon PASSO_TEST_URL/argv[2] (http...) + PASSO_BLOCK_IDS.'
    );
    process.exit(1);
  }
  let template;
  try {
    template = new URL(templateUrl);
  } catch {
    console.error('URL parse edilemedi:', templateUrl);
    process.exit(1);
  }
  if (!template.searchParams.has('blockId')) {
    console.error('Şablon URL’de blockId= yok; ekle veya PASSO_EVENT_ID ile üret.');
    process.exit(1);
  }
  return blockIds.map((bid) => {
    const n = Number(bid);
    if (!Number.isFinite(n) || n <= 0) {
      console.error('Geçersiz blockId:', bid);
      process.exit(1);
    }
    const u = new URL(template.toString());
    u.searchParams.set('blockId', String(n));
    return u.toString();
  });
}

const urls = resolveUrls();

const headers = {
  'User-Agent': userAgent,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'tr-TR,tr;q=0.6',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Priority: 'u=1, i',
  'Content-Type': 'text/plain',
  Currentculture: 'tr-TR',
  Referer: 'https://www.passo.com.tr/',
  Origin: 'https://www.passo.com.tr',
  'Sec-CH-UA': secChUa,
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"Windows"',
  'Sec-GPC': '1',
  'Sec-Fetch-Site': 'same-site',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
  ...(cookie ? { Cookie: cookie } : {}),
  ...(token
    ? {
        Authorization: `Bearer ${token}`,
        InComingToken: token,
        IncomingToken: token,
      }
    : {}),
};

const opts = { headers, timeout: 25000, validateStatus: () => true, responseType: 'text' };
if (socks) {
  const agent = new SocksProxyAgent(socks);
  opts.httpAgent = agent;
  opts.httpsAgent = agent;
  opts.proxy = false;
}

function preview(s, n = 80) {
  const t = String(s || '');
  if (t.length <= n) return t;
  return `${t.slice(0, n)}…(len=${t.length})`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  console.log(
    `[test-passoweb-seat-http] ${urls.length} istek` +
      (blockIds.length ? ` (PASSO_BLOCK_IDS=${blockIds.length} blok)` : ' (tek URL)') +
      (delayMs ? `, aralar ${delayMs}ms` : '')
  );
  console.log('[test-passoweb-seat-http] Cookie', cookie ? preview(cookie, 60) : '(yok)');
  console.log('[test-passoweb-seat-http] Token', token ? preview(token, 40) : '(yok)');
  console.log('[test-passoweb-seat-http] SOCKS', socks || '(yok, doğrudan çıkış)');
  console.log('[test-passoweb-seat-http] User-Agent', preview(userAgent, 72));
  if (!cookie) {
    console.log(
      '[test-passoweb-seat-http] Uyarı: Cookie yok — CF için Application → Cookies’ten __cf_bm (+ _cfuvid) PASSO_COOKIE yap.'
    );
  }

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const bidMatch = url.match(/blockId=(\d+)/);
    const label = bidMatch ? `blockId=${bidMatch[1]}` : `req ${i + 1}/${urls.length}`;
    console.log('\n---', label, '---');
    console.log('GET', url);
    try {
      const res = await axios.get(url, opts);
      console.log('HTTP', res.status, res.statusText || '');
      const rh = res.headers && typeof res.headers === 'object' ? res.headers : {};
      const ct = rh['content-type'] || '';
      const body = String(res.data || '');
      const cfBlock =
        res.status === 403 &&
        (body.includes('Sorry, you have been blocked') || body.includes('cf-error-details'));
      if (cfBlock) console.log('[CF] Cloudflare blok HTML');
      const jsonish = /application\/json/i.test(String(ct)) || (body.trim().startsWith('{') && body.length < 2_000_000);
      console.log('content-type:', String(ct).slice(0, 80));
      console.log('body len:', body.length, jsonish ? '(json benzeri)' : '');
      console.log('preview:', body.slice(0, 600));
    } catch (e) {
      console.error('Hata:', e.message || e);
      if (e.response) {
        console.error('HTTP', e.response.status, String(e.response.data || '').slice(0, 500));
      }
    }
    if (i < urls.length - 1 && delayMs) await sleep(delayMs);
  }
})();
