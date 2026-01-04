'use strict';

/**
 * SchedulerTestHub (Feature - loader only)
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

  let impl;
  try { impl = require(absImpl); }
  catch (e) {
    meta.log('loader', `module.error id=${meta.id} err=Cannot load impl file=${implFile} (${e.message || e})`);
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  const cfg = implConfig ? meta.loadConfRel(implConfig) : { absPath: '', conf: {} };

  if (!impl || typeof impl.init !== 'function') {
    meta.log('loader', `module.error id=${meta.id} err=Impl missing init() file=${implFile}`);
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  return impl.init({ ...meta, implConf: cfg.conf, implConfPath: cfg.absPath });
};
