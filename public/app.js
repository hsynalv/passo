const $ = (id) => document.getElementById(id);

const logBox = $('logBox');
const statusBox = $('statusBox');
const connStatus = $('connStatus');
const runIdEl = $('runId');
const runStatusEl = $('runStatus');
const logFilterEl = $('logFilter');
const autoScrollEl = $('autoScroll');
const autoScrollStatusEl = $('autoScrollStatus');

let currentRunId = null;
let es = null;

const aListEl = $('aAccounts');
const bListEl = $('bAccounts');

function accountRowEl(side, idx, initial = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'accountRow';
  wrap.dataset.side = side;

  const tag = document.createElement('div');
  tag.className = 'accountTag';
  tag.dataset.tag = '1';
  tag.textContent = `${side}1`;
  wrap.appendChild(tag);

  // Container for both input rows - this goes in the middle grid column
  const rowsContainer = document.createElement('div');
  rowsContainer.className = 'accountRowsWrap';

  const row1 = document.createElement('div');
  row1.className = 'accountRowInner';
  
  const row2 = document.createElement('div');
  row2.className = 'accountRowInner';

  const mk = (label, name, type, placeholder) => {
    const d = document.createElement('div');
    d.className = 'row';
    const l = document.createElement('label');
    l.className = 'smallLabel';
    l.textContent = label;
    const i = document.createElement('input');
    i.type = type;
    i.placeholder = placeholder || '';
    i.dataset.field = name;
    i.value = (initial && initial[name]) ? String(initial[name]) : '';
    d.appendChild(l);
    d.appendChild(i);
    return d;
  };

  // Row 1: Email, Password
  row1.appendChild(mk(`${side} Email`, 'email', 'email', `${side.toLowerCase()}@mail.com`));
  row1.appendChild(mk(`${side} Password`, 'password', 'password', '******'));
  
  // Row 2: TCKN, FanCard
  row2.appendChild(mk(`TCKN`, 'identity', 'text', '12345678901'));
  row2.appendChild(mk(`Fan Card`, 'fanCardCode', 'text', ''));

  rowsContainer.appendChild(row1);
  rowsContainer.appendChild(row2);
  wrap.appendChild(rowsContainer);

  const btnWrap = document.createElement('div');
  btnWrap.className = 'accountActions';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Sil';
  btn.className = 'btnDanger';
  btn.addEventListener('click', () => {
    wrap.remove();
    renumberAccounts(side);
    ensureAtLeastOne(side);
  });
  btnWrap.appendChild(btn);
  wrap.appendChild(btnWrap);
  
  return wrap;
}

function renumberAccounts(side) {
  const root = side === 'A' ? aListEl : bListEl;
  const rows = Array.from(root.querySelectorAll('.accountRow'));
  rows.forEach((r, i) => {
    const n = i + 1;
    const tag = r.querySelector('.accountTag');
    if (tag) tag.textContent = `${side}${n}`;
  });
}

function ensureAtLeastOne(side) {
  const root = side === 'A' ? aListEl : bListEl;
  const rows = Array.from(root.querySelectorAll('.accountRow'));
  if (rows.length === 0) addAccount(side);
}

function addAccount(side, initial = {}) {
  const el = accountRowEl(side, 0, initial);
  if (side === 'A') aListEl.appendChild(el);
  else bListEl.appendChild(el);
  renumberAccounts(side);
}

function readAccounts(side) {
  const root = side === 'A' ? aListEl : bListEl;
  const rows = Array.from(root.querySelectorAll('.accountRow'));
  const list = [];
  for (const r of rows) {
    const get = (f) => {
      const i = r.querySelector(`[data-field="${f}"]`);
      return i ? String(i.value || '').trim() : '';
    };
    const email = get('email');
    const password = get('password');
    const identity = get('identity');
    const fanCardCode = get('fanCardCode');
    if (!email || !password) continue;
    const item = { email, password };
    if (identity) item.identity = identity;
    if (fanCardCode) item.fanCardCode = fanCardCode;
    list.push(item);
  }
  return list;
}

const state = {
  filter: '',
  autoScroll: true,
  autoScrollStatus: true,
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
    if (m.seatId) parts.push(`ID: ${m.seatId}`);
    return parts.length > 0 ? ` (${parts.join(', ')})` : '';
  };
  
  const statusPatterns = [
    { keywords: ['step:', 'launchAndLogin', 'done', 'login', 'giriş'], message: (e) => {
      const account = e.message?.includes('step:A.') ? 'A' : (e.message?.includes('step:B.') ? 'B' : (e.message?.includes('step:C.') ? 'C' : null));
      const email = e.meta?.email || '';
      return account ? `✓ ${account} Hesabı giriş yapıldı${email ? ': ' + email : ''}` : null;
    }},
    { keywords: ['basket', 'eklendi', 'sepete', 'added', 'seçti ve sepete'], message: (e) => {
      const details = formatSeatDetails(e.meta?.seatInfo || e.meta);
      return `🛒 Sepete koltuk eklendi${details}`;
    }},
    { keywords: ['finalize', 'registered', 'ödeme', 'payment'], message: (e) => `💳 Ödeme işlemi başlatıldı` },
    { keywords: ['run started'], message: (e) => `🚀 Bot çalışmaya başladı` },
    { keywords: ['run stopped', 'completed', 'tamamlandı'], message: (e) => `✅ Bot tamamlandı` },
    { keywords: ['error', 'hata', 'failed', 'başarısız'], message: (e) => {
      const m = e.message || '';
      if (m.includes('login') || m.includes('giriş')) return '❌ Giriş hatası';
      if (m.includes('basket') || m.includes('sepet')) return '❌ Sepet hatası';
      if (m.includes('seat') || m.includes('koltuk')) return '❌ Koltuk seçim hatası';
      return '⚠️ Hata oluştu';
    }},
    { keywords: ['seat', 'koltuk', 'selected', 'pick', 'yakaladı'], message: (e) => {
      const details = formatSeatDetails(e.meta || {});
      return `🪑 Koltuk seçildi${details}`;
    }},
    { keywords: ['category', 'kategori', 'blok', 'block'], message: (e) => `📍 Kategori/blok değişti` },
    { keywords: ['transfer', 'taşıma', 'holder'], message: (e) => `↔️ Koltuk transfer ediliyor` },
    { keywords: ['remove', 'çıkarıldı', 'boşaltıldı'], message: (e) => `🗑️ Sepet boşaltıldı` },
  ];
  
  const matched = statusPatterns.find(p => p.keywords.some(kw => msg.includes(kw.toLowerCase())));
  return matched ? matched.message(entry) : null;
}

function clearLogs() {
  logBox.textContent = '';
  statusBox.textContent = '';
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
      if (j && j.status) {
        runStatusEl.textContent = j.status;
        if (j.status !== 'running') return;
      }
    } catch {}
    await new Promise((res) => setTimeout(res, 1000));
  }
}

$('botForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());

  // Normalize
  body.prioritySale = body.prioritySale === 'on';

  const aAccounts = readAccounts('A');
  const bAccounts = readAccounts('B');
  if (aAccounts.length) body.aAccounts = aAccounts;
  if (bAccounts.length) body.bAccounts = bAccounts;

  // If arrays are provided, drop legacy single-account fields to avoid confusion.
  delete body.email;
  delete body.password;
  delete body.email2;
  delete body.password2;

  // Empty strings => remove optional fields
  for (const k of Object.keys(body)) {
    if (typeof body[k] === 'string' && body[k].trim() === '') delete body[k];
  }

  runIdEl.textContent = '-';
  runStatusEl.textContent = '-';

  try {
    const resp = await fetch('/start-bot-async', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = await resp.json();
    if (!resp.ok) {
      appendLogLine(`${new Date().toISOString()} [ERROR]: start failed ${JSON.stringify(json)}`, { level: 'error', message: 'start failed' });
      return;
    }

    currentRunId = json.runId;
    runIdEl.textContent = currentRunId;
    runStatusEl.textContent = json.status || 'running';
    appendLogLine(`${new Date().toISOString()} [INFO]: run started ${currentRunId}`, { level: 'info', message: 'run started' });

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

startSse();

// Init with 1 row each
try {
  $('btnAddA').addEventListener('click', () => addAccount('A'));
  $('btnAddB').addEventListener('click', () => addAccount('B'));
  addAccount('A');
  addAccount('B');
} catch {}
