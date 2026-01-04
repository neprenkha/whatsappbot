'use strict';

const path = require('path');

module.exports.init = async function init(meta) {
  const hubConf = meta.hubConf || {};
  const implFile = (hubConf.implFile || '').trim();
  if (!implFile) {
    meta.log('OutboundGatewayHub', 'disabled: implFile missing in hub conf');
    return {};
  }

  const implPath = path.join(meta.codeRoot, implFile);
  let impl;
  try {
    impl = require(implPath);
  } catch (e) {
    meta.log('OutboundGatewayHub', `disabled: require failed implFile="${implFile}" err=${e && e.message ? e.message : e}`);
    return {};
  }

  if (!impl || typeof impl.init !== 'function') {
    meta.log('OutboundGatewayHub', `disabled: impl missing init() file=${implFile}`);
    return {};
  }

  let implCfg = { conf: {} };
  const implConfig = (hubConf.implConfig || '').trim();
  if (implConfig) {
    try {
      implCfg = meta.loadConfRel(implConfig) || { conf: {} };
    } catch (e) {
      meta.log('OutboundGatewayHub', `implConfig load failed file=${implConfig} err=${e && e.message ? e.message : e}`);
      implCfg = { conf: {} };
    }
  }

  const meta2 = Object.assign({}, meta, {
    implConf: implCfg.conf || {},
  });

  return await impl.init(meta2);
};
