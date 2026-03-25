const { ZodError } = require('zod');
const { isMongoConfigured } = require('../db/mongo');
const categoryRepo = require('../repositories/categoryRepository');
const credentialRepo = require('../repositories/credentialRepository');
const teamRepo = require('../repositories/teamRepository');
const { teamPayloadSchema } = require('../validators/management');

function mongoUnavailable(res) {
  return res.status(503).json({
    success: false,
    error: isMongoConfigured() ? 'MongoDB bağlantısı hazır değil' : 'MongoDB yapılandırması eksik',
  });
}

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
  if (error?.message === 'MONGODB_NOT_CONNECTED') return mongoUnavailable(res);
  return res.status(500).json({ success: false, error: error?.message || String(error) });
}

async function listTeams(req, res) {
  try {
    return res.json({ success: true, teams: await teamRepo.listTeams() });
  } catch (error) {
    return handleError(res, error);
  }
}

async function createTeam(req, res) {
  try {
    const payload = teamPayloadSchema.parse(req.body || {});
    const team = await teamRepo.createTeam(payload);
    return res.status(201).json({ success: true, team });
  } catch (error) {
    return handleError(res, error);
  }
}

async function updateTeam(req, res) {
  try {
    const payload = teamPayloadSchema.partial().parse(req.body || {});
    const team = await teamRepo.updateTeam(req.params.teamId, payload);
    if (!team) return res.status(404).json({ success: false, error: 'Takım bulunamadı' });
    return res.json({ success: true, team });
  } catch (error) {
    return handleError(res, error);
  }
}

async function deleteTeam(req, res) {
  try {
    const team = await teamRepo.getTeamById(req.params.teamId);
    if (!team) return res.status(404).json({ success: false, error: 'Takım bulunamadı' });
    const [deletedCategories, deletedCredentials] = await Promise.all([
      categoryRepo.deleteCategoriesByTeam(team.id),
      credentialRepo.deleteCredentialsByTeam(team.id),
    ]);
    await teamRepo.deleteTeam(team.id);
    return res.json({
      success: true,
      deletedTeamId: team.id,
      deletedCategories,
      deletedCredentials,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

module.exports = {
  createTeam,
  deleteTeam,
  listTeams,
  updateTeam,
};
