const delay = require('../utils/delay');
const cfg = require('../config');

const SEAT_NODE_SELECTOR = 'circle.seat-circle, svg.seatmap-svg g[id^="seat"] rect, svg.seatmap-svg rect[class^="block"], [seat-id], [data-seat-id], [data-id][class*="seat"], [class*="seat-circle"], svg circle[class*="seat"], .seat-circle';

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

  const isOk = (u) => !!u && u.includes(expected);

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
      await page.waitForFunction((inc) => location.href.includes(inc), { timeout: waitMs }, expected);
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
  timeoutMs = timeoutMs || cfg.TIMEOUTS.NETWORK_CAPTURE_TIMEOUT;
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

    if (!tribune && !block && !row && !seat) {
      // Seat selection page can contain "Sepete devam" etc. Avoid false positives.
      if (isSeatSelection && !isBasketUrl) return null;
      if (!hasStrongBasketDom && !isBasketUrl) return null;
      return { tribune: '', block: '', row: '', seat: '', blockId, seatId, combined: '', inBasket: true, url };
    }
    return { tribune, block, row, seat, blockId, seatId, combined: `${tribune} ${block} ${row} ${seat}`.trim(), inBasket: true, url };
  }).catch(() => null);
}

const readCatBlock = async (page) => page.evaluate(()=>{
  const cat = document.querySelector('.custom-select-box .selected-option')?.textContent?.trim() || '';
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
  await page.waitForSelector('.custom-select-box',{visible:true});
  await page.evaluate(()=>document.querySelector('.custom-select-box')?.click());
  await page.waitForSelector('.dropdown-option:not(.disabled)', {visible:true});
  await page.evaluate(catText=>{
      const opts=[...document.querySelectorAll('.dropdown-option:not(.disabled)')];
      const i=opts.findIndex(o=>(o.textContent||'').trim().toLowerCase().startsWith((catText||'').trim().toLowerCase()));
      (i>=0?opts[i]:opts[0])?.click();
  }, catBlock.categoryText||'');

  await page.waitForFunction(()=>{ const s=document.querySelector('select#blocks'); return s && s.options.length>1; }, {timeout:8000});
  await page.evaluate((val,txt)=>{
      const s=document.querySelector('select#blocks'); if(!s) return;
      const byVal=[...s.options].find(o=>String(o.value)===String(val));
      const byTxt=[...s.options].find(o=>(o.textContent||'').trim().toLowerCase()===(txt||'').trim().toLowerCase());
      const t = byVal||byTxt;
      if (t){ s.value=t.value; s.dispatchEvent(new Event('change',{bubbles:true})); }
  }, catBlock.blockVal, catBlock.blockText);
};

const openSeatMapStrict = async (page) => {
  const clicked = await page.evaluate(()=>{
      const btn = document.getElementById('custom_seat_button');
      if (!btn) return false;
      const s=getComputedStyle(btn);
      const hidden = btn.closest('[hidden]')||s.display==='none'||s.visibility==='hidden'||btn.offsetParent===null||btn.disabled;
      if (hidden) return false;
      btn.scrollIntoView({block:'center'}); btn.click(); return true;
  });
  if (!clicked) {
      try { await page.waitForSelector('#custom_seat_button',{visible:true,timeout:4000}); await page.click('#custom_seat_button'); } catch {}
  }
  for (let i=0;i<40;i++){
      const okMain = await page.evaluate((sel)=> document.querySelectorAll(sel).length > 0, SEAT_NODE_SELECTOR).catch(()=>false);
      if (okMain) return true;

      // Bazı durumlarda seat map iframe içinde olabiliyor; frame'lerde de seat node arayalım.
      try {
          const frames = page.frames ? page.frames() : [];
          if (frames && frames.length > 1) {
              for (const f of frames) {
                  if (f === page.mainFrame?.()) continue;
                  const okFrame = await f.evaluate((sel)=> document.querySelectorAll(sel).length > 0, SEAT_NODE_SELECTOR).catch(()=>false);
                  if (okFrame) return true;
              }
          }
      } catch {}

      // İlk tıklama bazen boşa düşüyor; birkaç turda bir tekrar dene.
      if (i === 8 || i === 18 || i === 28) {
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
  SEAT_NODE_SELECTOR,
  captureSeatIdFromNetwork,
  readBasketData,
  readCatBlock,
  setCatBlockOnB,
  openSeatMapStrict,
  clickContinueInsidePage
};
