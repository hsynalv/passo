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
  const categoryTypeValue = String(doc.categoryTypeValue || doc.label || '');
  const label = String(doc.label || doc.categoryTypeValue || '');
  return {
    id: String(doc._id),
    teamId: String(doc.teamId),
    label,
    selectionModeHint: null,
    categoryTypeValue,
    alternativeCategoryValue: '',
    sortOrder: 0,
    isActive: doc.isActive !== false,
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
  const doc = {
    teamId: String(teamId),
    label: String(payload.label || categoryTypeValue).trim() || categoryTypeValue,
    selectionModeHint: null,
    categoryTypeValue,
    alternativeCategoryValue: '',
    sortOrder: 0,
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
  const currentValue = String(existing.categoryTypeValue || existing.label || '').trim();
  const nextValue = payload.categoryTypeValue !== undefined
    ? String(payload.categoryTypeValue || '').trim()
    : currentValue;
  const next = {
    label: payload.label !== undefined
      ? String(payload.label || '').trim() || nextValue
      : (String(existing.label || '').trim() || nextValue),
    selectionModeHint: null,
    categoryTypeValue: nextValue,
    alternativeCategoryValue: '',
    sortOrder: 0,
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
