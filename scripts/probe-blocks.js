'use strict';

/**
 * probe-blocks.js
 *
 * Kullanım:
 *   node scripts/probe-blocks.js <legacyUrl> <svgUrl> <email> <password>
 *
 * Örnekler:
 *   node scripts/probe-blocks.js \
 *     "https://www.passo.com.tr/tr/etkinlik/lig-maci/11111111/koltuk-secim" \
 *     "https://www.passo.com.tr/tr/etkinlik/svg-maci/22222222/koltuk-secim" \
 *     "email@gmail.com" "sifre123"
 *
 * Sadece 1 URL test edeceksen diğerine "skip" yaz:
 *   node scripts/probe-blocks.js "skip" "https://..." "email" "sifre"
 */

const path = require('path');
const fs   = require('fs');
const { connect } = require('puppeteer-real-browser');

const legacyUrl = process.argv[2] || '';
const svgUrl    = process.argv[3] || '';

if (!legacyUrl && !svgUrl) {
  console.error('[HATA] Kullanim: node probe-blocks.js <legacyUrl|skip> <svgUrl|skip>');
  console.error('Ornek: node probe-blocks.js skip "https://www.passo.com.tr/tr/etkinlik/.../koltuk-secim"');
  process.exit(1);
}

// ─── Log setup ───────────────────────────────────────────────────────────────
const logsDir  = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const logFile  = path.join(logsDir, 'probe-blocks-' + Date.now() + '.txt');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function log(...args) {
  const line = args.join(' ');
  console.log(line);
  logStream.write(line + '\n');
}

function sep(title) {
  log('\n' + '═'.repeat(60));
  if (title) log('  ' + title);
  log('═'.repeat(60));
}

function sub(title) {
  log('\n' + '─'.repeat(50));
  log('  ' + title);
  log('─'.repeat(50));
}

// ─── Browser path ────────────────────────────────────────────────────────────
function findBrowserPath() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      const m = fs.readFileSync(envPath, 'utf8').match(/^CHROME_PATH\s*=\s*(.+)$/m);
      if (m) { const p = m[1].trim().replace(/^["']|["']$/g, ''); if (fs.existsSync(p)) return p; }
    }
  } catch {}
  const pf   = process.env['ProgramFiles']      || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const lad  = process.env['LOCALAPPDATA']       || '';
  for (const c of [
    path.join(pf,   'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(pf86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(lad,  'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(pf,   'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(lad,  'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf,   'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const waitForEnter = (msg) => new Promise(resolve => {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  rl.question(msg, () => { rl.close(); resolve(); });
});

// ─── API helpers ─────────────────────────────────────────────────────────────

async function apiGet(page, url) {
  try {
    const result = await page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { credentials: 'include' });
        const text = await r.text();
        return { ok: r.ok, status: r.status, body: text };
      } catch (e) {
        return { ok: false, status: 0, body: '', error: e.message };
      }
    }, url);
    if (!result.ok) return null;
    return JSON.parse(result.body);
  } catch {
    return null;
  }
}

// ─── DOM inspectors ──────────────────────────────────────────────────────────

async function inspectLegacyDOM(page) {
  return page.evaluate(() => {
    const results = { categories: [], blocks: [], rawHtml: '' };

    // Kategori dropdown'u (custom-select-box veya native select)
    const customOpts = Array.from(document.querySelectorAll('.custom-select-box .dropdown-option, .custom-select-box [role="option"]'));
    if (customOpts.length) {
      results.categories = customOpts.map(el => ({
        text: (el.textContent || '').trim(),
        dataValue: el.getAttribute('data-value') || '',
        dataId: el.getAttribute('data-id') || '',
        className: el.className,
        allAttrs: Array.from(el.attributes).map(a => ({ name: a.name, value: a.value }))
      }));
    }

    // Native select kategori
    const catSelect = document.querySelector('select[id*="categor" i], select[name*="categor" i]');
    if (catSelect && !results.categories.length) {
      results.categories = Array.from(catSelect.options).map(o => ({
        text: (o.textContent || '').trim(),
        value: o.value,
        dataId: o.getAttribute('data-id') || ''
      }));
    }

    // Blok select
    const blockSelect = document.querySelector('select#blocks, select[id*="block" i]');
    if (blockSelect) {
      results.blocks = Array.from(blockSelect.options).map(o => ({
        text: (o.textContent || '').trim(),
        value: o.value,
        dataId: o.getAttribute('data-id') || '',
        allAttrs: Array.from(o.attributes).map(a => ({ name: a.name, value: a.value }))
      }));
    }

    // Snippet of page HTML (kategori area)
    try {
      const area = document.querySelector('.category-selection, .seat-selection, [class*="category"], [class*="seat-map-container"]');
      results.rawHtml = (area ? area.outerHTML : '').slice(0, 2000);
    } catch {}

    return results;
  });
}

async function inspectSvgDOM(page) {
  return page.evaluate(() => {
    const results = { blocks: [], svgPresent: false, svgId: '', rawSvgHtml: '' };

    const svg = document.querySelector('svg.svgLayout, svg[class*="svgLayout"], .svgLayout svg, svg');
    if (!svg) return results;

    results.svgPresent = true;
    results.svgId = svg.id || svg.className || '';

    // Tüm tıklanabilir blok elementleri
    // Olası seçiciler: g[id], path[id], polygon[id], rect[id], [data-id], [data-block]
    const candidates = Array.from(svg.querySelectorAll('[id], [data-id], [data-block], [data-block-id], [data-name]'));

    const unique = new Map();
    for (const el of candidates) {
      const id = el.id || el.getAttribute('data-id') || '';
      if (!id || id.length < 2) continue;
      if (unique.has(id)) continue;

      // Title tag
      const titleEl = el.querySelector('title');
      const titleText = titleEl ? titleEl.textContent.trim() : '';

      // Tüm data-* attribute'lar
      const dataAttrs = {};
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.startsWith('data-')) dataAttrs[attr.name] = attr.value;
      }

      // Aria label
      const ariaLabel = el.getAttribute('aria-label') || '';

      // Text content (kısa)
      const textContent = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100);

      unique.set(id, {
        domId: id,
        tagName: el.tagName,
        titleText,
        ariaLabel,
        textContent,
        dataAttrs,
        allAttrs: Array.from(el.attributes)
          .filter(a => !a.name.startsWith('style'))
          .map(a => ({ name: a.name, value: a.value.slice(0, 80) }))
      });
    }

    results.blocks = Array.from(unique.values());

    // SVG outerHTML snippet
    results.rawSvgHtml = svg.outerHTML.slice(0, 3000);

    return results;
  });
}

// ─── Network capture ─────────────────────────────────────────────────────────

function attachNetworkCapture(page, captured) {
  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (!url.includes('passo.com.tr/api')) return;
      const rtype = res.request().resourceType();
      if (rtype !== 'xhr' && rtype !== 'fetch') return;
      if (res.status() < 200 || res.status() >= 400) return;
      const body = await res.text().catch(() => '');
      const key = url.split('?')[0].split('/').slice(-2).join('/');
      if (!captured.has(key)) {
        captured.set(key, { url, body });
      }
    } catch {}
  });
}

// ─── URL'den eventId çıkar ───────────────────────────────────────────────────
function extractEventId(url) {
  const m = url.match(/\/(\d{6,})/);
  return m ? m[1] : null;
}

// ─── Bir URL'yi incele ───────────────────────────────────────────────────────
async function probeUrl(page, targetUrl, label) {
  sep(label + ' — ' + targetUrl);

  const eventId = extractEventId(targetUrl);
  log('  EventId: ' + (eventId || 'bulunamadi'));

  const captured = new Map();
  attachNetworkCapture(page, captured);

  // koltuk-secim URL'sine git
  const koltukUrl = targetUrl.includes('koltuk-secim') ? targetUrl
    : targetUrl.replace(/\/?$/, '/koltuk-secim');

  log('\n[*] Navigate: ' + koltukUrl);
  try {
    await page.goto(koltukUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    log('[UYARI] goto timeout/hata: ' + e.message);
  }
  await sleep(4000);

  // ─── SVG mi Legacy mi? ─────────────────────────────────────────────────────
  const pageType = await page.evaluate(() => {
    const hasSvg = !!document.querySelector('svg.svgLayout, svg[class*="svgLayout"], .svgLayout');
    const hasLegacy = !!document.querySelector('.custom-select-box, select#blocks');
    return hasSvg ? 'svg' : hasLegacy ? 'legacy' : 'unknown';
  });

  log('  Sayfa tipi: ' + pageType.toUpperCase());

  // ─── API: kategori ve blok listesi ────────────────────────────────────────
  if (eventId) {
    sub('API — getavailableblocklist (tüm kategoriler için)');

    // Önce kategorileri çek
    const catRes = await apiGet(page,
      `https://ticketingweb.passo.com.tr/api/passoweb/getcategories?eventId=${eventId}&serieId=&tickettype=100&campaignId=null&validationintegrationid=null`
    );

    if (catRes && catRes.valueList) {
      log('  Kategoriler (' + catRes.valueList.length + ' adet):');
      for (const cat of catRes.valueList) {
        log('    [' + cat.id + '] ' + cat.name + ' — ' + cat.formattedPrice);

        // Her kategori için blok listesi
        const blkRes = await apiGet(page,
          `https://ticketingweb.passo.com.tr/api/passoweb/getavailableblocklist?eventId=${eventId}&serieId=&seatCategoryId=${cat.id}`
        );

        if (blkRes && blkRes.valueList && blkRes.valueList.length) {
          log('      Bloklar:');
          for (const blk of blkRes.valueList) {
            log('        → blockId=' + blk.id + '  name="' + blk.name + '"  toplam=' + blk.totalCount);
          }
        } else {
          log('      Blok yok / boş yanıt');
        }

        await sleep(300);
      }
    } else {
      log('  [UYARI] getcategories yanıt alınamadi');
    }
  }

  // ─── SVG blok tıklama → API doğrulama ────────────────────────────────────
  // Bir bloğa tıklayıp hangi blockId ile getseatstatus çağrıldığını yakala
  if (pageType === 'svg') {
    sub('SVG Doğrulama — İlk bloğa tıkla, getseatstatus blockId kontrol et');

    const clickResults = [];
    const clickCapture = new Promise(async (resolve) => {
      const handler = async (res) => {
        try {
          const u = res.url();
          if (u.includes('getseatstatus') || u.includes('getseats?') || u.includes('getavailableblocklist')) {
            clickResults.push(u);
          }
        } catch {}
      };
      page.on('response', handler);

      // İlk tıklanabilir bloğu bul ve tıkla
      try {
        const firstBlock = await page.$('g.block[id^="block"]');
        if (firstBlock) {
          const domId = await page.evaluate(el => el.id, firstBlock);
          const expectedInt = parseInt(domId.replace('block', ''));
          log('  Tiklanan blok DOM ID : ' + domId);
          log('  Beklenen API blockId : ' + expectedInt);
          await firstBlock.click();
          await sleep(3000);
        } else {
          log('  [UYARI] Tiklanabilir blok bulunamadi');
        }
      } catch (e) {
        log('  [HATA] Tiklama: ' + e.message);
      }

      page.off('response', handler);
      resolve();
    });

    await clickCapture;

    log('\n  Tiklamadan sonra gelen API istekleri:');
    if (clickResults.length === 0) {
      log('  (hic istek yakalanmadi)');
    }
    for (const u of clickResults) {
      const blockIdMatch = u.match(/blockId=(\d+)/);
      const apiBlockId = blockIdMatch ? blockIdMatch[1] : '?';
      log('  → ' + u.split('?')[0].split('/').pop() + '  blockId=' + apiBlockId);
      if (blockIdMatch) {
        log('    *** API blockId: ' + apiBlockId + ' ***');
      }
    }

    await sleep(1000);
    // Geri dön (sonraki DOM inceleme için sayfayı yenile)
    await page.goto(koltukUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(3000);
  }

  // ─── DOM inceleme ─────────────────────────────────────────────────────────
  if (pageType === 'svg') {
    sub('SVG DOM — Blok elementleri');
    const svgData = await inspectSvgDOM(page);
    log('  SVG mevcut: ' + svgData.svgPresent);
    log('  Bulunan element sayisi: ' + svgData.blocks.length);
    log('');

    for (const blk of svgData.blocks) {
      log('  DOM ID  : ' + blk.domId);
      log('  Tag     : ' + blk.tagName);
      log('  Title   : ' + (blk.titleText || '(yok)'));
      log('  Aria    : ' + (blk.ariaLabel || '(yok)'));
      log('  Text    : ' + (blk.textContent || '(yok)').slice(0, 60));
      if (Object.keys(blk.dataAttrs).length) {
        log('  data-*  : ' + JSON.stringify(blk.dataAttrs));
      }
      log('  Attrs   : ' + blk.allAttrs.map(a => a.name + '="' + a.value + '"').join('  '));
      log('');
    }

    // Raw SVG HTML snippet
    sub('SVG outerHTML (ilk 3000 karakter)');
    log(svgData.rawSvgHtml);

  } else if (pageType === 'legacy') {
    sub('Legacy DOM — Kategori ve blok dropdown');
    const legData = await inspectLegacyDOM(page);

    log('  Kategoriler (' + legData.categories.length + '):');
    for (const c of legData.categories) {
      log('    text="' + c.text + '"  value="' + (c.value || c.dataValue) + '"  data-id="' + c.dataId + '"');
      if (c.allAttrs && c.allAttrs.length) {
        log('    attrs: ' + c.allAttrs.map(a => a.name + '="' + a.value + '"').join('  '));
      }
    }

    log('\n  Bloklar (' + legData.blocks.length + '):');
    for (const b of legData.blocks) {
      log('    text="' + b.text + '"  value="' + b.value + '"  data-id="' + b.dataId + '"');
      if (b.allAttrs && b.allAttrs.length) {
        log('    attrs: ' + b.allAttrs.map(a => a.name + '="' + a.value + '"').join('  '));
      }
    }

    sub('Sayfa HTML snippet');
    log(legData.rawHtml.slice(0, 2000));

  } else {
    log('[UYARI] Sayfa tipi taninamadi. Muhtemelen henuz yuklenmedi veya login gerekiyor.');
    const html = await page.evaluate(() => document.body.innerHTML.slice(0, 1000));
    log(html);
  }

  // ─── Yakalanan API istekleri ───────────────────────────────────────────────
  if (captured.size) {
    sub('Yakalanan API istekleri');
    for (const [key, data] of captured) {
      log('  ' + key + '  →  ' + data.body.slice(0, 200));
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  sep('Passo Block Probe');
  log('  Legacy URL : ' + (legacyUrl === 'skip' ? 'ATLANDI' : legacyUrl));
  log('  SVG URL    : ' + (svgUrl    === 'skip' ? 'ATLANDI' : svgUrl));
  log('  Log        : ' + logFile);

  const browserPath = findBrowserPath();
  if (!browserPath) {
    log('[HATA] Brave/Chrome bulunamadi!');
    process.exit(1);
  }
  log('  Browser    : ' + browserPath);

  let browser, page;
  try {
    const result = await connect({
      headless: false,
      turnstile: true,
      args: ['--window-size=1400,900'],
      customConfig: { chromePath: browserPath },
      connectOption: { defaultViewport: null }
    });
    browser = result.browser;
    page    = result.page;
    log('\n[OK] Tarayici acildi.');
  } catch (e) {
    log('[HATA] Tarayici acilamadi: ' + e.message);
    process.exit(1);
  }

  // ─── Login ──────────────────────────────────────────────────────────────────
  sep('Login');
  await page.goto('https://www.passo.com.tr/tr/giris', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(1500);

  log('');
  log('  Tarayicida Passo hesabina giris yap.');
  log('  Giris tamamlaninca asagida Enter a bas.');
  log('');
  await waitForEnter('>>> Giris yapildi, devam etmek icin ENTER: ');

  const currentUrl = page.url();
  log('[OK] Devam ediliyor. Mevcut URL: ' + currentUrl);

  // ─── Legacy URL ─────────────────────────────────────────────────────────────
  if (legacyUrl && legacyUrl !== 'skip') {
    await probeUrl(page, legacyUrl, 'LEGACY MAÇ');
    await sleep(2000);
  }

  // ─── SVG URL ────────────────────────────────────────────────────────────────
  if (svgUrl && svgUrl !== 'skip') {
    await probeUrl(page, svgUrl, 'SVG MAÇ');
  }

  sep('TAMAMLANDI');
  log('Log dosyasi: ' + logFile);
  log('\nTarayiciyi kapatmak icin Ctrl+C ye bas.');

  // Tarayıcıyı açık bırak (inceleme için)
  await sleep(60000);
  await browser.close();
}

main().catch(e => {
  log('[FATAL] ' + e.message);
  process.exit(1);
});
