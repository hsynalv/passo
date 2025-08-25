const delay = require('../utils/delay');
const { openSeatMapStrict, readBasketData, clickContinueInsidePage } = require('./page');

/** A: random seat seç + sepet doğrulaması (re-click yok) */
async function pickRandomSeatWithVerify(page, maxMs = 45000){
  const end = Date.now() + maxMs;
  await openSeatMapStrict(page);
  await page.evaluate(()=>{ window.__passobot = {clicked:false, done:false}; });

  while (Date.now() < end) {
      // zaten sepette mi?
      const b0 = await readBasketData(page);
      if (b0 && b0.row && b0.seat) return b0;

      // seçili koltuk varsa tekrar TIKLAMA YOK
      const hasSelected = await page.evaluate(()=> !!document.querySelector(
          'circle.seat-circle.selected, circle.seat-circle[aria-pressed="true"], [data-selected="true"]'
      ));
      if (!hasSelected) {
          const clicked = await page.evaluate(() => {
              const pool = Array.from(document.querySelectorAll('circle.seat-circle'))
                  .filter(el =>
                      el.hasAttribute('block-id') &&
                      !el.classList.contains('occupied') &&
                      !el.classList.contains('disabled') &&
                      el.getAttribute('aria-disabled')!=='true'
                  );
              if (!pool.length) return false;
              const s = pool[Math.floor(Math.random()*pool.length)];
              s.scrollIntoView({block:'center', inline:'center'});
              const r = s.getBoundingClientRect();
              ['pointerover','pointerdown','mousedown','mouseup','pointerup','click'].forEach(type=>{
                  s.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));
              });
              window.__passobot.clicked = true;
              return true;
          });
          if (!clicked) { await delay(200); continue; }
      }

      // seçiliyse sadece DEVAM
      await clickContinueInsidePage(page);

      for (let w=0; w<20; w++){
          const data = await readBasketData(page);
          if (data && data.row && data.seat) return data;
          await delay(200);
      }
      // olmadıysa dön ama RE-CLICK yok; sadece tekrar devam dener
  }
  throw new Error('❌ Sürede koltuk seçimi/sepet doğrulaması yapılamadı (A).');
}

/** B: aynı koltuğu seç (KİLİTLİ — seçiliyken re-click YOK) */
async function pickExactSeatWithVerify_Locked(page, target, maxMs = 90000){
  const end = Date.now() + maxMs;
  await openSeatMapStrict(page);

  const wantSeatId=(target.seatId||'').toString().trim();
  const wantRow=(target.row||'').toString().trim().toLowerCase();
  const wantSeat=(target.seat||'').toString().trim().toLowerCase();

  await page.evaluate(()=>{ window.__passobot = {clicked:false, done:false}; });

  while (Date.now() < end) {
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

module.exports = { pickRandomSeatWithVerify, pickExactSeatWithVerify_Locked };
