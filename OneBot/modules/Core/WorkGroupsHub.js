'use strict';

const path = require('path');

module.exports.init = async function init(meta) {
  const hubConf = meta.hubConf || {};
  const implFile = String(hubConf.implFile || '').trim();
  const implConfig = String(hubConf.implConfig || '').trim();

  if (!implFile) {
    meta.log('WorkGroupsHub', `Error: Missing implFile in hub configuration.`);
    return {};
  }

  const absImpl = path.isAbsolute(implFile) ? implFile : path.join(meta.codeRoot, implFile);

  let impl;
  try {
    impl = require(absImpl);
  } catch (err) {
    meta.log('WorkGroupsHub', `Error: Failed to require implFile="${implFile}". Error=${err.message}`);
    return {};
  }

  if (!impl || typeof impl.init !== 'function') {
    meta.log('WorkGroupsHub', `Error: impl.init() missing or invalid in file="${implFile}".`);
    return {};
  }

  let implConf = {};
  if (implConfig) {
    try {
      const loaded = meta.loadConfRel(implConfig);
      implConf = loaded?.conf || {};
    } catch (err) {
      meta.log('WorkGroupsHub', `Warning: Failed to load implConfig="${implConfig}". Error=${err.message}`);
    }
  }

  return impl.init({ ...meta, implConf });
};