const $ = (id) => document.getElementById(id);

const logBox = $('logBox');
const statusBox = $('statusBox');
const connStatus = $('connStatus');
const runIdEl = $('runId');
const runStatusEl = $('runStatus');
const logFilterEl = $('logFilter');
const autoScrollEl = $('autoScroll');
const autoScrollStatusEl = $('autoScrollStatus');
const cTransferPairInput = $('cTransferPairIndexInput');
const stepperItems = Array.from(document.querySelectorAll('[data-step-target]'));
const stepPanels = Array.from(document.querySelectorAll('[data-step-panel]'));

let currentRunId = null;
let es = null;

function showToast(title, msg, type = 'success', durationMs = 4500) {
  const container = $('toastContainer');
  if (!container) return;
  const icons = { success: '\u2713', error: '\u2717', info: 'i' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toastIcon">${icons[type] || icons.info}</span><div class="toastBody"><div class="toastTitle">${escapeHtml(title)}</div><div class="toastMsg">${escapeHtml(msg)}</div></div><button class="toastClose" aria-label="Kapat">&times;</button>`;
  el.querySelector('.toastClose').addEventListener('click', () => removeToast(el));
  container.appendChild(el);
  setTimeout(() => removeToast(el), durationMs);
}

function removeToast(el) {
  if (!el || !el.parentNode) return;
  if (el.classList.contains('leaving')) return;
  el.classList.add('leaving');
  el.addEventListener('animationend', () => el.remove(), { once: true });
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderPairDashboard(dash) {
  const metaEl = $('pairDashboardMeta');
  const bodyEl = $('pairDashboardBody');
  if (!metaEl || !bodyEl) return;
  if (!dash || !Array.isArray(dash.pairs) || dash.pairs.length === 0) {
    metaEl.textContent = '';
    bodyEl.innerHTML = '<div class="pairDashEmpty">Run başlatıldığında eşleşmeler burada canlı güncellenir.</div>';
    return;
  }
  const pairs = dash.pairs;
  const matched = pairs.filter((p) => !p.unmatched).length;
  const extra = pairs.length - matched;
  const mode = dash.mode === 'multi' ? 'Çoklu' : 'Tek çift';
  const cT = Math.max(1, Number(dash.cTargetPairIndex) || 1);
  if (cTransferPairInput && document.activeElement !== cTransferPairInput) {
    cTransferPairInput.value = String(cT);
  }
  const t = dash.updatedAt ? new Date(dash.updatedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  metaEl.textContent = `${mode} · ${pairs.length} satır (${matched} eşleşen${extra ? `, ${extra} ekstra A` : ''}) · C/finalize hedefi: #${cT}${t ? ` · ${t}` : ''}`;

  bodyEl.innerHTML = pairs
    .map((p) => {
      const who =
        p.holder === 'A' ? 'A hesabında' : p.holder === 'B' ? 'B hesabında' : '—';
      const badge = p.isCTarget ? '<span class="pairDashC">C hedefi</span>' : '';
      const um = p.unmatched ? '<span class="pairDashWarn">B yok</span>' : '';
      const active = p.isCTarget ? ' active' : '';
      const trib = p.tribune != null && String(p.tribune).trim() ? String(p.tribune).trim() : null;
      const srow = p.seatRow != null && String(p.seatRow).trim() ? String(p.seatRow).trim() : null;
      const snum = p.seatNumber != null && String(p.seatNumber).trim() ? String(p.seatNumber).trim() : null;
      const detailLines =
        trib || srow || snum
          ? `<div class="pairCardRow"><span>Tribün</span> ${escapeHtml(trib || '—')}</div>
      <div class="pairCardRow"><span>Sıra</span> ${escapeHtml(srow || '—')}</div>
      <div class="pairCardRow"><span>Koltuk no</span> ${escapeHtml(snum || '—')}</div>`
          : '';
      return `<div class="pairCard${active}">
      <div class="pairCardHead"><strong>#${escapeHtml(p.pairIndex)}</strong> ${badge} ${um}</div>
      <div class="pairCardRow"><span>A</span> <code>${escapeHtml(p.aEmail || '—')}</code></div>
      <div class="pairCardRow"><span>B</span> <code>${escapeHtml(p.bEmail || '—')}</code></div>
      ${detailLines}
      <div class="pairCardRow"><span>Özet</span> ${escapeHtml(p.seatLabel || '—')} <span class="muted">(id: ${escapeHtml(p.seatId || '—')})</span></div>
      <div class="pairCardRow"><span>Tutucu</span> <strong>${escapeHtml(who)}</strong></div>
      <div class="pairCardPhase">${escapeHtml(p.phase || '')}</div>
    </div>`;
    })
    .join('');
}

const state = {
  filter: '',
  autoScroll: true,
  autoScrollStatus: true,
  activeStep: 'setup',
};

function setActiveStep(step) {
  const next = step === 'run' ? 'run' : 'setup';
  state.activeStep = next;

  for (const item of stepperItems) {
    const target = String(item.dataset.stepTarget || '').trim();
    item.classList.toggle('active', target === next);
    item.classList.toggle('done', !!currentRunId && target === 'setup');
    item.setAttribute('aria-current', target === next ? 'step' : 'false');
  }

  for (const panel of stepPanels) {
    const target = String(panel.dataset.stepPanel || '').trim();
    panel.hidden = target !== next;
    panel.classList.toggle('active', target === next);
  }
}

/** Sunucudan gelen .env tabanlı varsayılanlar; modal açıldığında doldurulur. */
let panelDefaultsFromServer = null;
let panelKeyOrder = [];
const PANEL_STORAGE_KEY = 'passobot_panel_settings_v1';

const PANEL_CHECKBOX_KEYS = new Set([
  'BASKET_LOOP_ENABLED',
  'EXPERIMENTAL_A_READD_ON_THRESHOLD',
]);

/** Bilet alımı — timeout / gecikme / çoklu hesap / sepet döngüsü / koltuk tarama. */
const PANEL_FIELD_META = {
  MULTI_A_CONCURRENCY: { label: 'Paralel A oturumu', hint: 'Aynı anda kaç A tarayıcısı.', section: 'multi' },
  MULTI_B_CONCURRENCY: { label: 'Paralel B oturumu', hint: 'Aynı anda kaç B tarayıcısı.', section: 'multi' },
  MULTI_STAGGER_MS: { label: 'Başlatma aralığı (ms)', hint: 'Oturumlar arası gecikme.', section: 'multi' },

  BASKET_LOOP_ENABLED: { label: 'Sepet döngüsü (basket loop)', hint: 'Transfer döngüsü aktif.', section: 'basket', type: 'checkbox' },
  BASKET_LOOP_MAX_HOPS: { label: 'Sepet döngüsü max adım', hint: 'Maksimum hop sayısı.', section: 'basket' },
  PASSIVE_SESSION_CHECK_MS: { label: 'Pasif hesap oturum kontrolü (ms)', hint: 'Karşı taraf sepetteyken bekleyen (koltuk sayfası) hesap bu aralıkla kontrol edilir; min 10 sn.', section: 'basket' },
  EXPERIMENTAL_A_READD_ON_THRESHOLD: { label: 'A yeniden ekleme (eşik modu)', hint: 'Deneysel: süre eşiğinde tekrar ekleme.', section: 'basket', type: 'checkbox' },
  EXPERIMENTAL_A_READD_THRESHOLD_SECONDS: { label: 'A readd eşik (sn)', hint: 'Ne kadar süre kala tetiklensin.', section: 'basket' },
  EXPERIMENTAL_A_READD_COOLDOWN_SECONDS: { label: 'A readd bekleme (sn)', hint: 'Tekrar arası minimum süre.', section: 'basket' },

  TURNSTILE_DETECTION_TIMEOUT: { label: 'Turnstile algılama timeout (ms)', hint: 'Widget bekleme.', section: 'timeouts' },
  CLICK_BUY_RETRIES: { label: 'Satın al tıklama denemesi', hint: 'SATIN AL için tekrar.', section: 'timeouts' },
  CLICK_BUY_DELAY: { label: 'Satın al tıklama gecikmesi (ms)', hint: 'Denemeler arası.', section: 'timeouts' },
  SEAT_SELECTION_MAX_MS: { label: 'Koltuk seçimi max süre (ms)', hint: 'Blok başına üst süre.', section: 'timeouts' },
  SEAT_PICK_EXACT_MAX_MS: { label: 'Tam koltuk yakalama max (ms)', hint: 'B’de hedef koltuk.', section: 'timeouts' },
  NETWORK_CAPTURE_TIMEOUT: { label: 'Ağ yakalama timeout (ms)', hint: 'API yanıtı bekleme.', section: 'timeouts' },
  SWAL_CONFIRM_TIMEOUT: { label: 'SweetAlert onay timeout (ms)', hint: 'Modal onayı.', section: 'timeouts' },
  REMOVE_FROM_CART_TIMEOUT: { label: 'Sepetten çıkar timeout (ms)', hint: 'Çıkarma onayı.', section: 'timeouts' },
  CATEGORY_SELECTION_RETRIES: { label: 'Kategori seçim denemesi', hint: 'Tekrar sayısı.', section: 'timeouts' },
  BLOCKS_WAIT_TIMEOUT: { label: 'Blok listesi bekleme (ms)', hint: 'select#blocks hazır olana kadar.', section: 'timeouts' },
  ORDER_LOG_TIMEOUT: { label: 'Order log HTTP timeout (ms)', hint: 'Harici log isteği.', section: 'timeouts' },

  TURNSTILE_CHECK_DELAY: { label: 'Turnstile kontrol gecikmesi (ms)', hint: 'Kısa bekleme.', section: 'delays' },
  AFTER_LOGIN_DELAY: { label: 'Giriş sonrası gecikme (ms)', hint: 'Sayfa otursun diye.', section: 'delays' },
  AFTER_CONTINUE_DELAY: { label: 'Devam sonrası gecikme (ms)', hint: 'Koltuk haritasına geçiş.', section: 'delays' },
  SEAT_SELECTION_DELAY: { label: 'Koltuk seçim gecikmesi (ms)', hint: 'Döngüler arası.', section: 'delays' },
  CATEGORY_SELECTION_DELAY: { label: 'Kategori seçim gecikmesi (ms)', hint: 'Kategori adımları arası.', section: 'delays' },
  CLEANUP_DELAY: { label: 'Temizlik gecikmesi (ms)', hint: 'Tarayıcı kapatmadan önce.', section: 'delays' },

  SEAT_SELECTION_CYCLES: { label: 'Koltuk seçim döngü sayısı', hint: 'Blok başına üst tur.', section: 'seat' },
  SEAT_SNIPE_MAX_MS: { label: 'Snipe max süre (ms)', hint: 'Boş koltuk bekleme üst sınırı.', section: 'seat' },
  SEAT_SNIPE_POLL_MS: { label: 'Snipe tarama aralığı (ms)', hint: 'Poll sıklığı.', section: 'seat' },
  CATEGORY_ROAM_EVERY_CYCLES: { label: 'Kategori gezinti (her N döngü)', hint: '0 = kapalı.', section: 'seat' },
};

const PANEL_SECTION_TITLES = {
  multi: 'Çoklu hesap',
  basket: 'Sepet döngüsü ve deneysel A',
  timeouts: 'Zaman aşımları (ms)',
  delays: 'Gecikmeler (ms)',
  seat: 'Koltuk ve kategori tarama',
  other: 'Diğer',
};

function loadStoredPanelSettings() {
  try {
    const raw = localStorage.getItem(PANEL_STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

function panelSettingsForSubmit() {
  const s = loadStoredPanelSettings();
  return s && Object.keys(s).length ? s : undefined;
}

async function ensurePanelDefaultsFetched() {
  if (panelDefaultsFromServer && panelKeyOrder.length) return;
  const r = await fetch('/api/panel-settings', { cache: 'no-store' });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Ayarlar yüklenemedi');
  panelDefaultsFromServer = j.defaults || {};
  panelKeyOrder = Array.isArray(j.keys) && j.keys.length ? j.keys : Object.keys(panelDefaultsFromServer);
}

function checkboxValueForKey(key, checked) {
  if (key === 'KEEP_BROWSERS_OPEN') return checked ? 'true' : 'false';
  return checked ? '1' : '0';
}

function isCheckboxChecked(key, rawVal) {
  const v = String(rawVal || '').trim().toLowerCase();
  if (key === 'KEEP_BROWSERS_OPEN') return v === 'true' || v === '1';
  return v === '1' || v === 'true';
}

function buildSettingsForm() {
  const body = $('settingsModalBody');
  body.textContent = '';
  const defaults = panelDefaultsFromServer || {};
  const stored = loadStoredPanelSettings();

  const bySection = {};
  for (const key of panelKeyOrder) {
    const meta = PANEL_FIELD_META[key] || { label: key, hint: '', section: 'other' };
    const section = meta.section || 'other';
    if (!bySection[section]) bySection[section] = [];
    bySection[section].push({ key, meta });
  }

  const sectionOrder = ['timeouts', 'delays', 'basket', 'multi', 'seat', 'other'];

  for (const section of sectionOrder) {
    const items = bySection[section];
    if (!items || !items.length) continue;

    const secEl = document.createElement('div');
    secEl.className = 'settingsSection';
    const h = document.createElement('h3');
    h.textContent = PANEL_SECTION_TITLES[section] || section;
    secEl.appendChild(h);

    const grid = document.createElement('div');
    grid.className = 'settingsGrid';

    for (const { key, meta } of items) {
      const valRaw = stored && Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : defaults[key];
      const val = valRaw != null ? String(valRaw) : '';
      const useCheckbox =
        PANEL_CHECKBOX_KEYS.has(key) || meta.type === 'checkbox';

      const wrap = document.createElement('div');
      wrap.className = 'settingsField' + (useCheckbox ? '' : ' fullWidth');

      const lab = document.createElement('label');
      lab.textContent = meta.label || key;
      wrap.appendChild(lab);

      if (meta.hint) {
        const hi = document.createElement('p');
        hi.className = 'hint';
        hi.textContent = meta.hint;
        wrap.appendChild(hi);
      }

      if (useCheckbox) {
        const row = document.createElement('label');
        row.className = 'chk chkRow';
        const inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.dataset.panelKey = key;
        inp.checked = isCheckboxChecked(key, val);
        row.appendChild(inp);
        row.appendChild(document.createTextNode(' Aktif'));
        wrap.appendChild(row);
      } else {
        const inp = document.createElement('input');
        inp.type = key === 'ANTICAPTCHA_KEY' ? 'password' : 'text';
        inp.dataset.panelKey = key;
        inp.value = val;
        if (/MS|DELAY|RETRIES|CONCURRENCY|SECONDS|HOPS|CYCLES|TIMEOUT|POLLS|WIDTH|PORT/i.test(key) && key !== 'CHROME_PATH' && key !== 'ORDER_LOG_URL' && key !== 'PASSO_LOGIN' && key !== 'TICKETING_API_BASE') {
          inp.type = 'text';
          inp.inputMode = 'numeric';
        }
        wrap.appendChild(inp);
      }

      grid.appendChild(wrap);
    }

    secEl.appendChild(grid);
    body.appendChild(secEl);
  }
}

function collectSettingsFromForm() {
  const body = $('settingsModalBody');
  const out = {};
  const inputs = body.querySelectorAll('[data-panel-key]');
  inputs.forEach((el) => {
    const key = el.dataset.panelKey;
    if (!key) return;
    if (el.type === 'checkbox') {
      out[key] = checkboxValueForKey(key, el.checked);
    } else {
      out[key] = String(el.value != null ? el.value : '').trim();
    }
  });
  return out;
}

function openSettingsModal() {
  const root = $('settingsModal');
  root.hidden = false;
}

function closeSettingsModal() {
  $('settingsModal').hidden = true;
}

async function openSettingsModalFresh() {
  try {
    await ensurePanelDefaultsFetched();
    buildSettingsForm();
    openSettingsModal();
  } catch (e) {
    infoLine('Bilet alım ayarları yüklenemedi', { error: e?.message || String(e) });
  }
}
const statusState = {
  lastText: '',
  lastAt: 0,
};

function fmt(entry) {
  const ts = entry.ts || '';
  const lvl = (entry.level || 'info').toUpperCase();
  const msg = entry.message || '';
  const meta = entry.meta && Object.keys(entry.meta).length ? ' ' + JSON.stringify(entry.meta) : '';
  return `${ts} [${lvl}]: ${msg}${meta}`;
}

function appendLogLine(line, entry) {
  const div = document.createElement('div');
  const text = String(line || '');
  div.textContent = text;
  
  // Check if this is a separator line
  const isSeparator = text.includes('[SEPARATOR]') || 
                      text.includes('==================') ||
                      text.includes('OTURUMLAR KAPATILDI');
  
  if (isSeparator) {
    div.className = 'log-separator';
  }
  
  // Full log box
  if (state.filter && !text.toLowerCase().includes(state.filter)) {
    div.style.display = 'none';
  }
  logBox.appendChild(div);
  if (state.autoScroll) logBox.scrollTop = logBox.scrollHeight;

  // Status box (simplified)
  if (isSeparator) {
    const sDiv = document.createElement('div');
    sDiv.className = 'log-separator';
    sDiv.textContent = '────────────────────────────────────────';
    statusBox.appendChild(sDiv);
    if (state.autoScrollStatus) statusBox.scrollTop = statusBox.scrollHeight;
  } else {
    const statusText = isStatusMessage(entry, line);
    if (statusText) {
      const now = Date.now();
      const isDuplicate = statusState.lastText === statusText && (now - statusState.lastAt) < 2500;
      if (isDuplicate) return;
      statusState.lastText = statusText;
      statusState.lastAt = now;
      const sDiv = document.createElement('div');
      sDiv.textContent = statusText;
      statusBox.appendChild(sDiv);
      if (state.autoScrollStatus) statusBox.scrollTop = statusBox.scrollHeight;
    }
  }
}

async function killSessions() {
  try {
    const resp = await fetch('/kill-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const json = await resp.json();
    if (resp.ok) {
      clearLogs();
      infoLine(`Aktif oturumlar kapatıldı: ${json.killedCount} oturum`);
    } else {
      infoLine('Oturum kapatma hatası', { error: json.error || 'unknown' });
    }
  } catch (err) {
    infoLine('Oturum kapatma isteği başarısız', { error: err?.message || String(err) });
  }
}

function isStatusMessage(entry, line) {
  const msg = String(entry?.message || line || '').toLowerCase();
  const meta = entry?.meta || {};
  
  // Helper to format seat details from meta
  const formatSeatDetails = (m) => {
    const parts = [];
    // Use combined if available (has full seat info: tribune block row seat)
    if (m.combined) return ` (${m.combined})`;
    if (m.tribune) parts.push(`Tribün: ${m.tribune}`);
    if (m.block || m.blockText || m.blockName) parts.push(`Blok: ${m.block || m.blockText || m.blockName}`);
    if (m.categoryText || m.categoryName) parts.push(`Kat: ${m.categoryText || m.categoryName}`);
    if (m.row || m.rowNumber) parts.push(`Sıra: ${m.row || m.rowNumber}`);
    if (m.seat || m.seatNumber || m.seatNum) parts.push(`Koltuk: ${m.seat || m.seatNumber || m.seatNum}`);
    return parts.length > 0 ? ` (${parts.join(', ')})` : '';
  };
  
  // Keep mappings strict to avoid false positives in status panel.
  if (msg.includes('run started')) return '🚀 Bot çalışmaya başladı';
  if (msg.includes('run stopped') || msg.includes('bot başarıyla tamamlandı') || msg.includes('completed')) return '✅ Bot tamamlandı';

  if (msg.includes('step:a.launchandlogin.done') || msg.includes('step:b.launchandlogin.done') || msg.includes('step:c.launchandlogin.done')) {
    const account = msg.includes('step:a.') ? 'A' : (msg.includes('step:b.') ? 'B' : (msg.includes('step:c.') ? 'C' : null));
    const email = meta?.email || '';
    return account ? `✓ ${account} Hesabı giriş yapıldı${email ? ': ' + email : ''}` : null;
  }

  if (msg.includes('launchandlogin: login tamamlanamadı')) return '❌ Giriş tamamlanamadı, login sayfasında kaldı';
  if (msg.includes('launchandlogin: login formu bulunamadı')) return '❌ Giriş formu bulunamadı (site/challenge yüklenmedi)';
  if (msg.includes('reloginifredirected: login redirect tespit edildi')) return '🔁 Oturum düştü, yeniden giriş deneniyor';
  if (msg.includes('reloginifredirected: login submit sonrası')) return '🔐 Yeniden giriş denemesi yapıldı';
  if (msg.includes('step:a.gotoevent.start') || msg.includes('step:b.gotoevent.start')) return '🎯 Etkinlik sayfasına gidiliyor';
  if (msg.includes('step:a.clickbuy.start') || msg.includes('step:b.clickbuy.start')) return '🛍️ SATIN AL butonu aranıyor/tıklanıyor';
  if (msg.includes('step:a.postbuy.ensureurl.start')) return '🧭 Koltuk seçimi sayfasına geçiş doğrulanıyor';

  if (msg.includes('categoryblock.select.done') || msg.includes('categoryblock.reselect.done') || msg.includes('categoryblock:svg_block_ok')) {
    const blockId = meta?.blockId || meta?.svgBlockId || null;
    return blockId ? `📍 Blok seçildi: ${blockId}` : '📍 Kategori/blok değişti';
  }

  if (msg.includes('categoryblock:svg_clicked')) {
    const id = meta?.clicked?.id || meta?.clickPoint?.id || null;
    return id ? `🗺️ SVG blok tıklandı: ${id}` : '🗺️ SVG blok tıklandı';
  }

  // Only show "seat selected" on strong/confirmed seat signals.
  const seatConfirmed =
    msg.includes('seatpick:a:selected') ||
    msg.includes('seatpick:b:selected') ||
    msg.includes('seatpick:a:basket_success') ||
    msg.includes('seatpick:b:basket_success') ||
    msg.includes('seatpick:a:basket_from_network') ||
    msg.includes('seatpick:b:basket_from_network') ||
    msg.includes('seat_selected_a') ||
    msg.includes('seat_grabbed_b');
  if (seatConfirmed) {
    const details = formatSeatDetails(meta?.seatInfo || meta);
    return `🪑 Koltuk seçildi${details}`;
  }

  if (msg.includes('sepete') || msg.includes('basket_success') || msg.includes('basket_from_network')) {
    const details = formatSeatDetails(meta?.seatInfo || meta);
    return `🛒 Sepete koltuk eklendi${details}`;
  }

  if (msg.includes('seat.noselectable.retry_block')) {
    const cycle = meta?.cycle != null ? ` (deneme ${meta.cycle})` : '';
    return `⏳ Bu blokta boş koltuk yok, yeni blok deneniyor${cycle}`;
  }
  if (msg.includes('seatpick:a:snipe_wait_start') || msg.includes('seatpick:b:snipe_wait_start')) {
    return '👀 Boşa düşecek koltuk için anlık tarama yapılıyor';
  }
  if (msg.includes('seatpick:a:snipe_wait_hit') || msg.includes('seatpick:b:snipe_wait_hit')) {
    return '⚡ Boşa düşen koltuk sinyali alındı, yakalama deneniyor';
  }
  if (msg.includes('seatpick:a:no_selectable_seats_back') || msg.includes('seatpick:b:no_selectable_seats_back')) {
    return '🚫 Bu blokta seçilebilir koltuk görünmüyor';
  }
  if (msg.includes('seatpick:a:diag') || msg.includes('seatpick:b:diag')) {
    return null; // too noisy for customer status panel
  }

  if (msg.includes('finalize') || msg.includes('payment') || msg.includes('ödeme')) return '💳 Ödeme işlemi başlatıldı';
  if (msg.includes('transfer') || msg.includes('holder_updated')) return '↔️ Koltuk transfer ediliyor';
  if (msg.includes('remove_from_cart') || msg.includes('çıkarıldı') || msg.includes('boşaltıldı')) return '🗑️ Sepet boşaltıldı';

  if (msg.includes('error') || msg.includes('hata') || msg.includes('failed') || msg.includes('başarısız')) {
    if (msg.includes('login') || msg.includes('giriş')) return '❌ Giriş hatası';
    if (msg.includes('basket') || msg.includes('sepet')) return '❌ Sepet hatası';
    if (msg.includes('seat') || msg.includes('koltuk')) return '❌ Koltuk seçim hatası';
    return '⚠️ Hata oluştu';
  }

  return null;
}

function clearLogs() {
  logBox.textContent = '';
  statusBox.textContent = '';
  statusState.lastText = '';
  statusState.lastAt = 0;
}

function infoLine(msg, meta) {
  const line = `${new Date().toISOString()} [UI]: ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`;
  appendLogLine(line, { message: msg, level: 'info' });
}

function setConn(text, ok) {
  connStatus.textContent = text;
  connStatus.className = ok ? 'status ok' : 'status';
}

function startSse() {
  if (es) {
    try { es.close(); } catch {}
  }

  setConn('Connecting...', false);
  es = new EventSource('/logs/stream');

  es.addEventListener('open', () => {
    setConn('Connected', true);
  });

  es.addEventListener('snapshot', (ev) => {
    try {
      const arr = JSON.parse(ev.data);
      if (Array.isArray(arr)) {
        for (const e of arr) appendLogLine(fmt(e), e);
      }
    } catch {}
  });

  es.addEventListener('log', (ev) => {
    try {
      const e = JSON.parse(ev.data);
      appendLogLine(fmt(e), e);
    } catch {}
  });

  es.addEventListener('error', () => {
    setConn('Disconnected (retrying...)', false);
  });
}

async function pollRunStatus(runId) {
  if (!runId) return;
  for (;;) {
    try {
      const r = await fetch(`/run/${encodeURIComponent(runId)}/status`, { cache: 'no-store' });
      const j = await r.json();
      const st = j?.run?.status;
      if (j?.run?.pairDashboard) renderPairDashboard(j.run.pairDashboard);
      if (st) runStatusEl.textContent = st;
      if (st && st !== 'running') return;
    } catch {}
    await new Promise((res) => setTimeout(res, 1000));
  }
}

const DIVAN_PRIORITY_CATEGORY_VALUE = 'Yüksek Divan Kurulu, Kongre ve Temsilci Üyeler';

function syncPrioritySaleUi() {
  const main = document.getElementById('prioritySaleSelect');
  const row = document.getElementById('prioritySaleCategoryRow');
  const divanDetails = document.getElementById('divanPriorityFieldsDetails');
  const cat = document.getElementById('prioritySaleCategorySelect');
  if (main && row) {
    row.hidden = String(main.value || '') !== 'on';
  }
  if (divanDetails && main) {
    const on = String(main.value || '') === 'on';
    const divan = on && cat && String(cat.value || '') === DIVAN_PRIORITY_CATEGORY_VALUE;
    divanDetails.hidden = !divan;
  }
}

document.getElementById('prioritySaleSelect')?.addEventListener('change', syncPrioritySaleUi);
document.getElementById('prioritySaleCategorySelect')?.addEventListener('change', syncPrioritySaleUi);
syncPrioritySaleUi();

$('botForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  const catalogApi = window.passobotCatalog || null;
  const selectedTeam = catalogApi && typeof catalogApi.getSelectedTeam === 'function'
    ? catalogApi.getSelectedTeam()
    : null;
  const selectedCategoryIds = catalogApi && typeof catalogApi.getSelectedCategoryIds === 'function'
    ? catalogApi.getSelectedCategoryIds()
    : [];
  const aCredentialIds = catalogApi && typeof catalogApi.getSelectedCredentialIds === 'function'
    ? catalogApi.getSelectedCredentialIds('A')
    : [];
  const bCredentialIds = catalogApi && typeof catalogApi.getSelectedCredentialIds === 'function'
    ? catalogApi.getSelectedCredentialIds('B')
    : [];

  if (!selectedTeam?.id || !selectedTeam?.name) {
    infoLine('Bot başlatmak için önce takım seçmelisin.');
    return;
  }

  body.teamId = selectedTeam.id;
  body.team = selectedTeam.name;
  if (selectedCategoryIds.length) body.selectedCategoryIds = selectedCategoryIds;

  // Öncelikli satış: kapalı → false; açık → seçilen kategori metni (Passo modal eşlemesi)
  const psRaw = String(body.prioritySale || '').trim().toLowerCase();
  if (psRaw === 'on') {
    const cat = String(body.prioritySaleCategory || '').trim();
    if (!cat) {
      infoLine('Öncelikli satış açıkken öncelik kategorisi seçmelisin.');
      showToast('Eksik seçim', 'Öncelik kategorisinden birini seç.', 'error', 5000);
      return;
    }
    body.prioritySale = cat;
    delete body.prioritySaleCategory;
  } else {
    body.prioritySale = false;
    delete body.prioritySaleCategory;
  }

  if (body.cTransferPairIndex != null && String(body.cTransferPairIndex).trim() !== '') {
    const n = parseInt(String(body.cTransferPairIndex).trim(), 10);
    if (Number.isFinite(n) && n >= 1) body.cTransferPairIndex = n;
    else delete body.cTransferPairIndex;
  }

  if (body.ticketCount != null && String(body.ticketCount).trim() !== '') {
    const tc = parseInt(String(body.ticketCount).trim(), 10);
    body.ticketCount = (Number.isFinite(tc) && tc >= 1) ? Math.min(tc, 10) : 1;
  }

  if (aCredentialIds.length) body.aCredentialIds = aCredentialIds;
  if (bCredentialIds.length) body.bCredentialIds = bCredentialIds;

  if (!selectedCategoryIds.length && !String(body.categoryType || '').trim()) {
    infoLine('En az 1 kayıtlı kategori seç veya fallback kategori gir.');
    return;
  }
  if (!aCredentialIds.length) {
    infoLine('En az 1 A üyeliği seçmelisin.');
    return;
  }
  // B üyeliği opsiyonel: seçilmezse A-only mod çalışır

  // If arrays are provided, drop legacy single-account fields to avoid confusion.
  delete body.email;
  delete body.password;
  delete body.email2;
  delete body.password2;

  // Empty strings => remove optional fields
  for (const k of Object.keys(body)) {
    if (typeof body[k] === 'string' && body[k].trim() === '') delete body[k];
  }

  const ps = panelSettingsForSubmit();
  if (ps) body.panelSettings = ps;

  runIdEl.textContent = '-';
  runStatusEl.textContent = '-';
  renderPairDashboard(null);

  try {
    const resp = await fetch('/start-bot-async', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = await resp.json();
    if (!resp.ok) {
      appendLogLine(`${new Date().toISOString()} [ERROR]: start failed ${JSON.stringify(json)}`, { level: 'error', message: 'start failed' });
      showToast('Baslatma Hatasi', json?.error || 'Bot baslatilirken bir hata olustu.', 'error', 6000);
      return;
    }

    currentRunId = json.runId;
    runIdEl.textContent = currentRunId;
    runStatusEl.textContent = json.status || 'running';
    appendLogLine(`${new Date().toISOString()} [INFO]: run started ${currentRunId}`, { level: 'info', message: 'run started' });
    showToast('Bot Baslatildi', 'Islem basladi, canli takip ekranina yonlendiriliyorsunuz.', 'success', 5000);
    setActiveStep('run');

    pollRunStatus(currentRunId);
  } catch (err) {
    appendLogLine(`${new Date().toISOString()} [ERROR]: start request failed ${err?.message || err}`, { level: 'error', message: 'start request failed' });
  }
});

$('btnClear').addEventListener('click', () => clearLogs());

async function apiPost(path, payload) {
  const resp = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(JSON.stringify(json));
  return json;
}

function requireRunId() {
  if (!currentRunId) {
    infoLine('runId yok. Önce Start (Async) ile run başlat.');
    return null;
  }
  return currentRunId;
}

try {
  for (const item of stepperItems) {
    item.addEventListener('click', () => {
      setActiveStep(item.dataset.stepTarget);
    });
  }

  $('btnRegisterC').addEventListener('click', async () => {
    const runId = requireRunId();
    if (!runId) return;
    const email = String($('cEmail').value || '').trim();
    const password = String($('cPassword').value || '').trim();
    if (!email || !password) {
      infoLine('C register için email/password gerekli');
      return;
    }
    try {
      const res = await apiPost(`/run/${encodeURIComponent(runId)}/c/register`, { email, password });
      infoLine('C register ok', res);
    } catch (e) {
      infoLine('C register failed', { error: e?.message || String(e) });
    }
  });

  $('btnFinalize').addEventListener('click', async () => {
    const runId = requireRunId();
    if (!runId) return;
    const payload = {
      identity: String($('finIdentity').value || '').trim() || null,
      cardHolder: String($('finCardHolder').value || '').trim() || null,
      cardNumber: String($('finCardNumber').value || '').trim() || null,
      expiryMonth: String($('finExpiryMonth').value || '').trim() || null,
      expiryYear: String($('finExpiryYear').value || '').trim() || null,
      cvv: String($('finCvv').value || '').trim() || null,
      autoPay: !!$('finAutoPay').checked,
    };

    // Remove nulls to keep request clean
    for (const k of Object.keys(payload)) {
      if (payload[k] === null || payload[k] === '') delete payload[k];
    }

    try {
      const res = await apiPost(`/run/${encodeURIComponent(runId)}/finalize`, payload);
      infoLine('Finalize request sent', res);
    } catch (e) {
      infoLine('Finalize request failed', { error: e?.message || String(e) });
    }
  });

  $('btnKillSessions').addEventListener('click', async () => {
    if (!confirm('Tüm aktif oturumları kapatmak istediğinize emin misiniz?')) return;
    await killSessions();
  });
} catch {}

logFilterEl.addEventListener('input', (e) => {
  state.filter = String(e.target.value || '').trim().toLowerCase();
});

autoScrollEl.addEventListener('change', (e) => {
  state.autoScroll = !!e.target.checked;
});

autoScrollStatusEl.addEventListener('change', (e) => {
  state.autoScrollStatus = !!e.target.checked;
});

setActiveStep('setup');
startSse();

ensurePanelDefaultsFetched().catch(() => {});
try {
  if (window.passobotCatalog && typeof window.passobotCatalog.setNotifier === 'function') {
    window.passobotCatalog.setNotifier(infoLine);
  }
  if (window.passobotCatalog && typeof window.passobotCatalog.init === 'function') {
    window.passobotCatalog.init();
  }
} catch {}

try {
  $('btnOpenSettings').addEventListener('click', () => openSettingsModalFresh());
  $('btnCloseSettings').addEventListener('click', () => closeSettingsModal());
  $('settingsModalBackdrop').addEventListener('click', () => closeSettingsModal());
  $('btnCancelSettings').addEventListener('click', () => closeSettingsModal());
  $('btnSavePanelSettings').addEventListener('click', () => {
    try {
      const collected = collectSettingsFromForm();
      localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(collected));
      infoLine('Bilet alım ayarları bu tarayıcıda kaydedildi; bir sonraki başlatmada kullanılacak.');
      closeSettingsModal();
    } catch (e) {
      infoLine('Ayarlar kaydedilemedi', { error: e?.message || String(e) });
    }
  });
  $('btnResetPanelDefaults').addEventListener('click', () => {
    try {
      localStorage.removeItem(PANEL_STORAGE_KEY);
      buildSettingsForm();
      infoLine('Kayıtlı panel ayarları silindi; sunucu (.env) varsayılanları gösteriliyor.');
    } catch (e) {
      infoLine('Sıfırlama başarısız', { error: e?.message || String(e) });
    }
  });
} catch {}

