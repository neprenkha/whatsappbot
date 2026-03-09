'use strict';

const path = require('path');

function text(v) {
  return String(v == null ? '' : v).trim();
}

function noopHandlers() {
  return { onEvent: async () => {}, onMessage: async () => {} };
}

module.exports.init = async function init(meta) {
  const pointerPath = text(meta && meta.raw ? meta.raw.config : '');
  let pointer = {};

  if (meta && meta.implConf && typeof meta.implConf === 'object') {
    pointer = meta.implConf;
  } else if (pointerPath && typeof meta.loadConfRel === 'function') {
    try {
      const loaded = meta.loadConfRel(pointerPath) || {};
      pointer = loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
    } catch (e) {
      meta.log('ContactBookHub', `module.error id=${meta.id}, pointer_load_failed path=${pointerPath} err=${e.message}`);
      return noopHandlers();
    }
  }

  const implFile = text(pointer.implFile);
  const implConfig = text(pointer.implConfig);
  if (!implFile) {
    meta.log('ContactBookHub', `module.error id=${meta.id}, missing_impl_file path=${pointerPath || '<none>'}`);
    return noopHandlers();
  }

  const absImpl = path.isAbsolute(implFile) ? implFile : path.join(meta.codeRoot, implFile);

  let impl;
  try {
    impl = require(absImpl);
  } catch (e) {
    meta.log('ContactBookHub', `module.error id=${meta.id}, impl_require_failed file=${absImpl} err=${e.message}`);
    return noopHandlers();
  }

  const implCfg = { absPath: '', conf: {} };
  if (implConfig) {
    try {
      const loaded = meta.loadConfRel(implConfig) || {};
      implCfg.absPath = text(loaded.absPath);
      implCfg.conf = loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
    } catch (e) {
      meta.log('ContactBookHub', `module.error id=${meta.id}, impl_conf_load_failed file=${implConfig} err=${e.message}`);
    }
  }

  if (!impl || typeof impl.init !== 'function') {
    meta.log('ContactBookHub', `module.error id=${meta.id}, impl_missing_init file=${absImpl}`);
    return noopHandlers();
  }

  return impl.init({
    ...meta,
    implConf: implCfg.conf,
    implConfPath: implCfg.absPath,
  });
};