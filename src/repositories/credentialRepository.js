const { ObjectId } = require('mongodb');
const { getCollection } = require('../db/mongo');

const COLLECTION = 'team_credentials';

function credentials() {
  return getCollection(COLLECTION);
}

function toObjectId(id) {
  return new ObjectId(String(id));
}

function mapCredential(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    teamId: String(doc.teamId),
    email: String(doc.email || ''),
    identity: doc.identity ? String(doc.identity) : '',
    fanCardCode: doc.fanCardCode ? String(doc.fanCardCode) : '',
    sicilNo: doc.sicilNo ? String(doc.sicilNo) : '',
    priorityTicketCode: doc.priorityTicketCode ? String(doc.priorityTicketCode) : '',
    encryptedPassword: String(doc.encryptedPassword || ''),
    isActive: doc.isActive !== false,
    categoryIds: Array.isArray(doc.categoryIds) ? doc.categoryIds.map(String) : [],
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

async function listCredentialsByTeam(teamId, options = {}) {
  const filter = { teamId: String(teamId) };
  if (!options.includeInactive) filter.isActive = { $ne: false };
  const docs = await credentials().find(filter).sort({ email: 1 }).toArray();
  return docs.map(mapCredential);
}

async function getCredentialById(teamId, credentialId) {
  const doc = await credentials().findOne({
    _id: toObjectId(credentialId),
    teamId: String(teamId),
  });
  return mapCredential(doc);
}

async function getCredentialsByIds(teamId, credentialIds) {
  const ids = Array.isArray(credentialIds) ? credentialIds.map((id) => String(id)) : [];
  if (!ids.length) return [];
  const docs = await credentials().find({
    _id: { $in: ids.map(toObjectId) },
    teamId: String(teamId),
    isActive: { $ne: false },
  }).toArray();
  const mapped = new Map(docs.map((doc) => [String(doc._id), mapCredential(doc)]));
  return ids.map((id) => mapped.get(String(id))).filter(Boolean);
}

async function createCredential(teamId, payload) {
  const now = new Date().toISOString();
  const doc = {
    teamId: String(teamId),
    email: String(payload.email || '').trim().toLowerCase(),
    encryptedPassword: String(payload.encryptedPassword || ''),
    identity: payload.identity ? String(payload.identity).trim() : '',
    fanCardCode: payload.fanCardCode ? String(payload.fanCardCode).trim() : '',
    sicilNo: payload.sicilNo ? String(payload.sicilNo).trim() : '',
    priorityTicketCode: payload.priorityTicketCode ? String(payload.priorityTicketCode).trim() : '',
    isActive: payload.isActive !== false,
    categoryIds: Array.isArray(payload.categoryIds) ? payload.categoryIds.map(String) : [],
    createdAt: now,
    updatedAt: now,
  };
  const result = await credentials().insertOne(doc);
  return mapCredential({ ...doc, _id: result.insertedId });
}

async function updateCredential(teamId, credentialId, payload) {
  const existing = await credentials().findOne({
    _id: toObjectId(credentialId),
    teamId: String(teamId),
  });
  if (!existing) return null;
  const next = {
    email: payload.email !== undefined ? String(payload.email || '').trim().toLowerCase() : String(existing.email || ''),
    identity: payload.identity !== undefined ? String(payload.identity || '').trim() : String(existing.identity || ''),
    fanCardCode: payload.fanCardCode !== undefined ? String(payload.fanCardCode || '').trim() : String(existing.fanCardCode || ''),
    sicilNo: payload.sicilNo !== undefined ? String(payload.sicilNo || '').trim() : String(existing.sicilNo || ''),
    priorityTicketCode: payload.priorityTicketCode !== undefined ? String(payload.priorityTicketCode || '').trim() : String(existing.priorityTicketCode || ''),
    isActive: payload.isActive !== undefined ? payload.isActive !== false : existing.isActive !== false,
    categoryIds: payload.categoryIds !== undefined
      ? (Array.isArray(payload.categoryIds) ? payload.categoryIds.map(String) : [])
      : (Array.isArray(existing.categoryIds) ? existing.categoryIds.map(String) : []),
    updatedAt: new Date().toISOString(),
  };
  if (payload.encryptedPassword !== undefined) {
    next.encryptedPassword = String(payload.encryptedPassword || '');
  }
  await credentials().updateOne({ _id: existing._id }, { $set: next });
  return mapCredential({ ...existing, ...next });
}

async function deleteCredential(teamId, credentialId) {
  const result = await credentials().deleteOne({
    _id: toObjectId(credentialId),
    teamId: String(teamId),
  });
  return result.deletedCount > 0;
}

async function deleteCredentialsByTeam(teamId) {
  const result = await credentials().deleteMany({ teamId: String(teamId) });
  return result.deletedCount || 0;
}

module.exports = {
  createCredential,
  deleteCredential,
  deleteCredentialsByTeam,
  getCredentialById,
  getCredentialsByIds,
  listCredentialsByTeam,
  updateCredential,
};
