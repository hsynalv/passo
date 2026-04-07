const { ZodError } = require('zod');
const proxyRepo = require('../repositories/proxyRepository');
const {
  proxyCreateSchema,
  proxyImportSchema,
  proxyUpdateSchema,
} = require('../validators/management');

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

function parseBulkText(rawText, fallbackProtocol = 'socks5') {
  const rows = String(rawText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'));

  const items = [];
  for (const row of rows) {
    const normalized = row.replace(/[\t;]+/g, ' ').replace(/\s+/g, ' ').trim();

    const urlMatch = normalized.match(/^(?:(https?|socks4|socks5):\/\/)?([^\s:]+):(\d+)(?::([^\s:]+):([^\s:]+))?$/i);
    if (urlMatch) {
      items.push({
        protocol: (urlMatch[1] || fallbackProtocol || 'socks5').toLowerCase(),
        host: urlMatch[2],
        port: Number(urlMatch[3]),
        username: urlMatch[4] || '',
        password: urlMatch[5] || '',
      });
      continue;
    }

    const parts = normalized.split(' ');
    if (parts.length >= 2) {
      const host = parts[0];
      const port = Number(parts[1]);
      if (host && Number.isFinite(port)) {
        items.push({
          protocol: String(fallbackProtocol || 'socks5').toLowerCase(),
          host,
          port,
          username: parts[2] || '',
          password: parts[3] || '',
        });
      }
    }
  }

  return items;
}

async function listProxies(req, res) {
  try {
    const includeInactive = String(req.query.includeInactive || '').trim() === '1';
    const includeBlacklisted = String(req.query.includeBlacklisted || '').trim() === '1';
    const proxies = await proxyRepo.listProxies({ includeInactive, includeBlacklisted });
    return res.json({ success: true, proxies });
  } catch (error) {
    return handleError(res, error);
  }
}

async function createProxy(req, res) {
  try {
    const payload = proxyCreateSchema.parse(req.body || {});
    const proxy = await proxyRepo.createProxy(payload);
    return res.status(201).json({ success: true, proxy });
  } catch (error) {
    return handleError(res, error);
  }
}

async function importProxyBulk(req, res) {
  try {
    const payload = proxyImportSchema.parse(req.body || {});
    const fromRows = parseBulkText(payload.rawText || '', payload.defaultProtocol || 'socks5');
    const fromItems = Array.isArray(payload.items) ? payload.items : [];
    const merged = [...fromItems, ...fromRows];
    const valid = merged.map((item) => proxyCreateSchema.parse(item));
    const inserted = await proxyRepo.importProxies(valid);
    return res.status(201).json({ success: true, count: inserted.length, proxies: inserted });
  } catch (error) {
    return handleError(res, error);
  }
}

async function updateProxy(req, res) {
  try {
    const payload = proxyUpdateSchema.parse(req.body || {});
    const proxy = await proxyRepo.updateProxy(req.params.proxyId, payload);
    if (!proxy) return res.status(404).json({ success: false, error: 'Proxy bulunamadı' });
    return res.json({ success: true, proxy });
  } catch (error) {
    return handleError(res, error);
  }
}

async function deleteProxy(req, res) {
  try {
    const ok = await proxyRepo.deleteProxy(req.params.proxyId);
    if (!ok) return res.status(404).json({ success: false, error: 'Proxy bulunamadı' });
    return res.json({ success: true });
  } catch (error) {
    return handleError(res, error);
  }
}

async function restoreProxy(req, res) {
  try {
    const proxy = await proxyRepo.restoreProxy(req.params.proxyId);
    if (!proxy) return res.status(404).json({ success: false, error: 'Proxy bulunamadı' });
    return res.json({ success: true, proxy });
  } catch (error) {
    return handleError(res, error);
  }
}

module.exports = {
  createProxy,
  deleteProxy,
  importProxyBulk,
  listProxies,
  restoreProxy,
  updateProxy,
};
