const $ = (id) => document.getElementById(id);

const connEl = $('recordsConnStatus');
const listEl = $('recordsList');
const metaEl = $('recordsMeta');
const summaryEl = $('recordsSummary');
const detailMetaEl = $('recordDetailMeta');
const detailBodyEl = $('recordDetailBody');

const state = {
  records: [],
  selectedId: '',
  es: null,
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDateTime(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('tr-TR');
}

function setConn(text, ok) {
  if (!connEl) return;
  connEl.textContent = text;
  connEl.className = ok ? 'status ok' : 'status';
}

function currentFilters() {
  return {
    q: String($('filterQuery')?.value || '').trim(),
    teamName: String($('filterTeam')?.value || '').trim(),
    eventUrl: String($('filterEventUrl')?.value || '').trim(),
    accountEmail: String($('filterAccountEmail')?.value || '').trim(),
    paymentSource: String($('filterPaymentSource')?.value || '').trim(),
    paymentState: String($('filterPaymentState')?.value || '').trim(),
    recordStatus: String($('filterRecordStatus')?.value || '').trim(),
    from: String($('filterFrom')?.value || '').trim(),
    to: String($('filterTo')?.value || '').trim(),
    limit: 250,
  };
}

function buildQuery(filters) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(filters || {})) {
    if (value == null || value === '') continue;
    qs.set(key, String(value));
  }
  return qs.toString();
}

function filterHaystack(record) {
  return [
    record.teamName,
    record.eventUrl,
    record.aAccountEmail,
    record.bAccountEmail,
    record.cAccountEmail,
    record.paymentActorEmail,
    record.paymentOwnerRole,
    record.holderRole,
    record.recordStatus,
    record.paymentState,
    record?.seat?.seatId,
    record?.seat?.combined,
    record?.seat?.block,
    record?.category?.categoryText,
    record?.category?.blockText,
    record?.category?.blockVal,
    record.failureReason,
  ].join(' ').toLowerCase();
}

function matchesFilters(record, filters) {
  if (!record) return false;
  const hay = (v) => String(v || '').toLowerCase();
  const q = hay(filters.q);
  const qTeam = hay(filters.teamName);
  const qEvent = hay(filters.eventUrl);
  const qAccount = hay(filters.accountEmail);
  if (q && !filterHaystack(record).includes(q)) return false;
  if (qTeam && !hay(record.teamName).includes(qTeam)) return false;
  if (qEvent && !hay(record.eventUrl).includes(qEvent)) return false;
  if (qAccount) {
    const accountHit = [
      record.aAccountEmail,
      record.bAccountEmail,
      record.cAccountEmail,
      record.paymentActorEmail,
    ].some((item) => hay(item).includes(qAccount));
    if (!accountHit) return false;
  }
  if (filters.paymentSource && String(record.paymentSource || '') !== String(filters.paymentSource)) return false;
  if (filters.paymentState && String(record.paymentState || '') !== String(filters.paymentState)) return false;
  if (filters.recordStatus && String(record.recordStatus || '') !== String(filters.recordStatus)) return false;
  if (filters.from && String(record.createdAt || '') < String(filters.from)) return false;
  if (filters.to && String(record.createdAt || '') > String(filters.to)) return false;
  return true;
}

function upsertRecord(record) {
  if (!record || !record.id) return;
  const idx = state.records.findIndex((item) => item.id === record.id);
  if (idx >= 0) state.records[idx] = record;
  else state.records.unshift(record);
  state.records.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function badge(label, tone = 'default') {
  return `<span class="recordBadge ${tone}">${escapeHtml(label)}</span>`;
}

function renderSummary(records) {
  if (!summaryEl) return;
  const total = records.length;
  const failed = records.filter((item) => item.recordStatus === 'failed').length;
  const finalized = records.filter((item) => item.recordStatus === 'finalized').length;
  const basketed = records.filter((item) => item.recordStatus === 'basketed').length;
  const aPayments = records.filter((item) => item.paymentSource === 'A').length;
  const cPayments = records.filter((item) => item.paymentSource === 'C').length;
  summaryEl.innerHTML = `
    <div class="summaryCard"><strong>${total}</strong><span>Toplam Kayit</span></div>
    <div class="summaryCard"><strong>${basketed}</strong><span>Sepette</span></div>
    <div class="summaryCard"><strong>${finalized}</strong><span>Finalize</span></div>
    <div class="summaryCard"><strong>${failed}</strong><span>Failed</span></div>
    <div class="summaryCard"><strong>${aPayments}</strong><span>Ana Hesap Odeme</span></div>
    <div class="summaryCard"><strong>${cPayments}</strong><span>C Finalize</span></div>
  `;
}

function renderList() {
  const filters = currentFilters();
  const visible = state.records.filter((record) => matchesFilters(record, filters));
  metaEl.textContent = `${visible.length} kayit gosteriliyor`;
  renderSummary(visible);
  if (!visible.length) {
    listEl.innerHTML = '<div class="pairDashEmpty">Filtreye uyan kayit yok.</div>';
    return;
  }

  listEl.innerHTML = visible.map((record) => {
    const active = record.id === state.selectedId ? ' active' : '';
    const seatLabel = record?.seat?.combined || [record?.seat?.row, record?.seat?.seatNumber].filter(Boolean).join(' / ') || record?.seat?.seatId || '—';
    const hasFailureLogs = Number(record.sessionLogCount || 0) > 0;
    return `<button type="button" class="recordRow${active}" data-record-id="${escapeHtml(record.id)}">
      <div class="recordRowHead">
        <strong>${escapeHtml(record.teamName || 'Takim yok')}</strong>
        <div class="recordBadgeRow">
          ${badge(record.recordStatus || 'unknown')}
          ${record.paymentSource ? badge(`Odeme: ${record.paymentSource === 'A' ? 'Ana Hesap' : record.paymentSource}`, record.paymentSource === 'A' ? 'ok' : 'warn') : ''}
          ${hasFailureLogs ? badge(`Log: ${record.sessionLogCount}`, 'danger') : ''}
        </div>
      </div>
      <div class="recordRowMeta">${escapeHtml(record.eventUrl || '—')}</div>
      <div class="recordRowMeta">Akis #${escapeHtml(record.pairIndex || 1)} · Tutucu: ${escapeHtml(record.holderRole === 'A' ? 'Ana Hesap' : record.holderRole === 'B' ? 'Tutucu Hesap' : record.holderRole || '—')} · Odeme sahibi: ${escapeHtml(record.paymentOwnerRole === 'A' ? 'Ana Hesap' : record.paymentOwnerRole === 'B' ? 'Tutucu Hesap' : record.paymentOwnerRole || '—')}</div>
      <div class="recordRowMeta">Ana: ${escapeHtml(record.aAccountEmail || '—')} · Tutucu: ${escapeHtml(record.bAccountEmail || '—')} · C: ${escapeHtml(record.cAccountEmail || '—')}</div>
      <div class="recordRowSeat">${escapeHtml(seatLabel)}</div>
      <div class="recordRowMeta">Basket: ${escapeHtml(formatDateTime(record?.basketState?.addedAt))} · Guncel: ${escapeHtml(formatDateTime(record.updatedAt || record.createdAt))}</div>
    </button>`;
  }).join('');

  listEl.querySelectorAll('[data-record-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const recordId = String(el.getAttribute('data-record-id') || '').trim();
      if (!recordId) return;
      state.selectedId = recordId;
      renderList();
      loadRecordDetail(recordId).catch((error) => {
        detailMetaEl.textContent = 'Hata';
        detailBodyEl.innerHTML = `<div class="pairDashEmpty">${escapeHtml(error?.message || String(error))}</div>`;
      });
    });
  });
}

function renderSessionLogs(sessionLogs) {
  if (!Array.isArray(sessionLogs) || !sessionLogs.length) {
    return '<div class="pairDashEmpty">Kaydedilmis session log yok.</div>';
  }
  return sessionLogs.map((item) => `
    <div class="timelineItem logItem">
      <div class="timelineType">${escapeHtml(item.level || 'info')} · ${escapeHtml(item.message || '')}</div>
      <div class="timelineAt">${escapeHtml(formatDateTime(item.ts || ''))}</div>
      <pre class="timelineMeta">${escapeHtml(JSON.stringify(item.meta || {}, null, 2))}</pre>
    </div>
  `).join('');
}

function renderDetail(record) {
  if (!record) {
    detailMetaEl.textContent = '';
    detailBodyEl.innerHTML = '<div class="pairDashEmpty">Soldan bir kayit sec.</div>';
    return;
  }
  const seat = record.seat || {};
  const category = record.category || {};
  const basketState = record.basketState || {};
  const auditTrail = Array.isArray(record.auditTrail) ? record.auditTrail : [];
  const sessionLogs = Array.isArray(record.sessionLogs) ? record.sessionLogs : [];
  detailMetaEl.textContent = `${record.teamName || 'Takim yok'} · Akis #${record.pairIndex || 1}`;
  detailBodyEl.innerHTML = `
    <div class="recordDetailGrid">
      <div class="recordDetailBlock">
        <h3>Genel</h3>
        <div class="recordDetailRow"><span>Run</span><code>${escapeHtml(record.runId || '—')}</code></div>
        <div class="recordDetailRow"><span>Event URL</span><code>${escapeHtml(record.eventUrl || '—')}</code></div>
        <div class="recordDetailRow"><span>Ticket Type</span><strong>${escapeHtml(record.ticketType || '—')}</strong></div>
        <div class="recordDetailRow"><span>Status</span><strong>${escapeHtml(record.recordStatus || '—')}</strong></div>
        <div class="recordDetailRow"><span>Odeme</span><strong>${escapeHtml(record.paymentState || '—')}</strong></div>
        <div class="recordDetailRow"><span>Finalize</span><strong>${escapeHtml(record.finalizeState || '—')}</strong></div>
      </div>
      <div class="recordDetailBlock">
        <h3>Hesaplar</h3>
        <div class="recordDetailRow"><span>Ana</span><code>${escapeHtml(record.aAccountEmail || '—')}</code></div>
        <div class="recordDetailRow"><span>Tutucu</span><code>${escapeHtml(record.bAccountEmail || '—')}</code></div>
        <div class="recordDetailRow"><span>C</span><code>${escapeHtml(record.cAccountEmail || '—')}</code></div>
        <div class="recordDetailRow"><span>Odeme Kaynagi</span><strong>${escapeHtml(record.paymentSource === 'A' ? 'Ana Hesap' : record.paymentSource || '—')}</strong></div>
        <div class="recordDetailRow"><span>Odeme Aktoru</span><code>${escapeHtml(record.paymentActorEmail || '—')}</code></div>
        <div class="recordDetailRow"><span>Tutucu</span><strong>${escapeHtml(record.holderRole === 'A' ? 'Ana Hesap' : record.holderRole === 'B' ? 'Tutucu Hesap' : record.holderRole || '—')}</strong></div>
      </div>
      <div class="recordDetailBlock">
        <h3>Basket</h3>
        <div class="recordDetailRow"><span>Sepete Giris</span><strong>${escapeHtml(formatDateTime(basketState.addedAt))}</strong></div>
        <div class="recordDetailRow"><span>Son Gorus</span><strong>${escapeHtml(formatDateTime(basketState.lastSeenAt))}</strong></div>
        <div class="recordDetailRow"><span>Basket State</span><strong>${escapeHtml(basketState.status || '—')}</strong></div>
        <div class="recordDetailRow"><span>Created</span><strong>${escapeHtml(formatDateTime(record.createdAt))}</strong></div>
        <div class="recordDetailRow"><span>Updated</span><strong>${escapeHtml(formatDateTime(record.updatedAt))}</strong></div>
        <div class="recordDetailRow"><span>Failure</span><strong>${escapeHtml(record.failureReason || '—')}</strong></div>
      </div>
      <div class="recordDetailBlock">
        <h3>Koltuk ve Kategori</h3>
        <div class="recordDetailRow"><span>Seat ID</span><strong>${escapeHtml(seat.seatId || '—')}</strong></div>
        <div class="recordDetailRow"><span>Combined</span><strong>${escapeHtml(seat.combined || '—')}</strong></div>
        <div class="recordDetailRow"><span>Tribun</span><strong>${escapeHtml(seat.tribune || '—')}</strong></div>
        <div class="recordDetailRow"><span>Blok</span><strong>${escapeHtml(seat.block || '—')}</strong></div>
        <div class="recordDetailRow"><span>Sira</span><strong>${escapeHtml(seat.row || '—')}</strong></div>
        <div class="recordDetailRow"><span>Koltuk</span><strong>${escapeHtml(seat.seatNumber || '—')}</strong></div>
        <div class="recordDetailRow"><span>Kategori</span><strong>${escapeHtml(category.categoryText || '—')}</strong></div>
        <div class="recordDetailRow"><span>Blok Text</span><strong>${escapeHtml(category.blockText || '—')}</strong></div>
        <div class="recordDetailRow"><span>Blok Val</span><strong>${escapeHtml(category.blockVal || '—')}</strong></div>
        <div class="recordDetailRow"><span>SVG</span><strong>${escapeHtml(category.svgBlockId || '—')}</strong></div>
      </div>
    </div>
    <div class="recordTimeline">
      <h3>Audit Trail</h3>
      ${auditTrail.length ? auditTrail.map((item) => `
        <div class="timelineItem">
          <div class="timelineType">${escapeHtml(item.type || 'event')}</div>
          <div class="timelineAt">${escapeHtml(formatDateTime(item.at || ''))}</div>
          <pre class="timelineMeta">${escapeHtml(JSON.stringify(item.meta || {}, null, 2))}</pre>
        </div>
      `).join('') : '<div class="pairDashEmpty">Audit trail yok.</div>'}
    </div>
    <div class="recordTimeline">
      <h3>Hata Oturumu Loglari (${escapeHtml(sessionLogs.length)})</h3>
      ${renderSessionLogs(sessionLogs)}
    </div>
  `;
}

async function fetchRecords() {
  const qs = buildQuery(currentFilters());
  const resp = await fetch(`/api/order-records${qs ? `?${qs}` : ''}`, { cache: 'no-store' });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error || 'Kayitlar yuklenemedi');
  state.records = Array.isArray(json.records) ? json.records : [];
  renderList();
  if (state.selectedId) {
    const current = state.records.find((item) => item.id === state.selectedId);
    if (current) renderDetail(current);
  }
}

async function loadRecordDetail(recordId) {
  if (!recordId) return;
  const resp = await fetch(`/api/order-records/${encodeURIComponent(recordId)}`, { cache: 'no-store' });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error || 'Kayit detayi yuklenemedi');
  renderDetail(json.record || null);
}

function startRecordStream() {
  if (state.es) {
    try { state.es.close(); } catch {}
  }
  setConn('Connecting...', false);
  const qs = buildQuery({ ...currentFilters(), limit: 150 });
  state.es = new EventSource(`/api/order-records/stream${qs ? `?${qs}` : ''}`);
  state.es.addEventListener('open', () => setConn('Connected', true));
  state.es.addEventListener('snapshot', (ev) => {
    try {
      const records = JSON.parse(ev.data);
      if (Array.isArray(records)) {
        state.records = records;
        renderList();
      }
    } catch {}
  });
  state.es.addEventListener('record', (ev) => {
    try {
      const record = JSON.parse(ev.data);
      upsertRecord(record);
      renderList();
      if (state.selectedId && state.selectedId === record.id) {
        renderDetail(record);
      }
    } catch {}
  });
  state.es.addEventListener('error', () => setConn('Disconnected (retrying...)', false));
}

async function applyFilters() {
  await fetchRecords();
  startRecordStream();
}

$('btnApplyRecordFilters')?.addEventListener('click', () => {
  applyFilters().catch((error) => {
    detailMetaEl.textContent = 'Hata';
    detailBodyEl.innerHTML = `<div class="pairDashEmpty">${escapeHtml(error?.message || String(error))}</div>`;
  });
});

$('btnResetRecordFilters')?.addEventListener('click', () => {
  ['filterQuery', 'filterTeam', 'filterEventUrl', 'filterAccountEmail', 'filterPaymentSource', 'filterPaymentState', 'filterRecordStatus', 'filterFrom', 'filterTo']
    .forEach((id) => {
      const el = $(id);
      if (el) el.value = '';
    });
  applyFilters().catch(() => {});
});

$('filterQuery')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  applyFilters().catch(() => {});
});

fetchRecords().catch((error) => {
  detailMetaEl.textContent = 'Hata';
  detailBodyEl.innerHTML = `<div class="pairDashEmpty">${escapeHtml(error?.message || String(error))}</div>`;
});
startRecordStream();
