'use strict';

/**
 * Passo API (ticketingweb) için tarayıcı çerezlerini topla.
 * Yalnızca aktif sayfa domain'i değil; alt domain'ler ayrı ayrı sorulur.
 */
async function buildPassoApiCookieHeader(page) {
  if (!page || typeof page.cookies !== 'function') return '';
  const urls = [
    'https://www.passo.com.tr/',
    'https://ticketingweb.passo.com.tr/',
  ];
  const byName = new Map();
  for (const u of urls) {
    try {
      const arr = await page.cookies(u);
      for (const c of arr || []) {
        if (c && c.name) byName.set(c.name, `${c.name}=${c.value}`);
      }
    } catch {}
  }
  return Array.from(byName.values()).join('; ');
}

module.exports = { buildPassoApiCookieHeader };
