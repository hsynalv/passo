const delay = require('../utils/delay');
const { getCfg } = require('../runCfg');

async function confirmSwalYes(page, timeoutMs = null) {
  timeoutMs = timeoutMs || getCfg().TIMEOUTS.SWAL_CONFIRM_TIMEOUT;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const contexts = [page, ...(typeof page.frames === 'function' ? page.frames() : [])];
    for (const ctx of contexts) {
      // 0) Preferred: ctx.click with visibility wait + verify modal closes
      try {
        await ctx.waitForSelector('.swal2-container.swal2-shown .swal2-confirm', { visible: true, timeout: 400 });
        try {
          await ctx.click('.swal2-container.swal2-shown .swal2-confirm', { delay: 20 });
        } catch {
          try { await ctx.click('.swal2-container.swal2-shown .swal2-confirm'); } catch {}
        }
        try {
          await ctx.waitForSelector('.swal2-container.swal2-shown', { hidden: true, timeout: 2500 });
          return true;
        } catch {}
      } catch {}

      // 0.7) Exact match for Passo swal modal structure (based on provided HTML)
      try {
        const clickedExact = await ctx.evaluate(() => {
          const container = document.querySelector('.swal2-container.swal2-center.swal2-backdrop-show');
          if (!container) return false;
          const actions = container.querySelector('.swal2-actions');
          if (!actions) return false;
          const confirmBtn = actions.querySelector('.swal2-confirm.swal2-styled');
          if (!confirmBtn) return false;
          const text = (confirmBtn.innerText || confirmBtn.textContent || '').trim();
          if (text !== 'Evet') return false;
          
          // Aggressive click sequence
          try { confirmBtn.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          try { confirmBtn.focus(); } catch {}
          try { confirmBtn.click(); } catch {}
          
          // Dispatch all mouse events
          const r = confirmBtn.getBoundingClientRect();
          const events = ['mousedown', 'mouseup', 'click'];
          events.forEach(type => {
            const evt = new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: r.left + r.width / 2,
              clientY: r.top + r.height / 2,
              button: 0,
              buttons: 1
            });
            confirmBtn.dispatchEvent(evt);
          });
          
          // Also try pointer events
          const ptrEvt = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
          confirmBtn.dispatchEvent(ptrEvt);
          
          return true;
        });
        if (clickedExact) {
          await delay(800);
          const stillOpen = await ctx.evaluate(() => !!document.querySelector('.swal2-container.swal2-shown'));
          if (!stillOpen) return true;
        }
      } catch {}
      try {
        const clickedByText = await ctx.evaluate(() => {
          const norm = (s) => (s || '').toString().trim().toLowerCase();
          const want = ['evet', 'yes', 'ok', 'tamam', 'onayla', 'devam'];
          const root = document.querySelector('.swal2-container.swal2-shown');
          if (!root) return false;
          const btns = Array.from(root.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
          const b = btns.find((x) => want.some((w) => norm(x.innerText || x.textContent || x.value || '') === w || norm(x.innerText || x.textContent || x.value || '').includes(w)));
          if (!b) return false;
          try { b.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          try { b.click(); return true; } catch {}
          return false;
        });
        if (clickedByText) {
          try {
            await ctx.waitForSelector('.swal2-container.swal2-shown', { hidden: true, timeout: 2500 });
            return true;
          } catch {}
        }
      } catch {}

      // 0.6) Keyboard confirm fallback (Enter)
      try {
        const hasSwal = await ctx.$('.swal2-container.swal2-shown').catch(() => null);
        if (hasSwal) {
          try { await hasSwal.dispose(); } catch {}
          if (ctx === page && page.keyboard) {
            try { await page.keyboard.press('Enter'); } catch {}
            try {
              await page.waitForSelector('.swal2-container.swal2-shown', { hidden: true, timeout: 1500 });
              return true;
            } catch {}
          }
        }
      } catch {}

      // 1) Preferred: real puppeteer click on swal confirm button
      try {
        const btn = await ctx.$('.swal2-container.swal2-shown .swal2-actions .swal2-confirm, .swal2-container.swal2-shown .swal2-confirm.swal2-styled');
        if (btn) {
          try { await btn.click({ delay: 20 }); } catch { try { await btn.click(); } catch {} }

          // Extra fallback: mouse click at center (some overlays swallow element-handle clicks)
          try {
            if (ctx === page && page.mouse) {
              const box = await btn.boundingBox().catch(() => null);
              if (box && box.width > 0 && box.height > 0) {
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 20 });
              }
            }
          } catch {}

          try { await btn.dispose(); } catch {}
          // confirm should close modal; verify quickly
          const stillOpen = await ctx.$('.swal2-container.swal2-shown').catch(() => null);
          if (!stillOpen) return true;
          try { await stillOpen.dispose(); } catch {}
          // even if still open, loop will retry
        }
      } catch {}

      // 2) If no handle yet, wait briefly for swal confirm to appear
      try {
        await ctx.waitForSelector('.swal2-container.swal2-shown .swal2-confirm', { visible: true, timeout: 400 });
        const btn2 = await ctx.$('.swal2-container.swal2-shown .swal2-confirm');
        if (btn2) {
          try { await btn2.click({ delay: 20 }); } catch { try { await btn2.click(); } catch {} }
          try { await btn2.dispose(); } catch {}
          const stillOpen2 = await ctx.$('.swal2-container.swal2-shown').catch(() => null);
          if (!stillOpen2) return true;
          try { await stillOpen2.dispose(); } catch {}
        }
      } catch {}

      // 3) Fallback: DOM event dispatch (some frames may block handle click)
      try {
        const ok = await ctx.evaluate(() => {
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
        if (ok) {
          const stillOpen3 = await ctx.$('.swal2-container.swal2-shown').catch(() => null);
          if (!stillOpen3) return true;
          try { await stillOpen3.dispose(); } catch {}
        }
      } catch {}
    }
    await delay(120);
  }
  return false;
}

async function clickRemoveFromCartAndConfirm(page, timeoutMs = null) {
  timeoutMs = timeoutMs || getCfg().TIMEOUTS.REMOVE_FROM_CART_TIMEOUT;
  const labels = ['Sil','Kaldır','Sepetten çıkar','Sepetten Çıkar','Çıkar','Remove','Delete'];
  let clicked = false;
  const contexts = [page, ...(typeof page.frames === 'function' ? page.frames() : [])];

  // Basket UI may render late (Angular). Wait a bit for remove button to appear in any frame.
  for (const ctx of contexts) {
    try {
      await ctx.waitForFunction(() => {
        const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = (el) => {
          try {
            const r = el.getBoundingClientRect();
            if (!r || r.width < 2 || r.height < 2) return false;
            const st = window.getComputedStyle(el);
            if (!st || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
            return true;
          } catch { return false; }
        };
        const btns = [...document.querySelectorAll('button,a,[role="button"]')];
        return btns.some(b => isVisible(b) && /\bsil\b|\bkald\w*r\b|remove|delete/i.test(norm(b.innerText || b.textContent || '')));
      }, { timeout: 5000 });
    } catch {}
  }

  const tryClickByLabels = async (ctx) => {
    for (const t of labels) {
      const ok = await ctx.evaluate((txt) => {
        const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
        const want = norm(txt);
        const nodes = [...document.querySelectorAll('button,a,[role="button"],span')];
        const isVisible = (el) => {
          try {
            const r = el.getBoundingClientRect();
            if (!r || r.width < 2 || r.height < 2) return false;
            const st = window.getComputedStyle(el);
            if (!st || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
            return true;
          } catch { return false; }
        };

        const textOf = (e) => norm(e.innerText || e.textContent || '');

        // Prefer exact "Sil" (but avoid "Tümünü Sil")
        if (want === 'sil') {
          const candidates = nodes
            .map((e) => ({ e, t: textOf(e) }))
            .filter((x) => x.t && isVisible(x.e));
          const best =
            candidates.find((x) => x.t === 'sil') ||
            candidates.find((x) => x.t.includes('sil') && !x.t.includes('tümünü')) ||
            null;
          if (best) {
            const btn = best.e.closest('button,a,[role="button"]') || best.e;
            try { btn.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
            try { btn.click(); } catch {
              try {
                const r = btn.getBoundingClientRect();
                ['mouseover','mousemove','mousedown','mouseup','click'].forEach(type => {
                  btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width/2, clientY: r.top + r.height/2 }));
                });
              } catch {}
            }
            return true;
          }
        }

        let el = nodes.find(e => isVisible(e) && textOf(e) === want) || null;
        if (!el) el = nodes.find(e => isVisible(e) && norm(e.innerText || e.textContent || '').includes(want)) || null;
        if (!el) return false;

        const btn = el.closest('button,a,[role="button"]') || el;
        try { btn.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
        try { btn.click(); } catch {
          try {
            const r = btn.getBoundingClientRect();
            ['mouseover','mousemove','mousedown','mouseup','click'].forEach(type => {
              btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width/2, clientY: r.top + r.height/2 }));
            });
          } catch {}
        }
        return true;
      }, t);
      if (ok) return true;
    }
    return false;
  };

  const tryBootstrapDanger = async (ctx) => {
    const ok4 = await ctx.evaluate(() => {
      const btn = document.querySelector('button.btn-outline-danger, button.btn-danger, .basket-list-detail button.btn-outline-danger, .basket-list-detail button.btn-danger');
      if (!btn) return false;
      try { btn.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
      try { btn.click(); return true; } catch {}
      return false;
    });
    return !!ok4;
  };

  const tryIconOrHeuristic = async (ctx) => {
    const ok = await ctx.evaluate(() => {
      const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = (el) => {
        try {
          const r = el.getBoundingClientRect();
          if (!r || r.width < 2 || r.height < 2) return false;
          const st = window.getComputedStyle(el);
          if (!st || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
          return true;
        } catch { return false; }
      };
      const nodes = [...document.querySelectorAll('button,a,[role="button"],svg,i,span')];
      const cand = nodes
        .map((n) => {
          const t = norm(n.getAttribute?.('aria-label') || n.getAttribute?.('title') || n.innerText || n.textContent || '');
          const cls = norm(n.getAttribute?.('class') || '');
          const dt = norm(n.getAttribute?.('data-testid') || '');
          const score =
            (t.includes('kaldır') ? 10 : 0) +
            (t.includes('sepett') && t.includes('çıkar') ? 10 : 0) +
            (t.includes('sil') ? 6 : 0) +
            (t.includes('çıkar') ? 6 : 0) +
            (cls.includes('trash') ? 4 : 0) +
            (cls.includes('remove') ? 4 : 0) +
            (cls.includes('delete') ? 4 : 0) +
            (dt.includes('remove') ? 4 : 0) +
            (dt.includes('delete') ? 4 : 0);
          return { n, score };
        })
        .filter(x => x.score > 0 && isVisible(x.n))
        .sort((a,b) => b.score - a.score)[0];
      if (!cand) return false;
      const btn = cand.n.closest('button,a,[role="button"]') || cand.n;
      try { btn.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
      try { btn.click(); return true; } catch {}
      return false;
    });
    if (ok) return true;

    const ok3 = await ctx.evaluate(() => {
      const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
      const roots = [
        document.querySelector('.basket-list-detail'),
        document.querySelector('.basket-list'),
        document.querySelector('.basket'),
        document.querySelector('[data-testid*="basket" i]'),
        document.querySelector('[data-testid*="sepet" i]')
      ].filter(Boolean);
      const root = roots[0];
      if (!root) return false;

      const isDisabled = (el) => el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true';
      const btnLike = (el) => {
        if (!el) return false;
        const tag = (el.tagName || '').toLowerCase();
        if (tag === 'button' || tag === 'a') return true;
        if (el.getAttribute && el.getAttribute('role') === 'button') return true;
        return false;
      };

      const explicit = root.querySelector(
        '[data-testid*="remove" i], [data-testid*="delete" i], [aria-label*="kald" i], [aria-label*="sil" i], [aria-label*="çıkar" i], [title*="kald" i], [title*="sil" i], [class*="remove" i], [class*="delete" i], [class*="trash" i]'
      );
      if (explicit && !isDisabled(explicit)) {
        const b = explicit.closest('button,a,[role="button"]') || explicit;
        try { b.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
        try { b.click(); return true; } catch {}
      }

      const item = root.querySelector('li, .basket-item, .basket-row, .basket-product, .product, .row') || root;
      const btns = [...item.querySelectorAll('button,a,[role="button"]')].filter(b => !isDisabled(b));
      const scored = btns
        .map((b) => {
          const t = norm(b.getAttribute('aria-label') || b.getAttribute('title') || b.innerText || b.textContent || '');
          const cls = norm(b.getAttribute('class') || '');
          const dt = norm(b.getAttribute('data-testid') || '');
          const key = `${t} ${cls} ${dt}`;
          const score =
            (key.includes('kald') ? 10 : 0) +
            (key.includes('sepett') && key.includes('çıkar') ? 10 : 0) +
            (key.includes('sil') ? 8 : 0) +
            (key.includes('remove') ? 6 : 0) +
            (key.includes('delete') ? 6 : 0) +
            (key.includes('trash') ? 6 : 0) +
            (key.includes('x') ? 2 : 0);
          return { b, score };
        })
        .sort((a, b) => b.score - a.score);

      const best = scored.find(x => x.score > 0)?.b || btns[btns.length - 1];
      if (best && btnLike(best)) {
        try { best.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
        try { best.click(); return true; } catch {}
      }
      return false;
    });
    return !!ok3;
  };

  for (const ctx of contexts) {
    try {
      if (await tryClickByLabels(ctx)) { clicked = true; break; }
    } catch {}
  }
  if (!clicked) {
    for (const ctx of contexts) {
      try {
        if (await tryBootstrapDanger(ctx)) { clicked = true; break; }
      } catch {}
    }
  }
  if (!clicked) {
    for (const ctx of contexts) {
      try {
        if (await tryIconOrHeuristic(ctx)) { clicked = true; break; }
      } catch {}
    }
  }
  if (!clicked) return false;
  return await confirmSwalYes(page, timeoutMs);
}

module.exports = { confirmSwalYes, clickRemoveFromCartAndConfirm };
