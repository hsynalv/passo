const { EventEmitter } = require('events');

const recordBus = new EventEmitter();
const BUFFER_MAX = parseInt(process.env.ORDER_RECORD_STREAM_BUFFER_MAX || '500', 10);
const recordBuffer = [];

function pushRecordUpdate(record) {
  if (!record || typeof record !== 'object') return;
  try {
    recordBuffer.push(record);
    while (recordBuffer.length > BUFFER_MAX) recordBuffer.shift();
  } catch {}
  try { recordBus.emit('record', record); } catch {}
}

function getRecentRecordUpdates(limit = 100) {
  try {
    const n = Math.max(1, Math.min(1000, parseInt(String(limit || 100), 10) || 100));
    return recordBuffer.slice(Math.max(0, recordBuffer.length - n));
  } catch {
    return [];
  }
}

function subscribeRecordUpdates(handler) {
  if (typeof handler !== 'function') return () => {};
  const fn = (record) => {
    try { handler(record); } catch {}
  };
  try { recordBus.on('record', fn); } catch {}
  return () => {
    try { recordBus.off('record', fn); } catch {}
  };
}

module.exports = {
  getRecentRecordUpdates,
  pushRecordUpdate,
  subscribeRecordUpdates,
};
