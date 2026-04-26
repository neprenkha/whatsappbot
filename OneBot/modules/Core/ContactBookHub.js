'use strict';

const path = require('path');

function text(v) {
  return String(v == null ? '' : v).trim();
}

function noopHandlers() {
  return { onEvent: async () => {}, onMessage: async () => {} };
}

module.exports.init = async function init(meta) {
  const hubConf = meta && meta.hubConf && typeof meta.hubConf === 'object' ? meta.hubConf : {};
  const implFile = text(hubConf.implFile);
  const implConfig = text(hubConf.implConfig);

  if (!implFile) {
    meta.log('ContactBookHub', `module.error id=${meta.id}, missing_impl_file hubConfPath=${meta.hubConfPath || '<none>'}`);
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

  let implCfg = { absPath: '', conf: {} };
  if (implConfig) {
    try {
      const loaded = meta.loadConfRel(implConfig) || {};
      implCfg = {
        absPath: text(loaded.absPath),
        conf: loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {},
      };
    } catch (e) {
      meta.log('ContactBookHub', `module.error id=${meta.id}, impl_conf_load_failed file=${implConfig} err=${e.message}`);
      return noopHandlers();
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