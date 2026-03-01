'use strict';

const path = require('path');

module.exports.init = async function init(meta) {
  const hubConf = meta.hubConf || {};
  const implFile = String(hubConf.implFile || '').trim();
  const implConfig = String(hubConf.implConfig || '').trim();

  if (!implFile) {
    meta.log('LogHub', `module.error id=${meta.id}, Missing implFile in hubConf.`);
    return null;
  }

  const absImpl = path.isAbsolute(implFile) ? implFile : path.join(meta.codeRoot, implFile);

  let impl;
  try {
    impl = require(absImpl);
  } catch (err) {
    meta.log('LogHub', `module.error id=${meta.id}, Require failed: ${err.message}. File=${absImpl}`);
    return null;
  }

  const cfg = implConfig ? meta.loadConfRel(implConfig) : { absPath: '', conf: {} };

  if (!impl || typeof impl.init !== 'function') {
    meta.log('LogHub', `module.error id=${meta.id}, Implementation missing init(). File=${absImpl}`);
    return null;
  }

  return impl.init({
    ...meta,
    implConf: cfg.conf || {},
    implConfPath: cfg.absPath || '',
  });
};