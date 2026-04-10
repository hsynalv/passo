/**
 * Bu hatalar çoğunlukla proxy kalitesi / credential değil; CF, shell, ulaşım.
 * Havuz blacklist ardışık sayacına yansıtılmamalı (soft markLoginFailure).
 */
function isSoftProxyLoginFailure(msg) {
  const m = String(msg || '').toLowerCase();
  if (!m) return false;
  if (m.includes('cloudflare')) return true;
  if (m.includes('kenar ağı') || m.includes('kenar agi')) return true;
  if (m.includes('chrome_error')) return true;
  if (m.includes('goto_failed')) return true;
  if (m.includes('login sayfasina erisilemedi')) return true;
  if (m.includes('login formu bulunamad')) return true;
  return false;
}

/**
 * Chromium/Node seviyesinde proxy veya tünel kopması; başka havuz proxy’si denemeye değer.
 * (Yanlış şifre / normal giriş reddi burada sayılmaz — aynı hesapla başka proxy denemek genelde anlamsız.)
 */
function isLikelyProxyTransportFailure(msg) {
  const m = String(msg || '').toLowerCase();
  if (!m) return false;
  if (m.includes('err_proxy_connection_failed')) return true;
  if (m.includes('err_proxy_certificate_invalid')) return true;
  if (m.includes('err_tunnel_connection_failed')) return true;
  if (m.includes('err_connection_reset')) return true;
  if (m.includes('err_connection_refused')) return true;
  if (m.includes('err_connection_closed')) return true;
  if (m.includes('err_address_unreachable')) return true;
  if (m.includes('econnreset')) return true;
  if (m.includes('econnrefused')) return true;
  if (m.includes('enetunreach')) return true;
  if (m.includes('socket hang up')) return true;
  if (m.includes('proxy authentication required')) return true;
  if (m.includes('establish tunnel')) return true;
  if (m.includes('failed to establish tunnel')) return true;
  if ((m.includes('407') || m.includes('proxy-authenticate')) && (m.includes('proxy') || m.includes('tunnel'))) return true;
  if (m.includes('browser has been disconnected')) return true;
  if (m.includes('target closed') || m.includes('session closed')) return true;
  if (m.includes('websocket error')) return true;
  return false;
}

/** Havuz modunda: tarayıcı kapatıldıktan sonra farklı proxy ile tekrar dene. */
function shouldRetryLoginWithAnotherPoolProxy(msg) {
  return isSoftProxyLoginFailure(msg) || isLikelyProxyTransportFailure(msg);
}

module.exports = {
  isSoftProxyLoginFailure,
  isLikelyProxyTransportFailure,
  shouldRetryLoginWithAnotherPoolProxy
};
