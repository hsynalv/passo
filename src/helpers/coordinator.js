'use strict';

const EventEmitter = require('events');
const axios        = require('axios');
const logger       = require('../utils/logger');

// HTTPS keep-alive ile bağlantı havuzu — her poll için yeni bağlantı açılmaz.
const { Agent: HttpsAgent } = require('https');
const _httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 64 });

/**
 * SeatCoordinator
 *
 * Proaktif koltuk tarama motoru.
 *
 * Tasarım ilkeleri:
 *  1. Multi-page polling   — Tüm idle hesapların sayfaları blokları paylaşır.
 *     83 blok / 5 idle hesap → her hesap ~17 bloğu poll eder, hepsi paralel.
 *     Bir hesap busy olduğunda kalan idle hesaplar onun bloklarını da kapsar.
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
   * @param {number}   [opts.intervalMs=800]
   * @param {number}   [opts.timeoutMs=1800000]  30 dakika default
   */
  constructor({ eventId, serieId = '', blockMap, filter = {}, intervalMs = 800, timeoutMs = 1_800_000 }) {
    super();
    this.eventId    = eventId;
    this.serieId    = serieId;
    this.blockMap   = blockMap || new Map();
    this.filter     = { adjacentCount: 1, maxPrice: null, rows: null, ...filter };
    this.intervalMs = intervalMs;
    this.timeoutMs  = timeoutMs;

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
    logger.info('SeatCoordinator:started', {
      eventId: this.eventId,
      blockCount: blockIds.length,
      accountCount: this._idlePool.length,
      intervalMs: this.intervalMs,
      timeoutMs: this.timeoutMs,
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

  /**
   * Her tick'te:
   *  1. Idle hesapları blok gruplarına böl, her grup bir hesabın page'inde paralel poll eder.
   *  2. Tüm gruplar eşzamanlı olarak çalışır (Promise.allSettled).
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

      const BASE  = 'https://ticketingweb.passo.com.tr/api/passoweb';
      const evId  = this.eventId;
      const seId  = this.serieId;

      // ── Cookie yenileme (her 60 tick'te bir veya henüz yoksa) ────────────────
      const shouldRefreshCookies = tick % 60 === 1; // ilk tick + her ~36 saniye

      const chunkResults = await Promise.allSettled(
        idleAccounts.map(async (ctx, i) => {
          const chunk = chunks[i] || [];
          if (!chunk.length) return [];

          // Cookie extract: yoksa veya periyodik yenileme zamanıysa page'den al.
          // page.evaluate yerine cookies() kullanıyoruz — frame detach sorunu yok.
          if ((!ctx.cookieString || shouldRefreshCookies) && ctx.page) {
            try {
              const cookieArr  = await ctx.page.cookies();
              ctx.cookieString = cookieArr.map(c => `${c.name}=${c.value}`).join('; ');
            } catch (e) {
              logger.warn('SeatCoordinator:cookie_refresh_failed', { email: ctx.email, error: e?.message });
            }
          }

          if (!ctx.cookieString) return [];

          try {
            // Node.js axios ile doğrudan HTTP — browser frame'e hiç dokunmaz.
            return await Promise.all(chunk.map(async (blockId) => {
              try {
                const url = `${BASE}/getseatstatus?eventId=${evId}&serieId=${seId}&blockId=${blockId}`;
                const res = await axios.get(url, {
                  httpsAgent:    _httpsAgent,
                  timeout:       8000,
                  validateStatus: () => true,
                  headers: {
                    'Cookie':          ctx.cookieString,
                    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept':          'application/json, text/plain, */*',
                    'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
                    'Referer':         'https://www.passo.com.tr/',
                    'Origin':          'https://www.passo.com.tr',
                  },
                });
                const httpStatus = res.status;
                if (httpStatus !== 200) {
                  return { blockId, seats: null, httpStatus, axiosError: null };
                }
                const data  = res.data;
                const seats = data?.valueList || data?.value || null;
                return { blockId, seats, httpStatus };
              } catch (e) {
                return {
                  blockId,
                  seats:      null,
                  httpStatus: null,
                  axiosError: e?.code || e?.message || 'request_failed',
                };
              }
            }));
          } catch (e) {
            logger.warn('SeatCoordinator:chunk_poll_failed', { email: ctx.email, error: e?.message });
            return [];
          }
        })
      );

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
      this.emit('tick_stats', {
        tick,
        tickMs: Date.now() - tickT0,
        eventId: this.eventId,
        blocksExpected: blockIds.length,
        incompletePoll: allResults.length !== blockIds.length,
        idleAccounts:     this._idlePool.length,
        busyAccounts:     this._busyPool.size,
        availableAfterFilter: available.length,
        ...httpSum,
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

  _matchesFilter(seat, blockId) {
    const { maxPrice, rows } = this.filter;
    if (maxPrice != null && seat.price != null && Number(seat.price) > maxPrice) return false;
    if (rows && rows.length && seat.rowName && !rows.includes(seat.rowName)) return false;
    return true;
  }

  /** HTTP özetini tek tur için üret (axios satırlarından). */
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
}

module.exports = { SeatCoordinator };
