'use strict';

const path = require('path');

module.exports.init = async function init(meta) {
  const cfg = meta.hubConf || {};
  const implFile = String(cfg.implFile || '').trim();
  const implConfig = String(cfg.implConfig || '').trim();

  if (!implFile) {
    meta.log('ContactBookHub', 'disabled: implFile missing');
    return {};
  }

  const absImpl = path.isAbsolute(implFile) ? implFile : path.join(meta.codeRoot, implFile);

  let impl;
  try {
    impl = require(absImpl);
  } catch (err) {
    meta.log('ContactBookHub', `disabled: require failed file=${implFile} err=${err.message}`);
    return {};
  }

  if (!impl || typeof impl.init !== 'function') {
    meta.log('ContactBookHub', `disabled: init missing file=${implFile}`);
    return {};
  }

  let implConf = {};
  if (implConfig) {
    try {
      const loaded = meta.loadConfRel(implConfig) || {};
      implConf = loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
    } catch (err) {
      meta.log('ContactBookHub', `disabled: implConfig load failed file=${implConfig} err=${err.message}`);
      return {};
    }
  }

  return impl.init({ ...meta, implConf });
};