'use strict';

const path = require('path');

module.exports.init = async function init(meta) {
  const hubConf = meta.hubConf || {};
  const implFile = String(hubConf.implFile || '').trim();
  const implConfig = String(hubConf.implConfig || '').trim();

  if (!implFile) {
    meta.log('SendQueueHub', `Error: Missing implFile in hubConf. Path=${meta.hubConfPath}`);
    return null;
  }

  const absImpl = path.isAbsolute(implFile) ? implFile : path.join(meta.codeRoot, implFile);

  let impl;
  try {
    impl = require(absImpl);
  } catch (e) {
    meta.log('SendQueueHub', `Error: Failed to require file=${implFile}, Error=${e.message}`);
    return null;
  }

  const cfg = implConfig ? meta.loadConfRel(implConfig) : { absPath: '', conf: {} };

  if (!impl || typeof impl.init !== 'function') {
    meta.log('SendQueueHub', `Error: Implementation missing init() in file=${implFile}`);
    return null;
  }

  return impl.init({
    ...meta,
    implConf: cfg.conf || {},
    implConfPath: cfg.absPath || '',
  });
};