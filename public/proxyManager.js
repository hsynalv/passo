(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    proxies: [],
    tab: 'active',
  };

  function notify(msg) {
    try { console.log('[proxy]', msg); } catch {}
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

  function openModal() {
    const root = $('proxyModal');
    if (root) root.hidden = false;
  }

  function closeModal() {
    const root = $('proxyModal');
    if (root) root.hidden = true;
  }

  function resetForm() {
    if ($('proxyEditId')) $('proxyEditId').value = '';
    if ($('proxyHostInput')) $('proxyHostInput').value = '';
    if ($('proxyPortInput')) $('proxyPortInput').value = '';
    if ($('proxyProtocolInput')) $('proxyProtocolInput').value = 'socks5';
    if ($('proxyUsernameInput')) $('proxyUsernameInput').value = '';
    if ($('proxyPasswordInput')) $('proxyPasswordInput').value = '';
    if ($('proxyActiveInput')) $('proxyActiveInput').checked = true;
    if ($('btnDeleteProxy')) $('btnDeleteProxy').disabled = true;
  }

  function activeList() {
    const all = Array.isArray(state.proxies) ? state.proxies : [];
    if (state.tab === 'blacklisted') return all.filter((p) => p && p.isBlacklisted);
    return all.filter((p) => p && !p.isBlacklisted);
  }

  function renderSummary() {
    const root = $('proxySummary');
    if (!root) return;
    const all = Array.isArray(state.proxies) ? state.proxies : [];
    const active = all.filter((p) => p && !p.isBlacklisted && p.isActive !== false).length;
    const blacklisted = all.filter((p) => p && p.isBlacklisted).length;
    root.innerHTML = `<strong>${all.length} proxy</strong><span>${active} aktif · ${blacklisted} blacklist</span>`;
  }

  function escapeHtml(input) {
    return String(input ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderList() {
    const root = $('proxyList');
    if (!root) return;
    root.textContent = '';
    const rows = activeList();
    if (!rows.length) {
      root.innerHTML = `<div class="itemListEmpty">${state.tab === 'blacklisted' ? 'Blacklistte proxy yok.' : 'Aktif proxy yok.'}</div>`;
      return;
    }

    for (const item of rows) {
      const row = document.createElement('div');
      row.className = 'itemCard';
      const blackUntil = item.blacklistUntil ? String(item.blacklistUntil) : '';
      const usage = `${item.successCount || 0} ok / ${item.failCount || 0} fail`;
      const auth = item.username ? `${escapeHtml(item.username)}:${item.password ? '***' : ''}` : 'auth yok';
      row.innerHTML = `
        <div>
          <strong>${escapeHtml(item.host)}:${escapeHtml(item.port)}</strong>
          <div class="itemCardMeta">${escapeHtml(item.protocol || 'socks5')} · ${auth} · ${usage}${item.isActive === false ? ' · pasif' : ''}${blackUntil ? ` · blacklist: ${escapeHtml(blackUntil)}` : ''}</div>
        </div>
        <div class="itemCardActions">
          <button type="button" class="btnMuted" data-action="edit" data-proxy-id="${escapeHtml(item.id)}">Düzenle</button>
          ${item.isBlacklisted ? `<button type="button" class="btnMuted" data-action="restore" data-proxy-id="${escapeHtml(item.id)}">Whitelist'e Al</button>` : ''}
          <button type="button" class="btnDanger" data-action="delete" data-proxy-id="${escapeHtml(item.id)}">Sil</button>
        </div>
      `;
      root.appendChild(row);
    }
  }

  function renderTabs() {
    const activeBtn = $('btnProxyTabActive');
    const blackBtn = $('btnProxyTabBlacklisted');
    if (activeBtn) activeBtn.className = state.tab === 'active' ? '' : 'btnMuted';
    if (blackBtn) blackBtn.className = state.tab === 'blacklisted' ? '' : 'btnMuted';
  }

  function renderAll() {
    renderSummary();
    renderTabs();
    renderList();
  }

  async function loadProxies() {
    const json = await apiJson('/api/proxies?includeInactive=1&includeBlacklisted=1');
    state.proxies = Array.isArray(json.proxies) ? json.proxies : [];
    renderAll();
  }

  function fillForm(id) {
    const item = state.proxies.find((p) => String(p.id) === String(id));
    if (!item) return;
    $('proxyEditId').value = item.id;
    $('proxyHostInput').value = item.host || '';
    $('proxyPortInput').value = item.port || '';
    $('proxyProtocolInput').value = item.protocol || 'socks5';
    $('proxyUsernameInput').value = item.username || '';
    $('proxyPasswordInput').value = item.password || '';
    $('proxyActiveInput').checked = item.isActive !== false;
    $('btnDeleteProxy').disabled = false;
  }

  async function saveProxy() {
    const payload = {
      host: String($('proxyHostInput')?.value || '').trim(),
      port: parseInt(String($('proxyPortInput')?.value || '').trim(), 10),
      protocol: String($('proxyProtocolInput')?.value || 'socks5').trim(),
      username: String($('proxyUsernameInput')?.value || '').trim(),
      password: String($('proxyPasswordInput')?.value || '').trim(),
      isActive: !!$('proxyActiveInput')?.checked,
    };

    const editId = String($('proxyEditId')?.value || '').trim();
    if (!payload.host || !Number.isFinite(payload.port)) {
      alert('Host ve port zorunlu');
      return;
    }

    if (editId) {
      await apiJson(`/api/proxies/${encodeURIComponent(editId)}`, { method: 'PUT', body: payload });
      notify('Proxy güncellendi');
    } else {
      await apiJson('/api/proxies', { method: 'POST', body: payload });
      notify('Proxy eklendi');
    }
    resetForm();
    await loadProxies();
  }

  async function deleteSelectedProxy() {
    const editId = String($('proxyEditId')?.value || '').trim();
    if (!editId) return;
    const ok = window.confirm('Bu proxy silinsin mi?');
    if (!ok) return;
    await apiJson(`/api/proxies/${encodeURIComponent(editId)}`, { method: 'DELETE' });
    resetForm();
    await loadProxies();
  }

  async function importBulk() {
    const rawText = String($('proxyBulkInput')?.value || '').trim();
    if (!rawText) {
      alert('Toplu ekleme için satır gir');
      return;
    }
    const defaultProtocol = String($('proxyImportProtocolInput')?.value || 'socks5').trim();
    const json = await apiJson('/api/proxies/import', {
      method: 'POST',
      body: { rawText, defaultProtocol },
    });
    notify(`Toplu import tamam (${json.count || 0})`);
    if ($('proxyBulkInput')) $('proxyBulkInput').value = '';
    await loadProxies();
  }

  async function deleteById(proxyId) {
    if (!proxyId) return;
    const ok = window.confirm('Bu proxy silinsin mi?');
    if (!ok) return;
    await apiJson(`/api/proxies/${encodeURIComponent(proxyId)}`, { method: 'DELETE' });
    await loadProxies();
    if (String($('proxyEditId')?.value || '') === String(proxyId)) resetForm();
  }

  async function restoreById(proxyId) {
    if (!proxyId) return;
    await apiJson(`/api/proxies/${encodeURIComponent(proxyId)}/restore`, { method: 'POST' });
    await loadProxies();
  }

  function bindEvents() {
    $('btnOpenProxyManager')?.addEventListener('click', async () => {
      openModal();
      try {
        await loadProxies();
      } catch (e) {
        alert(e?.message || String(e));
      }
    });
    $('btnCloseProxyModal')?.addEventListener('click', () => closeModal());
    $('proxyModalBackdrop')?.addEventListener('click', () => closeModal());
    $('btnProxyModalDone')?.addEventListener('click', () => closeModal());

    $('btnProxyTabActive')?.addEventListener('click', () => {
      state.tab = 'active';
      renderAll();
    });
    $('btnProxyTabBlacklisted')?.addEventListener('click', () => {
      state.tab = 'blacklisted';
      renderAll();
    });

    $('btnRefreshProxies')?.addEventListener('click', async () => {
      try { await loadProxies(); } catch (e) { alert(e?.message || String(e)); }
    });

    $('btnSaveProxy')?.addEventListener('click', async () => {
      try { await saveProxy(); } catch (e) { alert(e?.message || String(e)); }
    });

    $('btnDeleteProxy')?.addEventListener('click', async () => {
      try { await deleteSelectedProxy(); } catch (e) { alert(e?.message || String(e)); }
    });

    $('btnResetProxy')?.addEventListener('click', () => resetForm());

    $('btnImportProxyBulk')?.addEventListener('click', async () => {
      try { await importBulk(); } catch (e) { alert(e?.message || String(e)); }
    });

    $('proxyList')?.addEventListener('click', async (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
      if (!target) return;
      const action = String(target.getAttribute('data-action') || '').trim();
      const proxyId = String(target.getAttribute('data-proxy-id') || '').trim();
      if (!proxyId) return;
      try {
        if (action === 'edit') fillForm(proxyId);
        if (action === 'delete') await deleteById(proxyId);
        if (action === 'restore') await restoreById(proxyId);
      } catch (e) {
        alert(e?.message || String(e));
      }
    });
  }

  bindEvents();
  resetForm();
})();
