const delay = require('../utils/delay');

async function confirmSwalYes(page, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const clicked = await page.evaluate(() => {
      const cont = document.querySelector('.swal2-container.swal2-shown');
      if (!cont) return false;
      const btns = [
        ...cont.querySelectorAll('.swal2-actions .swal2-confirm, .swal2-confirm.swal2-styled, button.swal2-confirm, .swal2-actions button')
      ];
      if (!btns.length) return false;
      const prefer = (b) => {
        const t = (b.innerText || b.textContent || '').trim().toLowerCase();
        return ['evet','tamam','yes','ok','onayla','confirm'].includes(t);
      };
      const target = btns.find(prefer) || btns[0];
      if (!target) return false;
      const r = target.getBoundingClientRect();
      ['mouseover','mousemove','mousedown','mouseup','click'].forEach(type=>{
        target.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));
      });
      return true;
    });
    if (clicked) return true;
    await delay(120);
  }
  return false;
}

async function clickRemoveFromCartAndConfirm(page, timeoutMs = 12000) {
  const labels = ['Kaldır','Sepetten çıkar','Sil','Çıkar'];
  let clicked = false;
  for (const t of labels) {
    const ok = await page.evaluate((txt) => {
      const el = [...document.querySelectorAll('button,a')].find(e =>
        (e.innerText || e.textContent || '').trim().toLowerCase() === txt.toLowerCase()
      );
      if (el) { el.click(); return true; }
      return false;
    }, t);
    if (ok) { clicked = true; break; }
  }
  if (!clicked) {
    const icon = await page.$('[aria-label*="Kaldır"],[aria-label*="Sil"],.fa-trash,.icon-trash').catch(()=>null);
    if (icon) { try { await icon.click(); clicked = true; } catch {} }
  }
  if (!clicked) return false;
  return await confirmSwalYes(page, timeoutMs);
}

module.exports = { confirmSwalYes, clickRemoveFromCartAndConfirm };
