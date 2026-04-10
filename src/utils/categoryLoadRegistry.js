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

function slotKeyFromCategory(chosen) {
  if (!chosen || typeof chosen !== 'object') return '';
  const id = String(chosen.id || '').trim();
  if (id) return `id:${id}`;
  const ct = String(chosen.categoryType || '').trim().slice(0, 120);
  const ac = String(chosen.alternativeCategory || '').trim().slice(0, 120);
  const lb = String(chosen.label || '').trim().slice(0, 120);
  const svg = String(chosen.svgBlockId || '').trim();
  const core = ct || lb || 'cat';
  const alt = ac ? `|alt:${ac}` : '';
  const svgPart = svg ? `|svg:${svg.slice(0, 48)}` : '';
  return `t:${core}${alt}${svgPart}`;
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

module.exports = {
  slotKeyFromCategory,
  getLoad,
  adjustLoad,
  removeRun
};
