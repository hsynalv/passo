const delay = require('../utils/delay');
const cfg = require('../config');
const { formatError } = require('../utils/messages');
const { openSeatMapStrict, readBasketData, clickContinueInsidePage, ensureUrlContains, SEAT_NODE_SELECTOR } = require('./page');
const logger = require('../utils/logger');
const { confirmSwalYes } = require('./swal');

const SELECTED_SEAT_SELECTOR = (
  'circle.seat-circle.selected,' +
  'circle.seat-circle[aria-pressed="true"],' +
  '[data-selected="true"],' +
  'svg.seatmap-svg g.seatActive rect,' +
  'svg.seatmap-svg g.selected rect,' +
  'svg.seatmap-svg rect.selected'
);

function parseBasketFromApiJson(j, currentUrl) {
  try {
    if (!j || j.isError !== false) return null;
    const v = j.value || null;

    const products = (v && Array.isArray(v.basketBookingProducts)) ? v.basketBookingProducts : null;
    const p0 = products && products.length ? products[0] : null;

    const basket = v && v.basket ? v.basket : null;
    const basketId = basket?.basketId || '';
    const remainingTime = basket?.remainingTime || v?.basketRemaningTime || null;
    const hasBasketFlag = basket?.isBasket === true;

    const row = p0?.refSeatInfo_RowName ? String(p0.refSeatInfo_RowName) : '';
    const seat = p0?.refSeatInfo_SeatName ? String(p0.refSeatInfo_SeatName) : '';
    const tribune = p0?.tribune_Name ? String(p0.tribune_Name) : '';
    const block = p0?.block_Name ? String(p0.block_Name) : '';

    const seatIdFromNet = v?.id || p0?.refSeatInfoID || '';
    const blockIdFromNet = v?.refBlockID || p0?.refBlockID || '';

    if (!hasBasketFlag && !(products && products.length)) return null;

    return {
      tribune,
      block,
      row,
      seat,
      blockId: blockIdFromNet ? String(blockIdFromNet) : '',
      seatId: seatIdFromNet ? String(seatIdFromNet) : '',
      combined: `${tribune} ${block} ${row} ${seat}`.trim(),
      inBasket: true,
      url: currentUrl || '',
      basketId: basketId ? String(basketId) : '',
      remainingTime
    };
  } catch {
    return null;
  }
}

function startBasketNetworkWatcher(page, context) {
  let last = null;
  let lastAt = 0;
  const waiters = new Set();

  const done = (data) => {
    for (const w of Array.from(waiters)) {
      try { w.resolve(data); } catch {}
      waiters.delete(w);
    }
  };

  const onResp = async (resp) => {
    try {
      const u = resp.url();
      if (!/(addseattobasket|getuserbasketbookingblockview|getuserbasketbooking)/i.test(u)) return;
      const status = resp.status();
      if (status < 200 || status >= 400) return;
      const h = resp.headers ? resp.headers() : {};
      const ct = (h?.['content-type'] || h?.['Content-Type'] || '').toLowerCase();
      if (!ct.includes('application/json')) return;
      const j = await resp.json().catch(() => null);
      const curUrl = (() => { try { return page.url(); } catch { return ''; } })();
      const data = parseBasketFromApiJson(j, curUrl);
      if (!data) return;
      last = data;
      lastAt = Date.now();
      logger.info(`seatPick:${context}:basket_network_seen`, { apiUrl: u, basketId: data.basketId || '', seatId: data.seatId || '', row: data.row || '', seat: data.seat || '' });
      done(data);
    } catch {}
  };

  try { page.on('response', onResp); } catch {}

  return {
    getLatest: () => ({ data: last, at: lastAt }),
    wait: (ms) => new Promise((resolve) => {
      const w = { resolve };
      waiters.add(w);
      setTimeout(() => {
        if (waiters.has(w)) {
          waiters.delete(w);
          resolve(null);
        }
      }, Math.max(0, Number(ms) || 0));
    }),
    dispose: () => { try { page.removeListener('response', onResp); } catch {} }
  };
}

function isPassoHomeUrl(u) {
  if (!u) return false;
  try {
    const x = new URL(String(u));
    const p = (x.pathname || '').replace(/\/+$/, '') || '/';
    const isPasso = /(^|\.)passo\.com\.tr$/i.test(x.hostname);
    if (!isPasso) return false;
    return p === '/' || p === '/tr' || p === '/tr/anasayfa' || p === '/anasayfa';
  } catch {
    return false;
  }
}

async function clickSeatById(page, seatId) {
  if (!page || !seatId) return false;
  try {
    const ok = await page.evaluate((sid) => {
      const g = document.querySelector(`svg.seatmap-svg g#seat${sid}`);
      const r = g ? (g.querySelector('rect') || g.querySelector('circle') || g) : null;
      if (!r) return false;
      try { r.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
      const bb = r.getBoundingClientRect();
      const cx = bb.left + (bb.width / 2);
      const cy = bb.top + (bb.height / 2);
      const el = document.elementFromPoint(cx, cy) || r;
      const fire = (type) => {
        try {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }));
        } catch {}
      };
      ['pointerover', 'pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click'].forEach(fire);
      return true;
    }, String(seatId));
    return !!ok;
  } catch {
    return false;
  }
}

function isBasketLikeUrl(u) {
  if (!u) return false;
  try {
    const x = new URL(String(u));
    return /\/(sepet|basket|cart|odeme|payment)(\b|\/|\?|#)/i.test(x.pathname || '') || /\/(sepet|basket|cart|odeme|payment)(\b|\/|\?|#)/i.test(x.href || '');
  } catch {
    return /\/(sepet|basket|cart|odeme|payment)(\b|\/|\?|#)/i.test(String(u));
  }
}

async function recoverIfRedirected(page, context, label, expectedUrlIncludes, recoveryUrl, email, password, reloginIfRedirected, ensureTurnstileFn) {
  if (!page || !recoveryUrl) return false;
  const curUrl = (() => { try { return page.url(); } catch { return ''; } })();
  // If we already reached basket/cart/payment, do NOT try to recover back to seat page.
  // This is a success path, and recovery would cause us to undo progress.
  if (isBasketLikeUrl(curUrl)) return false;
  const isLogin = /\/giris(\?|$)/i.test(curUrl);
  const isHome = isPassoHomeUrl(curUrl);
  const urlDrift = expectedUrlIncludes ? (!curUrl || !curUrl.includes(String(expectedUrlIncludes))) : false;

  if (!isLogin && !isHome && !urlDrift) return false;
  logger.warn(`seatPick:${context}:redirect_detected`, { label, url: curUrl, isLogin, isHome, urlDrift, recoveryUrl });

  if (isLogin && reloginIfRedirected && email && password) {
    try {
      await reloginIfRedirected(page, email, password);
    } catch (e) {
      logger.warn(`seatPick:${context}:relogin_failed`, { label, error: e?.message || String(e) });
    }
  }

  try {
    await page.goto(String(recoveryUrl), { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch {}

  if (ensureTurnstileFn && email) {
    try {
      await ensureTurnstileFn(page, email, `seatPick:${context}:${label}`);
    } catch {}
  }

  try { await openSeatMapStrict(page); } catch {}
  return true;
}

async function mouseClickAt(page, x, y) {
  try {
    if (!page || !page.mouse) return false;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.up();
    return true;
  } catch {
    return false;
  }
}

async function robustSeatClick(page, x, y) {
  if (!page) return false;
  const points = [
    { dx: 0, dy: 0 },
    { dx: 1, dy: 1 },
    { dx: -1, dy: -1 },
    { dx: 2, dy: 0 },
    { dx: 0, dy: 2 }
  ];

  for (const p of points) {
    const ok = await mouseClickAt(page, x + p.dx, y + p.dy);
    if (ok) return true;
  }

  try {
    const ok2 = await page.evaluate((cx, cy) => {
      const el = document.elementFromPoint(cx, cy);
      if (!el) return false;
      const fire = (type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
      fire('mousemove');
      fire('mouseover');
      fire('mouseenter');
      fire('mousedown');
      fire('mouseup');
      fire('click');
      return true;
    }, x, y);
    return !!ok2;
  } catch {
    return false;
  }
}

async function ensureSingleProductQuantity(page, context) {
  if (!page) return { attempted: false, changed: false };
  try {
    const res = await page.evaluate(() => {
      const setSelectToOne = () => {
        const selects = Array.from(document.querySelectorAll('select'));
        for (const s of selects) {
          const opts = Array.from(s.options || []);
          const one = opts.find(o => String(o.value).trim() === '1' || (o.textContent || '').trim() === '1');
          if (one) {
            const prev = s.value;
            s.value = one.value;
            s.dispatchEvent(new Event('change', { bubbles: true }));
            s.dispatchEvent(new Event('input', { bubbles: true }));
            return { kind: 'select', changed: prev !== s.value, name: s.name || s.id || null };
          }
        }
        return null;
      };

      const setNumberInputToOne = () => {
        const inputs = Array.from(document.querySelectorAll('input[type="number"], input[name*="adet"], input[name*="qty"], input[id*="adet"], input[id*="qty"]'));
        for (const i of inputs) {
          const prev = i.value;
          i.value = '1';
          i.dispatchEvent(new Event('input', { bubbles: true }));
          i.dispatchEvent(new Event('change', { bubbles: true }));
          return { kind: 'input', changed: prev !== i.value, name: i.name || i.id || null };
        }
        return null;
      };

      const r1 = setSelectToOne();
      if (r1) return { attempted: true, ...r1 };
      const r2 = setNumberInputToOne();
      if (r2) return { attempted: true, ...r2 };
      return { attempted: true, changed: false, kind: 'none' };
    });

    logger.info(`seatPick:${context}:qty_one`, res);
    return res;
  } catch (e) {
    logger.warn(`seatPick:${context}:qty_one_failed`, { error: e?.message || String(e) });
    return { attempted: true, changed: false, error: e?.message || String(e) };
  }
}

/** A: random seat seç + sepet doğrulaması (re-click yok) */
async function pickRandomSeatWithVerify(page, maxMs = null, options = null){
  maxMs = maxMs || cfg.TIMEOUTS.SEAT_PICK_MAX;
  const startTs = Date.now();
  const initialEnd = startTs + maxMs;
  let end = initialEnd;
  options = options && typeof options === 'object' ? options : {};
  const expectedUrlIncludes = options.expectedUrlIncludes || null;
  const recoveryUrl = options.recoveryUrl || null;
  const context = options.context || 'A';
  const email = options.email || null;
  const ensureTurnstileFn = options.ensureTurnstileTokenOnPage || options.ensureTurnstileFn || null;
  const reloginIfRedirected = typeof options.reloginIfRedirected === 'function' ? options.reloginIfRedirected : null;
  const password = options.password || null;

  const extendDeadline = (ms, reason) => {
    try {
      const add = Number(ms) || 0;
      if (add <= 0) return;
      // Prevent unbounded extension (e.g. repeated captcha loops). Cap to +3 minutes total.
      const cap = 3 * 60 * 1000;
      const maxEnd = initialEnd + cap;
      end = Math.min(maxEnd, end + add);
      logger.info(`seatPick:${context}:deadline_extended`, { reason: reason || 'unknown', addMs: add, newRemainingMs: end - Date.now() });
    } catch {}
  };

  let needsMoreCount = 0;

  const basketWatcher = startBasketNetworkWatcher(page, context);

  try {

  let lastDiagAt = 0;

  const diag = async (label) => {
    const now = Date.now();
    if (now - lastDiagAt < 4000) return;
    lastDiagAt = now;
    try {
      const snap = await page.evaluate((lbl, sel) => {
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const allRects = Array.from(document.querySelectorAll('svg.seatmap-svg g[id^="seat"] rect'));
        const selectableRects = allRects.filter(r => {
          const pe = (r.getAttribute('pointer-events') || '').toLowerCase();
          if (pe === 'none') return false;
          const fill = (r.getAttribute('fill') || '').toLowerCase();
          if (fill === '#89a0a3') return false;
          return fill === '#00a5ff' || (r.getAttribute('stroke') || '').toLowerCase() === '#00a5ff';
        });
        const hasActiveSelection = !!document.querySelector('svg.seatmap-svg g.seatActive rect');
        return {
          label: lbl,
          title: document.title,
          url: location.href,
          hasVerifyHuman: bodyText.includes('verify you are human'),
          hasTurnstileWidget: !!document.querySelector('.cf-turnstile'),
          hasTurnstileTokenField: !!document.querySelector('input[name="cf-turnstile-response"]'),
          seatCount: document.querySelectorAll(sel).length,
          selectableCount: selectableRects.length,
          hasActiveSelection,
          hasSeatButton: !!document.getElementById('custom_seat_button')
        };
      }, label, SEAT_NODE_SELECTOR);
      logger.info(`seatPick:${context}:diag`, snap);
    } catch (e) {
      logger.warn(`seatPick:${context}:diag_failed`, { label, error: e?.message || String(e) });
    }
  };

  const ensureOnSeatPage = async (label) => {
    try {
      if (!expectedUrlIncludes) return;

      await recoverIfRedirected(
        page,
        context,
        label,
        expectedUrlIncludes,
        recoveryUrl,
        email,
        password,
        reloginIfRedirected,
        ensureTurnstileFn
      );

      const check = await ensureUrlContains(page, expectedUrlIncludes, {
        label: `seatPick:${context}:${label}`,
        recoveryUrl,
        retries: 2,
        waitMs: 8000,
        waitUntil: 'domcontentloaded',
        backoffMs: 350
      });
      if (!check.ok) {
        logger.warn(`seatPick:${context}:url_drift`, {
          label,
          url: check.url,
          expectedUrlIncludes: check.expected,
          recoveryUrl,
          attempts: check.attempts
        });
      }
    } catch {}
  };

  await ensureOnSeatPage('start');
  const seatMapOk = await openSeatMapStrict(page);
  if (!seatMapOk) logger.warn(`seatPick:${context}:seatmap_not_ready`);
  await diag('afterOpenSeatMapStrict');
  await page.evaluate(()=>{ window.__passobot = {clicked:false, done:false}; });

  let lockedSeat = null;
  let lockedMiss = 0;
  let lastContinueAttemptAt = 0;
  let lastContinueClickedAt = 0;
  let postContinueVerifyUntil = 0;
  let postContinueRetryCount = 0;
  let noSeatStreak = 0;
  let lastRecoverAt = 0;

  const POST_CONTINUE_VERIFY_MS = 45000;
  const POST_CONTINUE_STUCK_MS = 45000;
  const POST_CONTINUE_TRANSITION_GRACE_MS = 60000;

  const tryPickAdditionalSeat = async () => {
    try {
      const info = await page.evaluate(() => {
        const selectedNow = Array.from(document.querySelectorAll(
          'circle.seat-circle.selected, circle.seat-circle[aria-pressed="true"], [data-selected="true"], svg.seatmap-svg g.seatActive rect, svg.seatmap-svg g.selected rect, svg.seatmap-svg rect.selected'
        ));

        const rects = Array.from(document.querySelectorAll('svg.seatmap-svg g[id^="seat"] rect'));
        const candidates = rects.filter(r => {
          const pe = (r.getAttribute('pointer-events') || '').toLowerCase();
          if (pe === 'none') return false;
          const cls = (r.getAttribute('class') || '').toLowerCase();
          const fill = (r.getAttribute('fill') || '').toLowerCase();
          const opacity = (r.getAttribute('opacity') || '').toLowerCase();
          const style = (r.getAttribute('style') || '').toLowerCase();
          if (opacity === '0' || /opacity\s*:\s*0/.test(style)) return false;
          if (/(occupied|disabled|unavailable|dolu|sold|reserved)/i.test(cls) || fill === '#89a0a3') return false;
          // prefer selectable color
          const isSelectable = fill === '#00a5ff' || (r.getAttribute('stroke') || '').toLowerCase() === '#00a5ff';
          if (!isSelectable) return false;
          // avoid already selected/active rects
          const g = r.closest('g');
          if (g && (g.classList.contains('seatActive') || g.classList.contains('selected'))) return false;
          if (r.classList.contains('selected')) return false;
          return true;
        });

        if (!candidates.length) return null;
        const r0 = candidates[Math.floor(Math.random() * candidates.length)];
        r0.scrollIntoView({ block: 'center', inline: 'center' });
        const bb = r0.getBoundingClientRect();
        const cx = bb.left + (bb.width / 2);
        const cy = bb.top + (bb.height / 2);
        if (cy <= 10 || cx <= 10 || cy >= window.innerHeight - 10 || cx >= window.innerWidth - 10) return null;
        return { x: cx, y: cy, w: bb.width, h: bb.height, selectedCount: selectedNow.length };
      });

      if (!info) return false;
      const clicked = await robustSeatClick(page, info.x, info.y);
      if (!clicked) return false;
      logger.info(`seatPick:${context}:additional_seat_click`, { selectedCountBefore: info.selectedCount, x: info.x, y: info.y });
      await delay(250);
      return true;
    } catch {
      return false;
    }
  };

  const isLockedSeatSelected = async () => {
    if (!lockedSeat) return false;
    try {
      const ok = await page.evaluate((seat) => {
        if (!seat) return false;
        const seatId = seat.seatId;
        if (seatId) {
          const g = document.querySelector(`svg.seatmap-svg g#seat${seatId}`);
          const r = g ? g.querySelector('rect') : null;
          if (g && (g.classList.contains('seatActive') || /\bseatActive\b/i.test(g.getAttribute('class') || ''))) return true;
          if (g && (g.classList.contains('selected') || /selected/i.test(g.getAttribute('class') || ''))) return true;
          if (r && (r.classList.contains('selected') || /selected/i.test(r.getAttribute('class') || ''))) return true;
          // Prefer explicit selected indicators only. Attribute changes can happen due to hover/zoom and must not be treated as a selection.
          if (g && g.getAttribute('aria-pressed') === 'true') return true;
          if (r && r.getAttribute('aria-pressed') === 'true') return true;
          const fill = (r?.getAttribute('fill') || '').toLowerCase();
          if (fill === '#a9cc14') return true;
        }
        return false;
      }, lockedSeat);
      return !!ok;
    } catch {
      return false;
    }
  };

  const getSelectionState = async () => {
    try {
      const st = await page.evaluate((sel, seat) => {
        const selectedCount = document.querySelectorAll(sel).length;
        const seatId = seat?.seatId || null;
        let locked = null;
        if (seatId) {
          const g = document.querySelector(`svg.seatmap-svg g#seat${seatId}`);
          const r = g ? g.querySelector('rect') : null;
          locked = {
            hasG: !!g,
            hasRect: !!r,
            gClass: (g?.getAttribute('class') || ''),
            rectClass: (r?.getAttribute('class') || ''),
            rectFill: (r?.getAttribute('fill') || ''),
            rectStroke: (r?.getAttribute('stroke') || ''),
            ariaPressedG: g?.getAttribute('aria-pressed') || '',
            ariaPressedR: r?.getAttribute('aria-pressed') || ''
          };
        }
        return { selectedCount, locked };
      }, SELECTED_SEAT_SELECTOR, lockedSeat);
      return st;
    } catch {
      return null;
    }
  };

  while (Date.now() < end) {
      const nw = basketWatcher.getLatest();
      if (nw && nw.data) return nw.data;
      await ensureOnSeatPage('loop');
      await diag('loop');

      // bazen seatmap DOM'dan kaybolabiliyor (seatCount 0, button yok). bu durumda recover dene.
      const seatState = await page.evaluate((sel) => {
        return {
          seatCount: document.querySelectorAll(sel).length,
          hasSeatButton: !!document.getElementById('custom_seat_button')
        };
      }, SEAT_NODE_SELECTOR).catch(() => null);
      if (seatState && seatState.seatCount <= 0) {
        noSeatStreak++;
      } else {
        noSeatStreak = 0;
      }

      // After clicking Continue, seatmap might unmount. During this time, do not try to re-click
      // Continue or run recover loops; instead wait for basket/route to settle.
      if (postContinueVerifyUntil && Date.now() < postContinueVerifyUntil) {
        const b = await readBasketData(page);
        if (b && (b.row && b.seat)) return b;
        if (b && b.inBasket && isBasketLikeUrl(b.url)) return b;
        await delay(400);
        continue;
      }

      // If we clicked Continue but never reached basket, attempt a limited recovery:
      // ensure turnstile token again + click Continue again (cooldown protected).
      if (lastContinueClickedAt && (Date.now() - lastContinueClickedAt) > POST_CONTINUE_STUCK_MS && postContinueRetryCount < 2) {
        const curUrl = (() => { try { return page.url(); } catch { return ''; } })();
        const stillOnSeat = expectedUrlIncludes ? (curUrl && curUrl.includes(String(expectedUrlIncludes))) : false;
        const b1 = await readBasketData(page);
        if (stillOnSeat && !b1) {
          postContinueRetryCount++;
          logger.warn(`seatPick:${context}:post_continue_stuck`, { retry: postContinueRetryCount, url: curUrl });

          if (ensureTurnstileFn && email) {
            try {
              await ensureTurnstileFn(page, email, `seatPick:${context}:postContinueRetry${postContinueRetryCount}`);
            } catch {}
          }
          const r = await clickContinueInsidePage(page);
          logger.info(`seatPick:${context}:post_continue_retry_click`, { clicked: !!r, btnInfo: r?.btnInfo || null });
          if (r) {
            lastContinueClickedAt = Date.now();
            postContinueVerifyUntil = Date.now() + POST_CONTINUE_VERIFY_MS;
          }
        }
      }

      // "Devam" tıklandıktan hemen sonra seatmap geçici kaybolabiliyor (SPA/transition).
      // Bu durumda recover tetiklemek yerine basket/route güncellenmesini bekle.
      if (noSeatStreak >= 3 && lastContinueClickedAt && (Date.now() - lastContinueClickedAt) < POST_CONTINUE_TRANSITION_GRACE_MS) {
        logger.info(`seatPick:${context}:seatmap_transition_wait`, { noSeatStreak, seatState });
        await delay(500);
        continue;
      }

      if (noSeatStreak >= 3) {
        // If we recently clicked Continue, prefer waiting over recovery; recover attempts can break SPA transitions.
        if (lastContinueClickedAt && (Date.now() - lastContinueClickedAt) < POST_CONTINUE_TRANSITION_GRACE_MS) {
          await delay(500);
          continue;
        }
        const now = Date.now();
        if (now - lastRecoverAt > 4000) {
          lastRecoverAt = now;
          logger.warn(`seatPick:${context}:seatmap_lost_recover`, { noSeatStreak, seatState });
          lockedSeat = null;
          lockedMiss = 0;
          await ensureOnSeatPage('seatmap_recover');
          const ok = await openSeatMapStrict(page);
          if (!ok) logger.warn(`seatPick:${context}:seatmap_recover_failed`);
          await delay(500);
        }
      }

      // zaten sepette mi? (seat selection sayfasındaki yanlış pozitifleri engelle)
      const b0 = await readBasketData(page);
      if (b0 && (b0.row && b0.seat)) return b0;
      if (b0 && b0.inBasket && isBasketLikeUrl(b0.url)) return b0;

      // seçili koltuk varsa tekrar TIKLAMA YOK
      const hasSelected = await page.evaluate((sel) => !!document.querySelector(sel), SELECTED_SEAT_SELECTOR);
      if (!hasSelected) {
          const clickInfo = lockedSeat || await page.evaluate((sel) => {
              const bySeatRect = () => {
                  const rects = Array.from(document.querySelectorAll('svg.seatmap-svg g[id^="seat"] rect'));
                  const clickable = rects.filter(r => {
                      const pe = (r.getAttribute('pointer-events') || '').toLowerCase();
                      if (pe === 'none') return false;
                      const cls = (r.getAttribute('class') || '').toLowerCase();
                      const fill = (r.getAttribute('fill') || '').toLowerCase();
                      const stroke = (r.getAttribute('stroke') || '').toLowerCase();
                      const style = (r.getAttribute('style') || '').toLowerCase();
                      const cursor = (r.style && r.style.cursor ? String(r.style.cursor) : '').toLowerCase();
                      const opacity = (r.getAttribute('opacity') || '').toLowerCase();
                      const computedCursor = (() => {
                        try { return (window.getComputedStyle(r).cursor || '').toLowerCase(); } catch { return ''; }
                      })();
                      const isHidden = opacity === '0' || /opacity\s*:\s*0/.test(style);
                      if (isHidden) return false;
                      const cur = cursor || computedCursor;
                      if (cur && /(not-allowed|default)/i.test(cur)) {
                        // allow default, but some maps mark unselectable as not-allowed
                        if (/not-allowed/i.test(cur)) return false;
                      }
                      const isDisabled = /(occupied|disabled|unavailable|dolu|sold|reserved)/i.test(cls) || fill === '#89a0a3';
                      if (isDisabled) return false;

                      // Observed in Passo seatmap: selectable seats are typically #00a5ff, selected becomes #A9CC14 with stroke #00a5ff.
                      // Keep this as a preference filter to avoid selecting non-seat blocks.
                      const isPreferredSelectable = fill === '#00a5ff' || stroke === '#00a5ff' || /\bblock\d+\b/.test(cls);
                      return isPreferredSelectable;
                  });
                  if (!clickable.length) return null;
                  const r0 = clickable[Math.floor(Math.random() * clickable.length)];
                  const gid = r0.closest('g')?.getAttribute('id') || '';
                  const seatId = (gid.match(/seat(\d+)/i) || [])[1] || null;
                  const sig = {
                      cls: (r0.getAttribute('class') || ''),
                      fill: (r0.getAttribute('fill') || ''),
                      stroke: (r0.getAttribute('stroke') || ''),
                    op: (r0.getAttribute('opacity') || ''),
                    pe: (r0.getAttribute('pointer-events') || ''),
                    style: (r0.getAttribute('style') || '')
                  };
                  r0.scrollIntoView({ block: 'center', inline: 'center' });
                  const bb = r0.getBoundingClientRect();
                  const cx = bb.left + (bb.width / 2);
                  const cy = bb.top + (bb.height / 2);
                  // Skip if outside viewport
                  if (cy <= 10 || cx <= 10 || cy >= window.innerHeight - 10 || cx >= window.innerWidth - 10) return null;
                  return {
                      x: cx,
                      y: cy,
                      w: bb.width,
                      h: bb.height,
                      seatId,
                      sig
                  };
              };

              const primary = bySeatRect();
              if (primary) return primary;

              const pool = Array.from(document.querySelectorAll(sel))
                  .filter(el => {
                      const cls = (el.getAttribute('class') || '').toLowerCase();
                      const ariaDisabled = el.getAttribute('aria-disabled');
                      const isDisabled = ariaDisabled === 'true' || /(occupied|disabled|unavailable|dolu|sold|reserved)/i.test(cls);
                      return !isDisabled;
                  });
              if (!pool.length) return null;
              const s = pool[Math.floor(Math.random()*pool.length)];
              s.scrollIntoView({block:'center', inline:'center'});
              const bb = s.getBoundingClientRect();
              window.__passobot.clicked = true;
              return {
                x: Math.max(0, bb.left + (bb.width / 2)),
                y: Math.max(0, bb.top + (bb.height / 2)),
                w: bb.width,
                h: bb.height,
                seatId: null
              };
          }, SEAT_NODE_SELECTOR);
          if (!clickInfo || !Number.isFinite(clickInfo.x) || !Number.isFinite(clickInfo.y)) { await delay(200); continue; }

          if (!lockedSeat) {
            lockedSeat = clickInfo;
            logger.info(`seatPick:${context}:locked`, { seatId: clickInfo.seatId, x: clickInfo.x, y: clickInfo.y });
          }

          // Prefer deterministic click by seatId when available.
          let clicked = false;
          if (clickInfo.seatId) {
            clicked = await clickSeatById(page, clickInfo.seatId);
          }
          if (!clicked) {
            clicked = await robustSeatClick(page, clickInfo.x, clickInfo.y);
          }
          if (!clicked) {
            logger.warn(`seatPick:${context}:click_failed`, { seatId: lockedSeat?.seatId });
            await delay(200);
            continue;
          }

          // click sonrası seçimin DOM'a düşmesini kısa süre bekle
          for (let w = 0; w < 10; w++) {
              const selNow = await page.evaluate((sel) => !!document.querySelector(sel), SELECTED_SEAT_SELECTOR);
              if (selNow) break;
              await delay(80);
          }

          const picked = await page.evaluate((sel) => !!document.querySelector(sel), SELECTED_SEAT_SELECTOR);
          if (!picked) {
            const selDiag = await getSelectionState();
            // Seatmap DOM yokken seçimi doğrulamak mümkün değil; bu durumda lockedMiss şişirmeyelim.
            if (seatState && seatState.seatCount <= 0) {
              logger.info(`seatPick:${context}:not_selected_seatmap_missing_skip`, { seatId: lockedSeat?.seatId, seatState });
            } else {
              lockedMiss++;
              logger.warn(`seatPick:${context}:not_selected_after_click`, { seatId: lockedSeat?.seatId, lockedMiss, selDiag });
              if (lockedMiss >= 3) {
                logger.warn(`seatPick:${context}:lock_reset`, { seatId: lockedSeat?.seatId, reason: 'not_selected_after_3_clicks' });
                lockedSeat = null;
                lockedMiss = 0;
              }
            }
          } else {
            logger.info(`seatPick:${context}:selected`, { seatId: lockedSeat?.seatId });
            lockedMiss = 0;
          }
      }

      // Koltuk seçili değilse DEVAM'a basma (swal tetiklememek için)
      const selectedNow = await page.evaluate((sel) => !!document.querySelector(sel), SELECTED_SEAT_SELECTOR);
      const lockedSelected = await isLockedSeatSelected();
      if (!selectedNow && !lockedSelected) {
          await delay(140);
          continue;
      }

      if (selectedNow || lockedSelected) {
        const selState = await getSelectionState();
        logger.info(`seatPick:${context}:selection_before_continue`, { selectedNow, lockedSelected, selState });
      }

      // seçiliyse DEVAM - önce turnstile token kontrolü
      const now = Date.now();
      // "Devam" tuşunu çok hızlı spam'leme; çift tık geçişi bozuyor.
      const continueCooldownMs = 15000;
      if (lastContinueClickedAt && (now - lastContinueClickedAt) <= continueCooldownMs) {
        await delay(200);
        continue;
      }
      if (now - lastContinueAttemptAt > continueCooldownMs) {
        lastContinueAttemptAt = now;
        
        // Turnstile token kontrolü - yoksa devam'a basma
        const tokenState = await page.evaluate(() => {
          const field = document.querySelector('input[name="cf-turnstile-response"]');
          const hasToken = field && field.value && field.value.length > 100;
          const hasWidget = !!document.querySelector('.cf-turnstile');
          return { hasToken, hasWidget, tokenLen: field?.value?.length || 0 };
        });
        
        if (tokenState.hasWidget && !tokenState.hasToken) {
          logger.warn(`seatPick:${context}:no_turnstile_token`, tokenState);
          // Token yok - yeniden çözmeyi dene
          if (ensureTurnstileFn && email) {
            logger.info(`seatPick:${context}:resolving_turnstile`);
            try {
              const t0 = Date.now();
              await ensureTurnstileFn(page, email, `seatPick:${context}:beforeContinue`);
              const dt = Date.now() - t0;
              // Captcha solving can take 60-90s; extend seat-pick deadline accordingly.
              extendDeadline(dt + 8000, 'turnstile_before_continue');
            } catch (e) {
              logger.warn(`seatPick:${context}:turnstile_resolve_failed`, { error: e?.message });
            }
          }
          await delay(500);
          continue;
        }
        
        // Start transition watchers BEFORE clicking, otherwise fast XHR responses can be missed.
        const preUrl = (() => { try { return page.url(); } catch { return ''; } })();
        const waitUrlToBasket = page.waitForFunction(() => {
          const u = String(location.href || '');
          return /\/(sepet|basket|cart|odeme|payment)(\b|\/|\?|#)/i.test(u);
        }, { timeout: 20000 })
          .then(() => ({ type: 'url', url: (() => { try { return page.url(); } catch { return null; } })() }))
          .catch((e) => ({ type: 'url_timeout', error: e?.message || String(e) }));

        const waitBasketResp = page.waitForResponse((resp) => {
          try {
            const u = resp.url();
            return /(addseattobasket|getuserbasketbookingblockview|getuserbasketbooking|addseat|add-to-basket|AddToBasket|basket|sepet|cart|odeme|payment)/i.test(u);
          } catch {
            return false;
          }
        }, { timeout: 20000 })
          .then(async (r) => {
            let json = null;
            try {
              const h = r.headers ? r.headers() : {};
              const ct = (h?.['content-type'] || h?.['Content-Type'] || '').toLowerCase();
              if (ct.includes('application/json')) {
                json = await r.json().catch(() => null);
              }
            } catch {}
            return { type: 'resp', url: r.url(), status: r.status(), json };
          })
          .catch((e) => ({ type: 'resp_timeout', error: e?.message || String(e) }));

        logger.info(`seatPick:${context}:clicking_continue`, { seatId: lockedSeat?.seatId, tokenLen: tokenState.tokenLen });
        const continueClicked = await clickContinueInsidePage(page);
        logger.info(`seatPick:${context}:continue_result`, { clicked: !!continueClicked, btnInfo: continueClicked?.btnInfo || null });
        if (continueClicked) {
          lastContinueClickedAt = Date.now();
          postContinueVerifyUntil = Date.now() + POST_CONTINUE_VERIFY_MS;
          // Devam'a bastıktan sonra basket geçişini aktif takip et (SPA bazen URL'i gecikmeli güncelliyor).
          try {
            const transition = await Promise.race([
              waitUrlToBasket,
              waitBasketResp,
              delay(20000).then(() => ({ type: 'timeout' }))
            ]);
            logger.info(`seatPick:${context}:post_continue_transition`, { transition, preUrl, curUrl: (() => { try { return page.url(); } catch { return null; } })() });

            const nw2 = basketWatcher.getLatest();
            if (nw2 && nw2.data) return nw2.data;

            // If network says basket has items, accept it as success even if UI didn't navigate.
            try {
              const j = transition && transition.type === 'resp' ? transition.json : null;
              const isOk = transition && transition.type === 'resp' && transition.status >= 200 && transition.status < 400;
              if (isOk && j && j.isError === false) {
                const v = j.value || null;
                const basket = v && v.basket ? v.basket : (j.value && j.value.basket ? j.value.basket : null);
                const products = (j.value && Array.isArray(j.value.basketBookingProducts)) ? j.value.basketBookingProducts : null;
                const p0 = products && products.length ? products[0] : null;
                const row = p0?.refSeatInfo_RowName ? String(p0.refSeatInfo_RowName) : '';
                const seat = p0?.refSeatInfo_SeatName ? String(p0.refSeatInfo_SeatName) : '';
                const tribune = p0?.tribune_Name ? String(p0.tribune_Name) : '';
                const block = p0?.block_Name ? String(p0.block_Name) : '';
                const seatIdFromNet = v?.id || p0?.refSeatInfoID || '';
                const blockIdFromNet = v?.refBlockID || p0?.refBlockID || '';

                // addseattobasket response indicates basket was created.
                const basketId = basket?.basketId || '';
                const remainingTime = basket?.remainingTime || j.value?.basketRemaningTime || null;
                const hasBasketFlag = basket?.isBasket === true;

                if (hasBasketFlag || (products && products.length)) {
                  logger.info(`seatPick:${context}:basket_from_network`, {
                    basketId,
                    remainingTime,
                    seatId: seatIdFromNet,
                    blockId: blockIdFromNet,
                    row,
                    seat
                  });
                  return {
                    tribune,
                    block,
                    row,
                    seat,
                    blockId: blockIdFromNet ? String(blockIdFromNet) : '',
                    seatId: seatIdFromNet ? String(seatIdFromNet) : '',
                    combined: `${tribune} ${block} ${row} ${seat}`.trim(),
                    inBasket: true,
                    url: (() => { try { return page.url(); } catch { return ''; } })(),
                    basketId: basketId ? String(basketId) : '',
                    remainingTime
                  };
                }
              }
            } catch {}

            // If backend/response suggests basket but UI is still on seat selection, try direct navigation.
            const curUrl = (() => { try { return page.url(); } catch { return ''; } })();
            const stillOnSeat = expectedUrlIncludes ? (curUrl && curUrl.includes(String(expectedUrlIncludes))) : false;
            const looksBasket = transition && (transition.type === 'url' || (transition.type === 'resp' && transition.status >= 200 && transition.status < 400));
            if (stillOnSeat && looksBasket) {
              try {
                await page.goto('https://www.passo.com.tr/tr/sepet', { waitUntil: 'domcontentloaded', timeout: 30000 });
              } catch {}
            }
          } catch {}

          // Devam'a bastıktan sonra biraz bekle, basket'e düşmesi için
          await delay(800);
        }
      }

      // swal (Tamam/Evet) modal çıkarsa kapat
      try {
          const swalText = await page.evaluate(() => {
              const cont = document.querySelector('.swal2-container.swal2-shown');
              if (!cont) return null;
              const txt = (cont.querySelector('.swal2-html-container')?.innerText || cont.innerText || '').trim();
              return txt || null;
          });
          if (swalText) {
              logger.warn(`seatPick:${context}:swal`, { text: swalText });
              const needsMore = /lütfen\s*1\s*adet\s*daha\s*ürün\s*seçiniz/i.test(swalText);
              const seatProblem = /(koltuk\s*seç|koltuk\s*seçiniz|koltuk\s*dolu|seçtiğiniz\s*koltuk|seat\s*(is|was)\s*(not|no)\s*available)/i.test(swalText);
              const sessionProblem = /(oturum|zaman\s*aşımı|süre\s*doldu|yeniden\s*giriş|session\s*(expired|timeout)|time\s*(out|expired))/i.test(swalText);
              await confirmSwalYes(page, 5000);
              if (sessionProblem) {
                  throw new Error(`Oturum/Zaman aşımı uyarısı: ${swalText}`);
              }
              if (needsMore) {
                  needsMoreCount++;
                  // This message indicates Passo requires at least 2 products/seats. Try selecting one more seat and retry Continue.
                  const added = await tryPickAdditionalSeat();
                  if (!added) {
                      logger.warn(`seatPick:${context}:needs_more_but_cannot_add_seat`, { needsMoreCount });
                  }
                  // After adding seat, attempt Continue again (cooldown logic will prevent spam)
                  postContinueVerifyUntil = Date.now() + Math.min(POST_CONTINUE_VERIFY_MS, 20000);
                  if (needsMoreCount >= 3) {
                      throw new Error('"1 adet daha ürün seçiniz" uyarısı devam ediyor. İkinci koltuk eklenemedi veya sepet akışı ilerlemiyor.');
                  }
              }
              if (seatProblem) {
                  // yanlış/dolu koltuk seçildi veya seçim yok uyarısı -> lock reset + seatmap'i tekrar hazırla
                  lockedSeat = null;
                  lockedMiss = 0;
                  noSeatStreak = 0;
                  try { await openSeatMapStrict(page); } catch {}
                  await delay(250);
              }
          }
      } catch {}

      for (let w=0; w<20; w++){
          await ensureOnSeatPage('verify_wait');
          const data = await readBasketData(page);
          if (data && (data.row && data.seat)) return data;
          if (data && data.inBasket && isBasketLikeUrl(data.url)) return data;
          await delay(200);
      }
      // olmadıysa dön ama RE-CLICK yok; sadece tekrar devam dener
  }
  throw new Error(formatError('SEAT_SELECTION_FAILED_A'));
  } finally {
    try { basketWatcher.dispose(); } catch {}
  }
}

/** B: aynı koltuğu seç (KİLİTLİ — seçiliyken re-click YOK) */
async function pickExactSeatWithVerify_Locked(page, target, maxMs = null){
  maxMs = maxMs || cfg.TIMEOUTS.SEAT_PICK_EXACT_MAX;
  const end = Date.now() + maxMs;
  await openSeatMapStrict(page);

  const wantSeatId=(target.seatId||'').toString().trim();
  const wantRow=(target.row||'').toString().trim().toLowerCase();
  const wantSeat=(target.seat||'').toString().trim().toLowerCase();

  await page.evaluate(()=>{ window.__passobot = {clicked:false, done:false}; });

  while (Date.now() < end) {
      await recoverIfRedirected(page, 'B', 'locked_loop', null, null, null, null, null, null);
      // 1) Önce zaten SEPette mi?
      const b = await readBasketData(page);
      if (b && b.row && b.seat){
          const ok = (wantSeatId && String(b.seatId)===String(wantSeatId)) ||
              ((b.row||'').toLowerCase()===wantRow && (b.seat||'').toLowerCase()===wantSeat);
          if (ok) return b;
      }

      // 2) Haritada hedef koltuk seçiliyse -> tıklama YOK, sadece "Devam"
      const selectedMatches = await page.evaluate(({wantSeatId,wantRow,wantSeat})=>{
          const norm=s=>(s||'').toString().trim().toLowerCase();
          const sel = document.querySelector('circle.seat-circle.selected, circle.seat-circle[aria-pressed="true"], [data-selected="true"]');
          if (!sel) return false;
          const idMatch = !!wantSeatId && (
              sel.getAttribute('seat-id')===wantSeatId ||
              sel.getAttribute('data-seat-id')===wantSeatId ||
              sel.getAttribute('data-id')===wantSeatId
          );
          const t=[sel.getAttribute('title'),sel.getAttribute('aria-label'),sel.getAttribute('data-title'),sel.getAttribute('data-tooltip')]
              .filter(Boolean).join(' ').toLowerCase();
          const rowMatch = wantRow && t.includes(norm(wantRow));
          const seatMatch= wantSeat && t.includes(norm(wantSeat));
          return idMatch || (rowMatch && seatMatch);
      }, {wantSeatId,wantRow,wantSeat});

      if (selectedMatches) {
          await clickContinueInsidePage(page);
          for (let w=0; w<25; w++){
              const d = await readBasketData(page);
              if (d && ((wantSeatId && String(d.seatId)===String(wantSeatId)) ||
                  ((d.row||'').toLowerCase()===wantRow && (d.seat||'').toLowerCase()===wantSeat))) {
                  return d;
              }
              await delay(200);
          }
          // hâlâ sepete düşmediyse sadece tekrar devam dene (re-click YOK)
          await delay(250);
          continue;
      }

      // 3) Hedef koltuk seçili değilse ve daha önce click yapmadıysak 1 kez dene
      const didClick = await page.evaluate(({wantSeatId,wantRow,wantSeat})=>{
          const norm=s=>(s||'').toString().trim().toLowerCase();
          const st = window.__passobot || (window.__passobot = {clicked:false, done:false});
          if (st.clicked) return 'skip'; // tekrar tıklama YOK

          const nodes=[...document.querySelectorAll('circle.seat-circle, [seat-id], [data-seat-id], [data-id]')];
          let el=null;
          if (wantSeatId){
              el = nodes.find(x=>
                  x.getAttribute('seat-id')===wantSeatId ||
                  x.getAttribute('data-seat-id')===wantSeatId ||
                  x.getAttribute('data-id')===wantSeatId
              ) || null;
          }
          if (!el && wantRow && wantSeat){
              const rw=norm(wantRow), stt=norm(wantSeat);
              el = nodes.find(e=>{
                  const t=[e.getAttribute('title'),e.getAttribute('aria-label'),e.getAttribute('data-title'),e.getAttribute('data-tooltip')].filter(Boolean).join(' ').toLowerCase();
                  const cls=(e.getAttribute('class')||'').toLowerCase();
                  const okAvail = !/(occupied|disabled|unavailable|dolu|sold|reserved)/i.test(cls) && e.getAttribute('aria-disabled')!=='true';
                  return okAvail && t.includes(rw) && t.includes(stt);
              }) || null;
          }
          if (!el) return 'notfound';
          const cls=(el.getAttribute('class')||'').toLowerCase();
          if (/(occupied|disabled|unavailable|dolu|sold|reserved)/i.test(cls) || el.getAttribute('aria-disabled')==='true') return 'wait';

          el.scrollIntoView({block:'center', inline:'center'});
          const r = el.getBoundingClientRect();
          ['pointerover','pointerdown','mousedown','mouseup','pointerup','click'].forEach(type=>{
              el.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));
          });
          window.__passobot.clicked = true; // <<< kilit
          return 'clicked';
      }, {wantSeatId,wantRow,wantSeat});

      if (didClick === 'clicked') {
          // klik yapıldı; selected olana veya sepete düşünceye kadar sadece DEVAM dene
          for (let w=0; w<10; w++){
              const selNow = await page.evaluate(()=> !!document.querySelector('circle.seat-circle.selected, circle.seat-circle[aria-pressed="true"], [data-selected="true"]'));
              if (selNow) break;
              await delay(120);
          }
          await clickContinueInsidePage(page);
          await delay(250);
          continue;
      }

      // 'skip' veya 'notfound' veya 'wait'
      await delay(220);
  }
  return null;
}

async function waitForTargetSeatReady(page, target, maxMs = null) {
  maxMs = maxMs || 15000;
  const end = Date.now() + maxMs;
  await openSeatMapStrict(page);

  const wantSeatId = (target.seatId || '').toString().trim();
  const wantRow = (target.row || '').toString().trim().toLowerCase();
  const wantSeat = (target.seat || '').toString().trim().toLowerCase();

  while (Date.now() < end) {
    if (target && target.__recoveryOptions && typeof target.__recoveryOptions === 'object') {
      const o = target.__recoveryOptions;
      await recoverIfRedirected(page, o.context || 'B', 'wait_ready', o.expectedUrlIncludes || null, o.recoveryUrl || null, o.email || null, o.password || null, o.reloginIfRedirected || null, o.ensureTurnstileFn || null);
    }
    const found = await page.evaluate(({ wantSeatId, wantRow, wantSeat }) => {
      const norm = (s) => (s || '').toString().trim().toLowerCase();
      const nodes = [...document.querySelectorAll('circle.seat-circle, [seat-id], [data-seat-id], [data-id]')];
      if (!nodes.length) return false;
      if (wantSeatId) {
        const el = nodes.find((x) =>
          x.getAttribute('seat-id') === wantSeatId ||
          x.getAttribute('data-seat-id') === wantSeatId ||
          x.getAttribute('data-id') === wantSeatId
        );
        return !!el;
      }
      if (wantRow && wantSeat) {
        const rw = norm(wantRow);
        const st = norm(wantSeat);
        const el = nodes.find((e) => {
          const t = [e.getAttribute('title'), e.getAttribute('aria-label'), e.getAttribute('data-title'), e.getAttribute('data-tooltip')]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return t.includes(rw) && t.includes(st);
        });
        return !!el;
      }
      return false;
    }, { wantSeatId, wantRow, wantSeat });

    if (found) return true;
    await delay(120);
  }
  return false;
}

async function pickExactSeatWithVerify_ReleaseAware(page, target, maxMs = null) {
  maxMs = maxMs || cfg.TIMEOUTS.SEAT_PICK_EXACT_MAX;
  const end = Date.now() + maxMs;
  await openSeatMapStrict(page);

  const rec = (target && target.__recoveryOptions && typeof target.__recoveryOptions === 'object') ? target.__recoveryOptions : null;
  const ctx = rec?.context || 'B';
  const expectedUrlIncludes = rec?.expectedUrlIncludes || null;
  const recoveryUrl = rec?.recoveryUrl || null;
  const email = rec?.email || null;
  const password = rec?.password || null;
  const reloginIfRedirected = typeof rec?.reloginIfRedirected === 'function' ? rec.reloginIfRedirected : null;
  const ensureTurnstileFn = typeof rec?.ensureTurnstileFn === 'function' ? rec.ensureTurnstileFn : null;

  const wantSeatId = (target.seatId || '').toString().trim();
  const wantRow = (target.row || '').toString().trim().toLowerCase();
  const wantSeat = (target.seat || '').toString().trim().toLowerCase();

  const basketWatcher = startBasketNetworkWatcher(page, ctx);

  // Agresif retry: blok seçimi sonrası hızlı tıklama
  const AGGRESSIVE_RETRY_MS = 8000; // İlk 8 saniye agresif dene
  const aggressiveEnd = Date.now() + AGGRESSIVE_RETRY_MS;

  try {

  while (Date.now() < end) {
    const nw0 = basketWatcher.getLatest();
    if (nw0 && nw0.data) return nw0.data;

    await recoverIfRedirected(page, ctx, 'release_loop', expectedUrlIncludes, recoveryUrl, email, password, reloginIfRedirected, ensureTurnstileFn);

    // Önce basket kontrolü - network üzerinden gelen seat bilgisi
    const b = await readBasketData(page);
    if (b && b.row && b.seat) {
      const ok = (wantSeatId && String(b.seatId) === String(wantSeatId)) ||
        ((b.row || '').toLowerCase() === wantRow && (b.seat || '').toLowerCase() === wantSeat);
      if (ok) return b;
    }

    const isAggressive = Date.now() < aggressiveEnd;

    // Seçili seat kontrolü
    const selectedMatches = await page.evaluate(({ wantSeatId, wantRow, wantSeat }) => {
      const norm = (s) => (s || '').toString().trim().toLowerCase();
      const sel = document.querySelector('circle.seat-circle.selected, circle.seat-circle[aria-pressed="true"], [data-selected="true"]');
      if (!sel) return false;
      const idMatch = !!wantSeatId && (
        sel.getAttribute('seat-id') === wantSeatId ||
        sel.getAttribute('data-seat-id') === wantSeatId ||
        sel.getAttribute('data-id') === wantSeatId
      );
      const t = [sel.getAttribute('title'), sel.getAttribute('aria-label'), sel.getAttribute('data-title'), sel.getAttribute('data-tooltip')]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const rowMatch = wantRow && t.includes(norm(wantRow));
      const seatMatch = wantSeat && t.includes(norm(wantSeat));
      return idMatch || (rowMatch && seatMatch);
    }, { wantSeatId, wantRow, wantSeat });

    if (selectedMatches) {
      await clickContinueInsidePage(page);

      // Network may confirm basket even if UI stays on /koltuk-secim.
      try {
        const nw = await basketWatcher.wait(6000);
        if (nw) return nw;
      } catch {}

      // swal çıkarsa kapat
      try {
        const swalText = await page.evaluate(() => {
          const cont = document.querySelector('.swal2-container.swal2-shown');
          if (!cont) return null;
          const txt = (cont.querySelector('.swal2-html-container')?.innerText || cont.innerText || '').trim();
          return txt || null;
        });
        if (swalText) {
          logger.warn('seatPick:B:swal', { text: swalText });
          await confirmSwalYes(page, 5000);
        }
      } catch {}

      for (let w = 0; w < 20; w++) {
        const d = await readBasketData(page);
        if (d && ((wantSeatId && String(d.seatId) === String(wantSeatId)) ||
          ((d.row || '').toLowerCase() === wantRow && (d.seat || '').toLowerCase() === wantSeat))) {
          return d;
        }
        await delay(isAggressive ? 50 : 120);
      }
      await delay(isAggressive ? 30 : 80);
      continue;
    }

    // Seat bul ve tıkla
    const clickResult = await page.evaluate(({ wantSeatId, wantRow, wantSeat }) => {
      const norm = (s) => (s || '').toString().trim().toLowerCase();
      // Genişletilmiş selector - tüm olası seat elementleri
      const nodes = [...document.querySelectorAll('circle.seat-circle, [seat-id], [data-seat-id], [data-id], .seat, [class*="seat"]')];
      if (!nodes.length) return 'notfound';
      let el = null;
      if (wantSeatId) {
        el = nodes.find((x) =>
          x.getAttribute('seat-id') === wantSeatId ||
          x.getAttribute('data-seat-id') === wantSeatId ||
          x.getAttribute('data-id') === wantSeatId ||
          x.getAttribute('id') === wantSeatId
        ) || null;
      }
      if (!el && wantRow && wantSeat) {
        const rw = norm(wantRow), st = norm(wantSeat);
        el = nodes.find((e) => {
          const t = [e.getAttribute('title'), e.getAttribute('aria-label'), e.getAttribute('data-title'), e.getAttribute('data-tooltip'), e.innerText]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return t.includes(rw) && t.includes(st);
        }) || null;
      }
      if (!el) return 'notfound';

      const cls = (el.getAttribute('class') || '').toLowerCase();
      const isBlocked = /(occupied|disabled|unavailable|dolu|sold|reserved)/i.test(cls) || el.getAttribute('aria-disabled') === 'true';
      if (isBlocked) return 'blocked';

      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();

      // Agresif event dispatch
      const events = ['mouseover', 'mouseenter', 'pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click'];
      events.forEach((type) => {
        try {
          const evt = new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
          el.dispatchEvent(evt);
        } catch {}
      });

      // Direct click on element center via element method
      try { el.click(); } catch {}

      return 'clicked';
    }, { wantSeatId, wantRow, wantSeat });

    if (clickResult === 'clicked') {
      // click sonrası seçimin DOM'a düşmesini kısa süre bekle
      for (let w = 0; w < (isAggressive ? 20 : 10); w++) {
        const selNow = await page.evaluate(() => !!document.querySelector(
          'circle.seat-circle.selected, circle.seat-circle[aria-pressed="true"], [data-selected="true"]'
        ));
        if (selNow) break;
        await delay(isAggressive ? 30 : 60);
      }

      const selectedNow = await page.evaluate(() => !!document.querySelector(
        'circle.seat-circle.selected, circle.seat-circle[aria-pressed="true"], [data-selected="true"]'
      ));

      if (selectedNow) {
        await clickContinueInsidePage(page);

        // Network basket watcher - bu daha güvenilir
        try {
          const nw = await basketWatcher.wait(5000);
          if (nw) return nw;
        } catch {}

        // swal çıkarsa kapat
        try {
          const swalText = await page.evaluate(() => {
            const cont = document.querySelector('.swal2-container.swal2-shown');
            if (!cont) return null;
            const txt = (cont.querySelector('.swal2-html-container')?.innerText || cont.innerText || '').trim();
            return txt || null;
          });
          if (swalText) {
            logger.warn('seatPick:B:swal:after_click', { text: swalText });
            await confirmSwalYes(page, 5000);
          }
        } catch {}

        // Son bir basket kontrolü
        for (let w = 0; w < 15; w++) {
          const d = await readBasketData(page);
          if (d && d.row && d.seat) {
            const ok = (wantSeatId && String(d.seatId) === String(wantSeatId)) ||
              ((d.row || '').toLowerCase() === wantRow && (d.seat || '').toLowerCase() === wantSeat);
            if (ok) return d;
          }
          await delay(isAggressive ? 50 : 100);
        }
      }

      await delay(isAggressive ? 30 : 80);
      continue;
    }

    // notfound veya blocked durumunda daha az bekle (agresif modda)
    await delay(isAggressive ? 30 : 60);
  }

  throw new Error(formatError('SEAT_PICK_FAILED_B'));
  } finally {
    try { basketWatcher.dispose(); } catch {}
  }
}

module.exports = { pickRandomSeatWithVerify, pickExactSeatWithVerify_Locked, waitForTargetSeatReady, pickExactSeatWithVerify_ReleaseAware };
