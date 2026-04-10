/**
 * Aynı run içinde paralel A hesapları hangi kategoriye "girdi" (slot claim) — tek bilet (ticketCount===1)
 * ve birden fazla kategori seçiliyken aynı kategoriye yığılmayı azaltır. Tek iş parçacığında atomik sayım.
 */

const loadsByRun = new Map();

function ensureRunMap(runId) {
  const id = String(runId || '').trim();
  if (!id) return null;
  if (!loadsByRun.has(id)) loadsByRun.set(id, new Map());
  return loadsByRun.get(id);
}

/**
 * Aynı Passo kategorisini temsil eden iki panel satırı (farklı label, aynı type) tek slot’ta birleşsin.
 */
function slotKeyFromCategory(chosen) {
  if (!chosen || typeof chosen !== 'object') return '';
  const id = String(chosen.id || '').trim();
  if (id) return `id:${id}`;
  const svg = String(chosen.svgBlockId || '').trim();
  if (svg) return `svg:${svg.slice(0, 64)}`;
  const ct = String(chosen.categoryType || '').trim().toLowerCase().slice(0, 160);
  const ac = String(chosen.alternativeCategory || '').trim().toLowerCase().slice(0, 160);
  return `t:${ct}|a:${ac}`;
}

function getLoad(runId, key) {
  const m = loadsByRun.get(String(runId || '').trim());
  if (!m || !key) return 0;
  return m.get(key) || 0;
}

function adjustLoad(runId, key, delta) {
  const m = ensureRunMap(runId);
  if (!m || !key) return;
  const n = Math.max(0, (m.get(key) || 0) + delta);
  if (n <= 0) m.delete(key);
  else m.set(key, n);
}

function removeRun(runId) {
  loadsByRun.delete(String(runId || '').trim());
}

/** Kategori seçildi (yük id:t…); blok belli olunca aynı run’da anahtarı bloklu anahtara taşı — aynı kategoride farklı bloklara dağılım. */
function migrateKey(runId, fromKey, toKey) {
  const m = ensureRunMap(runId);
  if (!m || !fromKey || !toKey || fromKey === toKey) return;
  const n = m.get(fromKey) || 0;
  if (n <= 0) return;
  adjustLoad(runId, fromKey, -1);
  adjustLoad(runId, toKey, 1);
}

module.exports = {
  slotKeyFromCategory,
  getLoad,
  adjustLoad,
  removeRun,
  migrateKey
};
