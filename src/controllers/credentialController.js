const { ZodError } = require('zod');
const credentialRepo = require('../repositories/credentialRepository');
const teamRepo = require('../repositories/teamRepository');
const { encryptSecret } = require('../utils/credentialCrypto');
const { credentialCreateSchema, credentialUpdateSchema } = require('../validators/management');

function handleError(res, error) {
  if (error instanceof ZodError) {
    return res.status(400).json({
      success: false,
      error: 'VALIDATION_ERROR',
      details: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  if (error?.message === 'MONGODB_NOT_CONNECTED') {
    return res.status(503).json({ success: false, error: 'MongoDB bağlantısı hazır değil' });
  }
  return res.status(500).json({ success: false, error: error?.message || String(error) });
}

function toPublicCredential(doc) {
  if (!doc) return null;
  return {
    id: doc.id,
    teamId: doc.teamId,
    email: doc.email,
    identity: doc.identity || '',
    phone: doc.phone || '',
    fanCardCode: doc.fanCardCode || '',
    sicilNo: doc.sicilNo || '',
    priorityTicketCode: doc.priorityTicketCode || '',
    isActive: doc.isActive !== false,
    categoryIds: Array.isArray(doc.categoryIds) ? doc.categoryIds.map(String) : [],
    notes: doc.notes != null ? String(doc.notes) : '',
    hasPassword: !!doc.encryptedPassword,
    maskedPassword: doc.encryptedPassword ? '***' : '',
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

async function ensureTeam(req, res) {
  const team = await teamRepo.getTeamById(req.params.teamId);
  if (!team) {
    res.status(404).json({ success: false, error: 'Takım bulunamadı' });
    return null;
  }
  return team;
}

async function listCredentials(req, res) {
  try {
    const team = await ensureTeam(req, res);
    if (!team) return null;
    const includeInactive = String(req.query.includeInactive || '').trim() === '1';
    const items = await credentialRepo.listCredentialsByTeam(team.id, { includeInactive });
    return res.json({ success: true, credentials: items.map(toPublicCredential) });
  } catch (error) {
    return handleError(res, error);
  }
}

async function createCredential(req, res) {
  try {
    const team = await ensureTeam(req, res);
    if (!team) return null;
    const payload = credentialCreateSchema.parse(req.body || {});
    const created = await credentialRepo.createCredential(team.id, {
      ...payload,
      encryptedPassword: encryptSecret(String(payload.password || '')),
    });
    return res.status(201).json({ success: true, credential: toPublicCredential(created) });
  } catch (error) {
    return handleError(res, error);
  }
}

async function updateCredential(req, res) {
  try {
    const team = await ensureTeam(req, res);
    if (!team) return null;
    const payload = credentialUpdateSchema.parse(req.body || {});
    const next = { ...payload };
    if (payload.password !== undefined) {
      if (String(payload.password || '').trim()) {
        next.encryptedPassword = encryptSecret(String(payload.password || ''));
      }
      delete next.password;
    }
    const updated = await credentialRepo.updateCredential(team.id, req.params.credentialId, next);
    if (!updated) return res.status(404).json({ success: false, error: 'Üyelik bulunamadı' });
    return res.json({ success: true, credential: toPublicCredential(updated) });
  } catch (error) {
    return handleError(res, error);
  }
}

async function deleteCredential(req, res) {
  try {
    const team = await ensureTeam(req, res);
    if (!team) return null;
    const deleted = await credentialRepo.deleteCredential(team.id, req.params.credentialId);
    if (!deleted) return res.status(404).json({ success: false, error: 'Üyelik bulunamadı' });
    return res.json({ success: true });
  } catch (error) {
    return handleError(res, error);
  }
}

module.exports = {
  createCredential,
  deleteCredential,
  listCredentials,
  updateCredential,
};
