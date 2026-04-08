const { ObjectId } = require('mongodb');
const { getCollection } = require('../db/mongo');

const COLLECTION = 'team_categories';

function categories() {
  return getCollection(COLLECTION);
}

function toObjectId(id) {
  return new ObjectId(String(id));
}

function normalizeSelectionHint(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['legacy', 'scan', 'svg', 'scan_map'].includes(v)) return v;
  return null;
}

function mapCategory(doc) {
  if (!doc) return null;
  const categoryTypeValue = String(doc.categoryTypeValue || doc.label || '');
  const label = String(doc.label || doc.categoryTypeValue || '');
  const hint = doc.selectionModeHint != null && String(doc.selectionModeHint).trim() !== ''
    ? normalizeSelectionHint(doc.selectionModeHint)
    : null;
  const svgBlockId = String(doc.svgBlockId || '').trim();
  return {
    id: String(doc._id),
    teamId: String(doc.teamId),
    label,
    selectionModeHint: hint,
    categoryTypeValue,
    alternativeCategoryValue: String(doc.alternativeCategoryValue || '').trim(),
    sortOrder: Number.isFinite(Number(doc.sortOrder)) ? Math.floor(Number(doc.sortOrder)) : 0,
    svgBlockId: svgBlockId || null,
    isActive: doc.isActive !== false,
    ticketCount: Number.isFinite(doc.ticketCount) && doc.ticketCount >= 1 ? doc.ticketCount : 1,
    adjacentSeats: doc.adjacentSeats === true,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

async function listCategoriesByTeam(teamId, options = {}) {
  const filter = { teamId: String(teamId) };
  if (!options.includeInactive) filter.isActive = { $ne: false };
  const docs = await categories().find(filter).sort({ createdAt: 1, _id: 1 }).toArray();
  return docs.map(mapCategory);
}

async function getCategoryById(teamId, categoryId) {
  const doc = await categories().findOne({
    _id: toObjectId(categoryId),
    teamId: String(teamId),
  });
  return mapCategory(doc);
}

async function getCategoriesByIds(teamId, categoryIds) {
  const ids = Array.isArray(categoryIds) ? categoryIds.map((id) => String(id)) : [];
  if (!ids.length) return [];
  const docs = await categories().find({
    _id: { $in: ids.map(toObjectId) },
    teamId: String(teamId),
    isActive: { $ne: false },
  }).toArray();
  const mapped = new Map(docs.map((doc) => [String(doc._id), mapCategory(doc)]));
  return ids.map((id) => mapped.get(String(id))).filter(Boolean);
}

async function createCategory(teamId, payload) {
  const now = new Date().toISOString();
  const categoryTypeValue = String(payload.categoryTypeValue || payload.label || '').trim();
  const hint = payload.selectionModeHint != null && String(payload.selectionModeHint).trim() !== ''
    ? normalizeSelectionHint(payload.selectionModeHint)
    : null;
  const svgBlockId = String(payload.svgBlockId || '').trim();
  const doc = {
    teamId: String(teamId),
    label: String(payload.label || categoryTypeValue).trim() || categoryTypeValue,
    selectionModeHint: hint,
    categoryTypeValue,
    alternativeCategoryValue: String(payload.alternativeCategoryValue || '').trim(),
    sortOrder: Number.isFinite(Number(payload.sortOrder)) ? Math.floor(Number(payload.sortOrder)) : 0,
    svgBlockId: svgBlockId || undefined,
    isActive: payload.isActive !== false,
    ticketCount: Number.isFinite(payload.ticketCount) && payload.ticketCount >= 1 ? payload.ticketCount : 1,
    adjacentSeats: payload.adjacentSeats === true,
    createdAt: now,
    updatedAt: now,
  };
  const result = await categories().insertOne(doc);
  return mapCategory({ ...doc, _id: result.insertedId });
}

async function updateCategory(teamId, categoryId, payload) {
  const existing = await categories().findOne({
    _id: toObjectId(categoryId),
    teamId: String(teamId),
  });
  if (!existing) return null;
  const currentValue = String(existing.categoryTypeValue || existing.label || '').trim();
  const nextValue = payload.categoryTypeValue !== undefined
    ? String(payload.categoryTypeValue || '').trim()
    : currentValue;
  const nextHint = payload.selectionModeHint !== undefined
    ? (String(payload.selectionModeHint || '').trim() === '' ? null : normalizeSelectionHint(payload.selectionModeHint))
    : (existing.selectionModeHint != null ? normalizeSelectionHint(existing.selectionModeHint) : null);
  const nextSvg = payload.svgBlockId !== undefined
    ? String(payload.svgBlockId || '').trim()
    : String(existing.svgBlockId || '').trim();
  const next = {
    label: payload.label !== undefined
      ? String(payload.label || '').trim() || nextValue
      : (String(existing.label || '').trim() || nextValue),
    selectionModeHint: nextHint,
    categoryTypeValue: nextValue,
    alternativeCategoryValue: payload.alternativeCategoryValue !== undefined
      ? String(payload.alternativeCategoryValue || '').trim()
      : String(existing.alternativeCategoryValue || '').trim(),
    sortOrder: payload.sortOrder !== undefined && Number.isFinite(Number(payload.sortOrder))
      ? Math.floor(Number(payload.sortOrder))
      : (Number.isFinite(Number(existing.sortOrder)) ? Math.floor(Number(existing.sortOrder)) : 0),
    svgBlockId: nextSvg || undefined,
    isActive: payload.isActive !== undefined ? payload.isActive !== false : existing.isActive !== false,
    ticketCount: payload.ticketCount !== undefined
      ? (Number.isFinite(payload.ticketCount) && payload.ticketCount >= 1 ? payload.ticketCount : 1)
      : (Number.isFinite(existing.ticketCount) && existing.ticketCount >= 1 ? existing.ticketCount : 1),
    adjacentSeats: payload.adjacentSeats !== undefined
      ? payload.adjacentSeats === true
      : existing.adjacentSeats === true,
    updatedAt: new Date().toISOString(),
  };
  await categories().updateOne({ _id: existing._id }, { $set: next });
  return mapCategory({ ...existing, ...next });
}

async function deleteCategory(teamId, categoryId) {
  const result = await categories().deleteOne({
    _id: toObjectId(categoryId),
    teamId: String(teamId),
  });
  return result.deletedCount > 0;
}

async function deleteCategoriesByTeam(teamId) {
  const result = await categories().deleteMany({ teamId: String(teamId) });
  return result.deletedCount || 0;
}

/**
 * Scan map / canlı tarama satırlarından takım kategorisi oluşturur (svgBlockId + scan_map modu).
 * Aynı blockId için zaten kategori varsa atlar.
 */
async function createCategoriesFromScanItems(teamId, items = []) {
  const existing = await listCategoriesByTeam(teamId, { includeInactive: true });
  const seenSvg = new Set(
    existing.map((c) => String(c.svgBlockId || '').trim()).filter(Boolean)
  );
  const created = [];
  const skipped = [];
  for (const item of Array.isArray(items) ? items : []) {
    const blockId = String(item.blockId || '').trim();
    if (!blockId) continue;
    if (seenSvg.has(blockId)) {
      skipped.push(blockId);
      continue;
    }
    const label = String(item.categoryLabel || item.tooltipText || blockId).trim() || blockId;
    const categoryTypeValue = label;
    const cat = await createCategory(teamId, {
      label,
      categoryTypeValue,
      selectionModeHint: 'scan_map',
      svgBlockId: blockId,
      ticketCount: 1,
      adjacentSeats: false,
      isActive: true,
    });
    created.push(cat);
    seenSvg.add(blockId);
  }
  return { created, skipped };
}

module.exports = {
  createCategoriesFromScanItems,
  createCategory,
  deleteCategory,
  deleteCategoriesByTeam,
  getCategoriesByIds,
  getCategoryById,
  listCategoriesByTeam,
  updateCategory,
};
