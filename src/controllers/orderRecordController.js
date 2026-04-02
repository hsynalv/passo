const orderRecordRepo = require('../repositories/orderRecordRepository');
const { subscribeRecordUpdates } = require('../utils/orderRecordBus');

function handleError(res, error) {
  if (error?.message === 'MONGODB_NOT_CONNECTED') {
    return res.status(503).json({ success: false, error: 'MongoDB bağlantısı hazır değil' });
  }
  return res.status(500).json({ success: false, error: error?.message || String(error) });
}

function normalizeQuery(req) {
  return {
    teamId: req.query.teamId,
    teamName: req.query.teamName,
    team: req.query.team,
    eventUrl: req.query.eventUrl,
    paymentSource: req.query.paymentSource,
    paymentState: req.query.paymentState,
    recordStatus: req.query.recordStatus,
    q: req.query.q,
    accountEmail: req.query.accountEmail,
    aAccountEmail: req.query.aAccountEmail,
    bAccountEmail: req.query.bAccountEmail,
    cAccountEmail: req.query.cAccountEmail,
    from: req.query.from,
    to: req.query.to,
    limit: req.query.limit,
  };
}

async function listOrderRecords(req, res) {
  try {
    const records = await orderRecordRepo.listOrderRecords(normalizeQuery(req));
    return res.json({ success: true, records });
  } catch (error) {
    return handleError(res, error);
  }
}

async function getOrderRecord(req, res) {
  try {
    const record = await orderRecordRepo.getOrderRecordById(req.params.recordId);
    if (!record) return res.status(404).json({ success: false, error: 'Kayıt bulunamadı' });
    return res.json({ success: true, record });
  } catch (error) {
    return handleError(res, error);
  }
}

async function streamOrderRecords(req, res) {
  const filters = normalizeQuery(req);
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  try { res.flushHeaders && res.flushHeaders(); } catch {}

  const writeEvent = (event, data) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {}
  };

  try {
    const snapshot = await orderRecordRepo.listOrderRecords({ ...filters, limit: req.query.limit || 150 });
    writeEvent('snapshot', snapshot);
  } catch (error) {
    writeEvent('error', { error: error?.message || String(error) });
  }

  const unsub = subscribeRecordUpdates((record) => {
    try {
      const hay = (value) => String(value || '').toLowerCase();
      const q = hay(filters.q);
      const accountEmail = hay(filters.accountEmail);
      if (filters.teamName && !hay(record.teamName).includes(hay(filters.teamName))) return;
      if (filters.eventUrl && !hay(record.eventUrl).includes(hay(filters.eventUrl))) return;
      if (filters.paymentSource && String(record.paymentSource || '') !== String(filters.paymentSource)) return;
      if (filters.paymentState && String(record.paymentState || '') !== String(filters.paymentState)) return;
      if (filters.recordStatus && String(record.recordStatus || '') !== String(filters.recordStatus)) return;
      if (accountEmail) {
        const hit = [record.aAccountEmail, record.bAccountEmail, record.cAccountEmail, record.paymentActorEmail]
          .some((item) => hay(item).includes(accountEmail));
        if (!hit) return;
      }
      if (q) {
        const hit = [
          record.teamName,
          record.eventUrl,
          record.aAccountEmail,
          record.bAccountEmail,
          record.cAccountEmail,
          record.paymentActorEmail,
          record.holderRole,
          record.paymentOwnerRole,
          record.recordStatus,
          record.paymentState,
          record?.seat?.seatId,
          record?.seat?.combined,
          record?.category?.categoryText,
          record?.category?.blockText,
        ].some((item) => hay(item).includes(q));
        if (!hit) return;
      }
    } catch {}
    writeEvent('record', record);
  });

  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 25000);

  req.on('close', () => {
    try { clearInterval(keepAlive); } catch {}
    try { unsub && unsub(); } catch {}
    try { res.end(); } catch {}
  });
}

module.exports = {
  getOrderRecord,
  listOrderRecords,
  streamOrderRecords,
};
