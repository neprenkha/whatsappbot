'use strict';

const path = require('path');

function text(v) {
  return String(v == null ? '' : v).trim();
}

function noopHandlers() {
  return { onEvent: async () => {}, onMessage: async () => {} };
}

module.exports.init = async function init(meta) {
  const hubCfgPath = text(meta && meta.raw ? meta.raw.config : '');
  let hubConf = {};

  if (meta && meta.implConf && typeof meta.implConf === 'object') {
    hubConf = meta.implConf;
  } else if (hubCfgPath && typeof meta.loadConfRel === 'function') {
    try {
      const loaded = meta.loadConfRel(hubCfgPath) || {};
      hubConf = loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
    } catch (e) {
      meta.log('ContactBookHub', `module.error id=${meta.id}, Load hub conf failed. Path=${hubCfgPath}, Error=${e.message}`);
      return noopHandlers();
    }
  }

  const implFile = text(hubConf.implFile);
  const implConfig = text(hubConf.implConfig);

  if (!implFile) {
    meta.log('ContactBookHub', `module.error id=${meta.id}, Missing implFile. Path=${hubCfgPath || '<none>'}`);
    return noopHandlers();
  }

  const absImpl = path.isAbsolute(implFile) ? implFile : path.join(meta.codeRoot, implFile);

  let impl;
  try {
    impl = require(absImpl);
  } catch (err) {
    meta.log('ContactBookHub', `module.error id=${meta.id}, Require failed. File=${absImpl}, Error=${err.message}`);
    return noopHandlers();
  }

  let cfg = { absPath: '', conf: {} };
  if (implConfig) {
    try {
      cfg = meta.loadConfRel(implConfig) || cfg;
    } catch (e) {
      meta.log('ContactBookHub', `module.error id=${meta.id}, Load impl conf failed. File=${implConfig}, Error=${e.message}`);
    }
  }

  if (!impl || typeof impl.init !== 'function') {
    meta.log('ContactBookHub', `module.error id=${meta.id}, Impl missing init(). File=${absImpl}`);
    return noopHandlers();
  }

  return impl.init({
    ...meta,
    implConf: cfg.conf || {},
    implConfPath: cfg.absPath || '',
  });
};