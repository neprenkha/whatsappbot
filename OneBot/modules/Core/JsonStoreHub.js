'use strict';

const path = require('path');

const TAG = 'JsonStoreHub';
const DEFAULT_PRIORITY = 9640;

module.exports.init = async function init(meta) {
  const hubConf = meta.hubConf || {};
  const moduleId = hubConf.moduleId || meta.moduleId || 'JsonStore';
  const priority = Number.isFinite(Number(hubConf.priority)) ? Number(hubConf.priority) : DEFAULT_PRIORITY;

  const implFile = String(hubConf.implFile || '').trim();
  const implConfig = String(hubConf.implConfig || '').trim();

  if (!implFile) {
    meta.log(TAG, `Missing implFile configuration. Module=${moduleId}`);
    return { id: moduleId, priority };
  }

  const absImpl = path.isAbsolute(implFile) ? implFile : path.join(meta.codeRoot, implFile);
  let impl;
  try {
    impl = require(absImpl);
  } catch (err) {
    meta.log(TAG, `Require failed: ${err.message}, File=${implFile}`);
    return { id: moduleId, priority };
  }

  let cfg = { absPath: '', conf: {} };
  if (implConfig) {
    try {
      cfg = meta.loadConfRel(implConfig) || {};
    } catch (err) {
      meta.log(TAG, `Config load failed: ${err.message}, File=${implConfig}`);
    }
  }

  if (!impl || typeof impl.init !== 'function') {
    meta.log(TAG, `Implementation missing init(). File=${implFile}`);
    return { id: moduleId, priority };
  }

  let mod;
  try {
    mod = await impl.init({
      ...meta,
      moduleId,
      implConf: cfg.conf || {},
      implConfPath: cfg.absPath || '',
    });
  } catch (err) {
    meta.log(TAG, `Implementation init failed: ${err.message}, File=${implFile}`);
    return { id: moduleId, priority };
  }

  mod.id = mod.id || moduleId;
  mod.priority = Number.isFinite(Number(mod.priority)) ? Number(mod.priority) : priority;

  return mod;
};