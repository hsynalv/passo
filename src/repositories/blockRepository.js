'use strict';

const { ObjectId } = require('mongodb');
const { getCollection } = require('../db/mongo');

const COLLECTION = 'team_blocks';

function blocks() {
  return getCollection(COLLECTION);
}

function toObjectId(id) {
  return new ObjectId(String(id));
}

/**
 * @param {object} doc
 * @returns {object}
 */
function mapBlock(doc) {
  if (!doc) return null;
  const mode = String(doc.selectionMode || 'svg').toLowerCase();
  const base = {
    id: String(doc._id),
    teamId: String(doc.teamId),
    label: String(doc.label || ''),
    selectionMode: mode === 'legacy' ? 'legacy' : 'svg',
    isActive: doc.isActive !== false,
    ticketCount: Number.isFinite(doc.ticketCount) && doc.ticketCount >= 1 ? doc.ticketCount : 1,
    adjacentSeats: doc.adjacentSeats === true,
    sortOrder: Number.isFinite(Number(doc.sortOrder)) ? Math.floor(Number(doc.sortOrder)) : 0,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
  if (base.selectionMode === 'svg') {
    base.svgBlockId = String(doc.svgBlockId || '').trim() || null;
    base.apiBlockId = Number.isFinite(Number(doc.apiBlockId)) ? Number(doc.apiBlockId) : null;
  } else {
    base.categoryType = String(doc.categoryType || '').trim() || null;
    base.blockVal = String(doc.blockVal || '').trim() || null;
  }
  return base;
}

/**
 * @param {string} svgBlockId - e.g. "block17363"
 * @returns {number|null}
 */
function deriveApiBlockId(svgBlockId) {
  const s = String(svgBlockId || '').trim().replace(/^block/i, '');
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

async function listBlocksByTeam(teamId, options = {}) {
  const filter = { teamId: String(teamId) };
  if (!options.includeInactive) filter.isActive = { $ne: false };
  const docs = await blocks().find(filter).sort({ sortOrder: 1, createdAt: 1, _id: 1 }).toArray();
  return docs.map(mapBlock);
}

async function getBlockById(teamId, blockId) {
  const doc = await blocks().findOne({
    _id: toObjectId(blockId),
    teamId: String(teamId),
  });
  return mapBlock(doc);
}

async function getBlocksByIds(teamId, blockIds) {
  const ids = Array.isArray(blockIds) ? blockIds.map(String) : [];
  if (!ids.length) return [];
  const docs = await blocks().find({
    _id: { $in: ids.map(toObjectId) },
    teamId: String(teamId),
    isActive: { $ne: false },
  }).toArray();
  const mapped = new Map(docs.map((doc) => [String(doc._id), mapBlock(doc)]));
  // preserve input order
  return ids.map((id) => mapped.get(id)).filter(Boolean);
}

// ─── Write ────────────────────────────────────────────────────────────────────

async function createBlock(teamId, payload) {
  const now = new Date().toISOString();
  const mode = String(payload.selectionMode || 'svg').toLowerCase() === 'legacy' ? 'legacy' : 'svg';
  const doc = {
    teamId: String(teamId),
    label: String(payload.label || '').trim(),
    selectionMode: mode,
    isActive: payload.isActive !== false,
    ticketCount: Number.isFinite(payload.ticketCount) && payload.ticketCount >= 1 ? payload.ticketCount : 1,
    adjacentSeats: payload.adjacentSeats === true,
    sortOrder: Number.isFinite(Number(payload.sortOrder)) ? Math.floor(Number(payload.sortOrder)) : 0,
    createdAt: now,
    updatedAt: now,
  };
  if (mode === 'svg') {
    doc.svgBlockId = String(payload.svgBlockId || '').trim() || undefined;
    doc.apiBlockId = payload.apiBlockId != null
      ? Number(payload.apiBlockId)
      : deriveApiBlockId(doc.svgBlockId);
  } else {
    doc.categoryType = String(payload.categoryType || '').trim() || undefined;
    doc.blockVal = String(payload.blockVal || '').trim() || undefined;
  }
  const result = await blocks().insertOne(doc);
  return mapBlock({ ...doc, _id: result.insertedId });
}

async function updateBlock(teamId, blockId, payload) {
  const existing = await blocks().findOne({
    _id: toObjectId(blockId),
    teamId: String(teamId),
  });
  if (!existing) return null;

  const next = { updatedAt: new Date().toISOString() };
  if (payload.label !== undefined) next.label = String(payload.label || '').trim();
  if (payload.isActive !== undefined) next.isActive = payload.isActive !== false;
  if (payload.ticketCount !== undefined) {
    next.ticketCount = Number.isFinite(payload.ticketCount) && payload.ticketCount >= 1 ? payload.ticketCount : 1;
  }
  if (payload.adjacentSeats !== undefined) next.adjacentSeats = payload.adjacentSeats === true;
  if (payload.sortOrder !== undefined) next.sortOrder = Number.isFinite(Number(payload.sortOrder)) ? Math.floor(Number(payload.sortOrder)) : 0;

  const mode = payload.selectionMode !== undefined
    ? (String(payload.selectionMode).toLowerCase() === 'legacy' ? 'legacy' : 'svg')
    : existing.selectionMode;
  next.selectionMode = mode;

  if (mode === 'svg') {
    if (payload.svgBlockId !== undefined) {
      next.svgBlockId = String(payload.svgBlockId || '').trim() || undefined;
      next.apiBlockId = payload.apiBlockId != null
        ? Number(payload.apiBlockId)
        : deriveApiBlockId(next.svgBlockId);
    } else if (payload.apiBlockId !== undefined) {
      next.apiBlockId = Number(payload.apiBlockId);
    }
  } else {
    if (payload.categoryType !== undefined) next.categoryType = String(payload.categoryType || '').trim() || undefined;
    if (payload.blockVal !== undefined) next.blockVal = String(payload.blockVal || '').trim() || undefined;
  }

  await blocks().updateOne({ _id: existing._id }, { $set: next });
  return mapBlock({ ...existing, ...next });
}

async function deleteBlock(teamId, blockId) {
  const result = await blocks().deleteOne({
    _id: toObjectId(blockId),
    teamId: String(teamId),
  });
  return result.deletedCount > 0;
}

async function deleteBlocksByTeam(teamId) {
  const result = await blocks().deleteMany({ teamId: String(teamId) });
  return result.deletedCount || 0;
}

// ─── Scan Map ─────────────────────────────────────────────────────────────────

/**
 * Scan map satırlarından SVG blokları oluşturur.
 * Aynı svgBlockId için zaten blok varsa atlar.
 */
async function createBlocksFromScanItems(teamId, items = []) {
  const existing = await listBlocksByTeam(teamId, { includeInactive: true });
  const seenSvg = new Set(
    existing
      .filter((b) => b.selectionMode === 'svg')
      .map((b) => String(b.svgBlockId || '').trim())
      .filter(Boolean)
  );

  const created = [];
  const skipped = [];

  for (const item of Array.isArray(items) ? items : []) {
    const rawBlockId = String(item.blockId || '').trim();
    if (!rawBlockId) continue;

    if (seenSvg.has(rawBlockId)) {
      skipped.push(rawBlockId);
      continue;
    }

    const label = String(item.categoryLabel || item.tooltipText || item.legendTitle || rawBlockId).trim() || rawBlockId;
    const apiBlockId = deriveApiBlockId(rawBlockId);

    const blk = await createBlock(teamId, {
      label,
      selectionMode: 'svg',
      svgBlockId: rawBlockId,
      apiBlockId,
      ticketCount: 1,
      adjacentSeats: false,
      isActive: true,
    });
    created.push(blk);
    seenSvg.add(rawBlockId);
  }

  return { created, skipped };
}

module.exports = {
  createBlock,
  createBlocksFromScanItems,
  deleteBlock,
  deleteBlocksByTeam,
  getBlockById,
  getBlocksByIds,
  listBlocksByTeam,
  updateBlock,
};
