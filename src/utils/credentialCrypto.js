const crypto = require('crypto');
const cfg = require('../config');

function getSecretKey() {
  const secret = String(cfg.CREDENTIAL_SECRET_KEY || '').trim();
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptSecret(plainText) {
  const text = String(plainText || '');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getSecretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(payload) {
  const raw = String(payload || '').trim();
  if (!raw) return '';
  const [ivRaw, tagRaw, bodyRaw] = raw.split(':');
  if (!ivRaw || !tagRaw || !bodyRaw) {
    throw new Error('INVALID_ENCRYPTED_SECRET');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getSecretKey(),
    Buffer.from(ivRaw, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(bodyRaw, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function maskSecret(secret) {
  const raw = String(secret || '');
  if (!raw) return '';
  if (raw.length <= 4) return '*'.repeat(raw.length);
  return `${'*'.repeat(Math.max(0, raw.length - 4))}${raw.slice(-4)}`;
}

module.exports = {
  encryptSecret,
  decryptSecret,
  maskSecret,
};
