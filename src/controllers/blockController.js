'use strict';

const { ZodError } = require('zod');
const blockRepo = require('../repositories/blockRepository');
const teamRepo = require('../repositories/teamRepository');
const { blockPayloadSchema, blockUpdatePayloadSchema } = require('../validators/management');

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

async function listBlocks(req, res) {
  try {
    const team = await ensureTeam(req, res);
    if (!team) return null;
    const includeInactive = String(req.query.includeInactive || '').trim() === '1';
    const blockList = await blockRepo.listBlocksByTeam(team.id, { includeInactive });
    return res.json({ success: true, blocks: blockList });
  } catch (error) {
    return handleError(res, error);
  }
}

async function createBlock(req, res) {
  try {
    const team = await ensureTeam(req, res);
    if (!team) return null;
    const payload = blockPayloadSchema.parse(req.body || {});
    const block = await blockRepo.createBlock(team.id, payload);
    return res.status(201).json({ success: true, block });
  } catch (error) {
    return handleError(res, error);
  }
}

async function updateBlock(req, res) {
  try {
    const team = await ensureTeam(req, res);
    if (!team) return null;
    const payload = blockUpdatePayloadSchema.parse(req.body || {});
    const block = await blockRepo.updateBlock(team.id, req.params.blockId, payload);
    if (!block) return res.status(404).json({ success: false, error: 'Blok bulunamadı' });
    return res.json({ success: true, block });
  } catch (error) {
    return handleError(res, error);
  }
}

async function deleteBlock(req, res) {
  try {
    const team = await ensureTeam(req, res);
    if (!team) return null;
    const deleted = await blockRepo.deleteBlock(team.id, req.params.blockId);
    if (!deleted) return res.status(404).json({ success: false, error: 'Blok bulunamadı' });
    return res.json({ success: true });
  } catch (error) {
    return handleError(res, error);
  }
}

module.exports = {
  createBlock,
  deleteBlock,
  listBlocks,
  updateBlock,
};
