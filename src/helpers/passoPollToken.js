'use strict';

/**
 * Passo www SPA localStorage: token çoğu zaman JSON string (`"Bearer …"` veya çift sarılı) saklanır.
 * SEO / açıklama metinleri yanlışlıkla JWT sanılmamalı (Authorization başlığında \n → axios hata).
 */

const KEY_PRIORITY = [
  'storage_token',
  'access_token',
  'token',
  'jwt',
  'id_token',
  'accessToken',
  'authToken',
  'passo_token',
  'passoToken',
  'pb_token',
  'pb-token',
];

function normalizePassoPollTokenRaw(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  for (let d = 0; d < 5; d++) {
    if (s.charAt(0) === '{') {
      try {
        const o = JSON.parse(s);
        const t =
          o.access_token ||
          o.token ||
          o.accessToken ||
          o.jwt ||
          o.inComingToken ||
          o.InComingToken;
        if (t) s = String(t).trim();
        else return '';
      } catch {
        return '';
      }
      continue;
    }
    const q1 = s.charAt(0) === '"' && s.charAt(s.length - 1) === '"';
    const q2 = s.charAt(0) === "'" && s.charAt(s.length - 1) === "'";
    if (q1 || q2) {
      try {
        s = String(JSON.parse(s)).trim();
      } catch {
        s = s.slice(1, -1).trim();
      }
      continue;
    }
    break;
  }
  s = s.replace(/^bearer\s+/i, '').trim();
  s = s.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return s;
}

function isPlausiblePassoApiToken(s) {
  if (!s || s.length < 40) return false;
  if (!/^[A-Za-z0-9._+/=-]+$/.test(s)) return false;
  if (s.split('.').length >= 3) return true;
  return s.length >= 64;
}

/**
 * @param {Array<{ key: string, raw: string }>} pairs
 * @returns {{ token: string, key: string }}
 */
function pickBestPassoPollToken(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return { token: '', key: '' };
  const sorted = [...pairs].sort((a, b) => {
    const ia = KEY_PRIORITY.indexOf(a.key);
    const ib = KEY_PRIORITY.indexOf(b.key);
    const ra = ia === -1 ? 999 : ia;
    const rb = ib === -1 ? 999 : ib;
    if (ra !== rb) return ra - rb;
    const la = normalizePassoPollTokenRaw(a.raw).length;
    const lb = normalizePassoPollTokenRaw(b.raw).length;
    return lb - la;
  });
  for (const { key, raw } of sorted) {
    const t = normalizePassoPollTokenRaw(raw);
    if (isPlausiblePassoApiToken(t)) return { token: t, key };
  }
  return { token: '', key: '' };
}

/**
 * page.evaluate içine gömülecek koleksiyon — ana mantık Node tarafında pickBestPassoPollToken.
 */
function collectPassoTokenLikeStoragePairsSource() {
  return `function collectPassoTokenLikeStoragePairs() {
    var seen = {};
    var ar = [];
    function push(k, raw) {
      if (!k || raw == null || raw === '') return;
      if (seen[k]) return;
      seen[k] = true;
      ar.push({ key: k, raw: String(raw) });
    }
    var priority = ${JSON.stringify(KEY_PRIORITY)};
    for (var pi = 0; pi < priority.length; pi++) {
      var pk = priority[pi];
      try {
        var v = localStorage.getItem(pk) || sessionStorage.getItem(pk);
        if (v != null && v !== '') push(pk, v);
      } catch (e0) {}
    }
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || seen[k]) continue;
        var lk = String(k).toLowerCase();
        if (lk.indexOf('token') < 0 && lk.indexOf('auth') < 0 && lk.indexOf('jwt') < 0) continue;
        push(k, localStorage.getItem(k));
      }
      for (var j = 0; j < sessionStorage.length; j++) {
        var k2 = sessionStorage.key(j);
        if (!k2 || seen[k2]) continue;
        var lk2 = String(k2).toLowerCase();
        if (lk2.indexOf('token') < 0 && lk2.indexOf('auth') < 0 && lk2.indexOf('jwt') < 0) continue;
        push(k2, sessionStorage.getItem(k2));
      }
    } catch (e1) {}
    return ar;
  }`;
}

module.exports = {
  KEY_PRIORITY,
  normalizePassoPollTokenRaw,
  isPlausiblePassoApiToken,
  pickBestPassoPollToken,
  collectPassoTokenLikeStoragePairsSource,
};
