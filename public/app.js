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
const setupIssuesCard = $('setupIssuesCard');
const setupIssuesList = $('setupIssuesList');
const setupPaymentCard = $('setupPaymentCard');

let currentRunId = null;
let es = null;
let runStatusRefreshInFlight = null;
let runStatusRefreshTimer = null;
const previousPairSnapshot = new Map();
let lastSetupIssues = [];

function entryEventKey(entry, line) {
  const metaEvent = String(entry?.meta?.event || '').trim().toLowerCase();
  if (metaEvent) return metaEvent;
  return String(entry?.message || line || '').trim().toLowerCase();
}

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

function normalizeIssueText(issue) {
  if (!issue) return '';
  if (typeof issue === 'string') return issue.trim();
  if (typeof issue?.message === 'string') {
    const path = String(issue.path || '').trim();
    return path ? `${issue.message} (${path})` : issue.message.trim();
  }
  return String(issue).trim();
}

function renderSetupIssues(issues = []) {
  lastSetupIssues = Array.isArray(issues)
    ? issues.map(normalizeIssueText).filter(Boolean)
    : [];
  if (!setupIssuesCard || !setupIssuesList) return;
  if (!lastSetupIssues.length) {
    setupIssuesCard.hidden = true;
    setupIssuesList.innerHTML = '';
    return;
  }
  setupIssuesCard.hidden = false;
  setupIssuesList.innerHTML = lastSetupIssues
    .map((issue) => `<div class="setupIssueItem">${escapeHtml(issue)}</div>`)
    .join('');
}

function clearSetupIssues() {
  renderSetupIssues([]);
}

function showSetupIssues(title, issues) {
  const list = Array.isArray(issues) ? issues.map(normalizeIssueText).filter(Boolean) : [];
  if (!list.length) return;
  renderSetupIssues(list);
  showToast(title || 'Form Hatalari', list[0], 'error', 6000);
}

function syncSetupPaymentCard(forceCount = null) {
  if (!setupPaymentCard) return;
  const catalogApi = window.passobotCatalog || null;
  const payerCount = forceCount != null
    ? Math.max(0, Number(forceCount) || 0)
    : (catalogApi && typeof catalogApi.getSelectedPayerCredentialIds === 'function'
      ? catalogApi.getSelectedPayerCredentialIds().length
      : 0);
  const shouldShow = payerCount >= 1;
  setupPaymentCard.hidden = !shouldShow;
  const cardInputs = Array.from(setupPaymentCard.querySelectorAll('input'));
  for (const input of cardInputs) {
    input.required = shouldShow;
    input.setAttribute('aria-required', shouldShow ? 'true' : 'false');
  }
}

function digitsOnly(value) {
  return String(value || '').replace(/\D+/g, '');
}

function bindPaymentInputMasks() {
  const cardNumberEl = $('setupCardNumber');
  const expiryMonthEl = $('setupExpiryMonth');
  const expiryYearEl = $('setupExpiryYear');
  const cvvEl = $('setupCvv');

  if (cardNumberEl && !cardNumberEl.dataset.maskBound) {
    cardNumberEl.dataset.maskBound = '1';
    cardNumberEl.addEventListener('input', () => {
      const digits = digitsOnly(cardNumberEl.value).slice(0, 19);
      cardNumberEl.value = digits.replace(/(.{4})/g, '$1 ').trim();
    });
  }

  if (expiryMonthEl && !expiryMonthEl.dataset.maskBound) {
    expiryMonthEl.dataset.maskBound = '1';
    expiryMonthEl.addEventListener('input', () => {
      let digits = digitsOnly(expiryMonthEl.value).slice(0, 2);
      if (digits.length === 1 && Number(digits) > 1) digits = `0${digits}`;
      if (digits.length === 2) {
        const mm = Math.min(12, Math.max(1, Number(digits) || 1));
        digits = String(mm).padStart(2, '0');
      }
      expiryMonthEl.value = digits;
    });
  }

  if (expiryYearEl && !expiryYearEl.dataset.maskBound) {
    expiryYearEl.dataset.maskBound = '1';
    expiryYearEl.addEventListener('input', () => {
      expiryYearEl.value = digitsOnly(expiryYearEl.value).slice(0, 2);
    });
  }

  if (cvvEl && !cvvEl.dataset.maskBound) {
    cvvEl.dataset.maskBound = '1';
    cvvEl.addEventListener('input', () => {
      cvvEl.value = digitsOnly(cvvEl.value).slice(0, 4);
    });
  }
}

function maybeSurfaceSetupIssue(msg, meta) {
  const text = String(msg || '').trim();
  const metaErr = String(meta?.error || '').trim();
  const hay = `${text} ${metaErr}`.toLowerCase();
  if (!hay) return;
  const shouldSurface =
    hay.includes('zorunlu') ||
    hay.includes('seç') ||
    hay.includes('gerekli') ||
    hay.includes('yüklenemedi') ||
    hay.includes('hata') ||
    hay.includes('başarısız') ||
    hay.includes('failed') ||
    hay.includes('error');
  if (!shouldSurface) return;
  const issue = metaErr ? `${text} (${metaErr})` : text;
  const next = lastSetupIssues.includes(issue) ? lastSetupIssues : [...lastSetupIssues, issue];
  renderSetupIssues(next);
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

function formatCountdownSeconds(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function parseFiniteMaybe(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function computePairRemainingSeconds(source) {
  if (!source) return null;
  const observedRemaining = parseFiniteMaybe(source.basketRemainingSeconds);
  const observedAtMs = source.basketObservedAt ? Date.parse(String(source.basketObservedAt)) : NaN;
  if (observedRemaining != null && Number.isFinite(observedAtMs)) {
    const elapsed = Math.max(0, Math.floor((Date.now() - observedAtMs) / 1000));
    return Math.max(0, observedRemaining - elapsed);
  }
  const arrivedAtMs = parseFiniteMaybe(source.basketArrivedAtMs);
  const holdingTimeSeconds = parseFiniteMaybe(source.basketHoldingTimeSeconds);
  if (arrivedAtMs != null && arrivedAtMs > 0 && holdingTimeSeconds != null && holdingTimeSeconds > 0) {
    const elapsed = Math.max(0, Math.floor((Date.now() - arrivedAtMs) / 1000));
    return Math.max(0, holdingTimeSeconds - elapsed);
  }
  return null;
}

function pairRemainingLabel(source) {
  const remaining = computePairRemainingSeconds(source);
  if (!Number.isFinite(remaining)) return '—';
  if (remaining <= 0) return 'Süre doldu';
  return formatCountdownSeconds(remaining);
}

function pairRemainingTone(source) {
  const remaining = computePairRemainingSeconds(source);
  if (!Number.isFinite(remaining)) return '';
  if (remaining <= 30) return 'danger';
  if (remaining <= 90) return 'warn';
  return '';
}

function refreshPairCountdowns() {
  const nodes = document.querySelectorAll('.pairTimer');
  for (const node of nodes) {
    const label = pairRemainingLabel(node.dataset);
    const tone = pairRemainingTone(node.dataset);
    node.textContent = label;
    node.classList.toggle('warn', tone === 'warn');
    node.classList.toggle('danger', tone === 'danger');
  }
}

setInterval(refreshPairCountdowns, 1000);

function pairJustReachedBasket(prev, next) {
  const prevPhase = String(prev?.phase || '').toLowerCase();
  const nextPhase = String(next?.phase || '').toLowerCase();
  const nextHasBasket =
    nextPhase.includes('sepette') ||
    nextPhase.includes('odeme sayfasi hazir') ||
    nextPhase.includes('ödeme sayfası hazır');
  const prevHasBasket =
    prevPhase.includes('sepette') ||
    prevPhase.includes('odeme sayfasi hazir') ||
    prevPhase.includes('ödeme sayfası hazır');
  return nextHasBasket && !prevHasBasket;
}

function shouldFlashPairCard(prev, next) {
  if (!next) return false;
  if (!prev) return !!(next.seatId || next.holder || next.phase);
  if (pairJustReachedBasket(prev, next)) return true;
  if (String(prev.seatId || '') !== String(next.seatId || '')) return true;
  if (String(prev.holder || '') !== String(next.holder || '')) return true;
  if (String(prev.phase || '') !== String(next.phase || '')) return true;
  if (String(prev.paymentState || '') !== String(next.paymentState || '')) return true;
  return false;
}

function renderPairDashboard(dash) {
  const metaEl = $('pairDashboardMeta');
  const bodyEl = $('pairDashboardBody');
  if (!metaEl || !bodyEl) return;
  if (!dash || !Array.isArray(dash.pairs) || dash.pairs.length === 0) {
    metaEl.textContent = '';
    bodyEl.innerHTML = '<div class="pairDashEmpty">Run başlatıldığında akış kartları burada canlı güncellenir.</div>';
    return;
  }
  const pairs = dash.pairs;
  const matched = pairs.filter((p) => !p.unmatched).length;
  const extra = pairs.length - matched;
  const mode = dash.mode === 'multi' ? 'Çoklu' : 'Tek çift';
  const cT = Math.max(1, Number(dash.cTargetPairIndex) || 1);
  const activePairIndex = Math.max(0, Number(dash.activePairIndex) || 0);
  if (cTransferPairInput && document.activeElement !== cTransferPairInput) {
    cTransferPairInput.value = String(cT);
  }
  const t = dash.updatedAt ? new Date(dash.updatedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  metaEl.textContent = `${mode} · ${pairs.length} satır (${matched} eşleşen${extra ? `, ${extra} ekstra ana hesap` : ''}) · C/finalize hedefi: #${cT}${activePairIndex ? ` · aktif akış: #${activePairIndex}` : ''}${t ? ` · ${t}` : ''}`;

  bodyEl.innerHTML = pairs
    .map((p) => {
      const prev = previousPairSnapshot.get(String(p.pairIndex)) || null;
      const who =
        p.holder === 'A' ? 'Ana hesapta' : p.holder === 'B' ? 'Tutucu hesapta' : '—';
      const badge = p.isCTarget ? '<span class="pairDashC">C hedefi</span>' : '';
      const um = p.unmatched ? '<span class="pairDashWarn">Tutucu yok</span>' : '';
      const active = (p.isCTarget || p.isActivePair) ? ' active' : '';
      const flash = shouldFlashPairCard(prev, p) ? ' flash' : '';
      const activeBadge = p.isActivePair ? '<span class="pairDashC">Aktif</span>' : '';
      const trib = p.tribune != null && String(p.tribune).trim() ? String(p.tribune).trim() : null;
      const srow = p.seatRow != null && String(p.seatRow).trim() ? String(p.seatRow).trim() : null;
      const snum = p.seatNumber != null && String(p.seatNumber).trim() ? String(p.seatNumber).trim() : null;
      const paymentOwner =
        p.paymentOwnerRole === 'A' ? 'Ana Hesap' : p.paymentOwnerRole === 'C' ? 'C Hesabi' : '—';
      const paymentState = p.paymentState ? String(p.paymentState) : '—';
      const remainingLabel = pairRemainingLabel(p);
      const remainingTone = pairRemainingTone(p);
      const detailLines =
        trib || srow || snum
          ? `<div class="pairCardRow"><span>Tribün</span> ${escapeHtml(trib || '—')}</div>
      <div class="pairCardRow"><span>Sıra</span> ${escapeHtml(srow || '—')}</div>
      <div class="pairCardRow"><span>Koltuk no</span> ${escapeHtml(snum || '—')}</div>`
          : '';
      return `<div class="pairCard${active}${flash}">
      <div class="pairCardHead"><strong>#${escapeHtml(p.pairIndex)}</strong> ${badge} ${activeBadge} ${um}</div>
      <div class="pairCardRow"><span>Ana</span> <code>${escapeHtml(p.aEmail || '—')}</code></div>
      <div class="pairCardRow"><span>Tutucu</span> <code>${escapeHtml(p.bEmail || '—')}</code></div>
      ${detailLines}
      <div class="pairCardRow"><span>Özet</span> ${escapeHtml(p.seatLabel || '—')} <span class="muted">(id: ${escapeHtml(p.seatId || '—')})</span></div>
      <div class="pairCardRow"><span>Tutucu</span> <strong>${escapeHtml(who)}</strong></div>
      <div class="pairCardRow"><span>Kalan süre</span> <strong class="pairTimer${remainingTone ? ` ${remainingTone}` : ''}" data-basket-remaining-seconds="${escapeHtml(p.basketRemainingSeconds ?? '')}" data-basket-observed-at="${escapeHtml(p.basketObservedAt || '')}" data-basket-arrived-at-ms="${escapeHtml(p.basketArrivedAtMs ?? '')}" data-basket-holding-time-seconds="${escapeHtml(p.basketHoldingTimeSeconds ?? '')}">${escapeHtml(remainingLabel)}</strong></div>
      <div class="pairCardRow"><span>Ödeme sahibi</span> <strong>${escapeHtml(paymentOwner)}</strong></div>
      <div class="pairCardRow"><span>Ödeme durumu</span> <strong>${escapeHtml(paymentState)}</strong></div>
      <div class="pairCardPhase">${escapeHtml(p.phase || '')}</div>
    </div>`;
    })
    .join('');

  previousPairSnapshot.clear();
  for (const pair of pairs) {
    previousPairSnapshot.set(String(pair.pairIndex), {
      pairIndex: pair.pairIndex,
      seatId: pair.seatId || '',
      holder: pair.holder || '',
      phase: pair.phase || '',
      paymentState: pair.paymentState || '',
    });
  }
  refreshPairCountdowns();
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
  MULTI_A_CONCURRENCY: { label: 'Paralel ana hesap oturumu', hint: 'Aynı anda kaç ana hesap tarayıcısı.', section: 'multi' },
  MULTI_B_CONCURRENCY: { label: 'Paralel tutucu hesap oturumu', hint: 'Aynı anda kaç tutucu hesap tarayıcısı.', section: 'multi' },
  MULTI_STAGGER_MS: { label: 'Başlatma aralığı (ms)', hint: 'Oturumlar arası gecikme.', section: 'multi' },

  BASKET_LOOP_ENABLED: { label: 'Sepet döngüsü (basket loop)', hint: 'Transfer döngüsü aktif.', section: 'basket', type: 'checkbox' },
  BASKET_LOOP_MAX_HOPS: { label: 'Sepet döngüsü max adım', hint: 'Maksimum hop sayısı.', section: 'basket' },
  PASSIVE_SESSION_CHECK_MS: { label: 'Pasif hesap oturum kontrolü (ms)', hint: 'Karşı taraf sepetteyken bekleyen (koltuk sayfası) hesap bu aralıkla kontrol edilir; min 10 sn.', section: 'basket' },
  EXPERIMENTAL_A_READD_ON_THRESHOLD: { label: 'Ana hesap yeniden ekleme (eşik modu)', hint: 'Deneysel: süre eşiğinde tekrar ekleme.', section: 'basket', type: 'checkbox' },
  EXPERIMENTAL_A_READD_THRESHOLD_SECONDS: { label: 'Ana hesap yeniden ekleme eşiği (sn)', hint: 'Ne kadar süre kala tetiklensin.', section: 'basket' },
  EXPERIMENTAL_A_READD_COOLDOWN_SECONDS: { label: 'Ana hesap yeniden ekleme bekleme (sn)', hint: 'Tekrar arası minimum süre.', section: 'basket' },

  TURNSTILE_DETECTION_TIMEOUT: { label: 'Turnstile algılama timeout (ms)', hint: 'Widget bekleme.', section: 'timeouts' },
  CLICK_BUY_RETRIES: { label: 'Satın al tıklama denemesi', hint: 'SATIN AL için tekrar.', section: 'timeouts' },
  CLICK_BUY_DELAY: { label: 'Satın al tıklama gecikmesi (ms)', hint: 'Denemeler arası.', section: 'timeouts' },
  SEAT_SELECTION_MAX_MS: { label: 'Koltuk seçimi max süre (ms)', hint: 'Blok başına üst süre.', section: 'timeouts' },
  SEAT_PICK_EXACT_MAX_MS: { label: 'Tam koltuk yakalama max (ms)', hint: 'Tutucu hesapta hedef koltuk.', section: 'timeouts' },
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
  basket: 'Sepet döngüsü ve deneysel ana hesap',
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
  lastKey: '',
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
      const dedupeKey = [
        String(entryEventKey(entry, line) || ''),
        String(entry?.meta?.idx ?? ''),
        String(entry?.meta?.pairIndex ?? ''),
        String(entry?.meta?.seatId ?? entry?.meta?.seatInfo?.seatId ?? ''),
        String(entry?.meta?.email ?? entry?.meta?.aEmail ?? entry?.meta?.bEmail ?? ''),
        statusText,
      ].join('|');
      const isDuplicate = statusState.lastKey === dedupeKey && (now - statusState.lastAt) < 2500;
      if (isDuplicate) return;
      statusState.lastText = statusText;
      statusState.lastKey = dedupeKey;
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
  const eventKey = entryEventKey(entry, line);
  const meta = entry?.meta || {};
  
  // Helper to format seat details from meta
  const formatSeatDetails = (m) => {
    const src = m?.seatInfo || m?.seatA || m?.seatB || m || {};
    const parts = [];
    // Use combined if available (has full seat info: tribune block row seat)
    if (src.combined) return ` (${src.combined})`;
    if (src.tribune) parts.push(`Tribün: ${src.tribune}`);
    if (src.block || src.blockText || src.blockName) parts.push(`Blok: ${src.block || src.blockText || src.blockName}`);
    if (src.categoryText || src.categoryName) parts.push(`Kat: ${src.categoryText || src.categoryName}`);
    if (src.row || src.rowNumber) parts.push(`Sıra: ${src.row || src.rowNumber}`);
    if (src.seat || src.seatNumber || src.seatNum) parts.push(`Koltuk: ${src.seat || src.seatNumber || src.seatNum}`);
    return parts.length > 0 ? ` (${parts.join(', ')})` : '';
  };
  
  // Keep mappings strict to avoid false positives in status panel.
  if (msg.includes('run started')) return '🚀 Bot çalışmaya başladı';
  if (msg.includes('run stopped') || msg.includes('bot başarıyla tamamlandı') || msg.includes('completed')) return '✅ Bot tamamlandı';

  if (msg.includes('step:a.launchandlogin.done') || msg.includes('step:b.launchandlogin.done') || msg.includes('step:c.launchandlogin.done')) {
    const account = msg.includes('step:a.') ? 'Ana hesap' : (msg.includes('step:b.') ? 'Tutucu hesap' : (msg.includes('step:c.') ? 'C hesabi' : null));
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
    eventKey === 'a_hold_acquired' ||
    eventKey === 'b_exact_pick_done' ||
    eventKey === 'transfer_pair_done' ||
    msg.includes('seatpick:a:selected') ||
    msg.includes('seatpick:b:selected') ||
    msg.includes('seatpick:a:basket_success') ||
    msg.includes('seatpick:b:basket_success') ||
    msg.includes('seatpick:a:basket_from_network') ||
    msg.includes('seatpick:b:basket_from_network') ||
    msg.includes('seat_selected_a') ||
    msg.includes('seat_grabbed_b');
  if (seatConfirmed) {
    const details = formatSeatDetails(meta);
    return `🪑 Koltuk seçildi${details}`;
  }

  if (
    eventKey === 'a_hold_in_basket' ||
    eventKey === 'a_only_holding' ||
    eventKey === 'a_only_payment_ready' ||
    eventKey === 'a_payment_ready' ||
    msg.includes('sepete') ||
    msg.includes('basket_success') ||
    msg.includes('basket_from_network')
  ) {
    const details = formatSeatDetails(meta);
    const pairLabel = meta?.pairIndex != null ? ` #${meta.pairIndex}` : (meta?.idx != null ? ` #${Number(meta.idx) + 1}` : '');
    const account = meta?.email ? ` (${meta.email})` : '';
    return `🛒 Sepete koltuk eklendi${pairLabel}${account}${details}`;
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

function shouldRefreshRunStatusNow(entry, runId) {
  if (!runId) return false;
  const metaRunId = String(entry?.meta?.runId || '').trim();
  if (metaRunId && metaRunId !== String(runId)) return false;
  const eventKey = entryEventKey(entry, '');
  const message = String(entry?.message || '').toLowerCase();
  return [
    'a_hold_acquired',
    'a_hold_in_basket',
    'b_exact_pick_done',
    'transfer_pair_done',
    'holder_updated',
    'a_only_payment_ready',
    'a_only_holding',
    'a_payment_ready',
    'finalize_done',
  ].includes(eventKey) || message.includes('a hesabı koltuk seçti ve sepete eklendi');
}

async function refreshRunStatus(runId) {
  if (!runId) return null;
  if (runStatusRefreshInFlight) return runStatusRefreshInFlight;
  runStatusRefreshInFlight = (async () => {
    try {
      const r = await fetch(`/run/${encodeURIComponent(runId)}/status`, { cache: 'no-store' });
      const j = await r.json();
      const st = j?.run?.status;
      if (j?.run?.pairDashboard) renderPairDashboard(j.run.pairDashboard);
      if (st) runStatusEl.textContent = st;
      return j;
    } catch {
      return null;
    } finally {
      runStatusRefreshInFlight = null;
    }
  })();
  return runStatusRefreshInFlight;
}

function scheduleRunStatusRefresh(runId, delayMs = 0) {
  if (!runId) return;
  try {
    if (runStatusRefreshTimer) clearTimeout(runStatusRefreshTimer);
  } catch {}
  runStatusRefreshTimer = setTimeout(() => {
    runStatusRefreshTimer = null;
    refreshRunStatus(runId).catch(() => {});
  }, Math.max(0, Number(delayMs) || 0));
}

function clearLogs() {
  logBox.textContent = '';
  statusBox.textContent = '';
  statusState.lastText = '';
  statusState.lastKey = '';
  statusState.lastAt = 0;
}

function infoLine(msg, meta) {
  const line = `${new Date().toISOString()} [UI]: ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`;
  appendLogLine(line, { message: msg, level: 'info' });
  maybeSurfaceSetupIssue(msg, meta);
}

function getCheckedCategoryIdsFromDom() {
  return Array.from(document.querySelectorAll('#teamCategoryList input[type="checkbox"][data-category-id]:checked'))
    .map((el) => String(el.value || '').trim())
    .filter(Boolean);
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
      if (shouldRefreshRunStatusNow(e, currentRunId)) {
        scheduleRunStatusRefresh(currentRunId, 0);
      }
    } catch {}
  });

  es.addEventListener('error', () => {
    setConn('Disconnected (retrying...)', false);
  });
}

async function pollRunStatus(runId) {
  if (!runId) return;
  for (;;) {
    const j = await refreshRunStatus(runId);
    const st = j?.run?.status;
    if (st && st !== 'running') return;
    await new Promise((res) => setTimeout(res, 350));
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
window.addEventListener('passobot:payer-selection-changed', (event) => {
  syncSetupPaymentCard(event?.detail?.payerCount ?? null);
});
syncSetupPaymentCard();
bindPaymentInputMasks();

$('botForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearSetupIssues();

  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  const catalogApi = window.passobotCatalog || null;
  const selectedTeam = catalogApi && typeof catalogApi.getSelectedTeam === 'function'
    ? catalogApi.getSelectedTeam()
    : null;
  const selectedCategoryIds = catalogApi && typeof catalogApi.getSelectedCategoryIds === 'function'
    ? catalogApi.getSelectedCategoryIds()
    : [];
  const selectedCategoryIdsFromDom = getCheckedCategoryIdsFromDom();
  const mergedCategoryIds = Array.from(new Set([...(selectedCategoryIds || []), ...selectedCategoryIdsFromDom]));
  const aCredentialIds = catalogApi && typeof catalogApi.getSelectedCredentialIds === 'function'
    ? catalogApi.getSelectedCredentialIds('A')
    : [];
  const bCredentialIds = catalogApi && typeof catalogApi.getSelectedCredentialIds === 'function'
    ? catalogApi.getSelectedCredentialIds('B')
    : [];
  const payerACredentialIds = catalogApi && typeof catalogApi.getSelectedPayerCredentialIds === 'function'
    ? catalogApi.getSelectedPayerCredentialIds()
    : [];
  syncSetupPaymentCard(payerACredentialIds.length);

  if (!selectedTeam?.id || !selectedTeam?.name) {
    const issues = ['Bot başlatmak için önce takım seçmelisin.'];
    infoLine(issues[0]);
    showSetupIssues('Eksik form bilgisi', issues);
    return;
  }

  body.teamId = selectedTeam.id;
  body.team = selectedTeam.name;
  if (mergedCategoryIds.length) body.selectedCategoryIds = mergedCategoryIds;

  // Öncelikli satış: kapalı → false; açık → seçilen kategori metni (Passo modal eşlemesi)
  const psRaw = String(body.prioritySale || '').trim().toLowerCase();
  const validationIssues = [];
  if (psRaw === 'on') {
    const cat = String(body.prioritySaleCategory || '').trim();
    if (!cat) {
      validationIssues.push('Öncelikli satış açıkken öncelik kategorisi seçmelisin.');
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
  if (payerACredentialIds.length) body.payerACredentialIds = payerACredentialIds;

  if (!mergedCategoryIds.length && !String(body.categoryType || '').trim()) {
    validationIssues.push('En az 1 kayıtlı kategori seç veya fallback kategori gir.');
  }
  if (!aCredentialIds.length) {
    validationIssues.push('En az 1 ana hesap üyeliği seçmelisin.');
  }
  if (payerACredentialIds.length) {
    const cardFields = [
      { key: 'cardHolder', label: 'Kart sahibi adı' },
      { key: 'cardNumber', label: 'Kart numarası' },
      { key: 'expiryMonth', label: 'Son kullanma ayı' },
      { key: 'expiryYear', label: 'Son kullanma yılı' },
      { key: 'cvv', label: 'CVV' },
    ];
    for (const field of cardFields) {
      if (!String(body[field.key] || '').trim()) {
        validationIssues.push(`${field.label} zorunlu; çünkü en az 1 ana hesap "Odeme yapabilir" olarak seçildi.`);
      }
    }
  }
  if (validationIssues.length) {
    for (const issue of validationIssues) infoLine(issue);
    showSetupIssues('Eksik form bilgisi', validationIssues);
    return;
  }
  // Tutucu hesap opsiyonel: seçilmezse ana hesap odaklı mod çalışır

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
      const serverIssues = Array.isArray(json?.details) && json.details.length
        ? json.details
        : [json?.error || 'Bot baslatilirken bir hata olustu.'];
      showSetupIssues('Baslatma Hatasi', serverIssues);
      return;
    }

    currentRunId = json.runId;
    runIdEl.textContent = currentRunId;
    runStatusEl.textContent = json.status || 'running';
    appendLogLine(`${new Date().toISOString()} [INFO]: run started ${currentRunId}`, { level: 'info', message: 'run started' });
    showToast('Bot Baslatildi', 'Islem basladi, canli takip ekranina yonlendiriliyorsunuz.', 'success', 5000);
    clearSetupIssues();
    setActiveStep('run');

    pollRunStatus(currentRunId);
  } catch (err) {
    appendLogLine(`${new Date().toISOString()} [ERROR]: start request failed ${err?.message || err}`, { level: 'error', message: 'start request failed' });
    showSetupIssues('Baslatma Hatasi', [err?.message || String(err)]);
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

