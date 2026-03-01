'use strict';

const path = require('path');

module.exports.init = async function init(meta) {
  const hubConf = meta.hubConf || {};
  const enabled = !['0', 'false', 'off'].includes(String(hubConf.enabled || '1').trim().toLowerCase());

  if (!enabled) {
    meta.log('InstanceLockHub', 'Initialization disabled via configuration.');
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  const implFile = String(hubConf.implFile || 'Modules/Core/InstanceLock/InstanceLockCV.js').trim();
  const implConfig = String(hubConf.implConfig || '').trim();

  let impl;
  try {
    impl = require(path.join(meta.codeRoot, implFile));
  } catch (e) {
    meta.log('InstanceLockHub', `Error: Failed to require implementation file. File=${implFile}, Error=${e.message}`);
    throw e;
  }

  const cfg = implConfig ? meta.loadConfRel(implConfig) : { absPath: '', conf: {} };

  if (!impl || typeof impl.init !== 'function') {
    throw new Error(`InstanceLock implementation is missing init(): ${implFile}`);
  }

  return impl.init({
    ...meta,
    implConf: cfg.conf || {},
    implConfPath: cfg.absPath || '',
  });
};