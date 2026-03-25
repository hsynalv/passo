const { ObjectId } = require('mongodb');
const { getCollection } = require('../db/mongo');

const COLLECTION = 'teams';

function teams() {
  return getCollection(COLLECTION);
}

function toObjectId(id) {
  return new ObjectId(String(id));
}

function slugifyName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function mapTeam(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    name: String(doc.name || ''),
    slug: String(doc.slug || ''),
    isActive: doc.isActive !== false,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

async function listTeams() {
  const docs = await teams().find({}).sort({ name: 1 }).toArray();
  return docs.map(mapTeam);
}

async function getTeamById(id) {
  if (!id) return null;
  return mapTeam(await teams().findOne({ _id: toObjectId(id) }));
}

async function getTeamDocById(id) {
  if (!id) return null;
  return teams().findOne({ _id: toObjectId(id) });
}

async function createTeam(payload) {
  const name = String(payload.name || '').trim();
  const now = new Date().toISOString();
  const baseSlug = slugifyName(name) || `team-${Date.now()}`;
  let slug = baseSlug;
  let counter = 2;
  while (await teams().findOne({ slug })) {
    slug = `${baseSlug}-${counter++}`;
  }

  const doc = {
    name,
    slug,
    isActive: payload.isActive !== false,
    createdAt: now,
    updatedAt: now,
  };
  const result = await teams().insertOne(doc);
  return mapTeam({ ...doc, _id: result.insertedId });
}

async function updateTeam(id, payload) {
  const existing = await getTeamDocById(id);
  if (!existing) return null;
  const name = String(payload.name || existing.name || '').trim();
  let slug = existing.slug;
  if (name && name !== existing.name) {
    const baseSlug = slugifyName(name) || existing.slug || `team-${Date.now()}`;
    slug = baseSlug;
    let counter = 2;
    while (await teams().findOne({ slug, _id: { $ne: existing._id } })) {
      slug = `${baseSlug}-${counter++}`;
    }
  }
  const next = {
    name,
    slug,
    isActive: payload.isActive !== undefined ? payload.isActive !== false : existing.isActive !== false,
    updatedAt: new Date().toISOString(),
  };
  await teams().updateOne({ _id: existing._id }, { $set: next });
  return mapTeam({ ...existing, ...next });
}

async function deleteTeam(id) {
  const existing = await getTeamDocById(id);
  if (!existing) return false;
  const result = await teams().deleteOne({ _id: existing._id });
  return result.deletedCount > 0;
}

module.exports = {
  createTeam,
  deleteTeam,
  getTeamById,
  getTeamDocById,
  listTeams,
  updateTeam,
};
