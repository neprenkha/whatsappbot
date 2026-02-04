'use strict';

const path = require('path');

module.exports.init = async function init(meta) {
  const hubConf = meta.hubConf || {};
  const implFile = String(hubConf.implFile || '').trim();
  const implConfig = String(hubConf.implConfig || '').trim();

  if (!implFile) {
    meta.log('HelpHub', `module.error id=${meta.id}, Missing implFile in hubConf. Path=${meta.hubConfPath}`);
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  const absImpl = path.isAbsolute(implFile) ? implFile : path.join(meta.codeRoot, implFile);

  let impl;
  try {
    impl = require(absImpl);
  } catch (err) {
    meta.log('HelpHub', `module.error id=${meta.id}, Require failed: ${err.message}. File=${absImpl}`);
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  const cfg = implConfig ? meta.loadConfRel(implConfig) : { absPath: '', conf: {} };

  if (!impl || typeof impl.init !== 'function') {
    meta.log('HelpHub', `module.error id=${meta.id}, Impl missing init(). File=${absImpl}`);
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  return impl.init({
    ...meta,
    implConf: cfg.conf,
    implConfPath: cfg.absPath,
  });
};