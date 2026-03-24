const delay = require('../utils/delay');
const { getCfg } = require('../runCfg');
const { evaluateSafe, waitForFunctionSafe } = require('../utils/browserEval');

const SEAT_NODE_SELECTOR = 'circle.seat-circle, .seat-circle, [seat-id], [data-seat-id], [data-id][class*="seat"], [class*="seat-circle"], svg circle[class*="seat"], svg.seatmap-svg g[id^="seat"], svg.seatmap-svg g[id^="seat"] rect, svg.seatmap-svg g[id^="seat"] circle, svg.seatmap-svg g[id^="seat"] path, svg.seatmap-svg g[id^="seat"] polygon, svg.seatmap-svg g[id^="seat"] line, svg.seatmap-svg rect[class^="block"]';

const isHomeUrl = (u) => {
  if (!u) return false;
  try {
    const x = new URL(u);
    const p = (x.pathname || '').replace(/\/+$/, '') || '/';
    const isPasso = /(^|\.)passo\.com\.tr$/i.test(x.hostname);
    if (!isPasso) return false;
    return p === '/' || p === '/tr' || p === '/tr/anasayfa' || p === '/anasayfa';
  } catch {
    return false;
  }

};

async function ensureTcAssignedOnBasket(page, identity, options = null) {
  if (!page) return false;
  const opts = options && typeof options === 'object' ? options : {};
  const preferAssignToMyId = opts.preferAssignToMyId !== false;
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : 3;

  const tc = identity != null ? String(identity).trim() : '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const done = await evaluateSafe(page, (tcValue, preferMyId) => {
        const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim();
        const lower = (s) => norm(s).toLowerCase();

        const getRowEls = () => {
          const inputs = Array.from(document.querySelectorAll('input[placeholder="T.C. Kimlik No"][maxlength="11"]'));
          return inputs.map((inp) => {
            const td = inp.closest('td') || inp.closest('tr') || inp.parentElement;
            return { inp, td };
          });
        };

        const rows = getRowEls();
        if (!rows.length) return { ok: true, reason: 'no_tc_ui' };

        let anyTouched = false;
        for (const r of rows) {
          const inp = r.inp;
          const td = r.td || document.body;

          const assign = td.querySelector('input[type="checkbox"][id^="checkassign-to-my-id"]');
          const notCitizen = td.querySelector('input[type="checkbox"][id^="checknot-tc-citizen"]');
          if (notCitizen && notCitizen.checked) continue;

          const curVal = norm(inp.value || '');
          if (curVal && curVal.length === 11) continue;

          if (preferMyId && assign && !assign.checked) {
            try { assign.click(); } catch {}
            anyTouched = true;
            continue;
          }

          if (tcValue && tcValue.length === 11) {
            try {
              inp.focus();
              inp.value = '';
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              inp.value = tcValue;
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              inp.dispatchEvent(new Event('change', { bubbles: true }));
            } catch {}

            const btns = Array.from(td.querySelectorAll('button')).filter(b => !b.disabled);
            const defineBtn = btns.find(b => lower(b.innerText || b.textContent) === 'tanımla');
            if (defineBtn) {
              try { defineBtn.click(); } catch {}
              anyTouched = true;
              continue;
            }
            anyTouched = true;
          }
        }

        return { ok: true, reason: anyTouched ? 'touched' : 'already_ok' };
      }, tc, preferAssignToMyId).catch(() => null);

      if (done && done.ok) {
        if (done.reason === 'touched') {
          await delay(600);
          continue;
        }
        return true;
      }
    } catch {}
    await delay(600 * attempt);
  }
  return false;
}

async function clickBasketDevamToOdeme(page) {
  if (!page) return false;
  try {
    const btn = await evaluateSafe(page, () => {
      const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
      const els = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))
        .filter(el => {
          try {
            const st = window.getComputedStyle(el);
            if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
            if (el.disabled) return false;
            return !!(el.offsetParent !== null);
          } catch {
            return false;
          }
        });
      const cand = els
        .map(el => ({ el, t: norm(el.innerText || el.textContent || el.value || '') }))
        .filter(x => x.t === 'devam')
        .map(x => x.el);
      const best = cand.find(b => (b.getAttribute('class') || '').toLowerCase().includes('red-btn')) || cand[0] || null;
      if (!best) return null;
      best.scrollIntoView({ block: 'center', inline: 'center' });
      const r = best.getBoundingClientRect();
      return { x: r.left + (r.width / 2), y: r.top + (r.height / 2) };
    });
    if (!btn || !Number.isFinite(btn.x) || !Number.isFinite(btn.y)) return false;
    const wait = waitForFunctionSafe(page, () => {
      const u = String(location.href || '');
      return /\/odeme(\b|\/|\?|#)/i.test(u);
    }, { timeout: 30000 }).catch(() => null);
    await page.mouse.move(btn.x, btn.y);
    await page.mouse.down();
    await page.mouse.up();
    await Promise.race([wait, delay(2500)]);
    return true;
  } catch {
    return false;
  }
}

async function dismissPaymentInfoModalIfPresent(page) {
  if (!page) return false;
  try {
    const did = await evaluateSafe(page, () => {
      const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
      const conts = Array.from(document.querySelectorAll('.modal, .swal2-container, [role="dialog"], .cdk-overlay-container'));
      const visible = conts.filter(c => {
        try {
          const st = window.getComputedStyle(c);
          return st && st.display !== 'none' && st.visibility !== 'hidden' && (c.offsetParent !== null || st.position === 'fixed');
        } catch { return false; }
      });
      if (!visible.length) return false;
      const btns = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))
        .filter(b => {
          const t = norm(b.innerText || b.textContent || b.value || '');
          if (!t) return false;
          if (b.disabled) return false;
          return t === 'tamam' || t === 'ok' || t === 'kapat';
        });
      const b = btns[0] || null;
      if (!b) return false;
      try { b.click(); } catch {}
      return true;
    });
    if (did) await delay(500);
    return !!did;
  } catch {
    return false;
  }
}

async function fillInvoiceTcAndContinue(page, identity) {
  if (!page) return false;
  const tc = identity != null ? String(identity).trim() : '';
  if (!tc || tc.length !== 11) return false;

  try {
    const ok = await evaluateSafe(page, (tcValue) => {
      const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
      const inputs = Array.from(document.querySelectorAll('quick-input input.form-control[placeholder="T.C. Kimlik No"], input.form-control[placeholder="T.C. Kimlik No"][maxlength="11"]'));
      if (!inputs.length) return false;
      const inp = inputs[0];
      try {
        inp.focus();
        inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.value = tcValue;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      } catch {}

      const btns = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))
        .filter(b => {
          try {
            const st = window.getComputedStyle(b);
            if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
            if (b.disabled) return false;
            return !!(b.offsetParent !== null);
          } catch { return false; }
        });
      const cand = btns.find(b => (b.getAttribute('class') || '').toLowerCase().includes('black-btn') && norm(b.innerText || b.textContent || b.value || '').includes('devam'))
        || btns.find(b => norm(b.innerText || b.textContent || b.value || '') === 'devam')
        || null;
      if (!cand) return false;
      try { cand.click(); } catch {}
      return true;
    }, tc);
    if (ok) {
      await delay(1200);
      return true;
    }
  } catch {}
  return false;
}

async function acceptAgreementsAndContinue(page) {
  if (!page) return false;
  try {
    const did = await evaluateSafe(page, () => {
      const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
      const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'))
        .filter(cb => {
          if (cb.disabled) return false;
          const id = cb.getAttribute('id') || '';
          let labelTxt = '';
          try {
            if (id) labelTxt = document.querySelector(`label[for="${CSS.escape(id)}"]`)?.innerText || '';
          } catch {}
          const around = (cb.closest('label')?.innerText || cb.parentElement?.innerText || labelTxt || '');
          const t = norm(around);
          return /(kabul|onay|sözleşme|aydınlatma|kvkk|mesafeli|satış|bilet)/i.test(t);
        });
      let touched = false;
      for (const cb of boxes) {
        if (!cb.checked) {
          try { cb.click(); } catch {}
          touched = true;
        }
      }
      const btns = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))
        .filter(b => {
          try {
            const st = window.getComputedStyle(b);
            if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
            if (b.disabled) return false;
            return !!(b.offsetParent !== null);
          } catch { return false; }
        });
      const cont = btns.find(b => {
        const cls = (b.getAttribute('class') || '').toLowerCase();
        const t = norm(b.innerText || b.textContent || b.value || '');
        if (cls.includes('black-btn') && t.includes('devam')) return true;
        if (t === 'devam') return true;
        return false;
      }) || null;
      if (cont) {
        try { cont.click(); } catch {}
        return { ok: true, touched };
      }
      return { ok: touched, touched };
    });
    if (did && did.ok) {
      await delay(1200);
      return true;
    }
  } catch {}
  return false;
}

async function fillNkolayPaymentIframe(page, card, options = null) {
  if (!page) return false;
  const opts = options && typeof options === 'object' ? options : {};
  const clickPay = opts.clickPay === true;
  const c = card && typeof card === 'object' ? card : {};
  const name = c.cardHolder != null ? String(c.cardHolder).trim() : '';
  const number = c.cardNumber != null ? String(c.cardNumber).replace(/\s+/g, '').trim() : '';
  const mm = c.expiryMonth != null ? String(c.expiryMonth).trim() : '';
  const yy = c.expiryYear != null ? String(c.expiryYear).trim() : '';
  const cvv = c.cvv != null ? String(c.cvv).trim() : '';

  if (!name || !number || !mm || !yy || !cvv) return false;

  try {
    await page.waitForSelector('iframe#payment_nkolay_frame', { timeout: 30000 }).catch(() => null);
    const frameHandle = await page.$('iframe#payment_nkolay_frame').catch(() => null);
    const frame = frameHandle ? await frameHandle.contentFrame().catch(() => null) : null;
    if (!frame) return false;

    await frame.waitForSelector('#name, #number, #ay, #yil, #cvv', { timeout: 30000 }).catch(() => null);

    try { await frame.focus('#name'); } catch {}
    try { await frame.evaluate(() => { try { document.querySelector('#name')?.select?.(); } catch {} }); } catch {}
    try { await frame.type('#name', name, { delay: 20 }); } catch {}

    try { await frame.focus('#number'); } catch {}
    try { await frame.evaluate(() => { try { document.querySelector('#number')?.select?.(); } catch {} }); } catch {}
    try { await frame.type('#number', number, { delay: 15 }); } catch {}

    try { await frame.select('#ay', mm); } catch {}

    const yearFull = yy.length === 2 ? `20${yy}` : yy;
    try {
      const hasYear = await frame.$eval('#yil', (s, y) => {
        const opt = Array.from(s.options || []).some(o => String(o.value) === String(y));
        return opt;
      }, yearFull).catch(() => false);
      if (hasYear) await frame.select('#yil', yearFull);
    } catch {}

    try { await frame.focus('#cvv'); } catch {}
    try { await frame.evaluate(() => { try { document.querySelector('#cvv')?.select?.(); } catch {} }); } catch {}
    try { await frame.type('#cvv', cvv, { delay: 15 }); } catch {}

    let payClicked = false;
    if (clickPay) {
      try {
        await frame.waitForSelector('#paybuttontext', { timeout: 8000 }).catch(() => null);
        const btn = await frame.$('#paybuttontext').catch(() => null);
        if (btn) {
          try { await btn.click({ delay: 60 }); } catch { try { await frame.click('#paybuttontext'); } catch {} }
          payClicked = true;
        }
      } catch {}
    }

    if (clickPay) {
      return { ok: true, payClicked };
    }
    return true;
  } catch {
    return false;
  }
}

async function ensureUrlContains(page, expectedIncludes, options = null) {
  const opts = options && typeof options === 'object' ? options : {};
  const recoveryUrl = opts.recoveryUrl || null;
  const retries = Number.isFinite(opts.retries) ? opts.retries : 2;
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : 8000;
  const waitUntil = opts.waitUntil || 'domcontentloaded';
  const backoffMs = Number.isFinite(opts.backoffMs) ? opts.backoffMs : 350;

  const expected = String(expectedIncludes || '');
  if (!expected) return { ok: true, expected, url: (() => { try { return page.url(); } catch { return null; } })(), attempts: 0 };

  const getUrl = () => {
    try { return page.url(); } catch { return ''; }
  };

  const isOk = (u) => {
    if (!u) return false;
    const exp = String(expected || '');
    if (!exp) return true;
    // If expectation is a path like "/koltuk-secim", check against URL.pathname.
    // This prevents false positives like "/giris?returnUrl=.../koltuk-secim".
    if (exp.startsWith('/')) {
      try {
        const path = new URL(String(u)).pathname || '';
        return String(path).includes(exp);
      } catch {
        return String(u).includes(exp);
      }
    }
    return String(u).includes(exp);
  };

  let lastUrl = getUrl();
  if (isOk(lastUrl)) return { ok: true, expected, url: lastUrl, attempts: 0 };

  for (let attempt = 1; attempt <= retries; attempt++) {
    lastUrl = getUrl();

    if (recoveryUrl) {
      try {
        await page.goto(String(recoveryUrl), { waitUntil, timeout: waitMs });
      } catch {}
    }

    try {
      await waitForFunctionSafe(page, (inc) => location.href.includes(inc), { timeout: waitMs }, expected);
    } catch {}

    lastUrl = getUrl();
    if (isOk(lastUrl)) return { ok: true, expected, url: lastUrl, attempts: attempt };

    await delay(backoffMs * attempt);
  }

  return { ok: false, expected, url: lastUrl, attempts: retries };
}

async function gotoWithRetry(page, targetUrl, options = null) {
  const opts = options && typeof options === 'object' ? options : {};
  const retries = Number.isFinite(opts.retries) ? opts.retries : 2;
  const waitUntil = opts.waitUntil || 'networkidle2';
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 45000;
  const backoffMs = Number.isFinite(opts.backoffMs) ? opts.backoffMs : 350;
  const expectedUrlIncludes = opts.expectedUrlIncludes || null;
  const rejectIfIncludes = opts.rejectIfIncludes || null;
  const rejectIfHome = opts.rejectIfHome === true;

  const getUrl = () => {
    try { return page.url(); } catch { return ''; }
  };

  const isRejected = (u) => {
    if (!u) return false;
    if (rejectIfIncludes && u.includes(String(rejectIfIncludes))) return true;
    if (rejectIfHome && isHomeUrl(u)) return true;
    return false;
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await page.goto(String(targetUrl), { waitUntil, timeout: timeoutMs });
    } catch {}

    const after = getUrl();
    if (!isRejected(after)) {
      if (expectedUrlIncludes) {
        const check = await ensureUrlContains(page, expectedUrlIncludes, {
          retries: 1,
          waitMs: 6000,
          waitUntil: 'domcontentloaded',
          recoveryUrl: targetUrl,
          backoffMs
        });
        if (check.ok) return { ok: true, url: check.url, attempts: attempt };
      } else {
        return { ok: true, url: after, attempts: attempt };
      }
    }

    await delay(backoffMs * (attempt + 1));
  }

  return { ok: false, url: getUrl(), attempts: retries + 1 };
}

async function ensurePage(browser){
  try {
    const pages = await browser.pages();
    if (pages && pages.length){
      for (const p of pages){
        let u=''; try{ u = p.url(); }catch{}
        if (u && !/^about:blank$/i.test(u) && !/^chrome:\/\/newtab/i.test(u)) return p;
      }
    }
    return await browser.newPage();
  } catch { return null; }
}

const captureSeatIdFromNetwork = (page, timeoutMs=null)=> new Promise(resolve=>{
  timeoutMs = timeoutMs || getCfg().TIMEOUTS.NETWORK_CAPTURE_TIMEOUT;
  let settled=false; const done=v=>{ if(!settled){ settled=true; try{page.removeListener('response',onResp);}catch{}; clearTimeout(t); resolve(v||null);} };
  const t=setTimeout(()=>done(null),timeoutMs);
  const onResp=async(resp)=>{ try{
      const url=resp.url(); if(!/basket|addseat|add-to-basket|seat|AddToBasket|cart|add/i.test(url)) return;
      const ct=(resp.headers()['content-type']||'').toLowerCase(); if(!ct.includes('application/json')) return;
      const data=await resp.json().catch(()=>null); if(!data) return;
      let seatId=null, row=null, seat=null;
      
      // Extract from various response structures
      const extractSeatInfo = (obj) => {
        if (!obj) return null;
        const sid = obj.seatId != null ? String(obj.seatId) : (obj.seat_id != null ? String(obj.seat_id) : null);
        const r = obj.row != null ? String(obj.row) : (obj.rowNumber != null ? String(obj.rowNumber) : null);
        const s = obj.seat != null ? String(obj.seat) : (obj.seatNumber != null ? String(obj.seatNumber) : (obj.no != null ? String(obj.no) : null));
        if (sid) return { seatId: sid, row: r || '', seat: s || '' };
        return null;
      };
      
      let info = null;
      if ((info = extractSeatInfo(data))) { seatId=info.seatId; row=info.row; seat=info.seat; }
      else if (data.data && (info = extractSeatInfo(data.data))) { seatId=info.seatId; row=info.row; seat=info.seat; }
      else if (Array.isArray(data.selectedSeats) && data.selectedSeats.length && (info = extractSeatInfo(data.selectedSeats[0]))) {
        seatId=info.seatId; row=info.row; seat=info.seat;
      }
      else if (Array.isArray(data.value) && data.value.length && (info = extractSeatInfo(data.value[0]))) {
        seatId=info.seatId; row=info.row; seat=info.seat;
      }
      else if (Array.isArray(data.data) && data.data.length && (info = extractSeatInfo(data.data[0]))) {
        seatId=info.seatId; row=info.row; seat=info.seat;
      }
      // Try basketBookingProducts structure
      else if (data.value?.basketBookingProducts?.length > 0) {
        const p = data.value.basketBookingProducts[0];
        if (p?.product?.seat) {
          const s = p.product.seat;
          seatId = s.seatId ? String(s.seatId) : null;
          row = s.row || s.rowNumber || '';
          seat = s.seat || s.seatNumber || s.no || '';
        }
      }
      
      if (seatId) {
        logger.info('seatPick:network_capture', { seatId, row, seat, url: resp.url() });
        done({ seatId, row, seat });
      }
  }catch{} };
  page.on('response',onResp);
});

async function readBasketData(page) {
  return await page.evaluate(() => {
    const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim();
    const url = location.href;
    const isSeatSelection = url.includes('/koltuk-secim');
    const isBasketUrl = /\/(sepet|basket|cart|odeme|payment)(\b|\/|\?|#)/i.test(url);

    const getFromBasketDetails = (label) => {
      const el = Array.from(document.querySelectorAll('.basket-list-detail'))
        .find(e => norm(e.querySelector('.basket-span')?.textContent) === label);
      return el ? norm(el.querySelector('span:last-child')?.textContent) : '';
    };

    const getByLabelAnywhere = (label) => {
      const want = label.toLowerCase();
      const nodes = Array.from(document.querySelectorAll('div, span, li, p, dt'));
      for (const n of nodes) {
        const t = norm(n.textContent);
        if (!t) continue;
        if (t.toLowerCase() === want) {
          const sib = n.nextElementSibling;
          const v1 = sib ? norm(sib.textContent) : '';
          if (v1) return v1;
        }
        if (t.toLowerCase().startsWith(want + ':')) {
          const v2 = norm(t.slice(label.length + 1));
          if (v2) return v2;
        }
      }
      return '';
    };

    const get = (label) => {
      return (
        getFromBasketDetails(label) ||
        getByLabelAnywhere(label)
      );
    };

    const tribune = get('Tribün');
    const block = get('Blok');
    const row = get('Sıra');
    const seat = get('Koltuk');

    const hasStrongBasketDom = !!document.querySelector(
      '.basket-list-detail, .basket-list, .basket, [data-testid*="basket" i], [data-testid*="sepet" i]'
    );

    const sel = document.querySelector(
      'circle.seat-circle.selected, circle.seat-circle[aria-pressed="true"], [data-selected="true"], [seat-id].selected, [data-seat-id].selected'
    );
    const blockId = sel?.getAttribute('block-id') || '';
    const seatId = sel?.getAttribute('seat-id') || sel?.getAttribute('data-seat-id') || sel?.getAttribute('data-id') || '';

    // On seat selection pages, Tribün/Blok/Sıra/Koltuk labels can appear in the seat tooltip/panel
    // before the seat is actually added to the basket. Treat it as basket data only when we're on
    // a basket-like URL or when strong basket DOM is present.
    if (isSeatSelection && !isBasketUrl && !hasStrongBasketDom) return null;

    if (!tribune && !block && !row && !seat) {
      if (!hasStrongBasketDom && !isBasketUrl) return null;
      return { tribune: '', block: '', row: '', seat: '', blockId, seatId, combined: '', inBasket: true, url };
    }
    return { tribune, block, row, seat, blockId, seatId, combined: `${tribune} ${block} ${row} ${seat}`.trim(), inBasket: true, url };
  }).catch(() => null);
}

const readCatBlock = async (page) => page.evaluate(()=>{
  let cat = document.querySelector('.custom-select-box .selected-option')?.textContent?.trim() || '';
  if (!cat) {
    try {
      const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = (el) => {
        try {
          const r = el.getBoundingClientRect();
          if (!r || r.width < 2 || r.height < 2) return false;
          const st = window.getComputedStyle(el);
          if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
          return true;
        } catch { return false; }
      };
      const selects = Array.from(document.querySelectorAll('select')).filter(isVisible);
      const hasTicketish = (s) => {
        try {
          const opts = Array.from(s.options || []).map(o => norm(o.textContent || o.innerText || ''));
          return opts.some(t => t.includes('kategori')) && opts.some(t => /₺|try|tl/i.test(t));
        } catch { return false; }
      };
      const pick = selects.find(hasTicketish) || selects.find(s => {
        const id = norm(s.id);
        const name = norm(s.getAttribute('name') || '');
        return id.includes('kategori') || name.includes('kategori') || id.includes('category') || name.includes('category');
      }) || null;
      if (pick) {
        cat = pick.selectedOptions?.[0]?.textContent?.trim() || '';
      }
    } catch {}
  }
  const s = document.querySelector('select#blocks');
  const blockText = s?.selectedOptions?.[0]?.textContent?.trim() || '';
  let blockVal  = s?.value || '';
  try {
    if (blockVal && typeof blockVal !== 'string') blockVal = String(blockVal);
    if (blockVal && /\[object\s+Object\]/i.test(blockVal)) {
      const opt = s?.selectedOptions?.[0];
      const v = opt?.getAttribute('value') || '';
      blockVal = v || '';
    }
  } catch {}
  return {categoryText:cat, blockText, blockVal};
});

const setCatBlockOnB = async (page, catBlock) => {
  const safeCatText = (catBlock && catBlock.categoryText) ? String(catBlock.categoryText) : '';
  const safeBlockVal = (catBlock && catBlock.blockVal) ? String(catBlock.blockVal) : '';
  const safeBlockText = (catBlock && catBlock.blockText) ? String(catBlock.blockText) : '';

  // Some events use the newer SVG UI without legacy category/block dropdowns.
  // In those cases we should not fail the flow; caller can proceed with SVG block selection.
  try {
    const hasLegacy = await page.evaluate(() => {
      const hasCustomSelect = !!document.querySelector('.custom-select-box, .custom-select-box .selected-option');
      const hasBlocks = !!document.querySelector('select#blocks');
      const hasSvgLayout = !!document.querySelector('svg.svgLayout, .svgLayout');
      return { hasCustomSelect, hasBlocks, hasSvgLayout };
    });
    if (!hasLegacy?.hasCustomSelect || !hasLegacy?.hasBlocks) {
      if (hasLegacy?.hasSvgLayout) return true;
      // If neither legacy nor svg is detected, keep trying the legacy path below.
    }
  } catch {}

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // (1) Ensure dropdown visible
      const box = await page.waitForSelector('.custom-select-box', { visible: true, timeout: 6000 }).catch(() => null);
      if (!box) {
        // If UI is SVG-based, don't fail.
        const isSvg = await page.evaluate(() => !!document.querySelector('svg.svgLayout, .svgLayout')).catch(() => false);
        if (isSvg) return true;
        throw new Error('setCatBlockOnB:legacy_controls_missing');
      }
      await page.evaluate(() => document.querySelector('.custom-select-box')?.click());
      await page.waitForSelector('.dropdown-option:not(.disabled)', { visible: true, timeout: 15000 });
      await page.evaluate((catText) => {
        const norm = (s) => (s || '').toString().trim().toLowerCase();
        const opts = [...document.querySelectorAll('.dropdown-option:not(.disabled)')];
        const i = opts.findIndex(o => norm(o.textContent || '').startsWith(norm(catText || '')));
        (i >= 0 ? opts[i] : opts[0])?.click();
      }, safeCatText);

      const blocksReady = await page.waitForFunction(() => {
        const s = document.querySelector('select#blocks');
        if (!s) return false;
        const opts = Array.from(s.options || []);
        // need at least 2 options to be meaningful
        return opts.length >= 2;
      }, { timeout: Math.max(12000, Number(getCfg().TIMEOUTS.BLOCKS_WAIT_TIMEOUT || 0) + 9000) }).catch(() => null);
      if (!blocksReady) {
        const isSvg = await page.evaluate(() => !!document.querySelector('svg.svgLayout, .svgLayout')).catch(() => false);
        if (isSvg) return true;
        throw new Error('setCatBlockOnB:blocks_not_ready');
      }

      await page.evaluate((val, txt) => {
        const s = document.querySelector('select#blocks');
        if (!s) return;
        const byVal = [...s.options].find(o => String(o.value) === String(val));
        const byTxt = [...s.options].find(o => (o.textContent || '').trim().toLowerCase() === (txt || '').trim().toLowerCase());
        const t = byVal || byTxt;
        if (t) {
          s.value = t.value;
          s.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, safeBlockVal, safeBlockText);
      return true;
    } catch (e) {
      lastErr = e;
      try {
        // Re-trigger cat dropdown between attempts
        await page.evaluate(() => {
          const el = document.querySelector('.custom-select-box');
          if (el) { try { el.click(); } catch {} }
        });
      } catch {}
      await delay(700 * attempt);
    }
  }

  // If we reached here, legacy path failed. If SVG is present, do not fail the whole run.
  try {
    const isSvg = await page.evaluate(() => !!document.querySelector('svg.svgLayout, .svgLayout')).catch(() => false);
    if (isSvg) return true;
  } catch {}
  throw lastErr || new Error('setCatBlockOnB_failed');
};

const openSeatMapStrict = async (page) => {
  const clickInfo = await page.evaluate(()=>{
      const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();

      const byId = document.getElementById('custom_seat_button');
      const byText = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))
        .find(el => {
          const t = norm(el.innerText || el.textContent || el.value || '');
          if (!t) return false;
          // Seen in DOM: "Seçimi değiştir". Also handle other possible CTAs.
          return (
            t === 'seçimi değiştir' ||
            t.includes('kendim seçmek istiyorum') ||
            (t.includes('koltuk') && (t.includes('seç') || t.includes('seçim') || t.includes('değiştir')))
          );
        });

      const btn = byId || byText;
      if (!btn) return { ok: false, reason: 'not_found' };
      const s=getComputedStyle(btn);
      const hidden = btn.closest('[hidden]')||s.display==='none'||s.visibility==='hidden'||btn.offsetParent===null||btn.disabled;
      if (hidden) return { ok: false, reason: 'hidden' };
      try { btn.scrollIntoView({block:'center'}); } catch {}
      const r = btn.getBoundingClientRect();
      if (!r || !r.width || !r.height) {
        try { btn.click(); } catch {}
        return { ok: true, method: 'dom_click_no_rect' };
      }
      const x = r.left + (r.width / 2);
      const y = r.top + (r.height / 2);
      try { btn.click(); } catch {}
      return { ok: true, method: 'dom_click', x, y };
  });

  if (clickInfo && clickInfo.ok && Number.isFinite(clickInfo.x) && Number.isFinite(clickInfo.y)) {
      try {
          await page.mouse.move(clickInfo.x, clickInfo.y);
          await page.mouse.click(clickInfo.x, clickInfo.y, { delay: 35 });
      } catch {}
  } else if (!clickInfo?.ok) {
      try { await page.waitForSelector('#custom_seat_button',{visible:true,timeout:4000}); await page.click('#custom_seat_button', { delay: 35 }); } catch {}
  }
  const seatMapContainerSelector = 'svg.seatmap-svg, #seatmap, [id*="seat" i][class*="map" i], iframe';
  const isReadyInContext = async (ctx) => {
      try {
          const hasContainer = await ctx.evaluate((sel) => !!document.querySelector(sel), seatMapContainerSelector).catch(() => false);
          const hasNodes = await ctx.evaluate((sel) => document.querySelectorAll(sel).length > 0, SEAT_NODE_SELECTOR).catch(() => false);
          return !!(hasContainer && hasNodes);
      } catch {
          return false;
      }
  };

  for (let i=0;i<55;i++){
      const okMain = await isReadyInContext(page);
      if (okMain) return true;

      // Bazı durumlarda seat map iframe içinde olabiliyor; relevant frame'lerde de seat node arayalım.
      try {
          const frames = page.frames ? page.frames() : [];
          if (frames && frames.length > 1) {
              const main = typeof page.mainFrame === 'function' ? page.mainFrame() : null;
              for (const f of frames) {
                  if (main && f === main) continue;
                  const okFrame = await isReadyInContext(f);
                  if (okFrame) return true;
              }
          }
      } catch {}

      // İlk tıklama bazen boşa düşüyor; birkaç turda bir tekrar dene.
      if (i === 10 || i === 22 || i === 34 || i === 46) {
          try { await page.click('#custom_seat_button'); } catch {}
      }
      await delay(300);
  }
  return false;
};

async function clickContinueInsidePage(page){
  if (!page) return false;
  
  try {
      // Find the button and get its coordinates
      const btnData = await page.evaluate(() => {
          const norm = (s) => (s || '').toString().trim().toLowerCase();
          const candidates = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], .black-btn, .btn, [role="button"]'))
              .filter(el => {
                  const st = window.getComputedStyle(el);
                  const visible = !!(el.offsetParent !== null) && st && st.visibility !== 'hidden' && st.display !== 'none';
                  if (!visible) return false;
                  if (el.disabled) return false;
                  return true;
              });

          const scoreEl = (el) => {
              const t = norm(el.innerText || el.textContent || el.value || '');
              if (t === 'sepete devam et') return 100;
              if (t.includes('seçimi') || t.includes('değiştir')) return -1;
              let score = 0;
              if (t.includes('sepete') && t.includes('devam')) score += 10;
              else if (t.includes('sepete')) score += 5;
              else if (t.includes('devam')) score += 3;
              return score;
          };

          let best = null;
          let bestScore = 0;
          for (const el of candidates) {
              const s = scoreEl(el);
              if (s > bestScore) {
                  bestScore = s;
                  best = el;
              }
          }
          if (!best || bestScore <= 0) return null;

          best.scrollIntoView({ block: 'center', inline: 'center' });
          const r = best.getBoundingClientRect();
          return {
            x: r.left + (r.width / 2),
            y: r.top + (r.height / 2),
            text: (best.innerText || '').trim().substring(0, 50),
            score: bestScore
          };
      });
      
      if (!btnData || !btnData.x || !btnData.y) return false;
      
      // Use Puppeteer mouse click - this triggers Angular event handlers properly
      await page.mouse.move(btnData.x, btnData.y);
      await page.mouse.down();
      await page.mouse.up();
      
      return { ok: true, btnInfo: btnData };
  } catch {
      return false;
  }
}

module.exports = {
  ensurePage,
  ensureUrlContains,
  gotoWithRetry,
  isHomeUrl,
  SEAT_NODE_SELECTOR,
  captureSeatIdFromNetwork,
  readBasketData,
  readCatBlock,
  setCatBlockOnB,
  openSeatMapStrict,
  clickContinueInsidePage,
  ensureTcAssignedOnBasket,
  clickBasketDevamToOdeme,
  dismissPaymentInfoModalIfPresent,
  fillInvoiceTcAndContinue,
  acceptAgreementsAndContinue,
  fillNkolayPaymentIframe
};
