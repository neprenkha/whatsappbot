'use strict';

const path = require('path');

module.exports.init = async function init(meta) {
  const hubConf = meta.hubConf || {};
  const implFile = String(hubConf.implFile || '').trim();
  const implConfig = String(hubConf.implConfig || '').trim();

  if (!implFile) {
    meta.log('RateLimitHub', `Error: Missing implFile in hubConf. Path=${meta.hubConfPath}`);
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  const absImpl = path.isAbsolute(implFile) ? implFile : path.join(meta.codeRoot, implFile);

  let impl;
  try {
    impl = require(absImpl);
  } catch (e) {
    meta.log('RateLimitHub', `Error: Failed to require implementation file=${implFile}, Error=${e.message}`);
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  const cfg = implConfig ? meta.loadConfRel(implConfig) : { absPath: '', conf: {} };

  if (!impl || typeof impl.init !== 'function') {
    meta.log('RateLimitHub', `Error: Implementation missing init() in file=${implFile}`);
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  return impl.init({
    ...meta,
    implConf: cfg.conf || {},
    implConfPath: cfg.absPath || '',
  });
};