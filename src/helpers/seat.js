const delay = require('../utils/delay');
const { getCfg } = require('../runCfg');
const { formatError } = require('../utils/messages');
const { openSeatMapStrict, readBasketData, clickContinueInsidePage, ensureUrlContains, SEAT_NODE_SELECTOR } = require('./page');
const logger = require('../utils/logger');
const { confirmSwalYes } = require('./swal');

/** Koltuk haritasında ardışık tıklamalar arasında Turnstile token’ı için kısa bekle (çift sepet / çift seçim riski). */
async function awaitTurnstileGapForSeatMap(page, context, email, ensureTurnstileFn, tag) {
  if (!page) return;
  const maxMs = 6500;
  const poll = 300;
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const st = await page.evaluate(() => {
      const w = !!document.querySelector('.cf-turnstile');
      const f = document.querySelector('input[name="cf-turnstile-response"]');
      const tok = f && f.value && String(f.value).length >= 80;
      return { hasWidget: w, hasToken: tok };
    }).catch(() => ({ hasWidget: false, hasToken: true }));
    if (st.hasWidget && !st.hasToken) {
      if (typeof ensureTurnstileFn === 'function' && email) {
        try {
          await ensureTurnstileFn(page, email, `seatPick:${context}:mapGap:${tag}`, { background: true, recaptchaFallback: false });
        } catch {}
      }
      await delay(poll);
      continue;
    }
    await delay(380);
    return;
  }
}

const SELECTED_SEAT_SELECTOR = (
  'circle.seat-circle.selected,' +
  'circle.seat-circle[aria-pressed="true"],' +
  '[data-selected="true"],' +
  'svg.seatmap-svg rect.seatActive,' +
  'svg.seatmap-svg g.seatActive rect,' +
  'svg.seatmap-svg g.selected rect,' +
  'svg.seatmap-svg rect.selected'
);

const SEAT_CLAIM_TTL_MS = 20000;
const seatClaimsByGroup = new Map();

function pruneSeatClaims(groupKey, now = Date.now()) {
  const key = String(groupKey || 'default');
  const grp = seatClaimsByGroup.get(key);
  if (!grp) return null;
  for (const [sid, meta] of grp.entries()) {
    if (!meta || (now - Number(meta.ts || 0)) > SEAT_CLAIM_TTL_MS) grp.delete(sid);
  }
  if (!grp.size) {
    seatClaimsByGroup.delete(key);
    return null;
  }
  return grp;
}

function getClaimedSeatIds(groupKey, owner) {
  const grp = pruneSeatClaims(groupKey);
  if (!grp) return [];
  const mine = String(owner || '');
  const out = [];
  for (const [sid, meta] of grp.entries()) {
    if (!sid) continue;
    if (meta?.owner && mine && String(meta.owner) === mine) continue;
    out.push(String(sid));
  }
  return out;
}

function claimSeatId(groupKey, owner, seatId) {
  const sid = String(seatId || '').trim();
  if (!sid) return true;
  const key = String(groupKey || 'default');
  const mine = String(owner || '');
  const now = Date.now();
  let grp = pruneSeatClaims(key, now);
  if (!grp) {
    grp = new Map();
    seatClaimsByGroup.set(key, grp);
  }
  const cur = grp.get(sid);
  if (cur && cur.owner && mine && String(cur.owner) !== mine && (now - Number(cur.ts || 0)) <= SEAT_CLAIM_TTL_MS) {
    return false;
  }
  grp.set(sid, { owner: mine, ts: now });
  return true;
}

function releaseSeatId(groupKey, owner, seatId, force = false) {
  const sid = String(seatId || '').trim();
  if (!sid) return;
  const key = String(groupKey || 'default');
  const mine = String(owner || '');
  const grp = pruneSeatClaims(key);
  if (!grp) return;
  const cur = grp.get(sid);
  if (!cur) return;
  if (!force && cur.owner && mine && String(cur.owner) !== mine) return;
  grp.delete(sid);
  if (!grp.size) seatClaimsByGroup.delete(key);
}

function mapHeldSeatsFromProducts(products) {
  if (!Array.isArray(products) || !products.length) return [];
  const seen = new Set();
  const out = [];
  for (const p of products) {
    const seatId = p?.refSeatInfoID != null ? String(p.refSeatInfoID) : '';
    const row = p?.refSeatInfo_RowName != null ? String(p.refSeatInfo_RowName) : '';
    const seat = p?.refSeatInfo_SeatName != null ? String(p.refSeatInfo_SeatName) : '';
    const tribune = p?.tribune_Name != null ? String(p.tribune_Name) : '';
    const block = p?.block_Name != null ? String(p.block_Name) : '';
    const blockId = p?.refBlockID != null ? String(p.refBlockID) : '';
    const key = seatId || `${tribune}|${block}|${row}|${seat}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      tribune,
      block,
      row,
      seat,
      blockId,
      seatId,
      combined: `${tribune} ${block} ${row} ${seat}`.trim()
    });
  }
  return out;
}

function parseBasketFromApiJson(j, currentUrl) {
  try {
    if (!j || j.isError !== false) return null;
    const v = j.value || null;

    const products = (v && Array.isArray(v.basketBookingProducts)) ? v.basketBookingProducts : null;
    const p0 = products && products.length ? products[0] : null;
    const heldSeats = mapHeldSeatsFromProducts(products);

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
      remainingTime,
      itemCount: products && products.length ? products.length : 0,
      heldSeats
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
      const pickG = (id) => {
        const root = document.querySelector('svg.seatmap-svg');
        if (!root) return null;
        return (
          root.querySelector(`g#seat${id}`) ||
          root.querySelector(`g#g${id}`) ||
          root.querySelector(`g[id="seat${id}"]`) ||
          root.querySelector(`g[id="g${id}"]`)
        );
      };
      const g = pickG(sid);
      const r = g ? (g.querySelector('rect') || g.querySelector('circle') || g) : null;
      if (!r) return false;
      try { r.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
      const bb = r.getBoundingClientRect();
      const cx = bb.left + (bb.width / 2);
      const cy = bb.top + (bb.height / 2);
      const topEl = document.elementFromPoint(cx, cy);
      const fireOn = (node, type) => {
        try {
          if (!node) return;
          node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }));
        } catch {}
      };
      const seq = ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
      // First hit the actual seat nodes to bypass floating overlays/widgets.
      for (const t of seq) {
        fireOn(g || r, t);
        if (r !== g) fireOn(r, t);
      }
      // Then mirror to top element (if different) so page-level listeners still trigger.
      if (topEl && topEl !== r && topEl !== g) {
        for (const t of seq) fireOn(topEl, t);
      }
      try { if (typeof (g || r).click === 'function') (g || r).click(); } catch {}
      const topTxt = (() => {
        try {
          const t = (topEl?.innerText || topEl?.textContent || '').toString().trim().slice(0, 80);
          return t || null;
        } catch { return null; }
      })();
      const topCls = (() => { try { return String(topEl?.className || '').slice(0, 120); } catch { return null; } })();
      const topTag = (() => { try { return String(topEl?.tagName || ''); } catch { return null; } })();
      const overlayLikely = !!topEl && topEl !== r && topEl !== g && /turnstile|cloudflare|swal|toast|modal|captcha|overlay/i.test(`${topCls || ''} ${topTag || ''} ${topTxt || ''}`);
      if (overlayLikely) {
        try {
          window.__passobotClickObstruction = {
            seatId: String(sid),
            topTag,
            topCls,
            topTxt,
            at: Date.now()
          };
        } catch {}
      }
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
  if (/verify_wait|beforeContinue/i.test(String(label || '')) && (isHome || urlDrift)) {
    logger.warn(`seatPick:${context}:continue_blocked_by_challenge`, {
      label,
      reason: isHome ? 'redirect_home_after_continue' : 'url_drift_after_continue',
      url: curUrl,
      recoveryUrl
    });
  }

  if (isLogin && reloginIfRedirected && email && password) {
    try {
      await reloginIfRedirected(page, email, password);
    } catch (e) {
      logger.warn(`seatPick:${context}:relogin_failed`, { label, error: e?.message || String(e) });
    }
  }

  // If recoveryUrl is a login page with returnUrl, navigate directly to decoded returnUrl.
  // Otherwise we can get stuck in a loop: /giris -> /giris.
  let effectiveRecoveryUrl = String(recoveryUrl);
  try {
    if (/\/giris(\?|$)/i.test(effectiveRecoveryUrl)) {
      const u = new URL(effectiveRecoveryUrl);
      let ru = u.searchParams.get('returnUrl');
      if (ru) {
        try { ru = decodeURIComponent(ru); } catch {}
        if (!/^https?:\/\//i.test(ru)) {
          ru = `https://www.passo.com.tr${ru.startsWith('/') ? '' : '/'}${ru}`;
        }
        effectiveRecoveryUrl = ru;
      }
    }
  } catch {}

  try {
    await page.goto(String(effectiveRecoveryUrl), { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch {}

  try {
    await ensureUrlContains(page, '/koltuk-secim', {
      retries: 3,
      waitMs: 14000,
      recoveryUrl: effectiveRecoveryUrl,
      backoffMs: 450
    });
  } catch {}

  if (ensureTurnstileFn && email) {
    try {
      await ensureTurnstileFn(page, email, `seatPick:${context}:${label}:recover`, { background: false, recaptchaFallback: false });
    } catch (e) {
      logger.warn(`seatPick:${context}:recover_captcha_failed`, { label, error: e?.message || String(e) });
    }
  }

  try {
    await openSeatMapStrict(page);
  } catch {}

  try {
    await page.waitForFunction(
      (sel) => {
        try {
          return document.querySelectorAll(sel).length > 0;
        } catch {
          return false;
        }
      },
      { timeout: 14000, polling: 120 },
      SEAT_NODE_SELECTOR
    );
  } catch {
    logger.warn(`seatPick:${context}:recover_seatmap_wait_timeout`, { label });
  }

  logger.info(`seatPick:${context}:redirect_recover_done`, { label, url: (() => { try { return page.url(); } catch { return ''; } })() });
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

/**
 * Passo koltuk seçim ekranı: bilet tipi satırında adet `<select>` (çoğunlukla `form-control`, 1–5/10) olabiliyor.
 * DOM sürümüne göre sınıflı kapsayıcı değişebildiği için aday listesi geniş; üyelik/kategori selectleri elenir.
 * Angular gerçek kullanıcı etkileşimi bekleyebilir: önce Puppeteer ile tıkla + selectedIndex, gerekirse evaluate fallback.
 */
const PASSO_QTY_SELECT_CANDIDATE_CSS = [
  '.ticket-type-item-button select.form-control',
  '.ticket-type-title select.form-control',
  '.ticket-type-wrapped select.form-control',
  '.ticket-type-item select.form-control',
  '.ticket-type-row select.form-control',
  '[class*="ticket-type"] select.form-control',
  '.ticket-type-wrapped select',
  '.ticket-type-item-button select',
  '.ticket-type-title select',
  'select.form-control'
].join(', ');

/** Kategori/blok seçildikten sonra Passo adet alanını geç basıyor; kısa süre yoksa poll et. */
const PASSO_QTY_SELECT_APPEAR_MAX_MS = 12000;
const PASSO_QTY_SELECT_APPEAR_POLL_MS = 280;

async function applyTicketQuantityDropdown(page, context, desiredCount, options = null) {
  const want = Math.max(1, Math.min(10, Number(desiredCount) || 1));
  if (want <= 1) return { ok: false, reason: 'single_ticket' };
  if (!page) return { ok: false, reason: 'no_page' };
  const opt = options && typeof options === 'object' ? options : {};
  const appearBudget =
    want > 1
      ? Number.isFinite(Number(opt.appearMaxMs)) && Number(opt.appearMaxMs) >= 0
        ? Number(opt.appearMaxMs)
        : PASSO_QTY_SELECT_APPEAR_MAX_MS
      : 0;
  try {
    const appearDeadline = Date.now() + appearBudget;
    let meta = null;
    let waitedForAppearMs = 0;
    let appearPollExhausted = false;
    do {
      meta = await page.evaluate(
        (maxWant, selCss) => {
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect?.();
          if (!r || r.width < 2 || r.height < 2) return false;
          const st = window.getComputedStyle(el);
          if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
          return true;
        };

        const isMembershipSelect = (s) => {
          const opts = Array.from(s.options || []);
          return opts.some((o) => /üyelik|kampanya/i.test(o.textContent || ''));
        };

        /** Kategori/angular value ("277: Object") ile karışmasın: sadece gerçek adet UI'si (1, 2, "3 Adet", value="3"). */
        const parseQuantityOption = (o) => {
          if (!o) return NaN;
          const txt = String(o.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
          if (/^\d+$/.test(txt)) {
            const n = parseInt(txt, 10);
            if (n >= 1 && n <= 15) return n;
          }
          const mAdet = txt.match(/^(\d+)\s*adet\b/i);
          if (mAdet) {
            const n = parseInt(mAdet[1], 10);
            if (n >= 1 && n <= 15) return n;
          }
          const val = String(o.value || '').trim();
          if (/^\d+$/.test(val)) {
            const n = parseInt(val, 10);
            if (n >= 1 && n <= 15) return n;
          }
          return NaN;
        };

        // Sıra page.$$(selCss) ile aynı olmalı; indeks ham listede (filtre sonrası yeniden sıra yok).
        const rawList = Array.from(document.querySelectorAll(selCss));

        let bestIdx = -1;
        let bestNums = [];
        for (let i = 0; i < rawList.length; i++) {
          const sel = rawList[i];
          if (!isVisible(sel) || isMembershipSelect(sel)) continue;
          const nums = Array.from(sel.options || [])
            .map(parseQuantityOption)
            .filter((n) => Number.isFinite(n) && n >= 1 && n <= 15);
          const uniq = [...new Set(nums)].sort((a, b) => a - b);
          if (uniq.length < 2) continue;
          const maxOpt = uniq[uniq.length - 1];
          if (maxOpt > 10) continue;
          if (bestIdx < 0 || maxOpt > bestNums[bestNums.length - 1]) {
            bestIdx = i;
            bestNums = uniq;
          }
        }

        if (bestIdx < 0 || bestNums.length < 2) {
          return { ok: false, reason: 'no_quantity_select' };
        }

        const bestSel = rawList[bestIdx];
        const maxAvail = bestNums[bestNums.length - 1];
        const targetNum = Math.min(maxWant, maxAvail);
        const opt = Array.from(bestSel.options || []).find((o) => parseQuantityOption(o) === targetNum);
        if (!opt) {
          return { ok: false, reason: 'option_not_found', targetNum, bestNums };
        }

        return {
          ok: true,
          pick: targetNum,
          requested: maxWant,
          maxAvailable: maxAvail,
          capped: maxWant > maxAvail,
          candidateIndex: bestIdx,
          optionElementIndex: opt.index,
          optionValue: String(opt.value != null ? opt.value : ''),
          currentValue: String(bestSel.value != null ? bestSel.value : ''),
          currentNum: parseQuantityOption(bestSel.options?.[bestSel.selectedIndex] || null),
          selectedMatchesTarget: parseQuantityOption(bestSel.options?.[bestSel.selectedIndex] || null) === targetNum
        };
      },
      want,
      PASSO_QTY_SELECT_CANDIDATE_CSS
      );
      if (meta && (meta.ok || meta.reason !== 'no_quantity_select')) break;
      if (Date.now() >= appearDeadline) {
        if (meta && meta.reason === 'no_quantity_select') appearPollExhausted = true;
        break;
      }
      await delay(PASSO_QTY_SELECT_APPEAR_POLL_MS);
      waitedForAppearMs += PASSO_QTY_SELECT_APPEAR_POLL_MS;
    } while (true);

    if (waitedForAppearMs > 0) {
      if (meta?.ok) logger.info(`seatPick:${context}:ticket_qty_dropdown_appeared_after_wait`, { waitedMs: waitedForAppearMs });
      else if (meta?.reason === 'no_quantity_select') {
        logger.info(`seatPick:${context}:ticket_qty_dropdown_wait_exhausted`, { waitedMs: waitedForAppearMs });
      }
    }

    if (!meta || !meta.ok) {
      logger.info(`seatPick:${context}:ticket_qty_dropdown_skip`, { ...(meta || {}), appearPollExhausted, waitedForAppearMs });
      return { ok: false, ...(meta || {}), appearPollExhausted: !!appearPollExhausted, waitedForAppearMs };
    }

    if (opt.readOnly) {
      logger.info(`seatPick:${context}:ticket_qty_dropdown_read`, { ...meta, via: 'read_only' });
      return {
        ok: true,
        pick: meta.pick,
        requested: meta.requested,
        maxAvailable: meta.maxAvailable,
        capped: meta.capped,
        currentValue: meta.currentValue,
        currentNum: meta.currentNum,
        selectedMatchesTarget: meta.selectedMatchesTarget,
        changed: false
      };
    }

    if (meta.selectedMatchesTarget) {
      logger.info(`seatPick:${context}:ticket_qty_dropdown`, { ...meta, via: 'already_selected' });
      return {
        ok: true,
        pick: meta.pick,
        requested: meta.requested,
        maxAvailable: meta.maxAvailable,
        capped: meta.capped,
        currentValue: meta.currentValue,
        currentNum: meta.currentNum,
        selectedMatchesTarget: true,
        changed: false
      };
    }

    const selector = PASSO_QTY_SELECT_CANDIDATE_CSS;
    const handles = await page.$$(selector);
    const h = handles[meta.candidateIndex];
    if (h) {
      try {
        await h.scrollIntoView();
        await delay(60);
        try {
          await h.click({ delay: 50 });
        } catch {}
        const optVal = meta.optionValue != null ? String(meta.optionValue).trim() : '';
        if (optVal !== '') {
          try {
            await h.select(optVal);
          } catch {
            await h.evaluate((el, idx) => {
              el.selectedIndex = idx;
            }, meta.optionElementIndex);
          }
        } else {
          await h.evaluate((el, idx) => {
            el.selectedIndex = idx;
          }, meta.optionElementIndex);
        }
        await h.evaluate((el) => {
          try {
            el.focus();
          } catch {}
          el.dispatchEvent(new Event('input', { bubbles: true }));
          try {
            el.dispatchEvent(new InputEvent('input', { bubbles: true }));
          } catch {
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
          el.dispatchEvent(new Event('change', { bubbles: true }));
          try {
            el.dispatchEvent(new Event('ngModelChange', { bubbles: true }));
          } catch {}
          try {
            el.blur();
          } catch {}
        });
      } catch (pe) {
        logger.warn(`seatPick:${context}:ticket_qty_dropdown_puppeteer_fallback`, { error: pe?.message || String(pe) });
        await page.evaluate(
          ({ idx, optIdx, selCss }) => {
            const sels = Array.from(document.querySelectorAll(selCss));
            const el = sels[idx];
            if (!el || !el.options || !el.options[optIdx]) return;
            const opt = el.options[optIdx];
            el.selectedIndex = opt.index;
            el.value = opt.value;
            try {
              el.focus();
            } catch {}
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            try {
              el.dispatchEvent(new Event('ngModelChange', { bubbles: true }));
            } catch {}
          },
          { idx: meta.candidateIndex, optIdx: meta.optionElementIndex, selCss: PASSO_QTY_SELECT_CANDIDATE_CSS }
        );
      }
    } else {
      await page.evaluate(
        ({ idx, optIdx, selCss }) => {
          const sels = Array.from(document.querySelectorAll(selCss));
          const el = sels[idx];
          if (!el || !el.options || !el.options[optIdx]) return;
          const opt = el.options[optIdx];
          el.selectedIndex = opt.index;
          el.value = opt.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          try {
            el.dispatchEvent(new Event('ngModelChange', { bubbles: true }));
          } catch {}
        },
        { idx: meta.candidateIndex, optIdx: meta.optionElementIndex, selCss: PASSO_QTY_SELECT_CANDIDATE_CSS }
      );
    }

    logger.info(`seatPick:${context}:ticket_qty_dropdown`, { ...meta, via: 'puppeteer_or_eval' });
    await delay(750);
    return { ok: true, pick: meta.pick, requested: meta.requested, maxAvailable: meta.maxAvailable, capped: meta.capped, changed: true };
  } catch (e) {
    logger.warn(`seatPick:${context}:ticket_qty_dropdown_failed`, { error: e?.message || String(e) });
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Adet değişince Passo bazen mevcut koltuk seçimini yenilemeyi bekler (tek koltuk × N bilet). Tek gerçek mouse tıklaması (çift tık seçimi kaldırmasın). */
async function reclickActiveSeatAfterQuantityChange(page, context, gapOpts = null) {
  const gap = gapOpts && typeof gapOpts === 'object' ? gapOpts : null;
  try {
    await awaitTurnstileGapForSeatMap(page, context, gap?.email, gap?.ensureTurnstileFn, 'qtyReclick');
  } catch {}
  try {
    const pt = await page.evaluate(() => {
      const rect =
        document.querySelector('svg.seatmap-svg rect.seatActive') ||
        document.querySelector('svg.seatmap-svg g.seatActive rect') ||
        document.querySelector('svg.seatmap-svg g.selected rect') ||
        document.querySelector('circle.seat-circle.selected');
      if (!rect) return null;
      try {
        rect.scrollIntoView({ block: 'center', inline: 'center' });
      } catch {}
      const r = rect.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y };
    });
    if (pt && page.mouse) {
      try {
        await page.mouse.move(pt.x, pt.y);
        await page.mouse.click(pt.x, pt.y, { delay: 40 });
      } catch {}
      logger.info(`seatPick:${context}:ticket_qty_reclick_active_seat`, { x: pt.x, y: pt.y });
      await delay(450);
      return true;
    }
    return false;
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
  maxMs = maxMs || getCfg().TIMEOUTS.SEAT_PICK_MAX || getCfg().TIMEOUTS.SEAT_SELECTION_MAX;
  const startTs = Date.now();
  const initialEnd = startTs + maxMs;
  let end = initialEnd;
  options = options && typeof options === 'object' ? options : {};
  const expectedUrlIncludes = options.expectedUrlIncludes || null;
  const recoveryUrl = options.recoveryUrl || null;
  const context = options.context || 'A';
  const email = options.email || null;
  const roamCategoryTexts = Array.isArray(options.roamCategoryTexts) ? options.roamCategoryTexts.filter(Boolean).map(x => String(x).trim()).filter(Boolean) : [];
  const ensureTurnstileFn = options.ensureTurnstileTokenOnPage || options.ensureTurnstileFn || null;
  const reloginIfRedirected = typeof options.reloginIfRedirected === 'function' ? options.reloginIfRedirected : null;
  const password = options.password || null;
  const chooseCategoryFn = typeof options.chooseCategoryFn === 'function' ? options.chooseCategoryFn : null;
  const categorySelectionMode = options.categorySelectionMode || 'legacy';
  const seatSelectionModeRaw = String(options.seatSelectionMode || 'random').trim().toLowerCase();
  const seatSelectionMode = seatSelectionModeRaw === 'deterministic' ? 'deterministic' : 'random';
  const seatClaimGroupKey = String(options.claimGroupKey || 'default');
  const seatClaimOwner = String(context || 'unknown');
  const ticketCount = Math.max(1, Math.min(10, Number(options.ticketCount) || 1));
  const adjacentSeats = options.adjacentSeats === true;
  const quantitySelectionModeRaw = String(options.quantitySelectionMode || '').trim().toLowerCase();
  const quantitySelectionMode =
    quantitySelectionModeRaw === 'beforecategory' || quantitySelectionModeRaw === 'aftercategory'
      ? 'outsideSeat'
      : 'duringSeat';
  let lastBasketGuardWarnAt = 0;

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

  const canTreatBasketAsSuccess = async (basketData, source) => {
    if (!basketData) return false;
    if (ticketCount <= 1) return true;
    if (quantitySelectionMode !== 'outsideSeat') return true;

    const ddState = await applyTicketQuantityDropdown(page, `${context}:${source || 'basketGuard'}`, ticketCount, {
      appearMaxMs: 0,
      readOnly: true
    }).catch(() => null);

    if (ddState?.ok) {
      const need = ticketCount;
      const maxAv = Number(ddState.maxAvailable) || need;
      const targetQty = Math.min(need, maxAv);
      const gotQty = Number(ddState.currentNum) || 0;
      const qtyReady = ddState.selectedMatchesTarget === true || gotQty === targetQty;
      let selectedCountNow = 0;
      try {
        selectedCountNow = await page.evaluate((sel) => document.querySelectorAll(sel).length, SELECTED_SEAT_SELECTOR).catch(() => 0);
      } catch {}
      const basketItemCount = Math.max(0, Number(basketData?.itemCount) || 0);
      const seatCountReady = selectedCountNow >= ticketCount || basketItemCount >= ticketCount;
      const ready = qtyReady && seatCountReady;
      if (!ready) {
        const nowWarn = Date.now();
        if ((nowWarn - lastBasketGuardWarnAt) > 2500) {
          lastBasketGuardWarnAt = nowWarn;
          logger.warn(`seatPick:${context}:basket_success_blocked_incomplete_multi`, {
            source: source || 'basketGuard',
            ticketCount,
            gotQty,
            targetQty,
            selectedCountNow,
            basketItemCount,
            basketUrl: basketData?.url || null,
            inBasket: basketData?.inBasket === true
          });
        }
      }
      return ready;
    }

    return false;
  };

  let needsMoreCount = 0;

  const basketWatcher = startBasketNetworkWatcher(page, context);

  try {

  let lastDiagAt = 0;
  /** Çoklu bilet: adet select'i mümkünse koltuk tıklanmadan bir kez uygula (Angular modeli için). */
  let ticketQtyPrimed = options.ticketQuantityPrimed === true;
  /** Bir kez tam süre bekleyip hâlâ adet select yoksa döngüde her seferinde 12sn harcamayı kes */
  let skipQtyAppearLongWait = false;

  const diag = async (label) => {
    const now = Date.now();
    if (now - lastDiagAt < 4000) return;
    lastDiagAt = now;
    try {
      const snap = await page.evaluate((lbl, sel) => {
        const seatmapEl = document.querySelector('svg.seatmap-svg')
          || document.querySelector('#seatmap, .seatmap, .seatmapArea, .seatMap, .seatmap-container')
          || null;
        const rect = seatmapEl ? seatmapEl.getBoundingClientRect() : null;
        const vh = (window.innerHeight || document.documentElement.clientHeight || 0);
        const vw = (window.innerWidth || document.documentElement.clientWidth || 0);
        const inViewport = !!(rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw);

        const bodyText = (document.body && document.body.innerText ? document.body.innerText : '').toLowerCase();
        const allRects = Array.from(document.querySelectorAll('svg.seatmap-svg g[id^="seat"] rect'));
        const normFill = (r) => {
          const attr = (r.getAttribute('fill') || '').toLowerCase();
          if (attr) return attr;
          const st = (r.getAttribute('style') || '').toLowerCase();
          const m = st.match(/fill\s*:\s*([^;]+)/i);
          return (m && m[1] ? m[1].trim() : '');
        };
        const selectableRects = allRects.filter(r => {
          const pe = (r.getAttribute('pointer-events') || '').toLowerCase();
          if (pe === 'none') return false;
          const fill = normFill(r);
          if (fill === '#89a0a3') return false;
          const opacity = (r.getAttribute('opacity') || '').toLowerCase();
          const style = (r.getAttribute('style') || '').toLowerCase();
          if (opacity === '0' || /opacity\s*:\s*0/.test(style)) return false;
          const cls = (r.getAttribute('class') || '').toLowerCase();
          if (/(occupied|disabled|unavailable|dolu|sold|reserved)/i.test(cls)) return false;
          return true;
        });
        const topN = (obj, n = 8) => Object.entries(obj)
          .sort((a, b) => (b[1] || 0) - (a[1] || 0))
          .slice(0, n)
          .map(([k, v]) => ({ k, v }));

        let seatRectStats = null;
        if (allRects.length && selectableRects.length === 0) {
          const fillCounts = {};
          const strokeCounts = {};
          const peCounts = {};
          for (const r of allRects) {
            const fill = (String(normFill(r) || '').toLowerCase()) || '(empty)';
            const stroke = ((r.getAttribute('stroke') || '') + '').toLowerCase() || '(empty)';
            const pe = ((r.getAttribute('pointer-events') || '') + '').toLowerCase() || '(empty)';
            fillCounts[fill] = (fillCounts[fill] || 0) + 1;
            strokeCounts[stroke] = (strokeCounts[stroke] || 0) + 1;
            peCounts[pe] = (peCounts[pe] || 0) + 1;
          }
          seatRectStats = {
            allRects: allRects.length,
            fillsTop: topN(fillCounts),
            strokesTop: topN(strokeCounts),
            pointerEventsTop: topN(peCounts)
          };
        }
        const hasActiveSelection = !!(
          document.querySelector('svg.seatmap-svg rect.seatActive') ||
          document.querySelector('svg.seatmap-svg g.seatActive rect')
        );
        return {
          label: lbl,
          title: document.title,
          url: location.href,
          viewport: { w: vw, h: vh, y: window.scrollY || 0 },
          seatmapViewport: rect ? { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right, w: rect.width, h: rect.height, inViewport } : null,
          hasVerifyHuman: bodyText.includes('verify you are human'),
          hasTurnstileWidget: !!document.querySelector('.cf-turnstile'),
          hasTurnstileTokenField: !!document.querySelector('input[name="cf-turnstile-response"]'),
          seatCount: document.querySelectorAll(sel).length,
          selectableCount: selectableRects.length,
          seatRectStats,
          hasActiveSelection,
          hasSeatButton: !!document.getElementById('custom_seat_button')
        };
      }, label, SEAT_NODE_SELECTOR);
      logger.info(`seatPick:${context}:diag`, snap);
    } catch (e) {
      logger.warn(`seatPick:${context}:diag_failed`, { label, error: e?.message || String(e) });
    }
  };

  const ensureSeatmapInView = async (label) => {
    try {
      await page.evaluate((lbl) => {
        const seatmapEl = document.querySelector('svg.seatmap-svg')
          || document.querySelector('#seatmap, .seatmap, .seatmapArea, .seatMap, .seatmap-container')
          || null;
        if (!seatmapEl) return { ok: false, reason: 'no_seatmap_el' };
        try { seatmapEl.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
        const r = seatmapEl.getBoundingClientRect();
        const vh = (window.innerHeight || document.documentElement.clientHeight || 0);
        const vw = (window.innerWidth || document.documentElement.clientWidth || 0);
        const inViewport = (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw);
        return { ok: true, inViewport, rect: { top: r.top, left: r.left, w: r.width, h: r.height }, label: lbl };
      }, label);
    } catch {}
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
  if (!seatMapOk) {
    logger.warn(`seatPick:${context}:seatmap_not_ready`);
    try {
      const frames = (typeof page.frames === 'function') ? page.frames() : [];
      const frameDiag = [];
      for (let i = 0; i < Math.min(frames.length, 8); i++) {
        const f = frames[i];
        let url = '';
        try { url = f.url() || ''; } catch {}
        const d = await f.evaluate((sel) => {
          const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
          const seatNodes = document.querySelectorAll(String(sel || '')).length;
          const hasSvg = !!document.querySelector('svg.seatmap-svg');
          const hasSvgLayout = !!document.querySelector('svg.svgLayout, .svgLayout');
          const hasSeatBtn = !!document.getElementById('custom_seat_button') || Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))
            .some(el => {
              const t = norm(el.innerText || el.textContent || el.value || '');
              return t === 'seçimi değiştir' || t.includes('kendim seçmek istiyorum');
            });
          const hasIframe = !!document.querySelector('iframe');
          const hasCanvas = !!document.querySelector('canvas');
          return { seatNodes, hasSvg, hasSvgLayout, hasSeatBtn, hasIframe, hasCanvas, title: document.title };
        }, SEAT_NODE_SELECTOR).catch(() => null);
        frameDiag.push({ idx: i, url: url ? url.slice(0, 140) : '', diag: d });
      }
      logger.warn(`seatPick:${context}:seatmap_frame_diag`, { frameCount: frames.length, frameDiag });
    } catch {}
  }
  await ensureSeatmapInView('afterOpenSeatMapStrict');
  await diag('afterOpenSeatMapStrict');
  await page.evaluate(()=>{ window.__passobot = {clicked:false, done:false}; });

  let lockedSeat = null;
  let lockedMiss = 0;
  let seatPickQueue = [];
  let lastContinueAttemptAt = 0;
  let lastContinueClickedAt = 0;
  let turnstileWarmStartedAt = 0;
  let lastTurnstileBlockingAt = 0;
  let lastTurnstileFreshCheckAt = 0;
  let lastChallengeRecoverAt = 0;
  let postContinueVerifyUntil = 0;
  let postContinueRetryCount = 0;
  let noSeatStreak = 0;
  let lastRecoverAt = 0;
  let noSelectableStreak = 0;
  let lastNoSelectableActionAt = 0;
  let lastSeatmapUnlockAt = 0;
  let seatmapUnlockAttempts = 0;

  const POST_CONTINUE_VERIFY_MS = 45000;
  const POST_CONTINUE_STUCK_MS = 45000;
  const POST_CONTINUE_TRANSITION_GRACE_MS = 60000;

  const tryPickAdditionalSeat = async () => {
    try {
      await awaitTurnstileGapForSeatMap(page, context, email, ensureTurnstileFn, 'beforeAdditionalSeat');
    } catch {}
    try {
      const info = await page.evaluate(() => {
        const normFill = (r) => {
          const attr = (r.getAttribute('fill') || '').toLowerCase();
          if (attr) return attr;
          const st = (r.getAttribute('style') || '').toLowerCase();
          const m = st.match(/fill\s*:\s*([^;]+)/i);
          return (m && m[1] ? m[1].trim() : '');
        };
        const selectedNow = Array.from(document.querySelectorAll(
          'circle.seat-circle.selected, circle.seat-circle[aria-pressed="true"], [data-selected="true"], svg.seatmap-svg rect.seatActive, svg.seatmap-svg g.seatActive rect, svg.seatmap-svg g.selected rect, svg.seatmap-svg rect.selected'
        ));

        const rects = Array.from(document.querySelectorAll('svg.seatmap-svg g[id^="seat"] rect'));
        const candidates = rects.filter(r => {
          const pe = (r.getAttribute('pointer-events') || '').toLowerCase();
          if (pe === 'none') return false;
          const cls = (r.getAttribute('class') || '').toLowerCase();
          const fill = normFill(r);
          const opacity = (r.getAttribute('opacity') || '').toLowerCase();
          const style = (r.getAttribute('style') || '').toLowerCase();
          if (opacity === '0' || /opacity\s*:\s*0/.test(style)) return false;
          if (/(occupied|disabled|unavailable|dolu|sold|reserved)/i.test(cls) || fill === '#89a0a3') return false;
          // avoid already selected/active rects
          const g = r.closest('g');
          if (g && (g.classList.contains('seatActive') || g.classList.contains('selected'))) return false;
          if (r.classList.contains('selected') || r.classList.contains('seatActive')) return false;
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

  const tryPickAdjacentSeat = async () => {
    try {
      const info = await page.evaluate(() => {
        const normFill = (r) => {
          const attr = (r.getAttribute('fill') || '').toLowerCase();
          if (attr) return attr;
          const st = (r.getAttribute('style') || '').toLowerCase();
          const m = st.match(/fill\s*:\s*([^;]+)/i);
          return (m && m[1] ? m[1].trim() : '');
        };
        const isAvailable = (r) => {
          const pe = (r.getAttribute('pointer-events') || '').toLowerCase();
          if (pe === 'none') return false;
          const fill = normFill(r);
          if (fill === '#89a0a3') return false;
          const opacity = (r.getAttribute('opacity') || '').toLowerCase();
          const style = (r.getAttribute('style') || '').toLowerCase();
          if (opacity === '0' || /opacity\s*:\s*0/.test(style)) return false;
          const cls = (r.getAttribute('class') || '').toLowerCase();
          if (/(occupied|disabled|unavailable|dolu|sold|reserved)/i.test(cls)) return false;
          const g = r.closest('g');
          if (g && (g.classList.contains('seatActive') || g.classList.contains('selected'))) return false;
          if (r.classList.contains('selected') || r.classList.contains('seatActive')) return false;
          return true;
        };

        // Seçili koltukların g elementlerini bul
        const fromGs = Array.from(document.querySelectorAll('svg.seatmap-svg g.seatActive, svg.seatmap-svg g.selected'));
        const fromRectParents = Array.from(document.querySelectorAll('svg.seatmap-svg rect.seatActive'))
          .map((rr) => rr.closest('g'))
          .filter(Boolean);
        const selectedGs = Array.from(new Set([...fromGs, ...fromRectParents]));
        if (!selectedGs.length) return null;

        // Seçili koltukların pozisyonlarını topla (seatId ve bbox)
        const selectedPositions = [];
        for (const g of selectedGs) {
          const gid = g.getAttribute('id') || '';
          const seatNum = parseInt((gid.match(/seat(\d+)/i) || [])[1] || '0', 10);
          const rect = g.querySelector('rect');
          if (!rect) continue;
          const bb = rect.getBoundingClientRect();
          selectedPositions.push({ seatNum, cx: bb.left + bb.width / 2, cy: bb.top + bb.height / 2, w: bb.width, h: bb.height });
        }
        if (!selectedPositions.length) return null;

        // Tüm available koltukları topla
        const allRects = Array.from(document.querySelectorAll('svg.seatmap-svg g[id^="seat"] rect'));
        const available = [];
        for (const r of allRects) {
          if (!isAvailable(r)) continue;
          const g = r.closest('g');
          if (!g) continue;
          const gid = g.getAttribute('id') || '';
          const seatNum = parseInt((gid.match(/seat(\d+)/i) || [])[1] || '0', 10);
          const bb = r.getBoundingClientRect();
          available.push({ seatNum, cx: bb.left + bb.width / 2, cy: bb.top + bb.height / 2, w: bb.width, h: bb.height, rect: r });
        }
        if (!available.length) return null;

        // Her available koltuk için, seçili koltukların en yakınına olan mesafeyi hesapla
        // Yanyana = aynı satır (y yaklaşık eşit) ve x farkı ~1 koltuk genişliği
        let best = null;
        let bestDist = Infinity;
        for (const av of available) {
          for (const sel of selectedPositions) {
            const dy = Math.abs(av.cy - sel.cy);
            const dx = Math.abs(av.cx - sel.cx);
            // Aynı satır kontrolü: y farkı koltuk yüksekliğinin yarısından az olmalı
            const sameRow = dy < (sel.h * 0.7);
            if (!sameRow) continue;
            // Yanyana kontrolü: x farkı makul aralıkta (1-2 koltuk genişliği)
            if (dx < bestDist && dx < sel.w * 2.5) {
              bestDist = dx;
              best = av;
            }
          }
        }

        // Eğer yanyana bulunamadıysa, seatId bazlı ardışık kontrolü de dene
        if (!best) {
          const selNums = selectedPositions.map(s => s.seatNum).filter(n => n > 0);
          if (selNums.length) {
            const minNum = Math.min(...selNums);
            const maxNum = Math.max(...selNums);
            // seatId-1 veya seatId+1 ara
            const adjacent = available.filter(a => a.seatNum === minNum - 1 || a.seatNum === maxNum + 1);
            if (adjacent.length) best = adjacent[0];
          }
        }

        if (!best) return null;
        best.rect.scrollIntoView({ block: 'center', inline: 'center' });
        const bb = best.rect.getBoundingClientRect();
        const cx = bb.left + (bb.width / 2);
        const cy = bb.top + (bb.height / 2);
        if (cy <= 10 || cx <= 10 || cy >= window.innerHeight - 10 || cx >= window.innerWidth - 10) return null;
        return { x: cx, y: cy, seatNum: best.seatNum, distance: bestDist };
      });

      if (!info) return false;
      const clicked = await robustSeatClick(page, info.x, info.y);
      if (!clicked) return false;
      logger.info(`seatPick:${context}:adjacent_seat_click`, { seatNum: info.seatNum, x: info.x, y: info.y, distance: info.distance });
      await delay(250);
      return true;
    } catch {
      return false;
    }
  };

  // During sold-out sniping we need to react immediately when a seat is released.
  // This picks a fresh visible seat candidate (no lockedSeat reuse) and clicks it.
  const trySnipeFreshSeatNow = async () => {
    try {
      const info = await page.evaluate(() => {
        const normFill = (r) => {
          const attr = (r.getAttribute('fill') || '').toLowerCase();
          if (attr) return attr;
          const st = (r.getAttribute('style') || '').toLowerCase();
          const m = st.match(/fill\s*:\s*([^;]+)/i);
          return (m && m[1] ? m[1].trim() : '');
        };
        const rects = Array.from(document.querySelectorAll('svg.seatmap-svg g[id^="seat"] rect'));
        const candidates = rects.filter(r => {
          const pe = (r.getAttribute('pointer-events') || '').toLowerCase();
          if (pe === 'none') return false;
          const fill = normFill(r);
          if (fill === '#89a0a3') return false;
          const cls = (r.getAttribute('class') || '').toLowerCase();
          if (/(occupied|disabled|unavailable|dolu|sold|reserved)/i.test(cls)) return false;
          const g = r.closest('g');
          if (g && (g.classList.contains('seatActive') || g.classList.contains('selected'))) return false;
          if (r.classList.contains('selected') || r.classList.contains('seatActive')) return false;
          return true;
        });
        if (!candidates.length) return null;
        const r0 = candidates[0];
        try { r0.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
        const bb = r0.getBoundingClientRect();
        const cx = bb.left + (bb.width / 2);
        const cy = bb.top + (bb.height / 2);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
        if (cx <= 8 || cy <= 8 || cx >= (window.innerWidth - 8) || cy >= (window.innerHeight - 8)) return null;
        const gid = r0.closest('g')?.getAttribute('id') || '';
        const seatId = (gid.match(/seat(\d+)/i) || [])[1] || null;
        return { x: cx, y: cy, seatId };
      }).catch(() => null);

      if (!info) return false;
      lockedSeat = null; // force fresh selection path after snipe click

      let clicked = false;
      if (info.seatId) clicked = await clickSeatById(page, info.seatId);
      if (!clicked) clicked = await robustSeatClick(page, info.x, info.y);
      if (!clicked) return false;

      const selected = await page.waitForFunction((sel) => !!document.querySelector(sel), { timeout: 1200 }, SELECTED_SEAT_SELECTOR)
        .then(() => true)
        .catch(() => false);
      logger.info(`seatPick:${context}:snipe_fresh_click`, { seatId: info.seatId, x: info.x, y: info.y, selected });
      return selected;
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
          const root = document.querySelector('svg.seatmap-svg');
          const g = root && seatId
            ? (root.querySelector(`g#seat${seatId}`) || root.querySelector(`g#g${seatId}`) || root.querySelector(`g[id="seat${seatId}"]`) || root.querySelector(`g[id="g${seatId}"]`))
            : null;
          const r = g ? g.querySelector('rect') : null;
          if (g && (g.classList.contains('seatActive') || /\bseatActive\b/i.test(g.getAttribute('class') || ''))) return true;
          if (g && (g.classList.contains('selected') || /selected/i.test(g.getAttribute('class') || ''))) return true;
          if (r && (r.classList.contains('seatActive') || /\bseatActive\b/i.test(r.getAttribute('class') || ''))) return true;
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
          const root = document.querySelector('svg.seatmap-svg');
          const g = root
            ? (root.querySelector(`g#seat${seatId}`) || root.querySelector(`g#g${seatId}`) || root.querySelector(`g[id="seat${seatId}"]`) || root.querySelector(`g[id="g${seatId}"]`))
            : null;
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

  const readChallengeBlockState = async () => {
    try {
      return await page.evaluate(() => {
        const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
        const cont = document.querySelector('.swal2-container.swal2-shown, .swal2-container.swal2-backdrop-show');
        const txt = cont ? norm(cont.innerText || '') : '';
        const challengeModal = !!txt && (
          txt.includes('güvenlik doğrulaması başarısız') ||
          txt.includes('verify') ||
          txt.includes('human') ||
          txt.includes('captcha')
        );
        const tsField = document.querySelector('input[name="cf-turnstile-response"]');
        const tokenLen = tsField && tsField.value ? String(tsField.value).length : 0;
        const hasWidget = !!document.querySelector('.cf-turnstile');
        return { challengeModal, modalText: txt || null, hasWidget, hasTokenField: !!tsField, tokenLen };
      });
    } catch {
      return { challengeModal: false, modalText: null, hasWidget: false, hasTokenField: false, tokenLen: 0 };
    }
  };

  const recoverChallengeIfNeeded = async (label) => {
    const st = await readChallengeBlockState();
    const needs = !!st.challengeModal || (!!st.hasWidget && st.tokenLen < 80);
    if (!needs) return false;
    const now = Date.now();
    if (now - lastChallengeRecoverAt < 4500) return false;
    lastChallengeRecoverAt = now;
    logger.warn(`seatPick:${context}:challenge_block_detected`, { label, ...st });
    try {
      if (st.challengeModal) await confirmSwalYes(page, 6000);
    } catch {}
    if (ensureTurnstileFn && email) {
      try {
        const t0 = Date.now();
        await ensureTurnstileFn(page, email, `seatPick:${context}:challengeRecover:${label}`, { background: false, recaptchaFallback: false });
        const dt = Date.now() - t0;
        if (dt > 1200) extendDeadline(Math.min(12000, dt + 2000), 'challenge_recover_turnstile');
      } catch (e) {
        logger.warn(`seatPick:${context}:challenge_recover_turnstile_failed`, { label, error: e?.message || String(e) });
      }
    }
    try { await openSeatMapStrict(page); } catch {}
    if (lockedSeat?.seatId) releaseSeatId(seatClaimGroupKey, seatClaimOwner, lockedSeat.seatId);
    lockedSeat = null;
    lockedMiss = 0;
    await delay(260);
    return true;
  };

  while (Date.now() < end) {
      const nw = basketWatcher.getLatest();
      if (nw && nw.data && await canTreatBasketAsSuccess(nw.data, 'networkLatest')) return nw.data;
      await ensureOnSeatPage('loop');
      await recoverChallengeIfNeeded('loop_start');
      await diag('loop');

      const selectableState = await page.evaluate(() => {
        const normFill = (r) => {
          const attr = (r.getAttribute('fill') || '').toLowerCase();
          if (attr) return attr;
          const st = (r.getAttribute('style') || '').toLowerCase();
          const m = st.match(/fill\s*:\s*([^;]+)/i);
          return (m && m[1] ? m[1].trim() : '');
        };
        const allRects = Array.from(document.querySelectorAll('svg.seatmap-svg g[id^="seat"] rect'));
        const selectableRects = allRects.filter(r => {
          const pe = (r.getAttribute('pointer-events') || '').toLowerCase();
          if (pe === 'none') return false;
          const fill = normFill(r);
          if (fill === '#89a0a3') return false;
          const opacity = (r.getAttribute('opacity') || '').toLowerCase();
          const style = (r.getAttribute('style') || '').toLowerCase();
          if (opacity === '0' || /opacity\s*:\s*0/.test(style)) return false;
          const cls = (r.getAttribute('class') || '').toLowerCase();
          if (/(occupied|disabled|unavailable|dolu|sold|reserved)/i.test(cls)) return false;
          return true;
        });

        // Provide extra diag when seatmap exists but we detect 0 selectable seats.
        let diag = null;
        if (allRects.length && selectableRects.length === 0) {
          const fillCounts = {};
          for (const r of allRects) {
            const fill = (String(normFill(r) || '').toLowerCase()) || '(empty)';
            fillCounts[fill] = (fillCounts[fill] || 0) + 1;
          }
          diag = {
            allRects: allRects.length,
            fillsTop: Object.entries(fillCounts).sort((a, b) => (b[1] || 0) - (a[1] || 0)).slice(0, 8).map(([k, v]) => ({ k, v }))
          };
        }

        return { seatmapPresent: !!document.querySelector('svg.seatmap-svg'), selectableCount: selectableRects.length, diag };
      }).catch(() => null);

      if (selectableState && selectableState.seatmapPresent && selectableState.selectableCount <= 0) {
        noSelectableStreak++;
      } else {
        noSelectableStreak = 0;
      }

      // If at least one seat is now selectable, don't keep stale/off-screen locks.
      if (selectableState && selectableState.seatmapPresent && Number(selectableState.selectableCount || 0) > 0 && lockedSeat) {
        const stale = await page.evaluate((seat) => {
          if (!seat) return true;
          const x = Number(seat.x);
          const y = Number(seat.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
          const vw = window.innerWidth || 0;
          const vh = window.innerHeight || 0;
          if (x <= 8 || y <= 8 || x >= (vw - 8) || y >= (vh - 8)) return true;
          return false;
        }, lockedSeat).catch(() => true);
        if (stale) {
          logger.info(`seatPick:${context}:lock_cleared_stale_when_selectable`, { lockedSeat, selectableCount: selectableState.selectableCount });
          lockedSeat = null;
          lockedMiss = 0;
        }
      }

      if (noSelectableStreak >= 3) {
        const now = Date.now();
        if (now - lastNoSelectableActionAt > 8000) {
          lastNoSelectableActionAt = now;
          logger.warn(`seatPick:${context}:no_selectable_seats_back`, { noSelectableStreak, selectableState });

          // Heuristic: if the seatmap exists but is overwhelmingly gray/disabled, this is usually
          // a true "no seats" situation (not a captcha lock). In that case, do NOT try unlock/reload;
          // bubble up NO_SELECTABLE_SEATS so the caller can reselect category/block.
          const soldOutLike = (() => {
            try {
              const diag = selectableState?.diag;
              const allRects = Number(diag?.allRects || 0);
              const top = Array.isArray(diag?.fillsTop) ? diag.fillsTop[0] : null;
              const topFill = String(top?.k || '').toLowerCase();
              const topCount = Number(top?.v || 0);
              if (!allRects || !topFill) return false;
              // #89a0a3 is the common "unavailable" fill in Passo seatmaps.
              if (topFill === '#89a0a3' && (topCount / allRects) >= 0.92) return true;
              return false;
            } catch {
              return false;
            }
          })();

          // Packed match "snipe" mode:
          // If the map looks sold-out, reselecting blocks is slow (loader), and we can miss seats
          // that are freed from other users' baskets. Poll the current seatmap for a short window.
          if (soldOutLike) {
            const snipeMaxMs = Number(getCfg()?.TIMEOUTS?.SEAT_SNIPE_MAX_MS || 0) || 0;
            const pollMs = Number(getCfg()?.TIMEOUTS?.SEAT_SNIPE_POLL_MS || 0) || 350;
            const roamMs = Number(getCfg()?.TIMEOUTS?.SVG_CATEGORY_ROAM_MS || 0) || 0;
            if (snipeMaxMs > 0) {
              const until = Date.now() + snipeMaxMs;
              let lastRoamAt = 0;
              logger.info(`seatPick:${context}:snipe_wait_start`, { snipeMaxMs, pollMs });
              while (Date.now() < until) {
                try {
                  await ensureOnSeatPage('snipe_wait');
                } catch {}

                // SVG category roam: do not stay on the same category longer than roamMs.
                if (roamMs > 0 && roamCategoryTexts.length >= 2) {
                  const now2 = Date.now();
                  if (!lastRoamAt || (now2 - lastRoamAt) >= roamMs) {
                    lastRoamAt = now2;
                    try {
                      const roamRes = await page.evaluate((texts) => {
                        const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                        const isVisible = (el) => {
                          if (!el) return false;
                          const st = window.getComputedStyle(el);
                          if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                          const r = el.getBoundingClientRect?.();
                          if (!r) return true;
                          return r.width > 6 && r.height > 6;
                        };
                        const tNorms = (texts || []).map(norm).filter(Boolean);
                        if (tNorms.length < 2) return { ok: false, reason: 'texts_insufficient' };

                        const btns = Array.from(document.querySelectorAll('button, a, [role="tab"], [role="button"], li, div'))
                          .filter(isVisible)
                          .slice(0, 400);
                        const candidates = btns
                          .map((el) => {
                            const t = norm(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
                            return { el, t };
                          })
                          .filter(x => x.t && tNorms.some(tt => x.t.includes(tt)));
                        if (!candidates.length) return { ok: false, reason: 'no_candidates' };

                        // Try to infer current active category by aria-selected/active class.
                        let activeText = '';
                        try {
                          const active = candidates.find(x => x.el.getAttribute('aria-selected') === 'true')
                            || candidates.find(x => (x.el.getAttribute('class') || '').toLowerCase().includes('active'))
                            || null;
                          activeText = active ? active.t : '';
                        } catch {}

                        // Pick a different category than current active (simple round-robin: first that differs)
                        const pick = candidates.find(x => x.t && x.t !== activeText) || candidates[0];
                        try { pick.el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
                        try { pick.el.click(); } catch {}
                        return { ok: true, clickedText: pick.t, activeText };
                      }, roamCategoryTexts);
                      if (roamRes && roamRes.ok) {
                        logger.info(`seatPick:${context}:svg_category_roam`, roamRes);
                      }
                    } catch {}
                  }
                }

                try {
                  const st = await page.evaluate(() => {
                    const allRects = Array.from(document.querySelectorAll('svg.seatmap-svg g[id^="seat"] rect'));
                    const normFill = (r) => {
                      const attr = (r.getAttribute('fill') || '').toLowerCase();
                      if (attr) return attr;
                      const s = (r.getAttribute('style') || '').toLowerCase();
                      const m = s.match(/fill\s*:\s*([^;]+)/i);
                      return (m && m[1] ? m[1].trim() : '');
                    };
                    let selectable = 0;
                    for (const r of allRects) {
                      const pe = (r.getAttribute('pointer-events') || '').toLowerCase();
                      if (pe === 'none') continue;
                      const fill = normFill(r);
                      if (fill === '#89a0a3') continue;
                      const cls = (r.getAttribute('class') || '').toLowerCase();
                      if (/(occupied|disabled|unavailable|dolu|sold|reserved)/i.test(cls)) continue;
                      selectable++;
                      if (selectable >= 1) break;
                    }
                    return { all: allRects.length, selectable };
                  }).catch(() => null);
                  if (st && Number(st.selectable || 0) > 0) {
                    logger.info(`seatPick:${context}:snipe_wait_hit`, st);
                    noSelectableStreak = 0;
                    // Seat just became available; attempt immediate click before it disappears again.
                    try {
                      const sniped = await trySnipeFreshSeatNow();
                      if (sniped) {
                        // Keep going in outer loop for continue/basket verification.
                      }
                    } catch {}
                    break;
                  }
                } catch {}
                await delay(Math.max(120, pollMs));
              }
              logger.info(`seatPick:${context}:snipe_wait_end`);
              if (noSelectableStreak === 0) {
                continue;
              }
            }
          }

          // If seat nodes exist but ALL seat rects are non-interactive (pointer-events:none), the seatmap is effectively locked.
          // In that case, try a limited unlock recovery (turnstile + re-open seat map) instead of immediately failing.
          const lockDiag = await page.evaluate(() => {
            const rects = Array.from(document.querySelectorAll('svg.seatmap-svg g[id^="seat"] rect'));
            if (!rects.length) return { allRects: 0, peNone: 0, peNoneRatio: 0 };
            let peNone = 0;
            for (const r of rects) {
              const pe = (r.getAttribute('pointer-events') || '').toLowerCase();
              if (pe === 'none') peNone++;
            }
            return { allRects: rects.length, peNone, peNoneRatio: peNone / rects.length };
          }).catch(() => null);

          if (!soldOutLike && lockDiag && lockDiag.allRects > 0 && lockDiag.peNoneRatio >= 0.98) {
            const unlockCooldownMs = 12000;
            if (seatmapUnlockAttempts < 3 && (now - lastSeatmapUnlockAt) > unlockCooldownMs) {
              seatmapUnlockAttempts++;
              lastSeatmapUnlockAt = now;
              logger.warn(`seatPick:${context}:seatmap_locked_unlock_attempt`, { attempt: seatmapUnlockAttempts, lockDiag });

              if (ensureTurnstileFn && email) {
                try {
                  const t0 = Date.now();
                  await ensureTurnstileFn(page, email, `seatPick:${context}:seatmapUnlock${seatmapUnlockAttempts}`, { background: false });
                  const dt = Date.now() - t0;
                  extendDeadline(dt + 6000, 'turnstile_seatmap_unlock');
                } catch {}
              }

              try { await openSeatMapStrict(page); } catch {}

              // If still locked, try a UI reset (go back to layout and re-enter self-select).
              try {
                const stillLocked = await page.evaluate(() => {
                  const rects = Array.from(document.querySelectorAll('svg.seatmap-svg g[id^="seat"] rect'));
                  if (!rects.length) return false;
                  let peNone = 0;
                  for (const r of rects) {
                    const pe = (r.getAttribute('pointer-events') || '').toLowerCase();
                    if (pe === 'none') peNone++;
                  }
                  return (peNone / rects.length) >= 0.98;
                }).catch(() => false);

                if (stillLocked) {
                  logger.warn(`seatPick:${context}:seatmap_locked_ui_reset`, { attempt: seatmapUnlockAttempts });
                  await page.evaluate(() => {
                    const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                    const btns = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], div[role="button"]'));
                    const change = btns.find(b => norm(b.innerText || b.textContent || b.value || '') === 'seçimi değiştir');
                    if (change) { try { change.click(); } catch {} return; }
                    const back = btns.find(b => norm(b.innerText || b.textContent || b.value || '').includes('geri dön'));
                    if (back) { try { back.click(); } catch {} }
                  }).catch(() => {});
                  await delay(800);
                  try { await openSeatMapStrict(page); } catch {}
                }
              } catch {}

              // If UI reset didn't help and we have a recoveryUrl, do a soft reload back to seat page.
              try {
                const stillLocked2 = await page.evaluate(() => {
                  const rects = Array.from(document.querySelectorAll('svg.seatmap-svg g[id^="seat"] rect'));
                  if (!rects.length) return false;
                  let peNone = 0;
                  for (const r of rects) {
                    const pe = (r.getAttribute('pointer-events') || '').toLowerCase();
                    if (pe === 'none') peNone++;
                  }
                  return (peNone / rects.length) >= 0.98;
                }).catch(() => false);
                if (stillLocked2 && recoveryUrl) {
                  logger.warn(`seatPick:${context}:seatmap_locked_soft_reload`, { attempt: seatmapUnlockAttempts, recoveryUrl });
                  try { await page.goto(String(recoveryUrl), { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch {}
                  await delay(600);
                  if (ensureTurnstileFn && email) {
                    try {
                      logger.info(`seatPick:${context}:seatmap_unlock_reload_turnstile_ensure_start`, { attempt: seatmapUnlockAttempts });
                      // After reload the widget can mount late; wait a bit so ensureTurnstileFn actually runs.
                      await page.waitForFunction(() => {
                        return !!document.querySelector('.cf-turnstile') || !!document.querySelector('input[name="cf-turnstile-response"]') || !!document.querySelector('iframe[src*="recaptcha"]') || !!document.querySelector('.g-recaptcha');
                      }, { timeout: 8000 }).catch(() => {});
                      await ensureTurnstileFn(page, email, `seatPick:${context}:seatmapUnlockReload${seatmapUnlockAttempts}`, { background: false });
                      logger.info(`seatPick:${context}:seatmap_unlock_reload_captcha_ensure_done`, { attempt: seatmapUnlockAttempts });
                    } catch (e) {
                      logger.warn(`seatPick:${context}:seatmap_unlock_reload_turnstile_ensure_failed`, { attempt: seatmapUnlockAttempts, error: e?.message || String(e) });
                    }
                  }
                  try { await openSeatMapStrict(page); } catch {}
                }
              } catch {}

              await delay(700);
              noSelectableStreak = 0;
              continue;
            }
          }

          try {
            await page.evaluate(() => {
              const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
              const btns = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
              const change = btns.find(b => norm(b.innerText || b.textContent || b.value || '') === 'seçimi değiştir');
              if (change) { try { change.click(); } catch {} return; }
              const back = btns.find(b => norm(b.innerText || b.textContent || b.value || '').includes('geri dön'));
              if (back) { try { back.click(); } catch {} }
            });
          } catch {}

          try {
            await page.waitForFunction(() => {
              const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
              const els = Array.from(document.querySelectorAll('button, a, [role="button"], div[role="button"], input[type="button"], input[type="submit"]'));
              const hasSelfSelect = els.some(x => norm(x.innerText || x.textContent || x.value || '').includes('kendim seçmek istiyorum'));
              const hasLayout = !!document.querySelector('svg.svgLayout, .svgLayout');
              const hasLegacy = !!document.querySelector('.custom-select-box');
              return hasSelfSelect || hasLayout || hasLegacy;
            }, { timeout: 15000 });
          } catch {}
          throw new Error(formatError('NO_SELECTABLE_SEATS'));
        }
      }

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
        if (b && (b.row && b.seat) && await canTreatBasketAsSuccess(b, 'postContinueVerify')) return b;
        if (b && b.inBasket && isBasketLikeUrl(b.url) && await canTreatBasketAsSuccess(b, 'postContinueVerify')) return b;
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
              await ensureTurnstileFn(page, email, `seatPick:${context}:postContinueRetry${postContinueRetryCount}`, { background: true });
            } catch {}
          }
          if (ticketCount > 1) {
            let ddR = null;
            try {
              ddR = await applyTicketQuantityDropdown(page, context, ticketCount, {
                appearMaxMs: skipQtyAppearLongWait ? 0 : PASSO_QTY_SELECT_APPEAR_MAX_MS,
                readOnly: quantitySelectionMode === 'outsideSeat'
              });
              if (ddR && ddR.ok) {
                if (quantitySelectionMode === 'duringSeat') {
                  await reclickActiveSeatAfterQuantityChange(page, context, { email, ensureTurnstileFn });
                }
                const needR = ticketCount;
                const maxAvR = Number(ddR.maxAvailable) || needR;
                const targetQtyR = Math.min(needR, maxAvR);
                const gotR = quantitySelectionMode === 'outsideSeat'
                  ? (Number(ddR.currentNum) || 0)
                  : (Number(ddR.pick) || 0);
                const readyR = quantitySelectionMode === 'outsideSeat'
                  ? ddR.selectedMatchesTarget === true
                  : gotR === targetQtyR;
                if (!readyR) {
                  logger.warn(`seatPick:${context}:post_continue_retry_blocked_qty`, { gotR, targetQtyR, ticketCount });
                  await delay(400);
                  continue;
                }
              } else {
                const gsR = await getSelectionState();
                if ((gsR?.selectedCount || 0) < ticketCount) {
                  logger.warn(`seatPick:${context}:post_continue_retry_blocked_seats`, { selectedCount: gsR?.selectedCount, ticketCount });
                  await delay(400);
                  continue;
                }
              }
            } catch {
              await delay(400);
              continue;
            }
            if (ddR?.appearPollExhausted) skipQtyAppearLongWait = true;
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

          // After soft reloads or route changes, Turnstile token field can disappear.
          // Without a token the seatmap may never mount; resolve token before reopening the seatmap.
          if (ensureTurnstileFn && email) {
            let tokenState = null;
            try {
              const tokenState0 = await page.evaluate(() => {
                const field = document.querySelector('input[name="cf-turnstile-response"]');
                const hasToken = field && field.value && field.value.length > 100;
                const hasWidget = !!document.querySelector('.cf-turnstile');
                return { hasToken, hasWidget, hasTokenField: !!field, tokenLen: field?.value?.length || 0 };
              }).catch(() => null);

              // If the token field/widget isn't mounted yet, give it a short chance to appear.
              if (tokenState0 && !tokenState0.hasToken && (!tokenState0.hasWidget && !tokenState0.hasTokenField)) {
                await page.waitForFunction(() => {
                  return !!document.querySelector('.cf-turnstile') || !!document.querySelector('input[name="cf-turnstile-response"]') || !!document.querySelector('iframe[src*="recaptcha"]') || !!document.querySelector('.g-recaptcha');
                }, { timeout: 8000 }).catch(() => {});
              }

              tokenState = await page.evaluate(() => {
                const field = document.querySelector('input[name="cf-turnstile-response"]');
                const hasToken = field && field.value && field.value.length > 100;
                const hasWidget = !!document.querySelector('.cf-turnstile');
                return { hasToken, hasWidget, hasTokenField: !!field, tokenLen: field?.value?.length || 0 };
              }).catch(() => tokenState0);
            } catch (e) {
              logger.warn(`seatPick:${context}:seatmap_recover_turnstile_state_eval_failed`, { error: e?.message || String(e) });
            }

            // Deterministic: if we cannot prove we have a token, try blocking ensure.
            if (!tokenState || !tokenState.hasToken) {
              logger.info(`seatPick:${context}:seatmap_recover_turnstile_state`, tokenState);
              logger.info(`seatPick:${context}:seatmap_recover_turnstile_blocking`, tokenState);
              try {
                const t0 = Date.now();
                await ensureTurnstileFn(page, email, `seatPick:${context}:seatmapRecover`, { background: false });
                const dt = Date.now() - t0;
                extendDeadline(dt + 6000, 'turnstile_seatmap_recover');
              } catch (e) {
                logger.warn(`seatPick:${context}:seatmap_recover_turnstile_blocking_failed`, { error: e?.message || String(e) });
              }

              // After CAPTCHA solve, the page may have unlocked (dropdown appeared).
              // Re-do category/block selection so seatmap can load.
              if (chooseCategoryFn && roamCategoryTexts.length > 0) {
                try {
                  const hasDropdown = await page.evaluate(() => {
                    return !!document.querySelector('.custom-select-box, select option, .dropdown-option');
                  }).catch(() => false);
                  if (hasDropdown) {
                    logger.info(`seatPick:${context}:seatmap_recover_reselect_category`, { cats: roamCategoryTexts });
                    await chooseCategoryFn(page, roamCategoryTexts[0], roamCategoryTexts[1] || '', categorySelectionMode, { reapplyLastCommitted: true });
                    if (quantitySelectionMode === 'outsideSeat' && ticketCount > 1) {
                      const qtyAfterReselect = await applyTicketQuantityDropdown(page, context, ticketCount, {
                        appearMaxMs: PASSO_QTY_SELECT_APPEAR_MAX_MS
                      });
                      ticketQtyPrimed = qtyAfterReselect?.ok === true;
                      skipQtyAppearLongWait = !!qtyAfterReselect?.appearPollExhausted;
                    } else {
                      ticketQtyPrimed = false;
                      skipQtyAppearLongWait = false;
                    }
                    extendDeadline(8000, 'category_reselect_after_captcha');
                  }
                } catch (e) {
                  logger.warn(`seatPick:${context}:seatmap_recover_reselect_category_failed`, { error: e?.message || String(e) });
                }
              }
            }
          }

          // After soft reload, the selected SVG block context can be lost; re-click the last block to re-mount seatmap.
          try {
            const bid = await page.evaluate(() => {
              try { return String(window.__passobotLastSvgBlockId || '').trim(); } catch { return ''; }
            }).catch(() => '');
            if (bid) {
              const pt = await page.evaluate((id) => {
                const el = document.getElementById(String(id || ''));
                if (!el) return null;
                try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
                try {
                  const r = el.getBoundingClientRect();
                  const x = r.left + (r.width / 2);
                  const y = r.top + (r.height / 2);
                  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
                  return { x, y, w: r.width, h: r.height, tag: el.tagName };
                } catch {
                  return null;
                }
              }, bid).catch(() => null);
              if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
                logger.warn(`seatPick:${context}:seatmap_recover_reclick_block`, { blockId: bid, pt });
                try {
                  await page.mouse.move(pt.x, pt.y);
                  await page.mouse.down();
                  await page.mouse.up();
                } catch {}
                await delay(450);
              }
            }
          } catch {}

          const ok = await openSeatMapStrict(page);
          if (!ok) logger.warn(`seatPick:${context}:seatmap_recover_failed`);

          // If reopen failed and we have a recoveryUrl, do one navigation attempt and retry once.
          if (!ok && recoveryUrl) {
            try {
              await page.goto(String(recoveryUrl), { waitUntil: 'domcontentloaded', timeout: 45000 });
              await delay(600);
              if (ensureTurnstileFn && email) {
                await page.waitForFunction(() => {
                  return !!document.querySelector('.cf-turnstile') || !!document.querySelector('input[name="cf-turnstile-response"]') || !!document.querySelector('iframe[src*="recaptcha"]') || !!document.querySelector('.g-recaptcha');
                }, { timeout: 8000 }).catch(() => {});
                try {
                  await ensureTurnstileFn(page, email, `seatPick:${context}:seatmapRecoverNav`, { background: false });
                } catch (e) {
                  if (e && /detached|Target closed|Sayfa oturumu sonlandı/i.test(String(e.message))) throw e;
                }
              }
              // After nav + CAPTCHA solve, redo category/block selection
              if (chooseCategoryFn && roamCategoryTexts.length > 0) {
                try {
                  const hasDropdown = await page.evaluate(() => {
                    return !!document.querySelector('.custom-select-box, select option, .dropdown-option');
                  }).catch(() => false);
                  if (hasDropdown) {
                    logger.info(`seatPick:${context}:seatmap_recoverNav_reselect_category`, { cats: roamCategoryTexts });
                    await chooseCategoryFn(page, roamCategoryTexts[0], roamCategoryTexts[1] || '', categorySelectionMode, { reapplyLastCommitted: true });
                    if (quantitySelectionMode === 'outsideSeat' && ticketCount > 1) {
                      const qtyAfterReselect = await applyTicketQuantityDropdown(page, context, ticketCount, {
                        appearMaxMs: PASSO_QTY_SELECT_APPEAR_MAX_MS
                      });
                      ticketQtyPrimed = qtyAfterReselect?.ok === true;
                      skipQtyAppearLongWait = !!qtyAfterReselect?.appearPollExhausted;
                    } else {
                      ticketQtyPrimed = false;
                      skipQtyAppearLongWait = false;
                    }
                    extendDeadline(8000, 'category_reselect_after_nav');
                  }
                } catch (e) {
                  logger.warn(`seatPick:${context}:seatmap_recoverNav_reselect_category_failed`, { error: e?.message || String(e) });
                }
              }
              await openSeatMapStrict(page);
            } catch {}
          }

          // Give the seatmap a chance to mount after reopening.
          try {
            await page.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, { timeout: 8000 }, SEAT_NODE_SELECTOR);
          } catch {}
          await delay(500);
        }
      }

      // zaten sepette mi? (seat selection sayfasındaki yanlış pozitifleri engelle)
      const b0 = await readBasketData(page);
      if (b0 && (b0.row && b0.seat) && await canTreatBasketAsSuccess(b0, 'loopStart')) return b0;
      if (b0 && b0.inBasket && isBasketLikeUrl(b0.url) && await canTreatBasketAsSuccess(b0, 'loopStart')) return b0;

      if (quantitySelectionMode === 'duringSeat' && ticketCount > 1 && !ticketQtyPrimed) {
        const earlyDd = await applyTicketQuantityDropdown(page, context, ticketCount, {
          appearMaxMs: skipQtyAppearLongWait ? 0 : PASSO_QTY_SELECT_APPEAR_MAX_MS
        });
        if (earlyDd?.ok) {
          ticketQtyPrimed = true;
          const hasSelEarly = await page.evaluate((sel) => !!document.querySelector(sel), SELECTED_SEAT_SELECTOR);
          if (hasSelEarly) await reclickActiveSeatAfterQuantityChange(page, context, { email, ensureTurnstileFn });
        }
        if (earlyDd?.appearPollExhausted) skipQtyAppearLongWait = true;
      }

      // seçili koltuk varsa tekrar TIKLAMA YOK
      const hasSelected = await page.evaluate((sel) => !!document.querySelector(sel), SELECTED_SEAT_SELECTOR);
      if (!hasSelected) {
          let clickInfo = lockedSeat;
          if (!clickInfo && seatSelectionMode === 'deterministic' && Array.isArray(seatPickQueue) && seatPickQueue.length) {
            clickInfo = seatPickQueue.shift();
          }

          if (!clickInfo) {
          const claimedSeatIds = getClaimedSeatIds(seatClaimGroupKey, seatClaimOwner);
          const picked = await page.evaluate((sel, mode, excludedSeatIds) => {
              const excluded = new Set(Array.isArray(excludedSeatIds) ? excludedSeatIds.map(x => String(x)) : []);
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

                      // Available seat colors are dynamic; rely on interactivity and later selection verification.
                      // Keep a light guard to avoid obvious non-seat placeholders.
                      if (!fill || fill === '#000000') {
                        // If fill is empty/black, still allow when cursor suggests clickability.
                        return !!cur && cur !== 'none';
                      }
                      return true;
                  });
                  if (!clickable.length) return null;
                  const normToken = (t) => String(t || '').replace(/\s+/g, ' ').trim();
                  const parseRowSeat = (txt) => {
                    const s = normToken(txt).toLowerCase();
                    if (!s) return { row: null, seat: null };
                    const rowM = s.match(/\b(?:sıra|sira|row)\s*[:#-]?\s*([a-z0-9çğıöşü]+)\b/i);
                    const seatM = s.match(/\b(?:koltuk|seat)\s*[:#-]?\s*([a-z0-9çğıöşü]+)\b/i);
                    return {
                      row: rowM && rowM[1] ? normToken(rowM[1]) : null,
                      seat: seatM && seatM[1] ? normToken(seatM[1]) : null
                    };
                  };
                  const toNumOrNull = (v) => {
                    const s = String(v || '').trim();
                    if (!s) return null;
                    if (!/^\d+$/.test(s)) return null;
                    const n = parseInt(s, 10);
                    return Number.isFinite(n) ? n : null;
                  };
                  const cmpToken = (a, b) => {
                    const an = toNumOrNull(a);
                    const bn = toNumOrNull(b);
                    if (an != null && bn != null) return an - bn;
                    if (an != null && bn == null) return -1;
                    if (an == null && bn != null) return 1;
                    return String(a || '').localeCompare(String(b || ''), 'tr', { numeric: true, sensitivity: 'base' });
                  };

                  const items = clickable.map((r0) => {
                    const g = r0.closest('g');
                    const gid = g?.getAttribute('id') || '';
                    const seatId = (gid.match(/seat(\d+)/i) || [])[1] || null;
                    let labelText = '';
                    try { labelText = String(g?.getAttribute('aria-label') || r0.getAttribute('aria-label') || ''); } catch {}
                    if (!labelText) {
                      try { labelText = String(g?.querySelector?.('title')?.textContent || r0.querySelector?.('title')?.textContent || ''); } catch {}
                    }
                    const dataRow = g?.getAttribute?.('data-row') || r0.getAttribute?.('data-row') || g?.getAttribute?.('data-rowname') || r0.getAttribute?.('data-rowname') || '';
                    const dataSeat = g?.getAttribute?.('data-seat') || r0.getAttribute?.('data-seat') || g?.getAttribute?.('data-seatname') || r0.getAttribute?.('data-seatname') || '';
                    const parsed = parseRowSeat(labelText);
                    const row = (dataRow && normToken(dataRow)) || parsed.row || null;
                    const seat = (dataSeat && normToken(dataSeat)) || parsed.seat || null;
                    r0.scrollIntoView({ block: 'center', inline: 'center' });
                    const bb = r0.getBoundingClientRect();
                    const cx = bb.left + (bb.width / 2);
                    const cy = bb.top + (bb.height / 2);
                    return {
                      x: cx, y: cy, w: bb.width, h: bb.height,
                      seatId,
                      row,
                      seat,
                      labelText: labelText ? normToken(labelText) : null,
                      sig: {
                        cls: (r0.getAttribute('class') || ''),
                        fill: (r0.getAttribute('fill') || ''),
                        stroke: (r0.getAttribute('stroke') || ''),
                        op: (r0.getAttribute('opacity') || ''),
                        pe: (r0.getAttribute('pointer-events') || ''),
                        style: (r0.getAttribute('style') || '')
                      }
                    };
                  }).filter(it => {
                    if (!Number.isFinite(it.x) || !Number.isFinite(it.y) || it.x <= 0 || it.y <= 0) return false;
                    if (it.y <= 10 || it.x <= 10 || it.y >= window.innerHeight - 10 || it.x >= window.innerWidth - 10) return false;
                    if (it.seatId && excluded.has(String(it.seatId))) return false;
                    return true;
                  });

                  if (!items.length) return null;

                  if (mode === 'deterministic') {
                    items.sort((a, b) => {
                      const aHas = !!(a.row && a.seat);
                      const bHas = !!(b.row && b.seat);
                      if (aHas !== bHas) return aHas ? -1 : 1;
                      if (aHas && bHas) {
                        const cr = cmpToken(a.row, b.row);
                        if (cr !== 0) return cr;
                        const cs = cmpToken(a.seat, b.seat);
                        if (cs !== 0) return cs;
                      }
                      const aid = toNumOrNull(a.seatId);
                      const bid = toNumOrNull(b.seatId);
                      if (aid != null && bid != null && aid !== bid) return aid - bid;
                      if (aid != null && bid == null) return -1;
                      if (aid == null && bid != null) return 1;
                      if (a.y !== b.y) return a.y - b.y;
                      return a.x - b.x;
                    });
                    const queue = items.slice(0, 12);
                    return { primary: queue[0] || null, queue: queue.slice(1) };
                  }

                  const r0 = items[Math.floor(Math.random() * items.length)];
                  return { primary: r0, queue: [] };
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
              return { primary: {
                x: Math.max(0, bb.left + (bb.width / 2)),
                y: Math.max(0, bb.top + (bb.height / 2)),
                w: bb.width,
                h: bb.height,
                seatId: null,
                row: null,
                seat: null,
                labelText: null,
                sig: null
              }, queue: [] };
          }, SEAT_NODE_SELECTOR, seatSelectionMode, claimedSeatIds);
          if (picked && typeof picked === 'object') {
            if (Array.isArray(picked.queue) && picked.queue.length) seatPickQueue = picked.queue;
            clickInfo = picked.primary || null;
            if (!clickInfo && seatSelectionMode === 'deterministic' && Array.isArray(seatPickQueue) && seatPickQueue.length) {
              clickInfo = seatPickQueue.shift();
            }
          }
          }
          if (!clickInfo || !Number.isFinite(clickInfo.x) || !Number.isFinite(clickInfo.y) || clickInfo.x <= 0 || clickInfo.y <= 0) {
            await delay(200);
            continue;
          }

          if (clickInfo.seatId) {
            const claimed = claimSeatId(seatClaimGroupKey, seatClaimOwner, clickInfo.seatId);
            if (!claimed) {
              logger.info(`seatPick:${context}:seat_claim_conflict`, {
                seatId: clickInfo.seatId,
                group: seatClaimGroupKey
              });
              lockedSeat = null;
              lockedMiss = 0;
              await delay(120);
              continue;
            }
          }

          if (!lockedSeat) {
            lockedSeat = clickInfo;
            logger.info(`seatPick:${context}:locked`, { seatId: clickInfo.seatId, row: clickInfo.row || null, seat: clickInfo.seat || null, mode: seatSelectionMode, x: clickInfo.x, y: clickInfo.y });
          }

          // Prefer deterministic click by seatId when available.
          let clicked = false;
          if (clickInfo.seatId) {
            clicked = await clickSeatById(page, clickInfo.seatId);
            try {
              const obs = await page.evaluate(() => {
                const x = window.__passobotClickObstruction || null;
                if (x) window.__passobotClickObstruction = null;
                return x;
              }).catch(() => null);
              if (obs) logger.warn(`seatPick:${context}:click_obstructed_overlay`, obs);
            } catch {}
          }
          if (!clicked) {
            clicked = await robustSeatClick(page, clickInfo.x, clickInfo.y);
          }
          if (!clicked) {
            logger.warn(`seatPick:${context}:click_failed`, { seatId: lockedSeat?.seatId });
            if (lockedSeat?.seatId) releaseSeatId(seatClaimGroupKey, seatClaimOwner, lockedSeat.seatId);
            if (seatSelectionMode === 'deterministic' && Array.isArray(seatPickQueue) && seatPickQueue.length) {
              // Don't get stuck retrying a problematic seat; advance to the next deterministic candidate.
              lockedSeat = null;
              lockedMiss = 0;
            }
            await delay(200);
            continue;
          }

          // click sonrası seçimin DOM'a düşmesini kısa süre bekle
          for (let w = 0; w < 10; w++) {
              const selNow = await page.evaluate((sel) => !!document.querySelector(sel), SELECTED_SEAT_SELECTOR);
              if (selNow) break;
              await delay(80);
          }

          try {
            await awaitTurnstileGapForSeatMap(page, context, email, ensureTurnstileFn, 'afterSeatMapClick');
          } catch {}

          const picked = await page.evaluate((sel) => !!document.querySelector(sel), SELECTED_SEAT_SELECTOR);
          if (!picked) {
            const selDiag = await getSelectionState();
            // Seatmap DOM yokken seçimi doğrulamak mümkün değil; bu durumda lockedMiss şişirmeyelim.
            if (seatState && seatState.seatCount <= 0) {
              logger.info(`seatPick:${context}:not_selected_seatmap_missing_skip`, { seatId: lockedSeat?.seatId, seatState });
            } else {
              lockedMiss++;
              logger.warn(`seatPick:${context}:not_selected_after_click`, { seatId: lockedSeat?.seatId, lockedMiss, selDiag });
              if (lockedMiss >= 2) {
                const recovered = await recoverChallengeIfNeeded('not_selected_after_click');
                if (recovered) {
                  continue;
                }
              }
              if (seatSelectionMode === 'deterministic' && Array.isArray(seatPickQueue) && seatPickQueue.length) {
                logger.info(`seatPick:${context}:deterministic_advance_candidate`, { fromSeatId: lockedSeat?.seatId || null, remaining: seatPickQueue.length });
                if (lockedSeat?.seatId) releaseSeatId(seatClaimGroupKey, seatClaimOwner, lockedSeat.seatId);
                lockedSeat = null;
                lockedMiss = 0;
              }
              if (lockedMiss >= 3) {
                logger.warn(`seatPick:${context}:lock_reset`, { seatId: lockedSeat?.seatId, reason: 'not_selected_after_3_clicks' });
                if (lockedSeat?.seatId) releaseSeatId(seatClaimGroupKey, seatClaimOwner, lockedSeat.seatId);
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

      /** Çoklu bilet: sepete devam ancak dropdown hedef adedi onaylı veya yeterli koltuk seçili iken */
      let multiTicketReadyForContinue = ticketCount <= 1;

      const tryCompleteMultiTicketSelection = async (currentSelected) => {
        const normalizedSelected = Math.max(0, Number(currentSelected) || 0);
        const needed = ticketCount - normalizedSelected;
        if (needed <= 0) {
          return { finalCount: normalizedSelected, addedCount: 0, ready: normalizedSelected >= ticketCount };
        }

        logger.info(`seatPick:${context}:multi_ticket_picking`, {
          ticketCount,
          currentSelected: normalizedSelected,
          needed,
          adjacentSeats
        });

        let addedCount = 0;
        for (let s = 0; s < needed; s++) {
          let added = false;
          if (adjacentSeats) {
            added = await tryPickAdjacentSeat();
            if (!added) {
              logger.warn(`seatPick:${context}:adjacent_not_found_fallback_random`, { attempt: s + 1 });
              added = await tryPickAdditionalSeat();
            }
          } else {
            added = await tryPickAdditionalSeat();
          }

          if (added) {
            addedCount++;
            await delay(300);
          } else {
            logger.warn(`seatPick:${context}:additional_seat_failed`, { attempt: s + 1, needed, addedSoFar: addedCount, adjacentSeats });
            await delay(200);
            const retry = adjacentSeats ? await tryPickAdjacentSeat() : await tryPickAdditionalSeat();
            if (!retry && adjacentSeats) {
              const retryRandom = await tryPickAdditionalSeat();
              if (retryRandom) {
                addedCount++;
                await delay(300);
                continue;
              }
            }
            if (retry) {
              addedCount++;
              await delay(300);
            }
          }
        }

        const finalSelected = await getSelectionState();
        const finalCount = Math.max(0, Number(finalSelected?.selectedCount) || 0);
        const ready = finalCount >= ticketCount;
        logger.info(`seatPick:${context}:multi_ticket_result`, {
          ticketCount,
          addedCount,
          finalSelectedCount: finalCount,
          adjacentSeats,
          multiTicketReadyForContinue: ready
        });
        return { finalCount, addedCount, ready };
      };

      if (selectedNow || lockedSelected) {
        const selState = await getSelectionState();
        logger.info(`seatPick:${context}:selection_before_continue`, { selectedNow, lockedSelected, selState, ticketCount });

        // ticketCount > 1: önce bilet tipi satırındaki adet dropdown (Passo), yoksa ek koltuk tıkla
        if (ticketCount > 1) {
          const dd = await applyTicketQuantityDropdown(page, context, ticketCount, {
            appearMaxMs: skipQtyAppearLongWait ? 0 : PASSO_QTY_SELECT_APPEAR_MAX_MS,
            readOnly: quantitySelectionMode === 'outsideSeat'
          });
          if (dd && dd.ok) {
            if (quantitySelectionMode === 'duringSeat') {
              await reclickActiveSeatAfterQuantityChange(page, context, { email, ensureTurnstileFn });
            }
            const need = ticketCount;
            const maxAv = Number(dd.maxAvailable) || need;
            const targetQty = Math.min(need, maxAv);
            const got = quantitySelectionMode === 'outsideSeat'
              ? (Number(dd.currentNum) || 0)
              : (Number(dd.pick) || 0);
            const selectedCount = Number(selState?.selectedCount) || 0;
            const qtyReady = quantitySelectionMode === 'outsideSeat'
              ? dd.selectedMatchesTarget === true || got === targetQty
              : got === targetQty;
            multiTicketReadyForContinue = quantitySelectionMode === 'outsideSeat'
              ? (qtyReady && selectedCount >= ticketCount)
              : qtyReady;
            if (quantitySelectionMode === 'outsideSeat' && qtyReady && selectedCount < ticketCount) {
              const fillRes = await tryCompleteMultiTicketSelection(selectedCount);
              multiTicketReadyForContinue = fillRes.ready;
            }
            if (!multiTicketReadyForContinue) {
              logger.warn(`seatPick:${context}:multi_ticket_not_ready`, {
                need,
                got,
                targetQty,
                maxAv,
                qtyReady,
                selectedCount
              });
            }
          } else if (!dd || !dd.ok) {
            const fillRes = await tryCompleteMultiTicketSelection(selState?.selectedCount || 0);
            multiTicketReadyForContinue = fillRes.ready;
          }
          if (dd?.appearPollExhausted) skipQtyAppearLongWait = true;
        }
      }

      if (ticketCount > 1 && !multiTicketReadyForContinue) {
        logger.warn(`seatPick:${context}:continue_blocked_incomplete_multi_ticket`, { ticketCount });
        await delay(300);
        continue;
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

        // Continue öncesi token freshness check: token var görünse bile sayfa drift sonrası stale olabilir.
        // Wrapper token hazırsa hızlı döner; yoksa turnstile-first toparlar.
        const freshnessCooldownMs = 12000;
        if (ensureTurnstileFn && email && (!lastTurnstileFreshCheckAt || (Date.now() - lastTurnstileFreshCheckAt) > freshnessCooldownMs)) {
          lastTurnstileFreshCheckAt = Date.now();
          try {
            const t0 = Date.now();
            await ensureTurnstileFn(page, email, `seatPick:${context}:preContinueFreshness`, { background: false, recaptchaFallback: false });
            const dt = Date.now() - t0;
            if (dt > 3000) extendDeadline(Math.min(12000, dt + 1500), 'turnstile_precontinue_freshness');
          } catch (e) {
            logger.warn(`seatPick:${context}:turnstile_freshness_check_failed`, { error: e?.message || String(e) });
          }
        }
        
        // Turnstile token kontrolü - yoksa devam'a basma
        const tokenState = await page.evaluate(() => {
          const field = document.querySelector('input[name="cf-turnstile-response"]');
          const hasToken = field && field.value && field.value.length > 100;
          const hasWidget = !!document.querySelector('.cf-turnstile');
          return { hasToken, hasWidget, tokenLen: field?.value?.length || 0 };
        });
        
        if (tokenState.hasWidget && !tokenState.hasToken) {
          logger.warn(`seatPick:${context}:no_turnstile_token`, tokenState);

          // Token yok: önce background warmup başlat (akışı kilitlemeden).
          if (ensureTurnstileFn && email) {
            try {
              if (!turnstileWarmStartedAt || (Date.now() - turnstileWarmStartedAt) > 120000) {
                turnstileWarmStartedAt = Date.now();
                await ensureTurnstileFn(page, email, `seatPick:${context}:turnstileWarmup`, { background: true, recaptchaFallback: false });
              }
            } catch {}
          }

          // Warmup'a biraz süre tanı; çoğu durumda token bu arada hazır oluyor.
          if (turnstileWarmStartedAt && (Date.now() - turnstileWarmStartedAt) < 6000) {
            await delay(600);
            continue;
          }

          // Hala token yoksa: belirli aralıklarla blocking ensure yap.
          const blockingCooldownMs = 20000;
          if (ensureTurnstileFn && email && (!lastTurnstileBlockingAt || (Date.now() - lastTurnstileBlockingAt) > blockingCooldownMs)) {
            lastTurnstileBlockingAt = Date.now();
            logger.info(`seatPick:${context}:resolving_turnstile_blocking`);
            try {
              const t0 = Date.now();
              await ensureTurnstileFn(page, email, `seatPick:${context}:beforeContinue`, { background: false, recaptchaFallback: false });
              const dt = Date.now() - t0;
              // Captcha solving can take 60-90s; extend seat-pick deadline accordingly.
              extendDeadline(dt + 8000, 'turnstile_before_continue');
            } catch (e) {
              logger.warn(`seatPick:${context}:turnstile_resolve_failed`, { error: e?.message });
            }
          }

          await delay(700);
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
            if (nw2 && nw2.data && await canTreatBasketAsSuccess(nw2.data, 'postContinueNetworkLatest')) return nw2.data;

            // If network says basket has items, accept it as success even if UI didn't navigate.
            try {
              const j = transition && transition.type === 'resp' ? transition.json : null;
              const isOk = transition && transition.type === 'resp' && transition.status >= 200 && transition.status < 400;
              if (isOk && j && j.isError === false) {
                const v = j.value || null;
                const basket = v && v.basket ? v.basket : (j.value && j.value.basket ? j.value.basket : null);
                const products = (j.value && Array.isArray(j.value.basketBookingProducts)) ? j.value.basketBookingProducts : null;
                const p0 = products && products.length ? products[0] : null;
                const heldSeats = mapHeldSeatsFromProducts(products);
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
                  const basketFromNetwork = {
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
                    remainingTime,
                    itemCount: Array.isArray(products) ? products.length : 0,
                    heldSeats
                  };
                  if (await canTreatBasketAsSuccess(basketFromNetwork, 'networkTransition')) {
                    logger.info(`seatPick:${context}:basket_from_network`, {
                      basketId,
                      remainingTime,
                      seatId: seatIdFromNet,
                      blockId: blockIdFromNet,
                      row,
                      seat
                    });
                    return basketFromNetwork;
                  }
                }
              }
            } catch {}

            // If backend/response suggests basket but UI is still on seat selection, try direct navigation.
            const curUrl = (() => { try { return page.url(); } catch { return ''; } })();
            const stillOnSeat = expectedUrlIncludes ? (curUrl && curUrl.includes(String(expectedUrlIncludes))) : false;
            const transitionUrl = String(transition?.url || '').toLowerCase();
            const isRespOk = !!(transition && transition.type === 'resp' && transition.status >= 200 && transition.status < 400);
            const isAddSeatResp = isRespOk && /addseattobasket|addseat|add-to-basket|addtobasket/i.test(transitionUrl);
            const transitionProducts = Array.isArray(transition?.json?.value?.basketBookingProducts)
              ? transition.json.value.basketBookingProducts
              : [];
            const strongBasketSignal =
              !!(transition && transition.type === 'url') ||
              isAddSeatResp ||
              (isRespOk && transitionProducts.length > 0);
            if (stillOnSeat && strongBasketSignal) {
              try {
                await page.goto('https://www.passo.com.tr/tr/sepet', { waitUntil: 'domcontentloaded', timeout: 30000 });
              } catch {}
            }
          } catch {}

          // Devam'a bastıktan sonra biraz bekle, basket'e düşmesi için
          await delay(800);
        }
      }

      // swal (Tamam/Evet) modal çıkarsa kapat — başlık + gövde birlikte okunur (Passo bazen metni title'da tutuyor)
      try {
          const swalText = await page.evaluate(() => {
              const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim();
              const cont = document.querySelector('.swal2-container.swal2-shown, .swal2-container.swal2-backdrop-show');
              if (!cont) return null;
              const title = norm(cont.querySelector('.swal2-title')?.innerText || cont.querySelector('.swal2-title')?.textContent || '');
              const html = norm(cont.querySelector('.swal2-html-container')?.innerText || cont.querySelector('.swal2-html-container')?.textContent || '');
              const combined = norm(`${title} ${html}`.trim());
              const fallback = norm(cont.innerText || '');
              const out = combined || fallback;
              return out || null;
          });
          if (swalText) {
              const basketSuccessSwal = /(koltuk|biletiniz|bilet|ürün).{0,120}?(sepete|sepet)\s*(aktarıldı|eklendi|alındı|taşındı|yönlendirildi)|sepete\s*aktarıldı|sepete\s*eklendi|başarıyla\s*eklendi|işlem\s*başarılı/i.test(swalText);
              if (basketSuccessSwal) {
                  logger.info(`seatPick:${context}:swal_basket_success`, { text: swalText });
              } else {
                  logger.warn(`seatPick:${context}:swal`, { text: swalText });
              }
              const needsMore = /lütfen\s*1\s*adet\s*daha\s*ürün\s*seçiniz/i.test(swalText);
              const seatProblem = /(koltuk\s*seç|koltuk\s*seçiniz|koltuk\s*dolu|seçtiğiniz\s*koltuk|seat\s*(is|was)\s*(not|no)\s*available)/i.test(swalText);
              const sessionProblem = /(oturum|zaman\s*aşımı|süre\s*doldu|yeniden\s*giriş|session\s*(expired|timeout)|time\s*(out|expired))/i.test(swalText);
              await confirmSwalYes(page, basketSuccessSwal ? 12000 : 8000);
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
              if (seatProblem && !basketSuccessSwal) {
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
          if (data && (data.row && data.seat) && await canTreatBasketAsSuccess(data, 'verifyWait')) {
            logger.info(`seatPick:${context}:basket_success`, {
              tribune: data.tribune,
              block: data.block,
              row: data.row,
              seat: data.seat,
              combined: data.combined,
              seatId: data.seatId,
              blockId: data.blockId
            });
            return data;
          }
          if (data && data.inBasket && isBasketLikeUrl(data.url) && await canTreatBasketAsSuccess(data, 'verifyWait')) {
            logger.info(`seatPick:${context}:basket_success`, {
              tribune: data.tribune,
              block: data.block,
              row: data.row,
              seat: data.seat,
              combined: data.combined,
              seatId: data.seatId,
              blockId: data.blockId
            });
            return data;
          }
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
async function pickExactSeatWithVerify_Locked(page, target, maxMs = null, options = null) {
  maxMs = maxMs || getCfg().TIMEOUTS.SEAT_PICK_EXACT_MAX;
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
  maxMs = maxMs || getCfg().TIMEOUTS.SEAT_PICK_EXACT_MAX;
  let end = Date.now() + maxMs;
  let recoveryBonusUsedMs = 0;
  const recoveryBonusCapMs = 120000;
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

    const recovered = await recoverIfRedirected(page, ctx, 'release_loop', expectedUrlIncludes, recoveryUrl, email, password, reloginIfRedirected, ensureTurnstileFn);
    if (recovered && recoveryBonusUsedMs < recoveryBonusCapMs) {
      const add = Math.min(45000, recoveryBonusCapMs - recoveryBonusUsedMs);
      end += add;
      recoveryBonusUsedMs += add;
      logger.info(`seatPick:${ctx}:release_loop_deadline_extended`, { addMs: add, recoveryBonusUsedMs, seatId: wantSeatId || null });
    }

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
      const sel = document.querySelector('circle.seat-circle.selected, circle.seat-circle[aria-pressed="true"], [data-selected="true"], svg.seatmap-svg rect.seatActive, svg.seatmap-svg g.seatActive, svg.seatmap-svg g.seatActive rect, svg.seatmap-svg g.selected, svg.seatmap-svg g.selected rect');
      if (!sel) return false;

      // Passo SVG map: seat id can be embedded in class names (g<id>, block<id>)
      if (wantSeatId) {
        const cls = ((sel.getAttribute && sel.getAttribute('class')) ? sel.getAttribute('class') : (sel.className && sel.className.baseVal ? sel.className.baseVal : sel.className)) || '';
        const key = String(cls || '').toLowerCase();
        if (key.includes(`g${String(wantSeatId).toLowerCase()}`) || key.includes(`block${String(wantSeatId).toLowerCase()}`)) {
          return true;
        }
      }
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
      const pickRectCenterClick = (el) => {
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
        const r = el.getBoundingClientRect();
        if (!r || !r.width || !r.height) return false;

        const events = ['mouseover', 'mouseenter', 'pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click'];
        events.forEach((type) => {
          try {
            const evt = new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
            el.dispatchEvent(evt);
          } catch {}
        });
        try { el.click(); } catch {}
        return true;
      };

      // 1) First try Passo-specific seat selectors by seatId (observed: g<id> / block<id>)
      if (wantSeatId) {
        const id = String(wantSeatId).trim();
        const candidates = [
          `svg.seatmap-svg rect.block${CSS.escape(id)}`,
          `svg.seatmap-svg g.g${CSS.escape(id)} rect`,
          `svg.seatmap-svg g#${CSS.escape(id)} rect`,
          `svg.seatmap-svg [data-id="${id}"]`,
          `svg.seatmap-svg [data-seat-id="${id}"]`,
          `svg.seatmap-svg [seat-id="${id}"]`
        ];
        for (const sel of candidates) {
          const el = document.querySelector(sel);
          if (!el) continue;

          const cls = (el.getAttribute('class') || '').toLowerCase();
          const fill = (el.getAttribute('fill') || '').toLowerCase();
          const isBlocked = /(occupied|disabled|unavailable|dolu|sold|reserved)/i.test(cls) || el.getAttribute('aria-disabled') === 'true' || fill === '#89a0a3';
          if (isBlocked) return 'blocked';

          return pickRectCenterClick(el) ? 'clicked' : 'notfound';
        }
      }

      // 2) Fallback: generic seat nodes
      const nodes = [...document.querySelectorAll('circle.seat-circle, [seat-id], [data-seat-id], [data-id], .seat, [class*="seat"], svg.seatmap-svg g[id^="seat"], svg.seatmap-svg g[id^="seat"] rect')];
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

      return pickRectCenterClick(el) ? 'clicked' : 'notfound';
    }, { wantSeatId, wantRow, wantSeat });

    if (clickResult === 'clicked') {
      // click sonrası seçimin DOM'a düşmesini kısa süre bekle
      for (let w = 0; w < (isAggressive ? 20 : 10); w++) {
        const selNow = await page.evaluate(() => !!document.querySelector(
          'circle.seat-circle.selected, circle.seat-circle[aria-pressed="true"], [data-selected="true"], svg.seatmap-svg rect.seatActive, svg.seatmap-svg g.seatActive rect'
        ));
        if (selNow) break;
        await delay(isAggressive ? 30 : 60);
      }

      const selectedNow = await page.evaluate(() => !!document.querySelector(
        'circle.seat-circle.selected, circle.seat-circle[aria-pressed="true"], [data-selected="true"], svg.seatmap-svg rect.seatActive, svg.seatmap-svg g.seatActive, svg.seatmap-svg g.seatActive rect, svg.seatmap-svg g.selected, svg.seatmap-svg g.selected rect'
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

module.exports = { pickRandomSeatWithVerify, pickExactSeatWithVerify_Locked, waitForTargetSeatReady, pickExactSeatWithVerify_ReleaseAware, applyTicketQuantityDropdown };
