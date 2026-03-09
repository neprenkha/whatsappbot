'use strict';

const path = require('path');

function text(v) {
  return String(v == null ? '' : v).trim();
}

function noop() {
  return { onEvent: async () => {}, onMessage: async () => {} };
}

module.exports.init = async function init(meta) {
  const ptrCfgPath = text(meta && meta.raw ? meta.raw.config : '');
  let ptrCfg = {};

  if (meta && meta.implConf && typeof meta.implConf === 'object') {
    ptrCfg = meta.implConf;
  } else if (ptrCfgPath && typeof meta.loadConfRel === 'function') {
    try {
      const loaded = meta.loadConfRel(ptrCfgPath) || {};
      ptrCfg = loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
    } catch (e) {
      meta.log('ContactBookHub', `module.error id=${meta.id}, pointer_load_failed path=${ptrCfgPath} err=${e.message}`);
      return noop();
    }
  }

  const implFile = text(ptrCfg.implFile);
  const implConfig = text(ptrCfg.implConfig);
  if (!implFile) {
    meta.log('ContactBookHub', `module.error id=${meta.id}, missing_implFile path=${ptrCfgPath || '<none>'}`);
    return noop();
  }

  const absImpl = path.isAbsolute(implFile) ? implFile : path.join(meta.codeRoot, implFile);

  let impl;
  try {
    impl = require(absImpl);
  } catch (e) {
    meta.log('ContactBookHub', `module.error id=${meta.id}, require_failed file=${absImpl} err=${e.message}`);
    return noop();
  }

  const loadedImplCfg = { absPath: '', conf: {} };
  if (implConfig) {
    try {
      const loaded = meta.loadConfRel(implConfig) || {};
      loadedImplCfg.absPath = text(loaded.absPath);
      loadedImplCfg.conf = loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
    } catch (e) {
      meta.log('ContactBookHub', `module.error id=${meta.id}, impl_cfg_load_failed file=${implConfig} err=${e.message}`);
    }
  }

  if (!impl || typeof impl.init !== 'function') {
    meta.log('ContactBookHub', `module.error id=${meta.id}, impl_missing_init file=${absImpl}`);
    return noop();
  }

  return impl.init({
    ...meta,
    implConf: loadedImplCfg.conf,
    implConfPath: loadedImplCfg.absPath,
  });
};