const { ObjectId } = require('mongodb');
const { getCollection } = require('../db/mongo');
const { pushRecordUpdate } = require('../utils/orderRecordBus');

const COLLECTION = 'order_records';

let ensureIndexesPromise = null;

function orderRecords() {
  return getCollection(COLLECTION);
}

function toObjectId(id) {
  return new ObjectId(String(id));
}

function safeString(value) {
  return value == null ? '' : String(value);
}

function safeIso(value) {
  const s = safeString(value).trim();
  return s || null;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toRegex(value) {
  const s = safeString(value).trim();
  if (!s) return null;
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

async function ensureIndexes() {
  if (ensureIndexesPromise) return ensureIndexesPromise;
  ensureIndexesPromise = (async () => {
    const col = orderRecords();
    await Promise.all([
      col.createIndex({ recordKey: 1 }, { unique: true, sparse: true }),
      col.createIndex({ runId: 1, pairIndex: 1, createdAt: -1 }),
      col.createIndex({ teamId: 1, createdAt: -1 }),
      col.createIndex({ paymentSource: 1, updatedAt: -1 }),
      col.createIndex({ recordStatus: 1, updatedAt: -1 }),
      col.createIndex({ updatedAt: -1 }),
    ]);
  })().catch((error) => {
    ensureIndexesPromise = null;
    throw error;
  });
  return ensureIndexesPromise;
}

function mapOrderRecord(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    recordKey: safeString(doc.recordKey),
    runId: safeString(doc.runId),
    teamId: safeString(doc.teamId),
    teamName: safeString(doc.teamName),
    eventUrl: safeString(doc.eventUrl),
    ticketType: safeString(doc.ticketType),
    pairIndex: Number(doc.pairIndex) || 1,
    sourceRole: safeString(doc.sourceRole),
    holderRole: safeString(doc.holderRole),
    paymentOwnerRole: safeString(doc.paymentOwnerRole),
    paymentSource: doc.paymentSource == null ? null : safeString(doc.paymentSource),
    paymentActorEmail: safeString(doc.paymentActorEmail),
    paymentState: safeString(doc.paymentState),
    finalizeState: safeString(doc.finalizeState),
    recordStatus: safeString(doc.recordStatus),
    aAccountEmail: safeString(doc.aAccountEmail),
    bAccountEmail: safeString(doc.bAccountEmail),
    cAccountEmail: safeString(doc.cAccountEmail),
    seat: {
      seatId: safeString(doc.seat?.seatId),
      combined: safeString(doc.seat?.combined),
      tribune: safeString(doc.seat?.tribune),
      block: safeString(doc.seat?.block),
      row: safeString(doc.seat?.row),
      seatNumber: safeString(doc.seat?.seatNumber),
    },
    category: {
      categoryText: safeString(doc.category?.categoryText),
      blockText: safeString(doc.category?.blockText),
      blockVal: safeString(doc.category?.blockVal),
      svgBlockId: safeString(doc.category?.svgBlockId),
    },
    basketState: {
      addedAt: safeIso(doc.basketState?.addedAt),
      lastSeenAt: safeIso(doc.basketState?.lastSeenAt),
      status: safeString(doc.basketState?.status),
    },
    auditTrail: Array.isArray(doc.auditTrail)
      ? doc.auditTrail.map((item) => ({
          type: safeString(item?.type),
          at: safeIso(item?.at),
          meta: item?.meta && typeof item.meta === 'object' ? item.meta : {},
        }))
      : [],
    sessionLogCount: safeNumber(doc.sessionLogCount, 0),
    sessionLogs: Array.isArray(doc.sessionLogs)
      ? doc.sessionLogs.map((item) => ({
          ts: safeIso(item?.ts),
          level: safeString(item?.level),
          message: safeString(item?.message),
          runId: safeString(item?.runId),
          meta: item?.meta && typeof item.meta === 'object' ? item.meta : {},
        }))
      : [],
    failureReason: safeString(doc.failureReason),
    failureLoggedAt: safeIso(doc.failureLoggedAt),
    createdAt: safeIso(doc.createdAt),
    updatedAt: safeIso(doc.updatedAt),
  };
}

function buildSeatPayload(seat = {}, category = {}) {
  return {
    seatId: safeString(seat?.seatId),
    combined: safeString(seat?.combined),
    tribune: safeString(seat?.tribune),
    block: safeString(seat?.block || category?.blockText || category?.blockVal),
    row: safeString(seat?.row),
    seatNumber: safeString(seat?.seat),
  };
}

function buildCategoryPayload(category = {}) {
  return {
    categoryText: safeString(category?.categoryText),
    blockText: safeString(category?.blockText),
    blockVal: safeString(category?.blockVal),
    svgBlockId: safeString(category?.svgBlockId),
  };
}

function buildAuditEntry(type, meta = {}) {
  return {
    type: safeString(type),
    at: new Date().toISOString(),
    meta: meta && typeof meta === 'object' ? meta : {},
  };
}

function sanitizeSessionLogs(entries = []) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((item) => item && typeof item === 'object')
    .slice(-2000)
    .map((item) => ({
      ts: safeIso(item.ts || item.timestamp),
      level: safeString(item.level || 'info'),
      message: safeString(item.message),
      runId: safeString(item.runId),
      meta: item.meta && typeof item.meta === 'object' ? item.meta : {},
    }));
}

async function upsertByRecordKey(recordKey, update, options = {}) {
  await ensureIndexes();
  const result = await orderRecords().findOneAndUpdate(
    { recordKey: safeString(recordKey) },
    update,
    {
      upsert: options.upsert === true,
      returnDocument: 'after',
    }
  );
  const record = mapOrderRecord(result || null);
  if (record) pushRecordUpdate(record);
  return record;
}

function buildBaseSet(payload = {}, now) {
  return {
    runId: safeString(payload.runId),
    teamId: safeString(payload.teamId),
    teamName: safeString(payload.teamName),
    eventUrl: safeString(payload.eventUrl),
    ticketType: safeString(payload.ticketType),
    pairIndex: Number(payload.pairIndex) || 1,
    sourceRole: safeString(payload.sourceRole || 'A'),
    holderRole: safeString(payload.holderRole || ''),
    paymentOwnerRole: safeString(payload.paymentOwnerRole || ''),
    paymentSource: payload.paymentSource == null ? null : safeString(payload.paymentSource),
    paymentActorEmail: safeString(payload.paymentActorEmail),
    paymentState: safeString(payload.paymentState || 'none'),
    finalizeState: safeString(payload.finalizeState || 'none'),
    recordStatus: safeString(payload.recordStatus || 'basketed'),
    aAccountEmail: safeString(payload.aAccountEmail),
    bAccountEmail: safeString(payload.bAccountEmail),
    cAccountEmail: safeString(payload.cAccountEmail),
    seat: buildSeatPayload(payload.seat, payload.category),
    category: buildCategoryPayload(payload.category),
    updatedAt: now,
  };
}

async function upsertBasketRecord(payload = {}) {
  const now = new Date().toISOString();
  const recordKey = safeString(payload.recordKey);
  return upsertByRecordKey(recordKey, {
    $setOnInsert: {
      recordKey,
      createdAt: now,
      'basketState.addedAt': now,
    },
    $set: {
      ...buildBaseSet(payload, now),
      'basketState.lastSeenAt': now,
      'basketState.status': safeString(payload.basketStatus || 'in_basket'),
    },
    $push: {
      auditTrail: buildAuditEntry('basket_added', payload.auditMeta || {}),
    },
  }, { upsert: true });
}

async function appendEvent(recordKey, type, meta = {}, extraSet = {}) {
  const now = new Date().toISOString();
  return upsertByRecordKey(recordKey, {
    $set: {
      ...extraSet,
      updatedAt: now,
    },
    $push: {
      auditTrail: buildAuditEntry(type, meta),
    },
  }, { upsert: false });
}

async function markTransfer(recordKey, payload = {}) {
  const now = new Date().toISOString();
  return upsertByRecordKey(recordKey, {
    $set: {
      holderRole: safeString(payload.holderRole || 'B'),
      sourceRole: safeString(payload.sourceRole || 'B'),
      paymentOwnerRole: safeString(payload.paymentOwnerRole),
      recordStatus: safeString(payload.recordStatus || 'transferred'),
      bAccountEmail: safeString(payload.bAccountEmail),
      cAccountEmail: safeString(payload.cAccountEmail),
      seat: buildSeatPayload(payload.seat, payload.category),
      category: buildCategoryPayload(payload.category),
      'basketState.lastSeenAt': now,
      'basketState.status': safeString(payload.basketStatus || 'in_basket'),
      updatedAt: now,
    },
    $push: {
      auditTrail: buildAuditEntry('transfer_completed', payload.auditMeta || {}),
    },
  }, { upsert: false });
}

async function markAPaymentReady(recordKey, payload = {}) {
  const now = new Date().toISOString();
  return upsertByRecordKey(recordKey, {
    $set: {
      holderRole: safeString(payload.holderRole || 'A'),
      paymentOwnerRole: 'A',
      paymentSource: 'A',
      paymentActorEmail: safeString(payload.paymentActorEmail),
      paymentState: safeString(payload.paymentState || 'a_ready'),
      recordStatus: safeString(payload.recordStatus || 'payment_ready'),
      aAccountEmail: safeString(payload.aAccountEmail),
      seat: buildSeatPayload(payload.seat, payload.category),
      category: buildCategoryPayload(payload.category),
      'basketState.lastSeenAt': now,
      updatedAt: now,
    },
    $push: {
      auditTrail: buildAuditEntry('a_payment_ready', payload.auditMeta || {}),
    },
  }, { upsert: false });
}

async function markAPaymentCompleted(recordKey, payload = {}) {
  const now = new Date().toISOString();
  return upsertByRecordKey(recordKey, {
    $set: {
      paymentOwnerRole: 'A',
      paymentSource: 'A',
      paymentActorEmail: safeString(payload.paymentActorEmail),
      paymentState: safeString(payload.paymentState || 'a_paid'),
      recordStatus: safeString(payload.recordStatus || 'payment_completed'),
      finalizeState: safeString(payload.finalizeState || 'completed'),
      updatedAt: now,
    },
    $push: {
      auditTrail: buildAuditEntry('a_payment_completed', payload.auditMeta || {}),
    },
  }, { upsert: false });
}

async function markCFinalizeReady(recordKey, payload = {}) {
  const now = new Date().toISOString();
  return upsertByRecordKey(recordKey, {
    $set: {
      paymentOwnerRole: 'C',
      paymentSource: 'C',
      paymentActorEmail: safeString(payload.paymentActorEmail),
      paymentState: safeString(payload.paymentState || 'c_ready'),
      finalizeState: safeString(payload.finalizeState || 'requested'),
      recordStatus: safeString(payload.recordStatus || 'finalize_ready'),
      cAccountEmail: safeString(payload.cAccountEmail),
      updatedAt: now,
    },
    $push: {
      auditTrail: buildAuditEntry('c_finalize_ready', payload.auditMeta || {}),
    },
  }, { upsert: false });
}

async function markCFinalizeCompleted(recordKey, payload = {}) {
  const now = new Date().toISOString();
  return upsertByRecordKey(recordKey, {
    $set: {
      holderRole: 'C',
      paymentOwnerRole: 'C',
      paymentSource: 'C',
      paymentActorEmail: safeString(payload.paymentActorEmail),
      paymentState: safeString(payload.paymentState || 'c_paid'),
      finalizeState: safeString(payload.finalizeState || 'completed'),
      recordStatus: safeString(payload.recordStatus || 'finalized'),
      cAccountEmail: safeString(payload.cAccountEmail),
      seat: buildSeatPayload(payload.seat, payload.category),
      category: buildCategoryPayload(payload.category),
      updatedAt: now,
    },
    $push: {
      auditTrail: buildAuditEntry('c_finalize_completed', payload.auditMeta || {}),
    },
  }, { upsert: false });
}

async function markFailed(recordKey, payload = {}) {
  const now = new Date().toISOString();
  const sessionLogs = sanitizeSessionLogs(payload.sessionLogs);
  return upsertByRecordKey(recordKey, {
    $set: {
      paymentState: safeString(payload.paymentState || 'failed'),
      finalizeState: safeString(payload.finalizeState || 'failed'),
      recordStatus: safeString(payload.recordStatus || 'failed'),
      failureReason: safeString(payload.failureReason || payload.auditMeta?.error),
      failureLoggedAt: now,
      sessionLogs,
      sessionLogCount: sessionLogs.length,
      updatedAt: now,
    },
    $push: {
      auditTrail: buildAuditEntry('record_failed', payload.auditMeta || {}),
    },
  }, { upsert: false });
}

async function attachSessionLogsToRun(runId, payload = {}) {
  await ensureIndexes();
  const rid = safeString(runId).trim();
  if (!rid) return [];
  const docs = await orderRecords().find({ runId: rid }).sort({ updatedAt: -1 }).toArray();
  if (!docs.length) return [];
  const sessionLogs = sanitizeSessionLogs(payload.sessionLogs);
  const now = new Date().toISOString();
  const results = [];
  for (const doc of docs) {
    const updated = await orderRecords().findOneAndUpdate(
      { _id: doc._id },
      {
        $set: {
          failureReason: safeString(payload.failureReason || payload.error),
          failureLoggedAt: now,
          sessionLogs,
          sessionLogCount: sessionLogs.length,
          updatedAt: now,
        },
        $push: {
          auditTrail: buildAuditEntry('session_logs_attached', {
            reason: safeString(payload.failureReason || payload.error),
            logCount: sessionLogs.length,
          }),
        },
      },
      { returnDocument: 'after' }
    );
    const mapped = mapOrderRecord(updated || null);
    if (mapped) {
      pushRecordUpdate(mapped);
      results.push(mapped);
    }
  }
  return results;
}

async function getOrderRecordById(id) {
  await ensureIndexes();
  return mapOrderRecord(await orderRecords().findOne({ _id: toObjectId(id) }));
}

async function listOrderRecords(filters = {}) {
  await ensureIndexes();
  const query = {};
  const teamId = safeString(filters.teamId).trim();
  const teamName = toRegex(filters.teamName || filters.team);
  const eventUrl = toRegex(filters.eventUrl);
  const paymentSource = safeString(filters.paymentSource).trim();
  const paymentState = safeString(filters.paymentState).trim();
  const recordStatus = safeString(filters.recordStatus).trim();
  const accountEmail = toRegex(filters.accountEmail);
  const aAccountEmail = toRegex(filters.aAccountEmail);
  const bAccountEmail = toRegex(filters.bAccountEmail);
  const cAccountEmail = toRegex(filters.cAccountEmail);
  const q = toRegex(filters.q || filters.search);
  const from = safeString(filters.from).trim();
  const to = safeString(filters.to).trim();
  const limit = Math.max(1, Math.min(500, parseInt(String(filters.limit || 200), 10) || 200));

  if (teamId) query.teamId = teamId;
  if (teamName) query.teamName = teamName;
  if (eventUrl) query.eventUrl = eventUrl;
  if (paymentSource) query.paymentSource = paymentSource;
  if (paymentState) query.paymentState = paymentState;
  if (recordStatus) query.recordStatus = recordStatus;
  if (aAccountEmail) query.aAccountEmail = aAccountEmail;
  if (bAccountEmail) query.bAccountEmail = bAccountEmail;
  if (cAccountEmail) query.cAccountEmail = cAccountEmail;
  if (accountEmail) {
    query.$or = [
      { aAccountEmail: accountEmail },
      { bAccountEmail: accountEmail },
      { cAccountEmail: accountEmail },
      { paymentActorEmail: accountEmail },
    ];
  }
  if (q) {
    const qOr = [
      { teamName: q },
      { eventUrl: q },
      { aAccountEmail: q },
      { bAccountEmail: q },
      { cAccountEmail: q },
      { paymentActorEmail: q },
      { holderRole: q },
      { paymentOwnerRole: q },
      { recordStatus: q },
      { paymentState: q },
      { 'seat.seatId': q },
      { 'seat.combined': q },
      { 'seat.row': q },
      { 'seat.seatNumber': q },
      { 'category.categoryText': q },
      { 'category.blockText': q },
      { 'category.blockVal': q },
    ];
    if (query.$or) {
      const prevOr = query.$or;
      delete query.$or;
      query.$and = [{ $or: prevOr }, { $or: qOr }];
    } else {
      query.$or = qOr;
    }
  }
  if (from || to) {
    query.createdAt = {};
    if (from) query.createdAt.$gte = from;
    if (to) query.createdAt.$lte = to;
  }

  const docs = await orderRecords()
    .find(query)
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(limit)
    .toArray();
  return docs.map(mapOrderRecord);
}

module.exports = {
  appendEvent,
  attachSessionLogsToRun,
  getOrderRecordById,
  listOrderRecords,
  mapOrderRecord,
  markAPaymentCompleted,
  markAPaymentReady,
  markCFinalizeCompleted,
  markCFinalizeReady,
  markFailed,
  markTransfer,
  upsertBasketRecord,
};
