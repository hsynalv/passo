const { ZodError } = require('zod');
const categoryRepo = require('../repositories/categoryRepository');
const teamRepo = require('../repositories/teamRepository');
const { categoryPayloadSchema, categoryUpdatePayloadSchema } = require('../validators/management');

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

async function ensureTeam(req, res) {
  const team = await teamRepo.getTeamById(req.params.teamId);
  if (!team) {
    res.status(404).json({ success: false, error: 'Takım bulunamadı' });
    return null;
  }
  return team;
}

async function listCategories(req, res) {
  try {
    const team = await ensureTeam(req, res);
    if (!team) return null;
    const includeInactive = String(req.query.includeInactive || '').trim() === '1';
    const categories = await categoryRepo.listCategoriesByTeam(team.id, { includeInactive });
    return res.json({ success: true, categories });
  } catch (error) {
    return handleError(res, error);
  }
}

async function createCategory(req, res) {
  try {
    const team = await ensureTeam(req, res);
    if (!team) return null;
    const payload = categoryPayloadSchema.parse(req.body || {});
    const category = await categoryRepo.createCategory(team.id, payload);
    return res.status(201).json({ success: true, category });
  } catch (error) {
    return handleError(res, error);
  }
}

async function updateCategory(req, res) {
  try {
    const team = await ensureTeam(req, res);
    if (!team) return null;
    const payload = categoryUpdatePayloadSchema.parse(req.body || {});
    const category = await categoryRepo.updateCategory(team.id, req.params.categoryId, payload);
    if (!category) return res.status(404).json({ success: false, error: 'Kategori bulunamadı' });
    return res.json({ success: true, category });
  } catch (error) {
    return handleError(res, error);
  }
}

async function deleteCategory(req, res) {
  try {
    const team = await ensureTeam(req, res);
    if (!team) return null;
    const deleted = await categoryRepo.deleteCategory(team.id, req.params.categoryId);
    if (!deleted) return res.status(404).json({ success: false, error: 'Kategori bulunamadı' });
    return res.json({ success: true });
  } catch (error) {
    return handleError(res, error);
  }
}

module.exports = {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
};
