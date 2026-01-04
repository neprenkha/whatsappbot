'use strict';

/**
 * SendQueueHub (Core - Freeze)
 * - Loads implementation file + conf from its hub .conf
 * - Provides service: send(chatId, text, options)
 */

const path = require('path');

module.exports.init = async function init(meta) {
  const implFile = String(meta.hubConf.implFile || '').trim();
  const implConfig = String(meta.hubConf.implConfig || '').trim();

  if (!implFile) {
    meta.log('loader', `module.error id=${meta.id} err=Missing implFile in hubConf (${meta.hubConfPath})`);
    return null;
  }

  const absImpl = path.isAbsolute(implFile) ? implFile : path.join(meta.codeRoot, implFile);
  const impl = require(absImpl);

  const cfg = implConfig ? meta.loadConfRel(implConfig) : { absPath: '', conf: {} };

  return impl.init({
    ...meta,
    implConf: cfg.conf,
    implConfPath: cfg.absPath,
  });
};
