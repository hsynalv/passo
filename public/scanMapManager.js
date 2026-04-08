(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    teams: [],
    scannedItems: [],
    mappings: [],
    liveRunId: '',
    liveRunStatus: 'idle',
    liveRunLogs: [],
    liveRunPollTimer: null,
  };

  let notify = (msg, meta) => {
    try { console.log('[scan-map]', msg, meta || ''); } catch {}
  };

  function setNotifier(fn) {
    if (typeof fn === 'function') notify = fn;
  }

  async function apiJson(path, options = {}) {
    const resp = await fetch(path, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(json.error || json.message || `HTTP_${resp.status}`);
    return json;
  }

  function escapeHtml(input) {
    return String(input ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function openModal() {
    const root = $('scanMapModal');
    if (root) root.hidden = false;
  }

  function closeModal() {
    const root = $('scanMapModal');
    if (root) root.hidden = true;
    try {
      if (state.liveRunPollTimer) {
        clearTimeout(state.liveRunPollTimer);
        state.liveRunPollTimer = null;
      }
    } catch {}
  }

  function setRunMeta(runId, status) {
    state.liveRunId = String(runId || '').trim();
    state.liveRunStatus = String(status || '').trim() || 'idle';
    const idEl = $('scanMapRunId');
    const statusEl = $('scanMapRunStatus');
    const fileEl = $('scanMapRunLogFile');
    const proxyEl = $('scanMapRunProxy');
    if (idEl) idEl.textContent = state.liveRunId || '-';
    if (statusEl) statusEl.textContent = state.liveRunStatus;
    if (fileEl && !String(fileEl.textContent || '').trim()) fileEl.textContent = '-';
    if (proxyEl && !String(proxyEl.textContent || '').trim()) proxyEl.textContent = '-';
  }

  function renderLiveRunLogs() {
    const root = $('scanMapLogBox');
    if (!root) return;
    const lines = (Array.isArray(state.liveRunLogs) ? state.liveRunLogs : []).map((entry) => {
      const at = String(entry?.at || '').trim();
      const level = String(entry?.level || 'info').toUpperCase();
      const msg = String(entry?.message || '').trim();
      const meta = entry?.meta && typeof entry.meta === 'object' && Object.keys(entry.meta).length
        ? ` ${JSON.stringify(entry.meta)}`
        : '';
      return `${at || new Date().toISOString()} [${level}] ${msg}${meta}`;
    });
    root.textContent = lines.join('\n');
    root.scrollTop = root.scrollHeight;
  }

  function setLiveRunFromResponse(run) {
    if (!run || typeof run !== 'object') return;
    setRunMeta(run.runId, run.status);
    const fileEl = $('scanMapRunLogFile');
    const proxyEl = $('scanMapRunProxy');
    const proxyText = String(run?.result?.login?.proxy || '').trim();
    if (fileEl) fileEl.textContent = String(run.logFilePath || '').trim() || '-';
    if (proxyEl) proxyEl.textContent = proxyText || '-';
    state.liveRunLogs = Array.isArray(run.logs) ? run.logs : [];
    renderLiveRunLogs();
  }

  function clearLiveRunUi() {
    setRunMeta('', 'idle');
    const fileEl = $('scanMapRunLogFile');
    const proxyEl = $('scanMapRunProxy');
    if (fileEl) fileEl.textContent = '-';
    if (proxyEl) proxyEl.textContent = '-';
    state.liveRunLogs = [];
    renderLiveRunLogs();
  }

  async function pollLiveRun(runId) {
    const rid = String(runId || '').trim();
    if (!rid) return;
    const json = await apiJson(`/api/scan-map/runs/${encodeURIComponent(rid)}`);
    const run = json?.run || null;
    if (!run) return;
    setLiveRunFromResponse(run);

    if (run.status === 'completed') {
      state.scannedItems = Array.isArray(run?.result?.items) ? run.result.items : [];
      renderAll();
      const who = String(run?.result?.login?.email || '').trim();
      notify(`Canlı tarama tamam (${state.scannedItems.length})`, who ? { login: who } : undefined);
      return;
    }
    if (run.status === 'failed') {
      const reason = String(run?.error || 'Bilinmeyen hata').trim();
      notify('Canlı tarama başarısız', { error: reason });
      return;
    }

    try {
      if (state.liveRunPollTimer) clearTimeout(state.liveRunPollTimer);
    } catch {}
    state.liveRunPollTimer = setTimeout(() => {
      pollLiveRun(rid).catch((e) => {
        notify('Canlı tarama logları alınamadı', { error: e?.message || String(e) });
      });
    }, 900);
  }

  function getForm() {
    const teamId = String($('scanMapTeamSelect')?.value || '').trim();
    const eventAddress = String($('scanMapEventAddressInput')?.value || '').trim();
    const scopeType = String($('scanMapScopeSelect')?.value || 'team_event').trim() || 'team_event';
    const maxProbe = parseInt(String($('scanMapMaxProbeInput')?.value || '30').trim(), 10) || 30;
    const categoryHints = String($('scanMapCategoryHintInput')?.value || '')
      .split(',')
      .map((s) => String(s || '').trim())
      .filter(Boolean);
    const useProxy = !!$('scanMapUseProxyInput')?.checked;
    return { teamId, eventAddress, scopeType, maxProbe, categoryHints, useProxy };
  }

  function syncTeamAndEventDefaults() {
    try {
      const catalogApi = window.passobotCatalog || null;
      if (catalogApi && typeof catalogApi.getSelectedTeam === 'function') {
        const team = catalogApi.getSelectedTeam();
        if (team?.id && $('scanMapTeamSelect')) $('scanMapTeamSelect').value = String(team.id);
      }
    } catch {}

    try {
      const eventInput = document.querySelector('input[name="eventAddress"]');
      const currentEvent = String(eventInput?.value || '').trim();
      if (currentEvent && $('scanMapEventAddressInput') && !$('scanMapEventAddressInput').value.trim()) {
        $('scanMapEventAddressInput').value = currentEvent;
      }
    } catch {}
  }

  function renderTeams() {
    const root = $('scanMapTeamSelect');
    if (!root) return;
    const prev = String(root.value || '').trim();
    root.innerHTML = '<option value="">Takım seç</option>';
    for (const team of state.teams) {
      const opt = document.createElement('option');
      opt.value = team.id;
      opt.textContent = team.isActive === false ? `${team.name} (pasif)` : team.name;
      root.appendChild(opt);
    }
    root.value = state.teams.some((team) => String(team.id) === prev) ? prev : '';
    syncTeamAndEventDefaults();
  }

  function renderSummary() {
    const root = $('scanMapSummary');
    if (!root) return;
    const scanned = Array.isArray(state.scannedItems) ? state.scannedItems.length : 0;
    const saved = Array.isArray(state.mappings) ? state.mappings.length : 0;
    root.innerHTML = `<strong>${saved} kayıt</strong><span>${scanned} yeni tarama sonucu · ${saved} DB kaydı</span>`;
  }

  function combinedRows() {
    const saved = (Array.isArray(state.mappings) ? state.mappings : []).map((item) => ({ ...item, _source: 'saved' }));
    const scanned = (Array.isArray(state.scannedItems) ? state.scannedItems : []).map((item, idx) => ({ ...item, id: `scan-${idx}`, _source: 'scanned' }));
    const byKey = new Map();
    for (const item of saved) {
      const key = `${item.blockId || ''}`;
      if (!key) continue;
      byKey.set(key, item);
    }
    for (const item of scanned) {
      const key = `${item.blockId || ''}`;
      if (!key || byKey.has(key)) continue;
      byKey.set(key, item);
    }
    return Array.from(byKey.values());
  }

  function renderList() {
    const root = $('scanMapList');
    if (!root) return;
    root.textContent = '';
    const rows = combinedRows();
    if (!rows.length) {
      root.innerHTML = '<div class="itemListEmpty">Henüz kayıt yok.</div>';
      return;
    }

    for (const item of rows) {
      const row = document.createElement('div');
      row.className = 'itemCard scanMapRow' + (item.isDefault ? ' active' : '');
      const confidence = Number.isFinite(Number(item.confidence)) ? Math.round(Number(item.confidence)) : 0;
      const source = item._source === 'saved' ? 'DB' : 'Tarama';
      const seen = item.lastSeenAt ? ` · ${escapeHtml(String(item.lastSeenAt))}` : '';
      row.innerHTML = `
        <div>
          <strong>${escapeHtml(item.blockId || '-')}</strong>
          <div class="itemCardMeta">${escapeHtml(item.tooltipText || '-')}</div>
          <div class="itemCardMeta">kategori: ${escapeHtml(item.categoryLabel || item.legendTitle || '-')} · confidence: ${confidence} · kaynak: ${source}${seen}</div>
        </div>
        <div class="itemCardActions">
          ${item._source === 'saved' ? `<button type="button" class="btnMuted" data-action="default" data-mapping-id="${escapeHtml(item.id)}" data-category-label="${escapeHtml(item.categoryLabel || '')}">Varsayılan yap</button>` : ''}
          ${item._source === 'saved' ? `<button type="button" class="btnDanger" data-action="delete" data-mapping-id="${escapeHtml(item.id)}">Sil</button>` : ''}
        </div>
      `;
      root.appendChild(row);
    }
  }

  function renderAll() {
    renderSummary();
    renderList();
  }

  async function loadTeams() {
    const json = await apiJson('/api/teams');
    state.teams = Array.isArray(json.teams) ? json.teams : [];
    renderTeams();
  }

  async function loadMappings() {
    const { teamId, eventAddress, scopeType } = getForm();
    if (!teamId) {
      state.mappings = [];
      renderAll();
      return;
    }
    const q = new URLSearchParams({
      teamId,
      eventAddress,
      scopeType,
      includeInactive: '1',
    });
    const json = await apiJson(`/api/scan-map?${q.toString()}`);
    state.mappings = Array.isArray(json.mappings) ? json.mappings : [];
    renderAll();
  }

  async function runScan() {
    const form = getForm();
    if (!form.teamId) {
      alert('Takım seç');
      return;
    }
    if (!form.eventAddress) {
      alert('Etkinlik URL gir (tarama için zorunlu)');
      return;
    }
    const json = await apiJson('/api/scan-map/scan', {
      method: 'POST',
      body: form,
    });
    state.scannedItems = Array.isArray(json.items) ? json.items : [];
    renderAll();
    notify(`Tarama tamam (${state.scannedItems.length})`);
  }

  async function runLiveScan() {
    const form = getForm();
    if (!form.teamId) {
      alert('Takım seç');
      return;
    }
    if (!form.eventAddress) {
      alert('Etkinlik URL gir (canlı tarama için zorunlu)');
      return;
    }
    clearLiveRunUi();
    const json = await apiJson('/api/scan-map/scan-live', {
      method: 'POST',
      body: form,
    });
    const runId = String(json?.runId || '').trim();
    if (!runId) throw new Error('SCAN_RUN_ID_MISSING');
    setRunMeta(runId, String(json?.status || 'running'));
    state.liveRunLogs = [
      {
        at: new Date().toISOString(),
        level: 'info',
        message: 'Canlı tarama başlatıldı, loglar bekleniyor...',
        meta: { runId },
      },
    ];
    renderLiveRunLogs();
    await pollLiveRun(runId);
  }

  async function saveScanResult() {
    const form = getForm();
    if (!form.teamId) {
      alert('Takım seç');
      return;
    }
    if (!state.scannedItems.length) {
      alert('Önce blok taraması yap veya canlı taramayı tamamla');
      return;
    }
    const json = await apiJson('/api/scan-map/save-as-team-categories', {
      method: 'POST',
      body: {
        teamId: form.teamId,
        items: state.scannedItems,
      },
    });
    const skipped = Number(json.skippedCount || 0);
    notify(`Takım kategorileri kaydedildi (+${json.count || 0}${skipped ? `, ${skipped} blok zaten kategoriydi` : ''})`);
    try {
      if (window.passobotCatalog && typeof window.passobotCatalog.reloadCategories === 'function') {
        await window.passobotCatalog.reloadCategories();
      }
    } catch {}
  }

  async function setDefault(mappingId, categoryLabel) {
    const form = getForm();
    if (!form.teamId || !mappingId) return;
    await apiJson('/api/scan-map/default', {
      method: 'POST',
      body: {
        teamId: form.teamId,
        eventAddress: form.eventAddress,
        scopeType: form.scopeType,
        categoryLabel: categoryLabel || '',
        mappingId,
      },
    });
    await loadMappings();
  }

  async function removeMapping(mappingId) {
    if (!mappingId) return;
    const ok = window.confirm('Bu kayıt silinsin mi?');
    if (!ok) return;
    await apiJson(`/api/scan-map/${encodeURIComponent(mappingId)}`, { method: 'DELETE' });
    await loadMappings();
  }

  async function clearAll() {
    const form = getForm();
    if (!form.teamId) {
      alert('Takım seç');
      return;
    }
    const ok = window.confirm('Bu takım/event için tüm kayıtlar silinsin mi?');
    if (!ok) return;
    await apiJson('/api/scan-map/clear', {
      method: 'POST',
      body: {
        teamId: form.teamId,
        eventAddress: form.eventAddress,
        scopeType: form.scopeType,
      },
    });
    state.scannedItems = [];
    await loadMappings();
  }

  function bindEvents() {
    $('btnOpenScanMapManager')?.addEventListener('click', async () => {
      openModal();
      clearLiveRunUi();
      try {
        await loadTeams();
        await loadMappings();
      } catch (e) {
        alert(e?.message || String(e));
      }
    });
    $('btnCloseScanMapModal')?.addEventListener('click', closeModal);
    $('scanMapModalBackdrop')?.addEventListener('click', closeModal);
    $('btnScanMapModalDone')?.addEventListener('click', closeModal);

    $('scanMapTeamSelect')?.addEventListener('change', () => {
      loadMappings().catch((e) => notify('Kayıtlar yüklenemedi', { error: e?.message || String(e) }));
    });
    $('scanMapScopeSelect')?.addEventListener('change', () => {
      loadMappings().catch((e) => notify('Kayıtlar yüklenemedi', { error: e?.message || String(e) }));
    });
    $('scanMapEventAddressInput')?.addEventListener('change', () => {
      loadMappings().catch((e) => notify('Kayıtlar yüklenemedi', { error: e?.message || String(e) }));
    });

    $('btnScanMapRun')?.addEventListener('click', async () => {
      try { await runScan(); } catch (e) { alert(e?.message || String(e)); }
    });
    $('btnScanMapStart')?.addEventListener('click', async () => {
      try { await runLiveScan(); } catch (e) { alert(e?.message || String(e)); }
    });
    $('btnScanMapSave')?.addEventListener('click', async () => {
      try { await saveScanResult(); } catch (e) { alert(e?.message || String(e)); }
    });
    $('btnScanMapRefresh')?.addEventListener('click', async () => {
      try { await loadMappings(); } catch (e) { alert(e?.message || String(e)); }
    });
    $('btnScanMapClear')?.addEventListener('click', async () => {
      try { await clearAll(); } catch (e) { alert(e?.message || String(e)); }
    });

    $('scanMapList')?.addEventListener('click', async (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      const action = String(btn.dataset.action || '').trim();
      const mappingId = String(btn.dataset.mappingId || '').trim();
      const categoryLabel = String(btn.dataset.categoryLabel || '').trim();
      if (action === 'default') {
        try { await setDefault(mappingId, categoryLabel); } catch (e) { alert(e?.message || String(e)); }
        return;
      }
      if (action === 'delete') {
        try { await removeMapping(mappingId); } catch (e) { alert(e?.message || String(e)); }
      }
    });
  }

  function init() {
    bindEvents();
    clearLiveRunUi();
  }

  window.passobotScanMap = {
    init,
    loadMappings,
    openModal,
    setNotifier,
  };
})();
