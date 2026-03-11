const delay = require('./delay');

async function evaluateSafe(target, pageFunction, ...args) {
  if (!target || typeof target.evaluate !== 'function') {
    throw new Error('evaluateSafe target is invalid');
  }
  if (typeof pageFunction !== 'function') {
    return target.evaluate(pageFunction, ...args);
  }

  try {
    return await target.evaluate(pageFunction, ...args);
  } catch (err) {
    const msg = err?.message || String(err);
    if (!/Passed function cannot be serialized/i.test(msg)) throw err;
  }

  const fnSrc = String(pageFunction || '');
  if (/\[native code\]/i.test(fnSrc)) {
    throw new Error('evaluateSafe cannot fallback native function source');
  }

  let payload;
  try {
    payload = JSON.stringify(Array.isArray(args) ? args : []);
  } catch {
    return target.evaluate(pageFunction, ...args);
  }

  const safePayload = String(payload).replace(/</g, '\\u003c');
  const script = `(function(){var __args=${safePayload};var __fn=(${fnSrc});return __fn.apply(null,__args);})()`;
  return target.evaluate(script);
}

async function waitForFunctionSafe(target, pageFunction, options = {}, ...args) {
  if (!target || typeof target.waitForFunction !== 'function') {
    throw new Error('waitForFunctionSafe target is invalid');
  }

  try {
    return await target.waitForFunction(pageFunction, options, ...args);
  } catch (err) {
    const msg = err?.message || String(err);
    if (!/Passed function cannot be serialized/i.test(msg)) throw err;
  }

  const timeoutMs = Number.isFinite(options?.timeout) ? options.timeout : 30000;
  const pollingMs = typeof options?.polling === 'number' ? options.polling : 250;
  const started = Date.now();

  for (;;) {
    const ok = await evaluateSafe(target, pageFunction, ...args).catch(() => false);
    if (ok) return { ok: true, fallback: true };
    if (Date.now() - started > timeoutMs) {
      throw new Error('WAIT_FOR_FUNCTION_TIMEOUT_SAFE');
    }
    await delay(Math.max(50, pollingMs));
  }
}

module.exports = { evaluateSafe, waitForFunctionSafe };
