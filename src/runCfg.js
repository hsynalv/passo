const { AsyncLocalStorage } = require('async_hooks');
const baseCfg = require('./config');

const als = new AsyncLocalStorage();

function getCfg() {
  const s = als.getStore();
  return s || baseCfg;
}

function withRunCfg(runCfg, fn) {
  return new Promise((resolve, reject) => {
    als.run(runCfg, () => {
      Promise.resolve(fn()).then(resolve).catch(reject);
    });
  });
}

module.exports = { getCfg, withRunCfg };
