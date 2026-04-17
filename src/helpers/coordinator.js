'use strict';

const EventEmitter = require('events');
const axios = require('axios');
const logger       = require('../utils/logger');
const delay        = require('../utils/delay');
const { evaluateSafe } = require('../utils/browserEval');
const { buildPassoApiCookieHeader } = require('./passoSessionCookies');
const {
  pickBestPassoPollToken,
  collectPassoTokenLikeStoragePairsSource,
} = require('./passoPollToken');

/**
 * Gerçek passo.com.tr (Network panel) ile hizalı ek başlıklar.
 * Not: Tarayıcıda `Origin` / `Referer` fetch ile script’ten set edilemez (forbidden); Node axios’ta eklenebilir.
 */
function passoTicketingBrowserLikeHeaders({ forNode = false } = {}) {
  const h = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'text/plain',
    Currentculture: 'tr-TR',
  };
  if (forNode) {
    h.Referer = 'https://www.passo.com.tr/';
    h.Origin = 'https://www.passo.com.tr';
  }
  return h;
}

/**
 * Tarayıcı SOCKS/HTTP proxy ile aynı çıkışı Node axios’a verir (TLS hâlâ Node’dur — CF bazen 403).
 * @returns {{ httpAgent?: import('http').Agent, httpsAgent?: import('http').Agent, proxy: boolean } | { proxy: boolean }}
 */
function buildAxiosAgentsFromSnipeOutboundProxy(snipeOutboundProxy) {
  const none = { proxy: false };
  const p = snipeOutboundProxy;
  if (!p) return none;
  const portFromOpts = String(p.proxyPort == null ? '' : p.proxyPort).trim();
  if (!portFromOpts) return none;
  const user = String(p.proxyUsername || '').trim();
  const pass = String(p.proxyPassword || '').trim();
  const auth =
    user || pass ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';

  let raw = String(p.proxyHost || '').trim();
  if (!raw) return none;

  let proto = 'socks5';
  let hostname = '';
  let port = portFromOpts;

  if (/^(https?|socks4|socks5):\/\//i.test(raw)) {
    try {
      const normalized = raw.replace(/^socks5h:/i, 'socks5:');
      const u = new URL(normalized);
      proto = (u.protocol || 'socks5:').replace(/:$/, '').toLowerCase();
      if (proto === 'socks5h') proto = 'socks5';
      hostname = u.hostname;
      if (u.port) port = u.port;
    } catch {
      return none;
    }
  } else {
    hostname = raw.replace(/^\/+/, '');
  }
  if (!hostname) return none;

  const hostPort = `${hostname}:${port}`;
  try {
    if (proto === 'socks4' || proto === 'socks5') {
      const { SocksProxyAgent } = require('socks-proxy-agent');
      const url = `${proto}://${auth}${hostPort}`;
      const agent = new SocksProxyAgent(url);
      return { httpAgent: agent, httpsAgent: agent, proxy: false };
    }
    if (proto === 'http' || proto === 'https') {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      const proxyHttpUrl = `http://${auth}${hostPort}`;
      const agent = new HttpsProxyAgent(proxyHttpUrl);
      return { httpAgent: agent, httpsAgent: agent, proxy: false };
    }
  } catch (e) {
    logger.warn('buildAxiosAgentsFromSnipeOutboundProxy:failed', { error: e?.message || String(e) });
  }
  return none;
}

/** Ham gövdeyi log / runStore için kısalt. */
function previewHttpBody(data, maxLen = 900) {
  try {
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    if (s.length <= maxLen) return s;
    return `${s.slice(0, maxLen)}…(+${s.length - maxLen} karakter)`;
  } catch {
    try { return String(data).slice(0, maxLen); } catch { return '(önizleme yok)'; }
  }
}

/** HTML / Cloudflare gövdelerini log ve runStore için kısalt. */
function previewNetworkErrorBody(data, maxLen = 400) {
  try {
    if (data == null) return '(empty)';
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    if (/Attention Required!\s*\|\s*Cloudflare/i.test(str) || /cf-error-details/i.test(str)) {
      return '(Cloudflare HTML — oturum veya bölge kısıtı; ticketingweb alanında geçerli oturum gerekir)';
    }
    if (typeof data === 'string' && str.trimStart().startsWith('<!')) {
      const m = str.match(/<title>([^<]+)<\/title>/i);
      const t = m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 100) : '';
      const clip = str.replace(/\s+/g, ' ').trim().slice(0, Math.min(180, maxLen));
      return t ? `(HTML: ${t}) ${clip}…` : `(HTML, JSON değil) ${clip}…`;
    }
    return previewHttpBody(data, maxLen);
  } catch {
    return '(önizleme yok)';
  }
}

/**
 * Koltuk listesi JSON (`getseats` / `getseatsbyblockid`): value / valueList büyük olabilir.
 */
function previewSeatStatusPayload(data, maxLen = 900) {
  try {
    if (data == null) return '(empty)';
    if (typeof data !== 'object') return previewHttpBody(data, maxLen);
    const vl = data.valueList ?? data.value;
    const slim = { ...data };
    delete slim.valueList;
    delete slim.value;
    if (Array.isArray(vl)) {
      slim.valueListLength = vl.length;
      slim.valueListFirst  = vl.length ? vl[0] : null;
    } else {
      slim.valueListLength = null;
    }
    return previewHttpBody(slim, maxLen);
  } catch {
    return '(önizleme hatası)';
  }
}

/**
 * Snipe tick aralığı için alt sınır (ms): blok ve hesap sayısına göre dinamik.
 * Hesap başına düşen blok (B/A) arttıkça veya hesap sayısı arttıkça süre uzar (429 / Cloudflare).
 */
function computeSnipeMinIntervalMs(blockCount, accountCount) {
  const B = Math.max(0, Math.floor(Number(blockCount)) || 0);
  const A = Math.max(1, Math.floor(Number(accountCount)) || 1);
  if (B === 0) return 650;
  const perAccount = Math.ceil(B / A);
  const accountFactor = 1 + (A - 1) * 0.38;
  const load = perAccount * 38 + Math.sqrt(B + 1) * 18;
  let v = 480 + load * accountFactor;
  const pressure = B * A;
  if (pressure >= 20) v *= 1.22;
  if (pressure >= 32) v *= 1.08;
  return Math.min(12000, Math.max(700, Math.round(v)));
}

/**
 * SeatCoordinator
 *
 * Proaktif koltuk tarama motoru.
 *
 * Tasarım ilkeleri:
 *  1. Multi-page polling   — `pollTransport: 'node'`: Node axios + sayfadan Cookie/JWT (CORS yok; www’den tam ticketingweb URL).
 *     SOCKS varsa axios aynı proxy ile; TLS yine Node (CF 403 olası). `pollTransport: 'browser'`: göreli `fetch('/api/...')`.
 *     Bloklar hesaplar arasında bölünür; her sekmede pollConcurrency kadar paralel,
 *     kalanı sırayla (429 / Cloudflare rate limit azaltma).
 *  2. Seat TTL tracking    — Boşa düşen koltukların "ilk görülme" zamanı tutulur.
 *     Koltuk kaybolursa TTL tablosundan silinir; exclusive kilit serbest bırakılır.
 *  3. Exclusive assignment — seatId exclusive kilitle; aynı koltuk 2 hesaba atanmaz.
 *     markDone(failed=true) ile kilidin geri alınması mümkün.
 *  4. Burst dispatch       — Tek tick'te N koltuk varsa N idle hesap paralel gönderilir.
 *
 * Kullanım:
 *   const coord = new SeatCoordinator({ eventId, serieId, blockMap, filter, intervalMs });
 *   coord.addAccount(accountCtx);
 *   coord.on('seat_found', async ({ seatId, blockId, categoryId, assignedCtx, markDone, ageMs }) => { ... });
 *   await coord.start();
 *   coord.stop();
 *
 * Olaylar:
 *   tick_stats — Her tarama turu bittiğinde HTTP özeti (UI + log için).
 */
class SeatCoordinator extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}   opts.eventId
   * @param {string}   [opts.serieId='']
   * @param {Map<number,{categoryId,categoryName,blockName,svgBlockId?}>} opts.blockMap
   * @param {object}   [opts.filter]
   * @param {number}   [opts.filter.adjacentCount=1]
   * @param {number|null} [opts.filter.maxPrice]
   * @param {string[]|null} [opts.filter.rows]
   * @param {number}   [opts.intervalMs=1400]
   * @param {number}   [opts.timeoutMs=1800000]  30 dakika default
   * @param {number}   [opts.pollConcurrency=4]  Tek tick’te sekme başına eşzamanlı koltuk listesi isteği üst sınırı
   * @param {string}   [opts.ticketingApiBase=''] Node poll kökü (örn. https://ticketingweb.passo.com.tr); boşsa varsayılan.
   * @param {string}   [opts.pollTransport='browser'] `browser` | `node` — snipe için `node` (www + axios).
   * @param {string}   [opts.seatListPollMode='legacy'] `svg` → getseatsbyblockid; `legacy` → getseats (Passo web ile aynı).
   */
  constructor({
    eventId,
    serieId = '',
    blockMap,
    filter = {},
    intervalMs = 1400,
    timeoutMs = 1_800_000,
    pollConcurrency = 4,
    ticketingApiBase = '',
    pollTransport = 'browser',
    seatListPollMode = 'legacy',
  }) {
    super();
    this.eventId    = eventId;
    this.serieId    = serieId;
    const tab = String(ticketingApiBase || '').trim().replace(/\/+$/, '');
    this.ticketingApiBase = tab || 'https://ticketingweb.passo.com.tr';
    this.pollTransport = String(pollTransport || 'browser').toLowerCase() === 'node' ? 'node' : 'browser';
    this.seatListPollMode = String(seatListPollMode || 'legacy').toLowerCase() === 'svg' ? 'svg' : 'legacy';
    this.blockMap   = blockMap || new Map();
    this.filter     = { adjacentCount: 1, maxPrice: null, rows: null, ...filter };
    let im = Number(intervalMs);
    if (!Number.isFinite(im) || im < 400) im = 1400;
    this.intervalMs = Math.min(8000, Math.max(400, im));
    this.timeoutMs  = timeoutMs;
    this.pollConcurrency = Math.max(1, Math.min(12, Number(pollConcurrency) || 4));
    /** start() içinde hesap sayısına göre güncellenir */
    this._effectivePollConcurrency = this.pollConcurrency;

    this._idlePool      = [];          // accountCtx[]
    this._busyPool      = new Set();
    this._assignedSeats = new Set();   // exclusive seatId kilidi
    this._seatFirstSeen = new Map();   // seatId → timestamp (TTL takibi)
    this._lastSeenSeats = new Set();   // önceki tick'te görülen seatId'ler (kaybolma tespiti)
    this._abortCtrl     = null;
    this._running       = false;
    this._timer         = null;
    this._elapsed       = 0;
    this._tickRunning   = false;
    this._totalDispatched = 0;
    this._consecutive429Ticks = 0;
  }

  addAccount(accountCtx) { this._idlePool.push(accountCtx); }
  get allAccounts()       { return [...this._idlePool, ...this._busyPool]; }
  get idleCount()         { return this._idlePool.length; }
  get running()           { return this._running; }
  get totalDispatched()   { return this._totalDispatched; }

  async start() {
    if (this._running) return;
    if (this.blockMap.size === 0) {
      logger.warn('SeatCoordinator:start:no_blocks', {});
      return;
    }
    this._running = true;
    this._elapsed = 0;
    this._abortCtrl = new AbortController();
    const blockIds = Array.from(this.blockMap.keys());
    const ac0 = this._idlePool.length;
    const acForFloor = Math.max(1, ac0);
    const intervalUserRequested = this.intervalMs;
    const minByLoad = computeSnipeMinIntervalMs(blockIds.length, acForFloor);
    if (minByLoad > this.intervalMs) {
      logger.warn('SeatCoordinator:intervalMs_dynamic_floor', {
        blockCount: blockIds.length,
        accountCount: acForFloor,
        userRequested: intervalUserRequested,
        effective: minByLoad,
      });
      this.intervalMs = minByLoad;
    }
    let pc = this.pollConcurrency;
    if (blockIds.length >= 70 && ac0 >= 2) pc = Math.min(pc, 2);
    else if (blockIds.length >= 45 && ac0 >= 2) pc = Math.min(pc, 3);
    this._effectivePollConcurrency = Math.max(1, pc);
    if (this._effectivePollConcurrency !== this.pollConcurrency) {
      logger.warn('SeatCoordinator:pollConcurrency_clamped', {
        blockCount: blockIds.length,
        accountCount: ac0,
        requested: this.pollConcurrency,
        effective: this._effectivePollConcurrency,
      });
    }
    this._consecutive429Ticks = 0;
    const seqPoll =
      (blockIds.length >= 55 && ac0 >= 2) ||
      (ac0 >= 2 && blockIds.length * Math.max(1, ac0) >= 20);
    logger.info('SeatCoordinator:started', {
      eventId: this.eventId,
      blockCount: blockIds.length,
      accountCount: ac0,
      intervalMsUser: intervalUserRequested,
      intervalMsMinByLoad: minByLoad,
      intervalMs: this.intervalMs,
      pollConcurrency: this.pollConcurrency,
      pollConcurrencyEffective: this._effectivePollConcurrency,
      sequentialAccountPoll: seqPoll,
      timeoutMs: this.timeoutMs,
      ticketingApiBase: this.ticketingApiBase,
      pollTransport: this.pollTransport,
      seatListPollMode: this.seatListPollMode,
      seatListPollPath: this.seatListPollMode === 'svg' ? 'getseatsbyblockid' : 'getseats',
      ...(this.pollTransport === 'node'
        ? {
            nodePollNote:
              'getseats / getseatsbyblockid Node(axios); SOCKS proxy axios ile; www’den fetch CORS (preflight) yuzden kullanilmaz.',
          }
        : {}),
    });
    this._timer = setInterval(() => this._tick(blockIds), this.intervalMs);
    this._tick(blockIds); // ilk tick hemen
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._abortCtrl) { this._abortCtrl.abort(); this._abortCtrl = null; }
    logger.info('SeatCoordinator:stopped', { eventId: this.eventId, totalDispatched: this._totalDispatched });
    this.emit('stopped');
  }

  _returnToIdle(accountCtx, seatId, failed = false) {
    this._busyPool.delete(accountCtx);
    this._idlePool.push(accountCtx);
    if (failed && seatId != null) {
      this._assignedSeats.delete(seatId);
      logger.info('SeatCoordinator:seat_released_for_retry', { seatId });
    }
    logger.info('SeatCoordinator:account_returned_idle', {
      email: accountCtx.email,
      idleCount: this._idlePool.length,
    });
    this.emit('account_done', { accountCtx });
  }

  /** www (veya mevcut) sekmeden API bearer — storage_token + normalize (SEO metni Bearer sanılmasın). */
  async _extractPollTokenFromPage(page) {
    try {
      const collectFn = new Function(
        `${collectPassoTokenLikeStoragePairsSource()}\nreturn collectPassoTokenLikeStoragePairs();`
      );
      const pairs = await evaluateSafe(page, collectFn);
      const { token } = pickBestPassoPollToken(Array.isArray(pairs) ? pairs : []);
      return typeof token === 'string' ? token : '';
    } catch {
      return '';
    }
  }

  /**
   * `getseats` (legacy) veya `getseatsbyblockid` (SVG) — Node axios. Cookie/JWT sayfadan.
   */
  _buildSeatListPollUrl(blockId, seatCategoryId) {
    const base =
      String(this.ticketingApiBase || '').replace(/\/+$/, '') || 'https://ticketingweb.passo.com.tr';
    const enc = (v) => encodeURIComponent(String(v == null ? '' : v));
    const bid = Number(blockId);
    const sc = enc(String(seatCategoryId != null && seatCategoryId !== '' ? seatCategoryId : ''));
    if (this.seatListPollMode === 'svg') {
      return `${base}/api/passoweb/getseatsbyblockid?eventId=${enc(this.eventId)}&serieId=${enc(this.serieId || '')}&seatCategoryId=${sc}&blockId=${bid}&campaignId=undefined`;
    }
    return `${base}/api/passoweb/getseats?eventId=${enc(this.eventId)}&serieId=${enc(this.serieId || '')}&seatCategoryId=${sc}&blockId=${bid}`;
  }

  /**
   * CDP `Network.loadNetworkResource` ile poll — CORS yok, Chromium TLS, browser cookie jar.
   * Sayfa www veya ticketingweb'de olsun fark etmez; Puppeteer CDP doğrudan gider.
   */
  async _pollChunkCdp(ctx, blocks, eId, sId, effectivePc) {
    const page = ctx.page;
    if (!page || typeof page.createCDPSession !== 'function') return [];

    const token = await this._extractPollTokenFromPage(page);
    const lim = Math.max(1, Math.min(8, Number(effectivePc) || 4));

    let client;
    let frameId;
    try {
      client = await page.createCDPSession();
      const { frameTree } = await client.send('Page.getFrameTree');
      frameId = frameTree.frame.id;
    } catch (e) {
      logger.warn('SeatCoordinator:cdp_init_failed', { email: ctx.email, error: e?.message });
      return [];
    }

    const extraHeaders = {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'text/plain',
      Currentculture: 'tr-TR',
      Referer: 'https://www.passo.com.tr/',
      Origin: 'https://www.passo.com.tr',
    };
    if (token) {
      extraHeaders.Authorization = `Bearer ${token}`;
      extraHeaders.InComingToken = token;
      extraHeaders.IncomingToken = token;
    }

    try { await client.send('Network.setExtraHTTPHeaders', { headers: extraHeaders }); } catch {}

    const specs = (blocks || []).map((bid) => {
      const blockId = Number(bid);
      const meta = this.blockMap.get(blockId) || {};
      const rawCat = meta.categoryId;
      const seatCategoryId = rawCat != null && rawCat !== '' ? String(rawCat) : '';
      return { blockId, seatCategoryId };
    });

    const results = [];
    for (let o = 0; o < specs.length; o += lim) {
      if (o > 0) await delay(100);
      const slice = specs.slice(o, o + lim);
      const batch = await Promise.all(
        slice.map(async ({ blockId, seatCategoryId }) => {
          if (!seatCategoryId) {
            return { blockId, seats: null, httpStatus: null, axiosError: 'missing_seatCategoryId', bodyPreview: null };
          }
          const url = this._buildSeatListPollUrl(blockId, seatCategoryId);
          try {
            const resp = await client.send('Network.loadNetworkResource', {
              frameId,
              url,
              options: { disableCache: true, includeCredentials: true },
            });
            const { resource } = resp;
            const httpStatus = resource.httpStatusCode || null;
            // Ağ hatası (DNS fail, connection refused vb.) — HTTP status yok
            if (!resource.success && !httpStatus) {
              return {
                blockId, seats: null, httpStatus: null,
                axiosError: resource.netErrorName || 'cdp_net_error',
                bodyPreview: null,
              };
            }
            // HTTP yanıtı var (200, 403, 4xx, 5xx) — body'i her durumda oku (hata nedenini logla)
            let body = '';
            if (resource.stream) {
              try {
                for (;;) {
                  const chunk = await client.send('IO.read', { handle: resource.stream, size: 65536 });
                  body += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : (chunk.data || '');
                  if (chunk.eof) break;
                }
              } finally {
                await client.send('IO.close', { handle: resource.stream }).catch(() => {});
              }
            }
            if (httpStatus !== 200) {
              const isCfBlock = /Sorry, you have been blocked|cf-error-details|Attention Required.*Cloudflare/i.test(body);
              const bodyPreview = isCfBlock ? '(Cloudflare blok sayfası)' : body.replace(/\s+/g, ' ').trim().slice(0, 500);
              return { blockId, seats: null, httpStatus, axiosError: null, bodyPreview };
            }
            try {
              const data = JSON.parse(body);
              const seats = data.valueList || data.value || null;
              return { blockId, seats, httpStatus: 200, axiosError: null, bodyPreview: null };
            } catch {
              return { blockId, seats: null, httpStatus, axiosError: 'json_parse_failed', bodyPreview: body.slice(0, 400) };
            }
          } catch (e) {
            return { blockId, seats: null, httpStatus: null, axiosError: e?.message || 'cdp_error', bodyPreview: null };
          }
        })
      );
      for (const r of batch) results.push(r);
    }

    try { await client.send('Network.setExtraHTTPHeaders', { headers: {} }); } catch {}
    try { await client.detach(); } catch {}
    return results;
  }

  /**
   * www.passo.com.tr sayfasından cross-origin fetch + CDP Fetch.enable interceptor ile auth header enjeksiyonu.
   *
   * Sorun: ticketingweb.passo.com.tr'ye doğrudan sekme navigate etmek CF'i tetikler (API domain, doğrudan
   * tarayıcı erişimine kapalı). CDP loadNetworkResource iç kanal kullandığından setExtraHTTPHeaders uygulanmaz.
   *
   * Çözüm:
   *  1. JS fetch sadece Accept headerı ile istek atar (GET + basit header = preflight yok).
   *  2. Browser otomatik Origin: https://www.passo.com.tr ekler → CF WAF bu origin'e izin verir.
   *  3. CDP Fetch.enable interceptor network katmanında Authorization + Cookie + diğer auth headerları ekler.
   *  4. CF sunucuya: Origin✓ + CF cookie✓ + auth header → izin.
   *  5. Server: ACAO:* döner; JS fetch credentials:omit (default) → CORS geçer.
   */
  async _pollChunkBrowserIntercept(ctx, blocks, eId, sId, effectivePc) {
    const page = ctx.page;
    if (!page || typeof page.createCDPSession !== 'function') return [];

    const token = await this._extractPollTokenFromPage(page);
    let cookieHeader = '';
    try { cookieHeader = await buildPassoApiCookieHeader(page); } catch {}

    const lim = Math.max(1, Math.min(8, Number(effectivePc) || 4));
    const ticketingBase = String(this.ticketingApiBase || '').replace(/\/+$/, '') || 'https://ticketingweb.passo.com.tr';

    const chunkSpecs = blocks.map((bid) => {
      const blockId = Number(bid);
      const meta = this.blockMap.get(blockId) || {};
      const rawCat = meta.categoryId;
      const seatCategoryId = rawCat != null && rawCat !== '' ? String(rawCat) : '';
      return { blockId, seatCategoryId };
    });

    let client;
    let fetchEnabled = false;
    try {
      client = await page.createCDPSession();

      // Sadece ticketingweb isteklerini yakala (request aşamasında)
      await client.send('Fetch.enable', {
        patterns: [{ urlPattern: 'https://ticketingweb.passo.com.tr/*', requestStage: 'Request' }],
      });
      fetchEnabled = true;

      // Her yakalanan ticketingweb isteğine auth + cookie headerları enjekte et
      client.on('Fetch.requestPaused', async ({ requestId, request }) => {
        try {
          const inject = [];
          inject.push({ name: 'Content-Type',   value: 'text/plain' });
          inject.push({ name: 'Currentculture', value: 'tr-TR' });
          if (token) {
            inject.push({ name: 'Authorization', value: `Bearer ${token}` });
            inject.push({ name: 'InComingToken',  value: token });
            inject.push({ name: 'IncomingToken',  value: token });
          }
          if (cookieHeader) {
            inject.push({ name: 'Cookie', value: cookieHeader });
          }
          // Var olan headerları koru; bizimkilerle çakışanları yenileriyle değiştir
          const injectKeys = new Set(inject.map(h => h.name.toLowerCase()));
          const existing = Object.entries(request.headers || {})
            .filter(([k]) => !injectKeys.has(k.toLowerCase()))
            .map(([k, v]) => ({ name: k, value: v }));
          await client.send('Fetch.continueRequest', { requestId, headers: [...existing, ...inject] });
        } catch {
          try { await client.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }); } catch {}
        }
      });

      const rows = await evaluateSafe(
        page,
        /* istanbul ignore next */
        function interceptedFetchSeatList(blockSpecs, eId, sId, maxParallel, pollModeStr, base) {
          function enc(v) { return encodeURIComponent(String(v == null ? '' : v)); }
          var lim  = Math.max(1, Math.min(12, parseInt(maxParallel, 10) || 4));
          var mode = String(pollModeStr || 'legacy').toLowerCase() === 'svg' ? 'svg' : 'legacy';
          return (async function () {
            var acc = [];
            for (var o = 0; o < blockSpecs.length; o += lim) {
              if (o > 0) await new Promise(function (r) { setTimeout(r, 100); });
              var slice = blockSpecs.slice(o, o + lim);
              var batch = await Promise.all(slice.map(function (spec) {
                return (async function () {
                  var blockId = spec.blockId;
                  var seatCat = String(spec.seatCategoryId || '');
                  if (!seatCat) {
                    return { blockId: blockId, seats: null, httpStatus: null, axiosError: 'missing_seatCategoryId', bodyPreview: null };
                  }
                  // Sadece Accept ile basit GET — preflight tetiklenmiyor.
                  // Authorization + Cookie CDP interceptor tarafından network katmanında ekleniyor.
                  // Browser Origin: https://www.passo.com.tr otomatik ekliyor → CF WAF izin veriyor.
                  var url = mode === 'svg'
                    ? base + '/api/passoweb/getseatsbyblockid?eventId=' + enc(eId) + '&serieId=' + enc(sId) + '&seatCategoryId=' + enc(seatCat) + '&blockId=' + Number(blockId) + '&campaignId=undefined'
                    : base + '/api/passoweb/getseats?eventId='          + enc(eId) + '&serieId=' + enc(sId) + '&seatCategoryId=' + enc(seatCat) + '&blockId=' + Number(blockId);
                  try {
                    var r = await fetch(url, { headers: { Accept: 'application/json, text/plain, */*' } });
                    var httpStatus = r.status;
                    if (httpStatus !== 200) {
                      var body = ''; try { body = await r.text(); } catch {}
                      return { blockId: blockId, seats: null, httpStatus: httpStatus, axiosError: null, bodyPreview: body.replace(/\s+/g, ' ').trim().slice(0, 400) || null };
                    }
                    var data  = await r.json();
                    var seats = (data && (data.valueList || data.value)) || null;
                    return { blockId: blockId, seats: seats, httpStatus: 200, axiosError: null, bodyPreview: null };
                  } catch (e) {
                    return { blockId: blockId, seats: null, httpStatus: null, axiosError: e ? String(e.message || 'fetch_failed') : 'fetch_failed', bodyPreview: null };
                  }
                })();
              }));
              for (var j = 0; j < batch.length; j++) acc.push(batch[j]);
            }
            return acc;
          })();
        },
        chunkSpecs, eId, sId, lim, this.seatListPollMode, ticketingBase,
      );

      const list = Array.isArray(rows) ? rows : [];
      for (const row of list) {
        if (row.httpStatus === 200 && Array.isArray(row.seats)) {
          row.bodyPreview = previewSeatStatusPayload({ valueList: row.seats }, 900);
        }
      }
      return list;
    } catch (e) {
      logger.warn('SeatCoordinator:browser_intercept_failed', { email: ctx.email, error: e?.message });
      return [];
    } finally {
      if (fetchEnabled && client) { try { await client.send('Fetch.disable'); } catch {} }
      if (client)                 { try { await client.detach(); }             catch {} }
    }
  }

  async _pollChunkNodeHttp(ctx, blocks, eId, sId, effectivePc) {
    const page = ctx.page;
    if (!page) return [];
    let cookieHeader = '';
    try {
      cookieHeader = await buildPassoApiCookieHeader(page);
    } catch {}
    const token = await this._extractPollTokenFromPage(page);
    const headers = {
      ...passoTicketingBrowserLikeHeaders({ forNode: true }),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      headers.InComingToken = token;
      headers.IncomingToken = token;
    }
    const reqMs = Math.min(25000, Math.max(8000, Number(this.timeoutMs) || 20000));
    const lim = Math.max(1, Math.min(12, Number(effectivePc) || 4));
    const acc = [];
    const specs = (blocks || []).map((bid) => {
      const blockId = Number(bid);
      const meta = this.blockMap.get(blockId) || {};
      const rawCat = meta.categoryId;
      const seatCategoryId = rawCat != null && rawCat !== '' ? String(rawCat) : '';
      return { blockId, seatCategoryId };
    });

    const axiosAgentOpts = buildAxiosAgentsFromSnipeOutboundProxy(ctx.snipeOutboundProxy);
    if (axiosAgentOpts.httpsAgent && !ctx._snipeNodePollProxyLogged) {
      ctx._snipeNodePollProxyLogged = true;
      logger.info('SeatCoordinator:node_poll_uses_outbound_proxy', {
        email: ctx.email,
        hasAuth: !!(ctx.snipeOutboundProxy?.proxyUsername || ctx.snipeOutboundProxy?.proxyPassword),
      });
    }

    for (let o = 0; o < specs.length; o += lim) {
      if (o > 0) {
        const gapMs = specs.length > 5 ? 160 : (specs.length > 3 ? 110 : 70);
        await delay(gapMs);
      }
      const slice = specs.slice(o, o + lim);
      const batch = await Promise.all(
        slice.map(async ({ blockId, seatCategoryId }) => {
          if (!seatCategoryId) {
            return {
              blockId,
              seats: null,
              httpStatus: null,
              axiosError: 'missing_seatCategoryId',
              bodyPreview: 'blockMap.categoryId (seatCategoryId) gerekli',
            };
          }
          const url = this._buildSeatListPollUrl(blockId, seatCategoryId);
          try {
            const res = await axios.get(url, {
              headers,
              timeout: reqMs,
              validateStatus: () => true,
              responseType: 'text',
              ...axiosAgentOpts,
            });
            const httpStatus = res.status;
            const txt = typeof res.data === 'string' ? res.data : String(res.data || '');
            const ct = String(res.headers?.['content-type'] || res.headers?.['Content-Type'] || '').toLowerCase();
            if (httpStatus !== 200) {
              let bodyPreview = null;
              try {
                if (/Attention Required!\s*\|\s*Cloudflare/i.test(txt) || /cf-error-details/i.test(txt)) {
                  bodyPreview = '(Cloudflare HTML)';
                } else {
                  bodyPreview = txt.replace(/\s+/g, ' ').trim().slice(0, 400);
                }
              } catch (_) {}
              return { blockId, seats: null, httpStatus, axiosError: null, bodyPreview };
            }
            if (!ct.includes('json')) {
              return {
                blockId,
                seats: null,
                httpStatus,
                axiosError: null,
                bodyPreview: txt.replace(/\s+/g, ' ').trim().slice(0, 400) || '(yanıt JSON değil)',
              };
            }
            let data;
            try {
              data = JSON.parse(txt);
            } catch {
              return {
                blockId,
                seats: null,
                httpStatus,
                axiosError: null,
                bodyPreview: txt.replace(/\s+/g, ' ').trim().slice(0, 400),
              };
            }
            const seats = data.valueList || data.value || null;
            return { blockId, seats, httpStatus: 200, axiosError: null, bodyPreview: null };
          } catch (e) {
            return {
              blockId,
              seats: null,
              httpStatus: null,
              axiosError: e && e.message ? String(e.message) : 'axios_failed',
              bodyPreview: null,
            };
          }
        })
      );
      for (const r of batch) acc.push(r);
    }
    return acc;
  }

  /**
   * Her tick'te:
   *  1. Idle hesapları blok gruplarına böl, her grup bir hesabın page'inde paralel poll eder.
   *  2. Çok blok + birden fazla hesap: hesaplar sırayla poll edilir (429 azaltma). Aksi halde Promise.allSettled.
   *  3. Sonuçları birleştir, TTL takibi yap, dispatch et.
   */
  async _tick(blockIds) {
    if (!this._running || this._tickRunning) return;

    this._elapsed += this.intervalMs;
    if (this._elapsed > this.timeoutMs) {
      this._running = false;
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      if (this._abortCtrl) { this._abortCtrl.abort(); this._abortCtrl = null; }
      logger.warn('SeatCoordinator:timeout', { eventId: this.eventId, elapsedMs: this._elapsed });
      this.emit('timeout');
      return;
    }

    this._tickRunning = true;
    const tickT0 = Date.now();
    try {
      this._tickCount = (this._tickCount || 0) + 1;
      const tick = this._tickCount;

      const idleAccounts = [...this._idlePool];
      if (!idleAccounts.length) {
        this.emit('tick_stats', {
          tick,
          tickMs: Date.now() - tickT0,
          eventId: this.eventId,
          note: 'no_idle_accounts',
          busyAccounts: this._busyPool.size,
          blocksExpected: blockIds.length,
          blocksPolled: 0,
          http200: 0,
          httpNot200: 0,
          networkErrors: 0,
          blocksWithSeatList: 0,
          totalSeatRows: 0,
          availableAfterFilter: 0,
        });
        return;
      }

      // ── Multi-page block dağılımı ──────────────────────────────────────────
      // Blokları idle hesap sayısına eşit parçalara böl.
      // Her parça o hesabın page'inde çalışır → paralel, farklı session, farklı IP eğer proxy varsa.
      const n = idleAccounts.length;
      const chunkSize = Math.ceil(blockIds.length / n);
      const chunks = Array.from({ length: n }, (_, i) =>
        blockIds.slice(i * chunkSize, (i + 1) * chunkSize)
      );

      const evId  = this.eventId;
      const seId  = this.serieId;

      const pc = this._effectivePollConcurrency != null ? this._effectivePollConcurrency : this.pollConcurrency;

      const accountParallelPressure = blockIds.length * Math.max(1, idleAccounts.length);
      const useSequentialAccounts =
        (blockIds.length >= 55 && idleAccounts.length >= 2) ||
        (idleAccounts.length >= 2 && accountParallelPressure >= 20);

      const runChunk = async (ctx, i) => {
        const chunk = chunks[i] || [];
        if (!chunk.length) return [];

        const page = ctx.page;
        if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return [];

        try {
          if (!useSequentialAccounts && i > 0) await delay(90 + 110 * i);

          if (this.pollTransport === 'node') {
            const rows = await this._pollChunkNodeHttp(ctx, chunk, evId, seId, pc);
            const list = Array.isArray(rows) ? rows : [];
            for (const row of list) {
              if (row.httpStatus === 200 && Array.isArray(row.seats)) {
                row.bodyPreview = previewSeatStatusPayload({ valueList: row.seats }, 900);
              }
            }
            return list;
          }

          // 'browser': www.passo.com.tr'den cross-origin fetch + CDP Fetch interceptor ile auth enjeksiyonu.
          // CF WAF: Origin: https://www.passo.com.tr → izin. CORS: ACAO:* + no-credentials → geçer.
          if (this.pollTransport === 'browser') {
            const rows = await this._pollChunkBrowserIntercept(ctx, chunk, evId, seId, pc);
            const list = Array.isArray(rows) ? rows : [];
            for (const row of list) {
              if (row.httpStatus === 200 && Array.isArray(row.seats)) {
                row.bodyPreview = previewSeatStatusPayload({ valueList: row.seats }, 900);
              }
            }
            return list;
          }

          const chunkSpecs = chunk.map((bid) => {
            const blockId = Number(bid);
            const meta = this.blockMap.get(blockId) || {};
            const rawCat = meta.categoryId;
            const seatCategoryId = rawCat != null && rawCat !== '' ? String(rawCat) : '';
            return { blockId, seatCategoryId };
          });

          const pollToken = await this._extractPollTokenFromPage(page);
          const ticketingBase = String(this.ticketingApiBase || '').replace(/\/+$/, '') || 'https://ticketingweb.passo.com.tr';
          // ticketingweb.passo.com.tr frame varsa (koltuk-secim iframe), oradan same-origin fetch.
          // Yoksa main page'den cross-origin; credentials:include ile değil (ACAO:* ile uyumsuz).
          let evalTarget = page;
          try {
            const frames = typeof page.frames === 'function' ? page.frames() : [];
            const tw = frames.find((f) => {
              try { return (f.url?.() || '').includes('ticketingweb.passo.com.tr'); } catch { return false; }
            });
            if (tw) evalTarget = tw;
          } catch {}
          const rows = await evaluateSafe(
              evalTarget,
              function browserPollSeatList(blockSpecs, eId, sId, maxParallel, pollModeStr, preResolvedToken, ticketingApiBase) {
                function enc(v) {
                  return encodeURIComponent(String(v == null ? '' : v));
                }
                function buildPassoFetchHeaders() {
                  var h = {};
                  var token = String(preResolvedToken || '').trim();
                  if (token) {
                    h.Authorization = 'Bearer ' + token;
                    h.IncomingToken = token;
                    h.InComingToken = token;
                  }
                  h.Accept = 'application/json, text/plain, */*';
                  h['Content-Type'] = 'text/plain';
                  h.Currentculture = 'tr-TR';
                  return h;
                }
                // Relative URL kullanma: sayfa www.passo.com.tr'deyse yanlış host'a gider.
                // ticketingApiBase her zaman absolute (https://ticketingweb.passo.com.tr).
                var base = String(ticketingApiBase || 'https://ticketingweb.passo.com.tr').replace(/\/+$/, '');
                var lim = Math.max(1, Math.min(12, parseInt(maxParallel, 10) || 4));
                var mode = String(pollModeStr || 'legacy').toLowerCase() === 'svg' ? 'svg' : 'legacy';
                return (async function () {
                  var acc = [];
                  for (var o = 0; o < blockSpecs.length; o += lim) {
                    if (o > 0) {
                      var gapMs = blockSpecs.length > 5 ? 160 : (blockSpecs.length > 3 ? 110 : 70);
                      await new Promise(function (r) { setTimeout(r, gapMs); });
                    }
                    var slice = blockSpecs.slice(o, o + lim);
                    var batch = await Promise.all(slice.map(function (spec) {
                      return (async function () {
                        try {
                          var blockId = spec.blockId;
                          var seatCat = String(spec.seatCategoryId || '');
                          if (!seatCat) {
                            return {
                              blockId: blockId,
                              seats: null,
                              httpStatus: null,
                              axiosError: 'missing_seatCategoryId',
                              bodyPreview: null,
                            };
                          }
                          var url = mode === 'svg'
                            ? base + '/api/passoweb/getseatsbyblockid?eventId=' + enc(eId) + '&serieId=' + enc(sId) + '&seatCategoryId=' + enc(seatCat) + '&blockId=' + Number(blockId) + '&campaignId=undefined'
                            : base + '/api/passoweb/getseats?eventId=' + enc(eId) + '&serieId=' + enc(sId) + '&seatCategoryId=' + enc(seatCat) + '&blockId=' + Number(blockId);
                          var r;
                          var httpStatus;
                          var ct;
                          var lastErrText = '';
                          // Cross-origin: credentials:'include' + ACAO:* → CORS hata.
                          // 'same-origin' (varsayılan) kullan: same-origin'de cookie gider,
                          // cross-origin'de gitmez ama ACAO:* ile bloklanmaz. Auth header'da token var.
                          var isSameOrigin = (typeof location !== 'undefined') &&
                            String(ticketingApiBase).replace(/\/+$/, '').replace(/^https?:\/\//, '') === location.hostname;
                          var credMode = isSameOrigin ? 'include' : 'same-origin';
                          for (var attempt = 0; attempt < 2; attempt++) {
                            var hdrs = buildPassoFetchHeaders();
                            var init = { credentials: credMode, cache: 'no-store' };
                            if (hdrs && Object.keys(hdrs).length) init.headers = hdrs;
                            r = await fetch(url, init);
                            httpStatus = r.status;
                            ct = (r.headers.get('content-type') || '').toLowerCase();
                            if (httpStatus !== 401) break;
                            lastErrText = await r.text();
                            if (attempt === 0 && lastErrText.indexOf('InComingToken') >= 0) {
                              await new Promise(function (rr) { setTimeout(rr, 450); });
                              continue;
                            }
                            break;
                          }
                          if (httpStatus !== 200) {
                            let bodyPreview = null;
                            try {
                              var t = lastErrText;
                              if (!t) { try { t = await r.text(); } catch (e2) { t = ''; } }
                              if (/Attention Required!\s*\|\s*Cloudflare/i.test(t) || /cf-error-details/i.test(t)) {
                                bodyPreview = '(Cloudflare HTML)';
                              } else {
                                bodyPreview = t.replace(/\s+/g, ' ').trim().slice(0, 400);
                              }
                            } catch (_) {}
                            return { blockId, seats: null, httpStatus, axiosError: null, bodyPreview };
                          }
                          if (!ct.includes('json')) {
                            let bodyPreview = null;
                            try {
                              bodyPreview = (await r.text()).replace(/\s+/g, ' ').trim().slice(0, 400);
                            } catch (_) {}
                            return {
                              blockId,
                              seats: null,
                              httpStatus,
                              axiosError: null,
                              bodyPreview: bodyPreview || '(yanıt JSON değil)',
                            };
                          }
                          const data = await r.json();
                          const seats = data.valueList || data.value || null;
                          return { blockId, seats, httpStatus: 200, axiosError: null, bodyPreview: null };
                        } catch (e) {
                          return {
                            blockId,
                            seats: null,
                            httpStatus: null,
                            axiosError: e && e.message ? String(e.message) : 'fetch_failed',
                            bodyPreview: null,
                          };
                        }
                      })();
                    }));
                    for (var j = 0; j < batch.length; j++) acc.push(batch[j]);
                  }
                  return acc;
                })();
              },
              chunkSpecs,
              evId,
              seId,
              pc,
              this.seatListPollMode,
              pollToken,
              ticketingBase
            );
            const list = Array.isArray(rows) ? rows : [];
            for (const row of list) {
              if (row.httpStatus === 200 && Array.isArray(row.seats)) {
                row.bodyPreview = previewSeatStatusPayload({ valueList: row.seats }, 900);
              }
            }
            return list;
        } catch (e) {
          logger.warn('SeatCoordinator:chunk_poll_failed', { email: ctx.email, error: e?.message });
          return [];
        }
      };

      let chunkResults;
      if (useSequentialAccounts) {
        chunkResults = [];
        for (let i = 0; i < idleAccounts.length; i++) {
          if (i > 0) await delay(520 + 90 * i);
          try {
            chunkResults.push({ status: 'fulfilled', value: await runChunk(idleAccounts[i], i) });
          } catch (reason) {
            chunkResults.push({ status: 'rejected', reason });
          }
        }
      } else {
        chunkResults = await Promise.allSettled(
          idleAccounts.map((ctx, i) => runChunk(ctx, i))
        );
      }

      // ── Sonuçları birleştir ───────────────────────────────────────────────
      const allResults = [];
      for (const r of chunkResults) {
        if (r.status === 'fulfilled' && Array.isArray(r.value)) {
          allResults.push(...r.value);
        }
      }

      // ── Müsait koltukları topla + TTL takibi ─────────────────────────────
      const now          = Date.now();
      const currentSeats = new Set();
      const available    = [];

      for (const { blockId, seats } of allResults) {
        if (!Array.isArray(seats)) continue;
        for (const seat of seats) {
          if (seat.isSold || seat.isReserved) continue;
          const seatId = Number(seat.id);
          currentSeats.add(seatId);
          if (this._assignedSeats.has(seatId)) continue;
          if (!this._matchesFilter(seat, blockId)) continue;

          if (!this._seatFirstSeen.has(seatId)) {
            this._seatFirstSeen.set(seatId, now);
            logger.info('SeatCoordinator:new_seat_available', { seatId, blockId });
          }

          const ageMs = now - this._seatFirstSeen.get(seatId);
          available.push({ seatId, blockId, ageMs, seat });
        }
      }

      // TTL temizliği: önceki tick'te var ama bu tick'te kaybolanları sil.
      for (const seatId of this._lastSeenSeats) {
        if (!currentSeats.has(seatId)) {
          this._seatFirstSeen.delete(seatId);
          // Exclusive kilit: zaten assigned değilse zaten yok; assigned ise dispatch yapılmış demek, dokunma.
        }
      }
      this._lastSeenSeats = currentSeats;

      const httpSum = this._buildTickHttpSummary(allResults);
      const minIntervalByLoad = computeSnipeMinIntervalMs(
        blockIds.length,
        Math.max(1, idleAccounts.length)
      );
      const responseSamples = this._pickResponseSamples(allResults, 6);
      const allBlocksCf403 = allResults.length > 0
        && httpSum.http200 === 0
        && httpSum.httpNot200 === allResults.length
        && Number((httpSum.statusBreakdown || {})['403'] || 0) === allResults.length;
      const allBlocks429 = allResults.length > 0
        && httpSum.http200 === 0
        && httpSum.httpNot200 === allResults.length
        && Number((httpSum.statusBreakdown || {})['429'] || 0) === allResults.length;

      if (httpSum.http200 > 0) {
        this._consecutive429Ticks = 0;
      } else if (allBlocks429) {
        this._consecutive429Ticks = (this._consecutive429Ticks || 0) + 1;
        if (this._consecutive429Ticks >= 2) {
          this._adaptAfterSustained429(minIntervalByLoad, blockIds);
          this._consecutive429Ticks = 0;
        }
      } else {
        this._consecutive429Ticks = 0;
      }

      let cf403Hint = null;
      if (allBlocksCf403) {
        const pools = [...this._idlePool, ...this._busyPool];
        const hasOutProxy = pools.some(
          (c) => c && c.snipeOutboundProxy && String(c.snipeOutboundProxy.proxyPort || '').trim()
        );
        if (this.pollTransport === 'node') {
          cf403Hint = hasOutProxy
            ? 'ticketingweb: tüm yanıtlar 403 (Cloudflare). Axios SOCKS ile; buna rağmen 403 ise cookie/JWT, seatCategoryId veya Node TLS vs Chromium farkı (CF) olabilir.'
            : 'ticketingweb: tüm yanıtlar 403 (Cloudflare). Axios doğrudan çıkış; tarayıcı SOCKS farklı olabilir — proxy havuzu/manuel SOCKS deneyin.';
        } else {
          cf403Hint =
            'ticketingweb: tüm yanıtlar 403 (Cloudflare HTML). Sayfayı ticketing alanında yenile veya oturumu doğrula; hâlâ olmazsa IP/bölge kısıtı olabilir.';
        }
      }

      const pollHint = allBlocks429
        ? 'Tüm yanıtlar 429 (hız limiti / Cloudflare). Aralık blok ve hesap sayısına göre dinamik tabana çekilir; tick_stats.intervalMs ve minIntervalByLoad alanlarına bak. Gerekirse pollConcurrency veya hesap sayısını azalt.'
        : cf403Hint;
      this.emit('tick_stats', {
        tick,
        tickMs: Date.now() - tickT0,
        eventId: this.eventId,
        blocksExpected: blockIds.length,
        incompletePoll: allResults.length !== blockIds.length,
        idleAccounts:     this._idlePool.length,
        busyAccounts:     this._busyPool.size,
        availableAfterFilter: available.length,
        intervalMs: this.intervalMs,
        minIntervalByLoad,
        pollConcurrencyEffective: this._effectivePollConcurrency ?? this.pollConcurrency,
        sequentialAccountPoll: useSequentialAccounts,
        ...httpSum,
        ...(pollHint ? { pollHint } : {}),
        ...(responseSamples?.length ? { responseSamples } : {}),
      });

      if (!available.length) return;

      // ── En eski değil en YENI koltukları önce dispatch et ────────────────
      // Taze koltuk → başka kullanıcı henüz almamış olasılığı yüksek.
      available.sort((a, b) => a.ageMs - b.ageMs);

      logger.info('SeatCoordinator:available_seats', {
        count: available.length,
        idleAccounts: this._idlePool.length,
        seats: available.slice(0, 5).map(s => ({ seatId: s.seatId, blockId: s.blockId, ageMs: s.ageMs })),
      });

      // ── Burst dispatch ───────────────────────────────────────────────────
      for (const { seatId, blockId, ageMs } of available) {
        if (this._idlePool.length === 0) break;

        const accountCtx = this._idlePool.shift();
        this._busyPool.add(accountCtx);
        this._assignedSeats.add(seatId);
        this._totalDispatched++;

        const blockInfo = this.blockMap.get(blockId) || {};
        logger.info('SeatCoordinator:seat_dispatched', {
          seatId, blockId, ageMs,
          categoryId:   blockInfo.categoryId,
          categoryName: blockInfo.categoryName,
          blockName:    blockInfo.blockName,
          svgBlockId:   blockInfo.svgBlockId,
          email: accountCtx.email,
          totalDispatched: this._totalDispatched,
        });

        const markDone = (failed = false) => this._returnToIdle(accountCtx, seatId, failed);
        this.emit('seat_found', {
          seatId,
          blockId,
          categoryId:   blockInfo.categoryId,
          categoryName: blockInfo.categoryName,
          blockName:    blockInfo.blockName,
          svgBlockId:   blockInfo.svgBlockId,
          ageMs,
          assignedCtx:  accountCtx,
          markDone,
        });
      }

    } catch (e) {
      logger.warn('SeatCoordinator:tick_error', { error: e?.message });
    } finally {
      this._tickRunning = false;
    }
  }

  _rescheduleTickTimer(blockIds) {
    if (!this._running || !Array.isArray(blockIds) || !blockIds.length) return;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._timer = setInterval(() => this._tick(blockIds), this.intervalMs);
  }

  /**
   * Üst üste tüm bloklar 429 → aralığı ve sekme içi paralelliği düşür, timer'ı yeniden kur.
   */
  _adaptAfterSustained429(minIntervalFloor, blockIds) {
    const prevInt = this.intervalMs;
    const prevPc = this._effectivePollConcurrency ?? 1;
    const nextPc = Math.max(1, prevPc - 1);
    const intervalBump = nextPc < prevPc ? 1.48 : 1.32;
    const bumped = Math.min(
      16000,
      Math.max(minIntervalFloor, Math.round(prevInt * intervalBump))
    );
    let changed = false;
    if (nextPc < prevPc) {
      this._effectivePollConcurrency = nextPc;
      changed = true;
    }
    if (bumped > prevInt) {
      this.intervalMs = bumped;
      changed = true;
    }
    if (!changed) return;
    logger.warn('SeatCoordinator:429_sustained_backoff', {
      eventId: this.eventId,
      intervalMs: this.intervalMs,
      intervalMsBefore: prevInt,
      pollConcurrencyEffective: this._effectivePollConcurrency,
      pollConcurrencyBefore: prevPc,
      minIntervalFloor: minIntervalFloor,
    });
    this._rescheduleTickTimer(blockIds);
  }

  _matchesFilter(seat, blockId) {
    const { maxPrice, rows } = this.filter;
    if (maxPrice != null && seat.price != null && Number(seat.price) > maxPrice) return false;
    if (rows && rows.length && seat.rowName && !rows.includes(seat.rowName)) return false;
    return true;
  }

  /** HTTP özetini tek tur için üret (tarayıcı içi fetch satırlarından). */
  _buildTickHttpSummary(allResults) {
    let http200 = 0;
    let httpNot200 = 0;
    let networkErrors = 0;
    const statusBreakdown = {};
    let blocksWithSeatList = 0;
    let totalSeatRows      = 0;

    for (const row of allResults) {
      if (row.axiosError) {
        networkErrors++;
        continue;
      }
      const st = row.httpStatus;
      if (st === 200) http200++;
      else if (st != null) {
        httpNot200++;
        const k = String(st);
        statusBreakdown[k] = (statusBreakdown[k] || 0) + 1;
      } else {
        networkErrors++;
      }
      if (Array.isArray(row.seats)) {
        blocksWithSeatList++;
        totalSeatRows += row.seats.length;
      }
    }

    return {
      blocksPolled:       allResults.length,
      http200,
      httpNot200,
      networkErrors,
      statusBreakdown:    Object.keys(statusBreakdown).length ? statusBreakdown : undefined,
      blocksWithSeatList,
      totalSeatRows,
    };
  }

  /**
   * Tur başına sınırlı yanıt özeti: önce hatalar, sonra en fazla birkaç başarılı örnek.
   */
  _pickResponseSamples(allResults, max = 5) {
    if (!Array.isArray(allResults) || !allResults.length) return [];
    const out   = [];
    const push  = (r) => {
      if (out.length >= max) return;
      out.push({
        blockId:     r.blockId,
        httpStatus:  r.httpStatus,
        axiosError:  r.axiosError || undefined,
        bodyPreview: r.bodyPreview || null,
      });
    };
    for (const r of allResults) {
      if (out.length >= max) break;
      if (r.axiosError || (r.httpStatus != null && r.httpStatus !== 200)) push(r);
    }
    for (const r of allResults) {
      if (out.length >= max) break;
      if (r.httpStatus === 200 && r.bodyPreview) push(r);
    }
    return out;
  }
}

module.exports = { SeatCoordinator };
