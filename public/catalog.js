(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    teams: [],
    selectedTeamId: '',
    teamSearch: '',
    categories: [],
    credentials: [],
    selectedCategoryIds: [],
    aCredentialIds: [],
    bCredentialIds: [],
  };

  let notify = (msg, meta) => {
    try {
      console.log('[catalog]', msg, meta || '');
    } catch {}
  };

  function currentTeam() {
    return state.teams.find((item) => String(item.id) === String(state.selectedTeamId)) || null;
  }

  function filteredTeams() {
    const q = String(state.teamSearch || '').trim().toLowerCase();
    if (!q) return state.teams.slice();
    return state.teams.filter((item) => {
      const hay = `${item.name || ''} ${item.slug || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  function setNotifier(fn) {
    if (typeof fn === 'function') notify = fn;
  }

  function openModal() {
    const root = $('catalogModal');
    if (root) root.hidden = false;
  }

  function closeModal() {
    const root = $('catalogModal');
    if (root) root.hidden = true;
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
    if (!resp.ok) {
      throw new Error(json.error || json.message || `HTTP_${resp.status}`);
    }
    return json;
  }

  function syncSelectedCategoriesFromDom() {
    const root = $('teamCategoryList');
    if (!root) return;
    const values = Array.from(root.querySelectorAll('input[type="checkbox"][data-category-id]:checked'))
      .map((el) => String(el.value || '').trim())
      .filter(Boolean);
    state.selectedCategoryIds = values;
  }

  function syncSelectedCredentialIdsFromDom() {
    const getValues = (el) => {
      if (!el) return [];
      return Array.from(el.querySelectorAll('input[type="checkbox"][data-credential-id]:checked'))
        .map((input) => String(input.value || '').trim())
        .filter(Boolean);
    };
    state.aCredentialIds = getValues($('aCredentialList'));
    state.bCredentialIds = getValues($('bCredentialList'));
  }

  function renderTeamOptions() {
    const teamSelect = $('teamSelect');
    if (!teamSelect) return;
    const prev = String(state.selectedTeamId || '');
    teamSelect.innerHTML = '<option value="">Takım seç</option>';
    for (const team of state.teams) {
      const opt = document.createElement('option');
      opt.value = team.id;
      opt.textContent = team.isActive === false ? `${team.name} (pasif)` : team.name;
      teamSelect.appendChild(opt);
    }
    teamSelect.value = state.teams.some((item) => item.id === prev) ? prev : '';
    state.selectedTeamId = String(teamSelect.value || '');
    syncTeamForm();
  }

  function renderManageTeamList() {
    const root = $('manageTeamList');
    if (!root) return;
    root.textContent = '';
    const teams = filteredTeams();
    if (!state.teams.length) {
      root.innerHTML = '<div class="itemListEmpty">Henüz takım yok. Soldaki formdan ilk takımı ekle.</div>';
      return;
    }
    if (!teams.length) {
      root.innerHTML = '<div class="itemListEmpty">Aramaya uyan takım bulunamadı.</div>';
      return;
    }
    for (const item of teams) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'teamListItem' + (String(item.id) === String(state.selectedTeamId) ? ' active' : '');
      row.dataset.teamId = item.id;
      row.innerHTML = `<div class="teamListMeta">
        <strong>${escapeHtml(item.name || 'Takım')}</strong>
        <span>${escapeHtml(item.slug || '')}</span>
      </div>`;
      root.appendChild(row);
    }
  }

  function renderCategoryChecklist() {
    const root = $('teamCategoryList');
    if (!root) return;
    root.textContent = '';
    if (!state.selectedTeamId) {
      root.innerHTML = '<div class="checkListEmpty">Önce takım seç.</div>';
      return;
    }
    const activeCategories = state.categories.filter((item) => item.isActive !== false);
    if (!activeCategories.length) {
      root.innerHTML = '<div class="checkListEmpty">Bu takım için kayıtlı aktif kategori yok.</div>';
      return;
    }
    for (const item of activeCategories) {
      const wrap = document.createElement('label');
      wrap.className = 'checkItem';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = item.id;
      input.dataset.categoryId = item.id;
      input.checked = state.selectedCategoryIds.includes(item.id);
      input.addEventListener('change', () => syncSelectedCategoriesFromDom());
      const meta = document.createElement('div');
      meta.className = 'checkItemMeta';
      const title = document.createElement('strong');
      title.textContent = item.label || item.categoryTypeValue || 'Kategori';
      const sub = document.createElement('span');
      const bits = [
        item.categoryTypeValue ? `değer: ${item.categoryTypeValue}` : '',
        item.alternativeCategoryValue ? `alt: ${item.alternativeCategoryValue}` : '',
        item.selectionModeHint ? `mod: ${item.selectionModeHint}` : '',
      ].filter(Boolean);
      sub.textContent = bits.join(' • ') || 'Tanım yok';
      meta.appendChild(title);
      meta.appendChild(sub);
      wrap.appendChild(input);
      wrap.appendChild(meta);
      root.appendChild(wrap);
    }
  }

  function fillCredentialList(rootEl, selectedIds, roleLabel) {
    if (!rootEl) return;
    rootEl.textContent = '';
    if (!state.selectedTeamId) {
      rootEl.innerHTML = '<div class="checkListEmpty">Önce takım seç.</div>';
      return;
    }
    const activeCredentials = state.credentials.filter((item) => item.isActive !== false);
    if (!activeCredentials.length) {
      rootEl.innerHTML = '<div class="checkListEmpty">Kayıtlı üyelik yok.</div>';
      return;
    }
    for (const item of activeCredentials) {
      const wrap = document.createElement('label');
      wrap.className = 'credentialPickItem';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = item.id;
      input.dataset.credentialId = item.id;
      input.checked = selectedIds.includes(item.id);
      input.addEventListener('change', () => syncSelectedCredentialIdsFromDom());

      const meta = document.createElement('div');
      meta.className = 'credentialPickMeta';
      meta.innerHTML = `<strong>${escapeHtml(item.email || `${roleLabel} üyeliği`)}</strong>
        <span>TCKN: ${escapeHtml(item.identity || '—')} • Fan Card: ${escapeHtml(item.fanCardCode || '—')}</span>`;

      wrap.appendChild(input);
      wrap.appendChild(meta);
      rootEl.appendChild(wrap);
    }
  }

  function renderCredentialPickers() {
    fillCredentialList($('aCredentialList'), state.aCredentialIds, 'A');
    fillCredentialList($('bCredentialList'), state.bCredentialIds, 'B');
    const aCountEl = $('aCredentialCount');
    const bCountEl = $('bCredentialCount');
    if (aCountEl) aCountEl.textContent = `${state.aCredentialIds.length} secili`;
    if (bCountEl) bCountEl.textContent = `${state.bCredentialIds.length} secili`;
  }

  function syncTeamForm() {
    const team = currentTeam();
    const nameEl = $('teamNameInput');
    if (nameEl) nameEl.value = team ? String(team.name || '') : '';
    const deleteBtn = $('btnDeleteTeam');
    if (deleteBtn) deleteBtn.disabled = !team;
  }

  function renderManagerSummary() {
    const root = $('managerTeamSummary');
    const content = $('managerContent');
    if (!root) return;
    const team = currentTeam();
    if (!team) {
      if (content) content.classList.add('disabled');
      root.innerHTML = '<strong>Takım seçilmedi</strong><span>Soldan bir takım seçmeden kategori ve üyelik yönetimi yapılamaz.</span>';
      return;
    }
    if (content) content.classList.remove('disabled');
    const categoryCount = state.categories.length;
    const credentialCount = state.credentials.length;
    root.innerHTML = `<strong>Seçili takım: ${escapeHtml(team.name || '')}</strong>
      <span>${escapeHtml(team.slug || '')} • ${categoryCount} kategori • ${credentialCount} üyelik</span>`;
  }

  function resetCategoryForm() {
    $('categoryEditId').value = '';
    $('categoryLabelInput').value = '';
    $('categoryValueInput').value = '';
    $('categoryAltInput').value = '';
    $('categoryModeInput').value = '';
    $('categorySortInput').value = '0';
  }

  function resetCredentialForm() {
    $('credentialEditId').value = '';
    $('credentialEmailInput').value = '';
    $('credentialPasswordInput').value = '';
    $('credentialIdentityInput').value = '';
    $('credentialFanCardInput').value = '';
  }

  function renderManageCategoryList() {
    const root = $('manageCategoryList');
    if (!root) return;
    root.textContent = '';
    if (!state.selectedTeamId) {
      root.innerHTML = '<div class="itemListEmpty">Önce takım seç.</div>';
      return;
    }
    const all = state.categories.slice().sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
    if (!all.length) {
      root.innerHTML = '<div class="itemListEmpty">Kategori yok.</div>';
      return;
    }
    const editingId = String($('categoryEditId').value || '');
    for (const item of all) {
      const row = document.createElement('div');
      row.className = 'itemCard' + (editingId === item.id ? ' active' : '');
      const meta = document.createElement('div');
      meta.innerHTML = `<strong>${escapeHtml(item.label || item.categoryTypeValue || 'Kategori')}</strong>
        <div class="itemCardMeta">değer: ${escapeHtml(item.categoryTypeValue || '')}<br>alt: ${escapeHtml(item.alternativeCategoryValue || '—')}<br>mod: ${escapeHtml(item.selectionModeHint || 'varsayılan')} • sıra: ${escapeHtml(String(item.sortOrder ?? 0))}</div>`;
      const actions = document.createElement('div');
      actions.className = 'itemCardActions';
      actions.innerHTML = `<button type="button" data-action="edit" data-category-id="${escapeHtml(item.id)}" class="btnMuted">Düzenle</button>
        <button type="button" data-action="delete" data-category-id="${escapeHtml(item.id)}" class="btnDanger">Sil</button>`;
      row.appendChild(meta);
      row.appendChild(actions);
      root.appendChild(row);
    }
  }

  function renderManageCredentialList() {
    const root = $('manageCredentialList');
    if (!root) return;
    root.textContent = '';
    if (!state.selectedTeamId) {
      root.innerHTML = '<div class="itemListEmpty">Önce takım seç.</div>';
      return;
    }
    if (!state.credentials.length) {
      root.innerHTML = '<div class="itemListEmpty">Üyelik yok.</div>';
      return;
    }
    const editingId = String($('credentialEditId').value || '');
    for (const item of state.credentials) {
      const row = document.createElement('div');
      row.className = 'itemCard' + (editingId === item.id ? ' active' : '');
      const meta = document.createElement('div');
      meta.innerHTML = `<strong>${escapeHtml(item.email || '')}</strong>
        <div class="itemCardMeta">TCKN: ${escapeHtml(item.identity || '—')}<br>Fan Card: ${escapeHtml(item.fanCardCode || '—')}</div>`;
      const actions = document.createElement('div');
      actions.className = 'itemCardActions';
      actions.innerHTML = `<button type="button" data-action="edit" data-credential-id="${escapeHtml(item.id)}" class="btnMuted">Düzenle</button>
        <button type="button" data-action="delete" data-credential-id="${escapeHtml(item.id)}" class="btnDanger">Sil</button>`;
      row.appendChild(meta);
      row.appendChild(actions);
      root.appendChild(row);
    }
  }

  function renderAll() {
    renderTeamOptions();
    renderManageTeamList();
    renderManagerSummary();
    renderCategoryChecklist();
    renderCredentialPickers();
    renderManageCategoryList();
    renderManageCredentialList();
  }

  async function loadTeams(options = {}) {
    const keepSelection = options.keepSelection !== false;
    const nextSelected = options.selectedTeamId !== undefined
      ? String(options.selectedTeamId || '')
      : (keepSelection ? String(state.selectedTeamId || '') : '');
    const json = await apiJson('/api/teams');
    state.teams = Array.isArray(json.teams) ? json.teams : [];
    if (state.teams.some((item) => item.id === nextSelected)) {
      state.selectedTeamId = nextSelected;
    } else {
      state.selectedTeamId = state.teams[0] ? String(state.teams[0].id || '') : '';
    }
    renderTeamOptions();
    if (state.selectedTeamId) {
      await loadSelectedTeamData();
    } else {
      state.categories = [];
      state.credentials = [];
      state.selectedCategoryIds = [];
      state.aCredentialIds = [];
      state.bCredentialIds = [];
      renderManageTeamList();
      renderManagerSummary();
      renderCategoryChecklist();
      renderCredentialPickers();
      renderManageCategoryList();
      renderManageCredentialList();
    }
  }

  async function loadSelectedTeamData() {
    if (!state.selectedTeamId) {
      state.categories = [];
      state.credentials = [];
      resetCategoryForm();
      resetCredentialForm();
      renderAll();
      return;
    }
    const [catJson, credJson] = await Promise.all([
      apiJson(`/api/teams/${encodeURIComponent(state.selectedTeamId)}/categories?includeInactive=1`),
      apiJson(`/api/teams/${encodeURIComponent(state.selectedTeamId)}/credentials?includeInactive=1`),
    ]);
    state.categories = Array.isArray(catJson.categories) ? catJson.categories : [];
    state.credentials = Array.isArray(credJson.credentials) ? credJson.credentials : [];
    state.selectedCategoryIds = state.selectedCategoryIds.filter((id) => state.categories.some((item) => item.id === id && item.isActive !== false));
    state.aCredentialIds = state.aCredentialIds.filter((id) => state.credentials.some((item) => item.id === id && item.isActive !== false));
    state.bCredentialIds = state.bCredentialIds.filter((id) => state.credentials.some((item) => item.id === id && item.isActive !== false));
    renderManageTeamList();
    renderManagerSummary();
    renderCategoryChecklist();
    renderCredentialPickers();
    renderManageCategoryList();
    renderManageCredentialList();
  }

  function selectedCategoryIds() {
    syncSelectedCategoriesFromDom();
    return state.selectedCategoryIds.slice();
  }

  function selectedCredentialIds(role) {
    syncSelectedCredentialIdsFromDom();
    if (String(role || '').toUpperCase() === 'A') return state.aCredentialIds.slice();
    return state.bCredentialIds.slice();
  }

  function escapeHtml(input) {
    return String(input ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function handleCreateTeam() {
    const name = String($('teamNameInput').value || '').trim();
    if (!name) {
      notify('Takım adı zorunlu');
      return;
    }
    const json = await apiJson('/api/teams', {
      method: 'POST',
      body: { name, isActive: true },
    });
    notify('Takım kaydedildi', { team: json?.team?.name || name });
    await loadTeams({ selectedTeamId: json?.team?.id || '' });
  }

  async function handleUpdateTeam() {
    if (!state.selectedTeamId) {
      notify('Güncellemek için takım seç');
      return;
    }
    const name = String($('teamNameInput').value || '').trim();
    const json = await apiJson(`/api/teams/${encodeURIComponent(state.selectedTeamId)}`, {
      method: 'PUT',
      body: { name, isActive: true },
    });
    notify('Takım güncellendi', { team: json?.team?.name || name });
    await loadTeams({ selectedTeamId: state.selectedTeamId });
  }

  async function handleDeleteTeam() {
    const team = currentTeam();
    if (!team) {
      notify('Silmek için önce takım seç');
      return;
    }
    const ok = window.confirm(`"${team.name}" takımını ve bağlı tüm kategori/üyelikleri silmek istediğine emin misin?`);
    if (!ok) return;
    await apiJson(`/api/teams/${encodeURIComponent(team.id)}`, {
      method: 'DELETE',
    });
    notify('Takım silindi', { team: team.name });
    state.selectedTeamId = '';
    state.categories = [];
    state.credentials = [];
    state.selectedCategoryIds = [];
    state.aCredentialIds = [];
    state.bCredentialIds = [];
    resetCategoryForm();
    resetCredentialForm();
    await loadTeams({ keepSelection: false });
  }

  async function selectTeam(teamId) {
    state.selectedTeamId = String(teamId || '').trim();
    renderAll();
    try {
      await loadSelectedTeamData();
    } catch (error) {
      notify('Takım detayları yüklenemedi', { error: error?.message || String(error) });
    }
  }

  async function handleSaveCategory() {
    if (!state.selectedTeamId) {
      notify('Kategori için önce takım seç');
      return;
    }
    const payload = {
      label: String($('categoryLabelInput').value || '').trim(),
      categoryTypeValue: String($('categoryValueInput').value || '').trim(),
      alternativeCategoryValue: String($('categoryAltInput').value || '').trim(),
      selectionModeHint: String($('categoryModeInput').value || '').trim() || null,
      sortOrder: parseInt(String($('categorySortInput').value || '0').trim(), 10) || 0,
      isActive: true,
    };
    const editId = String($('categoryEditId').value || '').trim();
    if (editId) {
      await apiJson(`/api/teams/${encodeURIComponent(state.selectedTeamId)}/categories/${encodeURIComponent(editId)}`, {
        method: 'PUT',
        body: payload,
      });
      notify('Kategori güncellendi', { label: payload.label });
    } else {
      await apiJson(`/api/teams/${encodeURIComponent(state.selectedTeamId)}/categories`, {
        method: 'POST',
        body: payload,
      });
      notify('Kategori eklendi', { label: payload.label });
    }
    resetCategoryForm();
    await loadSelectedTeamData();
  }

  async function handleDeleteCategory(categoryId) {
    if (!state.selectedTeamId || !categoryId) return;
    await apiJson(`/api/teams/${encodeURIComponent(state.selectedTeamId)}/categories/${encodeURIComponent(categoryId)}`, {
      method: 'DELETE',
    });
    if (String($('categoryEditId').value || '') === String(categoryId)) resetCategoryForm();
    notify('Kategori silindi');
    await loadSelectedTeamData();
  }

  async function handleSaveCredential() {
    if (!state.selectedTeamId) {
      notify('Üyelik için önce takım seç');
      return;
    }
    const payload = {
      email: String($('credentialEmailInput').value || '').trim(),
      password: String($('credentialPasswordInput').value || '').trim(),
      identity: String($('credentialIdentityInput').value || '').trim(),
      fanCardCode: String($('credentialFanCardInput').value || '').trim(),
      isActive: true,
    };
    const editId = String($('credentialEditId').value || '').trim();
    if (editId) {
      if (!payload.password) delete payload.password;
      await apiJson(`/api/teams/${encodeURIComponent(state.selectedTeamId)}/credentials/${encodeURIComponent(editId)}`, {
        method: 'PUT',
        body: payload,
      });
      notify('Üyelik güncellendi', { email: payload.email });
    } else {
      await apiJson(`/api/teams/${encodeURIComponent(state.selectedTeamId)}/credentials`, {
        method: 'POST',
        body: payload,
      });
      notify('Üyelik eklendi', { email: payload.email });
    }
    resetCredentialForm();
    await loadSelectedTeamData();
  }

  async function handleDeleteCredential(credentialId) {
    if (!state.selectedTeamId || !credentialId) return;
    await apiJson(`/api/teams/${encodeURIComponent(state.selectedTeamId)}/credentials/${encodeURIComponent(credentialId)}`, {
      method: 'DELETE',
    });
    if (String($('credentialEditId').value || '') === String(credentialId)) resetCredentialForm();
    notify('Üyelik silindi');
    await loadSelectedTeamData();
  }

  function fillCategoryForm(categoryId) {
    const item = state.categories.find((row) => row.id === categoryId);
    if (!item) return;
    $('categoryEditId').value = item.id;
    $('categoryLabelInput').value = item.label || '';
    $('categoryValueInput').value = item.categoryTypeValue || '';
    $('categoryAltInput').value = item.alternativeCategoryValue || '';
    $('categoryModeInput').value = item.selectionModeHint || '';
    $('categorySortInput').value = String(item.sortOrder ?? 0);
    renderManageCategoryList();
  }

  function fillCredentialForm(credentialId) {
    const item = state.credentials.find((row) => row.id === credentialId);
    if (!item) return;
    $('credentialEditId').value = item.id;
    $('credentialEmailInput').value = item.email || '';
    $('credentialPasswordInput').value = '';
    $('credentialIdentityInput').value = item.identity || '';
    $('credentialFanCardInput').value = item.fanCardCode || '';
    renderManageCredentialList();
  }

  function bindEvents() {
    $('btnOpenCatalogManager')?.addEventListener('click', async () => {
      openModal();
      try {
        await loadTeams({ keepSelection: true });
      } catch (error) {
        notify('Takımlar yüklenemedi', { error: error?.message || String(error) });
      }
    });
    $('btnCloseCatalogModal')?.addEventListener('click', () => closeModal());
    $('catalogModalBackdrop')?.addEventListener('click', () => closeModal());
    $('btnCatalogModalDone')?.addEventListener('click', () => closeModal());
    $('teamSearchInput')?.addEventListener('input', (event) => {
      state.teamSearch = String(event.target.value || '');
      renderManageTeamList();
    });
    $('teamSelect')?.addEventListener('change', async (event) => {
      await selectTeam(event.target.value);
    });
    $('btnRefreshTeams')?.addEventListener('click', async () => {
      try {
        await loadTeams({ keepSelection: true });
        notify('Takımlar yenilendi');
      } catch (error) {
        notify('Takımlar yenilenemedi', { error: error?.message || String(error) });
      }
    });
    $('btnSelectAllCategories')?.addEventListener('click', () => {
      state.selectedCategoryIds = state.categories.filter((item) => item.isActive !== false).map((item) => item.id);
      renderCategoryChecklist();
    });
    $('btnClearCategories')?.addEventListener('click', () => {
      state.selectedCategoryIds = [];
      renderCategoryChecklist();
    });
    $('btnCreateTeam')?.addEventListener('click', async () => {
      try { await handleCreateTeam(); } catch (error) { notify('Takım kaydedilemedi', { error: error?.message || String(error) }); }
    });
    $('btnUpdateTeam')?.addEventListener('click', async () => {
      try { await handleUpdateTeam(); } catch (error) { notify('Takım güncellenemedi', { error: error?.message || String(error) }); }
    });
    $('btnDeleteTeam')?.addEventListener('click', async () => {
      try { await handleDeleteTeam(); } catch (error) { notify('Takım silinemedi', { error: error?.message || String(error) }); }
    });
    $('manageTeamList')?.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-team-id]');
      if (!button) return;
      const teamId = String(button.dataset.teamId || '').trim();
      if (!teamId || teamId === state.selectedTeamId) return;
      await selectTeam(teamId);
    });
    $('btnSaveCategory')?.addEventListener('click', async () => {
      try { await handleSaveCategory(); } catch (error) { notify('Kategori kaydedilemedi', { error: error?.message || String(error) }); }
    });
    $('btnDeleteCategory')?.addEventListener('click', async () => {
      const categoryId = String($('categoryEditId').value || '').trim();
      if (!categoryId) {
        notify('Silmek için önce bir kategori seç');
        return;
      }
      try { await handleDeleteCategory(categoryId); } catch (error) { notify('Kategori silinemedi', { error: error?.message || String(error) }); }
    });
    $('btnResetCategory')?.addEventListener('click', () => {
      resetCategoryForm();
      renderManageCategoryList();
    });
    $('manageCategoryList')?.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-category-id]');
      if (!button) return;
      const categoryId = String(button.dataset.categoryId || '').trim();
      if (!categoryId) return;
      if (button.dataset.action === 'edit') {
        fillCategoryForm(categoryId);
        return;
      }
      if (button.dataset.action === 'delete') {
        try { await handleDeleteCategory(categoryId); } catch (error) { notify('Kategori silinemedi', { error: error?.message || String(error) }); }
      }
    });
    $('btnSaveCredential')?.addEventListener('click', async () => {
      try { await handleSaveCredential(); } catch (error) { notify('Üyelik kaydedilemedi', { error: error?.message || String(error) }); }
    });
    $('btnDeleteCredential')?.addEventListener('click', async () => {
      const credentialId = String($('credentialEditId').value || '').trim();
      if (!credentialId) {
        notify('Silmek için önce bir üyelik seç');
        return;
      }
      try { await handleDeleteCredential(credentialId); } catch (error) { notify('Üyelik silinemedi', { error: error?.message || String(error) }); }
    });
    $('btnResetCredential')?.addEventListener('click', () => {
      resetCredentialForm();
      renderManageCredentialList();
    });
    $('manageCredentialList')?.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-credential-id]');
      if (!button) return;
      const credentialId = String(button.dataset.credentialId || '').trim();
      if (!credentialId) return;
      if (button.dataset.action === 'edit') {
        fillCredentialForm(credentialId);
        return;
      }
      if (button.dataset.action === 'delete') {
        try { await handleDeleteCredential(credentialId); } catch (error) { notify('Üyelik silinemedi', { error: error?.message || String(error) }); }
      }
    });
  }

  async function init() {
    bindEvents();
    resetCategoryForm();
    resetCredentialForm();
    try {
      await loadTeams({ keepSelection: false });
    } catch (error) {
      notify('Takım verileri yüklenemedi', { error: error?.message || String(error) });
    }
  }

  window.passobotCatalog = {
    getSelectedCategoryIds: selectedCategoryIds,
    getSelectedCredentialIds: selectedCredentialIds,
    getSelectedTeam() {
      const team = currentTeam();
      return team ? { id: team.id, name: team.name } : null;
    },
    init,
    loadTeams,
    openModal,
    setNotifier,
  };
})();
