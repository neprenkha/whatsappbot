'use strict';

/**
 * BootAnnounceHub (Core)
 * Thin loader: loads implFile + implConfig from hub conf.
 */
const path = require('path');

module.exports.init = async function init(meta) {
  const noop = { onEvent: async () => {}, onMessage: async () => {} };

  const hubConf = meta.hubConf || {};
  const implFile = String(hubConf.implFile || '').trim();
  const implConfig = String(hubConf.implConfig || '').trim();

  if (!implFile) {
    meta.log('loader', `module.error id=${meta.id} err=Missing implFile in hubConf (${meta.hubConfPath})`);
    return noop;
  }

  const implAbs = path.isAbsolute(implFile)
    ? implFile
    : path.join(String(meta.codeRoot || ''), implFile);

  let impl;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    impl = require(implAbs);
  } catch (err) {
    meta.log('loader', `module.error id=${meta.id} err=Require failed file=${implFile} msg=${err?.message || err}`);
    return noop;
  }

  let cfg = { absPath: '', conf: {} };
  if (implConfig) {
    try {
      const res = meta.loadConfRel(implConfig);
      if (res && typeof res === 'object' && Object.prototype.hasOwnProperty.call(res, 'conf')) {
        cfg = { absPath: String(res.absPath || ''), conf: res.conf || {} };
      } else {
        cfg = { absPath: '', conf: res || {} };
      }
    } catch (err) {
      meta.log('loader', `module.error id=${meta.id} err=loadConfRel failed cfg=${implConfig} msg=${err?.message || err}`);
      cfg = { absPath: '', conf: {} };
    }
  }

  const implInit =
    (impl && typeof impl.init === 'function') ? impl.init :
    (impl && impl.default && typeof impl.default.init === 'function') ? impl.default.init :
    null;

  if (!implInit) {
    meta.log('loader', `module.error id=${meta.id} err=Impl missing init() file=${implFile}`);
    return noop;
  }

  try {
    return await implInit({
      ...meta,
      implConf: cfg.conf,
      implConfPath: cfg.absPath,
    });
  } catch (err) {
    meta.log('loader', `module.error id=${meta.id} err=Impl init failed file=${implFile} msg=${err?.message || err}`);
    return noop;
  }
};
