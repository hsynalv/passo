const { ObjectId } = require('mongodb');
const { getCollection } = require('../db/mongo');

const COLLECTION = 'team_categories';

function categories() {
  return getCollection(COLLECTION);
}

function toObjectId(id) {
  return new ObjectId(String(id));
}

function mapCategory(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    teamId: String(doc.teamId),
    label: String(doc.label || ''),
    selectionModeHint: String(doc.selectionModeHint || '').trim() || null,
    categoryTypeValue: String(doc.categoryTypeValue || ''),
    alternativeCategoryValue: doc.alternativeCategoryValue ? String(doc.alternativeCategoryValue) : '',
    sortOrder: Number.isFinite(Number(doc.sortOrder)) ? Number(doc.sortOrder) : 0,
    isActive: doc.isActive !== false,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

async function listCategoriesByTeam(teamId, options = {}) {
  const filter = { teamId: String(teamId) };
  if (!options.includeInactive) filter.isActive = { $ne: false };
  const docs = await categories().find(filter).sort({ sortOrder: 1, label: 1 }).toArray();
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
  const doc = {
    teamId: String(teamId),
    label: String(payload.label || '').trim(),
    selectionModeHint: payload.selectionModeHint ? String(payload.selectionModeHint).trim() : null,
    categoryTypeValue: String(payload.categoryTypeValue || '').trim(),
    alternativeCategoryValue: payload.alternativeCategoryValue ? String(payload.alternativeCategoryValue).trim() : '',
    sortOrder: Number.isFinite(Number(payload.sortOrder)) ? Number(payload.sortOrder) : 0,
    isActive: payload.isActive !== false,
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
  const next = {
    label: payload.label !== undefined ? String(payload.label || '').trim() : String(existing.label || ''),
    selectionModeHint: payload.selectionModeHint !== undefined
      ? (payload.selectionModeHint ? String(payload.selectionModeHint).trim() : null)
      : (existing.selectionModeHint || null),
    categoryTypeValue: payload.categoryTypeValue !== undefined
      ? String(payload.categoryTypeValue || '').trim()
      : String(existing.categoryTypeValue || ''),
    alternativeCategoryValue: payload.alternativeCategoryValue !== undefined
      ? String(payload.alternativeCategoryValue || '').trim()
      : String(existing.alternativeCategoryValue || ''),
    sortOrder: payload.sortOrder !== undefined
      ? (Number.isFinite(Number(payload.sortOrder)) ? Number(payload.sortOrder) : 0)
      : (Number.isFinite(Number(existing.sortOrder)) ? Number(existing.sortOrder) : 0),
    isActive: payload.isActive !== undefined ? payload.isActive !== false : existing.isActive !== false,
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

module.exports = {
  createCategory,
  deleteCategory,
  deleteCategoriesByTeam,
  getCategoriesByIds,
  getCategoryById,
  listCategoriesByTeam,
  updateCategory,
};
