const { ObjectId } = require('mongodb');
const { getCollection } = require('../db/mongo');
const { shouldSkipProxyBlacklistStreak } = require('../utils/proxyLoginFailure');

const COLLECTION = 'proxies';
const BLACKLIST_MS = 24 * 60 * 60 * 1000;
const FAILURE_THRESHOLD = 3;

function proxies() {
  return getCollection(COLLECTION);
}

function toObjectId(id) {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
}

function normalizeProtocol(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['http', 'https', 'socks4', 'socks5'].includes(raw)) return raw;
  return 'socks5';
}

/** Havuzdan atanabilir proxy'ler (aktif, blacklist dışı, host+port geçerli) — acquire ile aynı kriter. */
function assignableProxyFilterAt(nowIso) {
  return {
    isActive: { $ne: false },
    host: { $exists: true, $nin: [null, ''] },
    port: { $exists: true, $nin: [null, 0] },
    $or: [
      { blacklistUntil: null },
      { blacklistUntil: { $exists: false } },
      { blacklistUntil: '' },
      { blacklistUntil: { $lte: nowIso } },
    ],
  };
}

function mapProxy(doc) {
  if (!doc) return null;
  const until = doc.blacklistUntil ? String(doc.blacklistUntil) : null;
  const now = Date.now();
  const untilMs = until ? Date.parse(until) : NaN;
  const isBlacklisted = Number.isFinite(untilMs) && untilMs > now;

  return {
    id: String(doc._id),
    host: String(doc.host || ''),
    port: Number(doc.port) || 0,
    protocol: normalizeProtocol(doc.protocol),
    username: doc.username ? String(doc.username) : '',
    password: doc.password ? String(doc.password) : '',
    isActive: doc.isActive !== false,
    failCount: Number(doc.failCount) || 0,
    successCount: Number(doc.successCount) || 0,
    consecutiveLoginFailures: Number(doc.consecutiveLoginFailures) || 0,
    lastUsedAt: doc.lastUsedAt || null,
    lastSuccessAt: doc.lastSuccessAt || null,
    lastFailureAt: doc.lastFailureAt || null,
    blacklistUntil: until,
    blacklistReason: doc.blacklistReason ? String(doc.blacklistReason) : '',
    isBlacklisted,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

function identityFilter(payload) {
  return {
    host: String(payload.host || '').trim(),
    port: Number(payload.port) || 0,
    protocol: normalizeProtocol(payload.protocol),
    username: payload.username ? String(payload.username).trim() : '',
  };
}

async function listProxies(options = {}) {
  const docs = await proxies().find({}).sort({ host: 1, port: 1 }).toArray();
  let items = docs.map(mapProxy);
  if (!options.includeInactive) {
    items = items.filter((item) => item.isActive !== false);
  }
  if (!options.includeBlacklisted) {
    items = items.filter((item) => !item.isBlacklisted);
  }
  return items;
}

async function getProxyById(id) {
  const oid = toObjectId(id);
  if (!oid) return null;
  const doc = await proxies().findOne({ _id: oid });
  return mapProxy(doc);
}

async function createProxy(payload) {
  const now = new Date().toISOString();
  const doc = {
    host: String(payload.host || '').trim(),
    port: Number(payload.port) || 0,
    protocol: normalizeProtocol(payload.protocol),
    username: payload.username ? String(payload.username).trim() : '',
    password: payload.password ? String(payload.password).trim() : '',
    isActive: payload.isActive !== false,
    failCount: 0,
    successCount: 0,
    consecutiveLoginFailures: 0,
    lastUsedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    blacklistUntil: null,
    blacklistReason: '',
    createdAt: now,
    updatedAt: now,
  };

  const same = await proxies().findOne(identityFilter(doc));
  if (same) {
    const next = {
      ...doc,
      failCount: same.failCount || 0,
      successCount: same.successCount || 0,
      consecutiveLoginFailures: same.consecutiveLoginFailures || 0,
      lastUsedAt: same.lastUsedAt || null,
      lastSuccessAt: same.lastSuccessAt || null,
      lastFailureAt: same.lastFailureAt || null,
      blacklistUntil: same.blacklistUntil || null,
      blacklistReason: same.blacklistReason || '',
      createdAt: same.createdAt || now,
      updatedAt: now,
    };
    await proxies().updateOne({ _id: same._id }, { $set: next });
    return mapProxy({ ...same, ...next });
  }

  const result = await proxies().insertOne(doc);
  return mapProxy({ ...doc, _id: result.insertedId });
}

async function importProxies(items) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  for (const item of list) {
    if (!item || !item.host || !item.port) continue;
    const created = await createProxy(item);
    out.push(created);
  }
  return out;
}

async function updateProxy(id, payload) {
  const oid = toObjectId(id);
  if (!oid) return null;
  const existing = await proxies().findOne({ _id: oid });
  if (!existing) return null;

  const next = {
    host: payload.host !== undefined ? String(payload.host || '').trim() : String(existing.host || ''),
    port: payload.port !== undefined ? Number(payload.port) || 0 : Number(existing.port) || 0,
    protocol: payload.protocol !== undefined ? normalizeProtocol(payload.protocol) : normalizeProtocol(existing.protocol),
    username: payload.username !== undefined ? String(payload.username || '').trim() : String(existing.username || ''),
    password: payload.password !== undefined ? String(payload.password || '').trim() : String(existing.password || ''),
    isActive: payload.isActive !== undefined ? payload.isActive !== false : existing.isActive !== false,
    updatedAt: new Date().toISOString(),
  };

  await proxies().updateOne({ _id: oid }, { $set: next });
  return mapProxy({ ...existing, ...next });
}

async function deleteProxy(id) {
  const oid = toObjectId(id);
  if (!oid) return false;
  const result = await proxies().deleteOne({ _id: oid });
  return result.deletedCount > 0;
}

async function restoreProxy(id) {
  const oid = toObjectId(id);
  if (!oid) return null;
  const existing = await proxies().findOne({ _id: oid });
  if (!existing) return null;
  const next = {
    blacklistUntil: null,
    blacklistReason: '',
    consecutiveLoginFailures: 0,
    updatedAt: new Date().toISOString(),
  };
  await proxies().updateOne({ _id: oid }, { $set: next });
  return mapProxy({ ...existing, ...next });
}

async function countAssignableProxies() {
  const nowIso = new Date().toISOString();
  try {
    return await proxies().countDocuments(assignableProxyFilterAt(nowIso));
  } catch {
    return 0;
  }
}

async function acquireNextActiveProxy() {
  const nowIso = new Date().toISOString();
  const now = Date.now();

  // Atomik seçim: paralel tarayıcı açılışlarında aynı proxy'nin iki kez verilmesini önler.
  const filter = assignableProxyFilterAt(nowIso);

  const update = {
    $set: {
      lastUsedAt: nowIso,
      updatedAt: nowIso,
    },
  };

  let doc = null;
  try {
    doc = await proxies().findOneAndUpdate(filter, update, {
      sort: { lastUsedAt: 1, _id: 1 },
      returnDocument: 'after',
    });
  } catch (e) {
    // Eski MongoDB sürümlerinde findOneAndUpdate+sort desteklenmeyebilir; okuma+yazmaya düş.
    try {
      const docs = await proxies().find({ isActive: { $ne: false } }).toArray();
      const candidates = docs
        .map(mapProxy)
        .filter((item) => {
          if (!item) return false;
          if (item.isBlacklisted) return false;
          return item.host && item.port;
        })
        .sort((a, b) => {
          const aT = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
          const bT = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
          if (aT !== bT) return aT - bT;
          return String(a.id).localeCompare(String(b.id));
        });
      const picked = candidates[0] || null;
      if (!picked) return null;
      const oid = toObjectId(picked.id);
      if (oid) {
        await proxies().updateOne({ _id: oid }, { $set: { lastUsedAt: nowIso, updatedAt: nowIso } });
      }
      return { ...picked, pickedAt: now, lastUsedAt: nowIso };
    } catch {
      throw e;
    }
  }

  if (!doc) return null;
  const mapped = mapProxy(doc);
  if (!mapped || !mapped.host || !mapped.port || mapped.isBlacklisted) return null;
  return { ...mapped, pickedAt: now, lastUsedAt: nowIso };
}

async function markLoginSuccess(id) {
  const oid = toObjectId(id);
  if (!oid) return null;
  const now = new Date().toISOString();
  const existing = await proxies().findOne({ _id: oid });
  if (!existing) return null;

  const next = {
    successCount: (Number(existing.successCount) || 0) + 1,
    consecutiveLoginFailures: 0,
    lastSuccessAt: now,
    updatedAt: now,
  };

  await proxies().updateOne({ _id: oid }, { $set: next });
  return mapProxy({ ...existing, ...next });
}

async function markLoginFailure(id, options = {}) {
  const oid = toObjectId(id);
  if (!oid) return null;
  const now = new Date();
  const nowIso = now.toISOString();
  const existing = await proxies().findOne({ _id: oid });
  if (!existing) return null;

  const soft = options.soft === true;
  const threshold = Math.max(1, Number(options.threshold) || FAILURE_THRESHOLD);
  const failCount = (Number(existing.failCount) || 0) + 1;
  const prevConsecutive = Number(existing.consecutiveLoginFailures) || 0;
  const skipStreak =
    options.skipBlacklistStreak === true || shouldSkipProxyBlacklistStreak(options.reason || '');
  const consecutive = skipStreak ? prevConsecutive : prevConsecutive + 1;

  const next = {
    failCount,
    consecutiveLoginFailures: consecutive,
    lastFailureAt: nowIso,
    updatedAt: nowIso,
  };

  if (consecutive >= threshold) {
    const until = new Date(now.getTime() + BLACKLIST_MS).toISOString();
    next.blacklistUntil = until;
    next.blacklistReason = options.reason ? String(options.reason).slice(0, 500) : 'login_failure_threshold';
    next.consecutiveLoginFailures = 0;
  }

  await proxies().updateOne({ _id: oid }, { $set: next });
  return mapProxy({ ...existing, ...next });
}

module.exports = {
  acquireNextActiveProxy,
  countAssignableProxies,
  createProxy,
  deleteProxy,
  getProxyById,
  importProxies,
  listProxies,
  markLoginFailure,
  markLoginSuccess,
  restoreProxy,
  updateProxy,
};
