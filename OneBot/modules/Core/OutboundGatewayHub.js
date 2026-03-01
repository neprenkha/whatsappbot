'use strict';

const path = require('path');

module.exports.init = async function init(meta) {
  const hubConf = meta.hubConf || {};
  const implFile = (hubConf.implFile || '').trim();
  if (!implFile) {
    meta.log('OutboundGatewayHub', 'disabled: implFile missing.');
    return {};
  }

  const implPath = path.join(meta.codeRoot, implFile);
  let impl;
  try {
    impl = require(implPath);
  } catch (e) {
    meta.log('OutboundGatewayHub', `Error: Failed to require ${implFile}. Error=${e.message}`);
    return {};
  }

  if (!impl || typeof impl.init !== 'function') {
    meta.log('OutboundGatewayHub', `Error: Implementation missing init() in file ${implFile}`);
    return {};
  }

  const implConfig = (hubConf.implConfig || '').trim();
  let implCfg = { conf: {} };
  if (implConfig) {
    try {
      implCfg = meta.loadConfRel(implConfig) || { conf: {} };
    } catch (e) {
      meta.log('OutboundGatewayHub', `Error loading config: ${implConfig}. Error=${e.message}`);
    }
  }

  const meta2 = { ...meta, implConf: implCfg.conf || {} };
  return await impl.init(meta2);
};