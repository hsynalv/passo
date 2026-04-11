'use strict';

const EventEmitter = require('events');
const logger = require('../utils/logger');

/**
 * SeatCoordinator
 *
 * Snipe modunun merkezi koordinatörü.
 * - Tek bir shared watcher, tüm hedef blokları 800ms'de bir poll eder.
 * - Boşa düşen koltuklar için idle hesap havuzundan exclusive atama yapar.
 * - Açılış burst: ilk poll'da N seat müsait → N hesabı paralel dispatch.
 * - Her seat exclusive: aynı seatId iki hesaba verilmez.
 *
 * Kullanım:
 *   const coord = new SeatCoordinator({ eventId, serieId, blockMap, filter, intervalMs });
 *   coord.addAccount(accountCtx);
 *   coord.on('seat_found', async ({ seatId, blockId, categoryId, assignedCtx, markDone }) => {
 *     // ... hesap işini yapsın ...
 *     markDone(); // idle'a geri döndür
 *   });
 *   await coord.start();
 *   // ...
 *   coord.stop();
 */
class SeatCoordinator extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}   opts.eventId
   * @param {string}   [opts.serieId='']
   * @param {Map<number,{categoryId,categoryName,blockName}>} opts.blockMap  - fetchBlockMap çıktısı
   * @param {object}   [opts.filter]
   * @param {number}   [opts.filter.adjacentCount=1]
   * @param {number|null} [opts.filter.maxPrice]
   * @param {string[]|null} [opts.filter.rows]
   * @param {number}   [opts.intervalMs=800]
   * @param {number}   [opts.timeoutMs=1800000]  - 30 dakika default
   */
  constructor({ eventId, serieId = '', blockMap, filter = {}, intervalMs = 800, timeoutMs = 1_800_000 }) {
    super();
    this.eventId    = eventId;
    this.serieId    = serieId;
    this.blockMap   = blockMap || new Map();
    this.filter     = { adjacentCount: 1, maxPrice: null, rows: null, ...filter };
    this.intervalMs = intervalMs;
    this.timeoutMs  = timeoutMs;

    this._idlePool   = [];   // accountCtx[]
    this._busyPool   = new Set();
    this._assignedSeats = new Set(); // seatId'ler — exclusive atama için
    this._abortCtrl  = null;
    this._running    = false;
    this._timer      = null;
    this._elapsed    = 0;
    this._monitorPage = null;
    this._tickRunning = false; // eşzamanlı tick guard
  }

  /** Hesabı idle havuzuna ekle */
  addAccount(accountCtx) {
    this._idlePool.push(accountCtx);
  }

  /** Tüm hesaplar (idle + busy) */
  get allAccounts() {
    return [...this._idlePool, ...this._busyPool];
  }

  /** İdledeki hesap sayısı */
  get idleCount() { return this._idlePool.length; }

  /** Çalışıyor mu */
  get running() { return this._running; }

  /**
   * Watcher'ı başlat.
   * blockMap boşsa hata vermez, uyarı loglar.
   */
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
    });

    this._timer = setInterval(() => this._tick(blockIds), this.intervalMs);
    // İlk tick'i hemen çalıştır
    this._tick(blockIds);
  }

  /** Watcher'ı durdur */
  stop() {
    if (!this._running) return;
    this._running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._abortCtrl) { this._abortCtrl.abort(); this._abortCtrl = null; }
    logger.info('SeatCoordinator:stopped', { eventId: this.eventId });
    this.emit('stopped');
  }

  /**
   * Hesabı işi bittikten sonra idle'a geri al.
   * Bu metod markDone(failed) olarak dispatch callback'ine geçilir.
   * failed=true ise seatId exclusive kilidini kaldır (tekrar denenebilir).
   */
  _returnToIdle(accountCtx, seatId, failed = false) {
    this._busyPool.delete(accountCtx);
    this._idlePool.push(accountCtx);
    if (failed && seatId != null) {
      this._assignedSeats.delete(seatId);
      logger.info('SeatCoordinator:seat_released_for_retry', { seatId });
    }
    logger.info('SeatCoordinator:account_returned_idle', { email: accountCtx.email });
    this.emit('account_done', { accountCtx });
  }

  /** Tek bir poll tick'i */
  async _tick(blockIds) {
    if (!this._running) return;
    // Önceki tick henüz bitmemişse atla (page.evaluate > intervalMs durumu)
    if (this._tickRunning) return;

    this._elapsed += this.intervalMs;
    if (this._elapsed > this.timeoutMs) {
      logger.warn('SeatCoordinator:timeout', { eventId: this.eventId });
      // stop() çağırmak 'stopped' eventi de atar; timeout'ta sadece 'timeout' atılsın
      this._running = false;
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      if (this._abortCtrl) { this._abortCtrl.abort(); this._abortCtrl = null; }
      logger.info('SeatCoordinator:stopped', { eventId: this.eventId, reason: 'timeout' });
      this.emit('timeout');
      return;
    }

    this._tickRunning = true;
    try {
      // Aktif bir monitor page seç (idle pool'un başındaki hesabın page'i)
      const monitorCtx = this._idlePool[0] || null;
      if (!monitorCtx || !monitorCtx.page) return; // tüm hesaplar busy

      const BASE = 'https://ticketingweb.passo.com.tr/api/passoweb';
      const evId = this.eventId;
      const seId = this.serieId;

      const results = await monitorCtx.page.evaluate(async (blocks, base, evId, seId) => {
        return Promise.all(blocks.map(async (blockId) => {
          try {
            const url = `${base}/getseatstatus?eventId=${evId}&serieId=${seId}&blockId=${blockId}`;
            const r = await fetch(url, { credentials: 'include' });
            if (!r.ok) return { blockId, seats: null };
            const j = await r.json();
            return { blockId, seats: j.valueList || j.value || null };
          } catch {
            return { blockId, seats: null };
          }
        }));
      }, blockIds, BASE, evId, seId);

      // Müsait koltukları topla
      const availableSeats = [];
      for (const { blockId, seats } of results) {
        if (!Array.isArray(seats)) continue;
        for (const seat of seats) {
          if (seat.isSold || seat.isReserved) continue;
          const seatId = Number(seat.id);
          if (this._assignedSeats.has(seatId)) continue; // zaten atandı
          if (!this._matchesFilter(seat, blockId)) continue;
          availableSeats.push({ seatId, blockId });
        }
      }

      if (availableSeats.length === 0) return;

      // Burst: N koltuk müsait → N hesabı paralel dispatch
      for (const { seatId, blockId } of availableSeats) {
        if (this._idlePool.length === 0) break; // idle hesap kalmadı

        const accountCtx = this._idlePool.shift();
        this._busyPool.add(accountCtx);
        this._assignedSeats.add(seatId); // exclusive kilitle

        const blockInfo = this.blockMap.get(blockId) || {};
        logger.info('SeatCoordinator:seat_dispatched', {
          seatId, blockId,
          categoryId: blockInfo.categoryId,
          email: accountCtx.email,
        });

        const markDone = (failed = false) => this._returnToIdle(accountCtx, seatId, failed);

        this.emit('seat_found', {
          seatId,
          blockId,
          categoryId: blockInfo.categoryId,
          categoryName: blockInfo.categoryName,
          blockName: blockInfo.blockName,
          assignedCtx: accountCtx,
          markDone,
        });
      }

    } catch (e) {
      logger.warn('SeatCoordinator:tick_error', { error: e?.message });
    } finally {
      this._tickRunning = false;
    }
  }

  /** Filtre kontrolü */
  _matchesFilter(seat, blockId) {
    const { maxPrice, rows } = this.filter;
    if (maxPrice != null && seat.price != null && Number(seat.price) > maxPrice) return false;
    if (rows && rows.length && seat.rowName && !rows.includes(seat.rowName)) return false;
    return true;
  }
}

module.exports = { SeatCoordinator };
