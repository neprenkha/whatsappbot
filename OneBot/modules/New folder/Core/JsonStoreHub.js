'use strict';

const path = require('path');

const TAG = 'JsonStoreHub';
const DEFAULT_PRIORITY = 9640;

module.exports.init = async function init(meta) {
  const hub = meta.hubConf || {};

  const moduleId = hub.moduleId || meta.moduleId || 'JsonStore';
  const priority = Number.isFinite(Number(hub.priority)) ? Number(hub.priority) : DEFAULT_PRIORITY;

  const implFileRel = (hub.implFile || '').trim();
  const implConfRel = (hub.implConfig || hub.implConf || '').trim(); // support both keys

  if (!implFileRel) {
    meta.log(TAG, 'Missing implFile in hub config.');
    return { id: moduleId, priority };
  }

  const implAbs = path.isAbsolute(implFileRel) ? implFileRel : path.join(meta.codeRoot, implFileRel);

  let impl;
  try {
    impl = require(implAbs);
  } catch (err) {
    meta.log(TAG, `Impl require failed: ${implFileRel}`, { err: String(err) });
    return { id: moduleId, priority };
  }

  // load impl config (optional)
  let cfg = { absPath: '', conf: {} };
  if (implConfRel) {
    try {
      cfg = meta.loadConfRel(implConfRel);
    } catch (err) {
      meta.log(TAG, `Impl config load failed: ${implConfRel}`, { err: String(err) });
      cfg = { absPath: '', conf: {} };
    }
  }

  const childMeta = {
    ...meta,
    moduleId,
    implConf: cfg.conf || {},
    implConfPath: cfg.absPath || '',
    implConfig: cfg.conf || {},       // alias
    implConfigPath: cfg.absPath || '', // alias
  };

  if (!impl || typeof impl.init !== 'function') {
    meta.log(TAG, `Impl missing init() file=${implFileRel}`);
    return { id: moduleId, priority };
  }

  let mod;
  try {
    mod = await impl.init(childMeta);
  } catch (err) {
    meta.log(TAG, `Impl init failed: ${implFileRel}`, { err: String(err) });
    return { id: moduleId, priority };
  }

  // normalize
  if (!mod || typeof mod !== 'object') mod = {};
  mod.id = mod.id || moduleId;
  mod.priority = Number.isFinite(Number(mod.priority)) ? Number(mod.priority) : priority;

  return mod;
};
