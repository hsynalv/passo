const delay = require('../utils/delay');

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

const captureSeatIdFromNetwork = (page, timeoutMs=15000)=> new Promise(resolve=>{
  let settled=false; const done=v=>{ if(!settled){ settled=true; try{page.removeListener('response',onResp);}catch{}; clearTimeout(t); resolve(v||null);} };
  const t=setTimeout(()=>done(null),timeoutMs);
  const onResp=async(resp)=>{ try{
      const url=resp.url(); if(!/basket|addseat|add-to-basket|seat|AddToBasket|cart|add/i.test(url)) return;
      const ct=(resp.headers()['content-type']||'').toLowerCase(); if(!ct.includes('application/json')) return;
      const data=await resp.json().catch(()=>null); if(!data) return;
      let seatId=null;
      if (data.seatId!=null) seatId=String(data.seatId);
      else if (data.seat_id!=null) seatId=String(data.seat_id);
      else if (data.data && (data.data.seatId!=null||data.data.seat_id!=null)) seatId=String(data.data.seatId ?? data.data.seat_id);
      else if (Array.isArray(data.selectedSeats)&&data.selectedSeats.length){
          const f=data.selectedSeats[0]; if(f&&(f.seatId!=null||f.seat_id!=null)) seatId=String(f.seatId ?? f.seat_id);
      }
      if (seatId) done(seatId);
  }catch{} };
  page.on('response',onResp);
});

async function readBasketData(page) {
  return await page.evaluate(()=>{
      const get = (label) => {
          const el = Array.from(document.querySelectorAll('.basket-list-detail'))
              .find(e => (e.querySelector('.basket-span')?.textContent||'').trim() === label);
          return el ? (el.querySelector('span:last-child')?.textContent||'').trim() : '';
      };
      const tribune = get('Tribün');
      const block   = get('Blok');
      const row     = get('Sıra');
      const seat    = get('Koltuk');

      const sel = document.querySelector(
          'circle.seat-circle.selected, circle.seat-circle[aria-pressed="true"], [data-selected="true"], [seat-id].selected, [data-seat-id].selected'
      );
      const blockId = sel?.getAttribute('block-id') || '';
      const seatId  = sel?.getAttribute('seat-id') || sel?.getAttribute('data-seat-id') || sel?.getAttribute('data-id') || '';

      if (!tribune && !block && !row && !seat) return null;
      return { tribune, block, row, seat, blockId, seatId, combined: `${tribune} ${block} ${row} ${seat}`.trim() };
  }).catch(()=>null);
}

const readCatBlock = async (page) => page.evaluate(()=>{
  const cat = document.querySelector('.custom-select-box .selected-option')?.textContent?.trim() || '';
  const s = document.querySelector('select#blocks');
  const blockText = s?.selectedOptions?.[0]?.textContent?.trim() || '';
  const blockVal  = s?.value || '';
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
  for (let i=0;i<24;i++){
      const ok = await page.evaluate(()=> !!document.querySelector('circle.seat-circle'));
      if (ok) break;
      await delay(300);
  }
};

async function clickContinueInsidePage(page){
  return await page.evaluate(()=>{
      const texts = ['Sepete devam et','Sepete devam','Devam','SEPETE DEVAM ET','DEVAM'];
      const btn = [...document.querySelectorAll('button, .black-btn, .btn, [role="button"]')]
          .find(el => texts.some(t => ((el.innerText||'').trim().toLowerCase()) === t.toLowerCase() ||
              ((el.innerText||'').trim().toLowerCase()).includes(t.toLowerCase())));
      if (!btn) return false;
      const r=btn.getBoundingClientRect();
      ['mouseover','mousemove','mousedown','mouseup','click'].forEach(type=>{
          btn.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));
      });
      return true;
  });
}

module.exports = {
  ensurePage,
  captureSeatIdFromNetwork,
  readBasketData,
  readCatBlock,
  setCatBlockOnB,
  openSeatMapStrict,
  clickContinueInsidePage
};
