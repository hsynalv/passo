const { ObjectId } = require('mongodb');
const { getCollection } = require('../db/mongo');

const COLLECTION = 'team_event_block_maps';
const LIVE_RUN_COLLECTION = 'scan_map_live_runs';
let ensureIndexesPromise = null;
let ensureLiveRunIndexesPromise = null;

function mappings() {
  return getCollection(COLLECTION);
}

function liveRuns() {
  return getCollection(LIVE_RUN_COLLECTION);
}

function toObjectId(id) {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
}

function normalizeScopeType(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === 'team' ? 'team' : 'team_event';
}

function normalizeEventAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.hash = '';
    u.search = '';
    u.pathname = String(u.pathname || '').replace(/\/+$/, '');
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw.replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

function normalizeCategoryLabel(value) {
  return String(value || '').trim();
}

function safeString(v) {
  return String(v == null ? '' : v).trim();
}

function safeIso(v) {
  const s = safeString(v);
  if (!s) return new Date().toISOString();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function sanitizeLiveScanLog(entry = {}) {
  const meta = entry?.meta && typeof entry.meta === 'object' ? entry.meta : {};
  return {
    at: safeIso(entry?.at),
    level: safeString(entry?.level || 'info') || 'info',
    message: safeString(entry?.message),
    meta,
  };
}

function mapLiveRun(doc) {
  if (!doc) return null;
  return {
    runId: safeString(doc.runId),
    status: safeString(doc.status || 'running') || 'running',
    payload: doc.payload && typeof doc.payload === 'object' ? doc.payload : {},
    logs: Array.isArray(doc.logs) ? doc.logs.map((item) => sanitizeLiveScanLog(item)).slice(-600) : [],
    result: doc.result || null,
    error: doc.error || null,
    logFilePath: safeString(doc.logFilePath),
    createdAt: safeIso(doc.createdAt),
    updatedAt: safeIso(doc.updatedAt),
  };
}

function mapMapping(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    teamId: String(doc.teamId || ''),
    eventAddress: String(doc.eventAddress || ''),
    scopeType: normalizeScopeType(doc.scopeType),
    categoryLabel: String(doc.categoryLabel || ''),
    tooltipText: String(doc.tooltipText || ''),
    legendTitle: String(doc.legendTitle || ''),
    blockId: String(doc.blockId || ''),
    confidence: Number.isFinite(Number(doc.confidence)) ? Number(doc.confidence) : 0,
    scoreMeta: doc.scoreMeta && typeof doc.scoreMeta === 'object' ? doc.scoreMeta : {},
    isDefault: doc.isDefault === true,
    isActive: doc.isActive !== false,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
    lastSeenAt: doc.lastSeenAt || null,
  };
}

async function ensureIndexes() {
  if (ensureIndexesPromise) return ensureIndexesPromise;
  ensureIndexesPromise = (async () => {
    const col = mappings();
    await Promise.all([
      col.createIndex({ teamId: 1, eventAddress: 1, scopeType: 1, categoryLabel: 1, isDefault: 1 }),
      col.createIndex({ teamId: 1, eventAddress: 1, scopeType: 1, blockId: 1 }, { unique: true }),
      col.createIndex({ teamId: 1, updatedAt: -1 }),
    ]);
  })().catch((error) => {
    ensureIndexesPromise = null;
    throw error;
  });
  return ensureIndexesPromise;
}

async function ensureLiveRunIndexes() {
  if (ensureLiveRunIndexesPromise) return ensureLiveRunIndexesPromise;
  ensureLiveRunIndexesPromise = (async () => {
    const col = liveRuns();
    await Promise.all([
      col.createIndex({ runId: 1 }, { unique: true }),
      col.createIndex({ status: 1, updatedAt: -1 }),
      col.createIndex({ createdAt: -1 }),
    ]);
  })().catch((error) => {
    ensureLiveRunIndexesPromise = null;
    throw error;
  });
  return ensureLiveRunIndexesPromise;
}

function buildFilter(teamId, eventAddress = '', scopeType = 'team_event', includeInactive = false) {
  const scope = normalizeScopeType(scopeType);
  const filter = {
    teamId: String(teamId || '').trim(),
    scopeType: scope,
  };
  if (scope === 'team_event') filter.eventAddress = normalizeEventAddress(eventAddress);
  else filter.eventAddress = '';
  if (!includeInactive) filter.isActive = { $ne: false };
  return filter;
}

async function listMappingsByScope(teamId, eventAddress = '', scopeType = 'team_event', options = {}) {
  await ensureIndexes();
  const filter = buildFilter(teamId, eventAddress, scopeType, options.includeInactive === true);
  const docs = await mappings().find(filter).sort({ isDefault: -1, confidence: -1, updatedAt: -1 }).toArray();
  return docs.map(mapMapping);
}

async function upsertMapping(payload = {}) {
  await ensureIndexes();
  const now = new Date().toISOString();
  const scopeType = normalizeScopeType(payload.scopeType);
  const teamId = String(payload.teamId || '').trim();
  const eventAddress = scopeType === 'team_event' ? normalizeEventAddress(payload.eventAddress) : '';
  const blockId = String(payload.blockId || '').trim();
  if (!teamId || !blockId) return null;

  const filter = { teamId, eventAddress, scopeType, blockId };
  const existing = await mappings().findOne(filter);
  const next = {
    teamId,
    eventAddress,
    scopeType,
    categoryLabel: normalizeCategoryLabel(payload.categoryLabel),
    tooltipText: String(payload.tooltipText || '').trim(),
    legendTitle: String(payload.legendTitle || '').trim(),
    blockId,
    confidence: Number.isFinite(Number(payload.confidence)) ? Math.max(0, Math.min(100, Number(payload.confidence))) : 0,
    scoreMeta: payload.scoreMeta && typeof payload.scoreMeta === 'object' ? payload.scoreMeta : {},
    isDefault: payload.isDefault === true,
    isActive: payload.isActive !== false,
    lastSeenAt: payload.lastSeenAt || now,
    updatedAt: now,
  };

  if (existing) {
    await mappings().updateOne({ _id: existing._id }, { $set: next });
    return mapMapping({ ...existing, ...next });
  }

  const doc = { ...next, createdAt: now };
  const result = await mappings().insertOne(doc);
  return mapMapping({ ...doc, _id: result.insertedId });
}

async function saveMappings(teamId, eventAddress = '', scopeType = 'team_event', items = []) {
  await ensureIndexes();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const saved = await upsertMapping({ ...item, teamId, eventAddress, scopeType });
    if (saved) out.push(saved);
  }
  return out;
}

async function setDefaultMapping(teamId, eventAddress = '', scopeType = 'team_event', categoryLabel = '', mappingId = '') {
  await ensureIndexes();
  const scope = normalizeScopeType(scopeType);
  const normalizedEvent = scope === 'team_event' ? normalizeEventAddress(eventAddress) : '';
  const normalizedCategoryLabel = normalizeCategoryLabel(categoryLabel);
  const oid = toObjectId(mappingId);
  if (!oid) return null;

  const baseFilter = {
    teamId: String(teamId || '').trim(),
    eventAddress: normalizedEvent,
    scopeType: scope,
    categoryLabel: normalizedCategoryLabel,
  };
  await mappings().updateMany(baseFilter, { $set: { isDefault: false, updatedAt: new Date().toISOString() } });
  const result = await mappings().findOneAndUpdate(
    { ...baseFilter, _id: oid },
    { $set: { isDefault: true, isActive: true, updatedAt: new Date().toISOString() } },
    { returnDocument: 'after' }
  );
  return mapMapping(result || null);
}

async function deleteMapping(mappingId) {
  await ensureIndexes();
  const oid = toObjectId(mappingId);
  if (!oid) return false;
  const result = await mappings().deleteOne({ _id: oid });
  return result.deletedCount > 0;
}

async function clearMappings(teamId, eventAddress = '', scopeType = 'team_event') {
  await ensureIndexes();
  const filter = buildFilter(teamId, eventAddress, scopeType, true);
  const result = await mappings().deleteMany(filter);
  return result.deletedCount || 0;
}

async function upsertLiveScanRun(run = {}) {
  await ensureLiveRunIndexes();
  const rid = safeString(run.runId);
  if (!rid) return null;
  const now = new Date().toISOString();
  const payload = run.payload && typeof run.payload === 'object' ? run.payload : {};
  const logs = Array.isArray(run.logs) ? run.logs.map((item) => sanitizeLiveScanLog(item)).slice(-600) : [];
  const set = {
    runId: rid,
    status: safeString(run.status || 'running') || 'running',
    payload,
    logs,
    result: run.result || null,
    error: run.error || null,
    logFilePath: safeString(run.logFilePath),
    updatedAt: safeIso(run.updatedAt || now),
  };
  const setOnInsert = {
    createdAt: safeIso(run.createdAt || now),
  };
  const result = await liveRuns().findOneAndUpdate(
    { runId: rid },
    { $set: set, $setOnInsert: setOnInsert },
    { upsert: true, returnDocument: 'after' }
  );
  return mapLiveRun(result || null);
}

async function appendLiveScanLog(runId, entry = {}, statusPatch = null) {
  await ensureLiveRunIndexes();
  const rid = safeString(runId);
  if (!rid) return null;
  const sanitized = sanitizeLiveScanLog(entry);
  const nextStatus = statusPatch && typeof statusPatch === 'object' ? statusPatch : null;
  const now = new Date().toISOString();
  const update = {
    $setOnInsert: {
      runId: rid,
      status: 'running',
      payload: {},
      result: null,
      error: null,
      createdAt: now,
    },
    $set: {
      updatedAt: now,
      ...(nextStatus || {}),
    },
    $push: {
      logs: {
        $each: [sanitized],
        $slice: -600,
      },
    },
  };
  const result = await liveRuns().findOneAndUpdate(
    { runId: rid },
    update,
    { upsert: true, returnDocument: 'after' }
  );
  return mapLiveRun(result || null);
}

async function getLiveScanRun(runId) {
  await ensureLiveRunIndexes();
  const rid = safeString(runId);
  if (!rid) return null;
  const doc = await liveRuns().findOne({ runId: rid });
  return mapLiveRun(doc);
}

module.exports = {
  appendLiveScanLog,
  clearMappings,
  deleteMapping,
  getLiveScanRun,
  listMappingsByScope,
  normalizeEventAddress,
  saveMappings,
  setDefaultMapping,
  upsertLiveScanRun,
  upsertMapping,
};
