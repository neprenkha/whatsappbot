'use strict';

const path = require('path');

module.exports.init = async function init(meta) {
  const hubCfg = meta.hubConf || {};
  const implFile = hubCfg.implFile;

  if (!implFile) throw new Error('OutboxTestHub: missing implFile in hubConf');

  const absImpl = path.isAbsolute(implFile) ? implFile : path.join(meta.codeRoot, implFile);
  const impl = require(absImpl);

  if (!impl || typeof impl.init !== 'function') {
    throw new Error(`OutboxTestHub: Impl missing init() file=${implFile}`);
  }

  let implConf = {};
  if (hubCfg.implConf) {
    implConf = await meta.loadConfRel(hubCfg.implConf);
  }

  const mergedModuleConf = { ...(meta.moduleConf || {}), ...(implConf || {}) };

  return impl.init({ ...meta, moduleConf: mergedModuleConf, implConf });
};
