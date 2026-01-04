'use strict';

const path = require('path');

module.exports.init = async function init(meta) {
  const hubConf = meta.hubConf || {};
  const implFile = String(hubConf.implFile || '').trim();
  const implConfig = String(hubConf.implConfig || '').trim();

  if (!implFile) {
    meta.log('FallbackHub', 'disabled: missing implFile in hub conf');
    return {};
  }

  let implAbs = implFile;
  if (!path.isAbsolute(implAbs)) {
    implAbs = path.join(meta.codeRoot, implAbs);
  }

  let impl;
  try {
    impl = require(implAbs);
  } catch (e) {
    meta.log('FallbackHub', `disabled: require failed: ${e && e.message ? e.message : e}`);
    return {};
  }

  if (!impl || typeof impl.init !== 'function') {
    meta.log('FallbackHub', 'disabled: impl.init is not a function');
    return {};
  }

  let implConf = {};
  if (implConfig) {
    try {
      const loaded = meta.loadConfRel(implConfig);
      implConf = (loaded && loaded.conf) ? loaded.conf : {};
    } catch (e) {
      meta.log('FallbackHub', `warn: implConfig load failed, using defaults: ${e && e.message ? e.message : e}`);
      implConf = {};
    }
  }

  const meta2 = Object.assign({}, meta, { implConf });
  return impl.init(meta2);
};
