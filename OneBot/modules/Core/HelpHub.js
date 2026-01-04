'use strict';

/**
 * HelpHub (Core - Freeze)
 * Loads implementation file + conf from its hub .conf
 */
const path = require('path');

module.exports.init = async function init(meta) {
  const implFile = String(meta.hubConf.implFile || '').trim();
  const implConfig = String(meta.hubConf.implConfig || '').trim();

  if (!implFile) {
    meta.log('loader', `module.error id=${meta.id} err=Missing implFile in hubConf (${meta.hubConfPath})`);
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  const absImpl = path.isAbsolute(implFile) ? implFile : path.join(meta.codeRoot, implFile);
  const impl = require(absImpl);

  const cfg = implConfig ? meta.loadConfRel(implConfig) : { absPath: '', conf: {} };

  if (!impl || typeof impl.init !== 'function') {
    meta.log('loader', `module.error id=${meta.id} err=Impl missing init() file=${implFile}`);
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  return impl.init({
    ...meta,
    implConf: cfg.conf,
    implConfPath: cfg.absPath,
  });
};
