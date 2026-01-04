'use strict';

/*
  ModuleLoaderHub (CORE, FREEZE)
  - Hub primary: never put business logic here
  - Reads hub conf path from meta.raw.config (string)
  - Loads implementation file (V1/V2...) from hub conf
  - Loads implementation config from hub conf
*/

const fs = require('fs');
const path = require('path');

function safeReadText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function parseKV(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (!k) continue;
    out[k] = v;
  }
  return out;
}

function resolveMaybeAbsolute(baseRoot, maybePath) {
  if (!maybePath) return '';
  if (path.isAbsolute(maybePath)) return maybePath;
  return path.join(baseRoot, maybePath);
}

module.exports = function ModuleLoaderHub(meta, services) {
  const kernel = services.kernel;

  const botConfigRoot = path.join(kernel.dataRoot, 'bots', kernel.botName, 'config');

  const hubConfRel = String(meta?.raw?.config || meta?.config || '').trim(); // string path
  const hubConfAbs = hubConfRel ? resolveMaybeAbsolute(botConfigRoot, hubConfRel) : '';
  const hubCfg = hubConfAbs ? parseKV(safeReadText(hubConfAbs)) : {};

  const implFile = String(hubCfg.implFile || 'Modules/Core/ModuleLoaderV1.js').trim();
  const implConfigRel = String(hubCfg.implConfig || 'modules/Core/ModuleLoaderV1.conf').trim();

  const implAbs = resolveMaybeAbsolute(kernel.codeRoot, implFile);
  const implConfigAbs = resolveMaybeAbsolute(botConfigRoot, implConfigRel);
  const implCfg = parseKV(safeReadText(implConfigAbs));

  let implFactory;
  try {
    implFactory = require(implAbs);
  } catch (e) {
    console.log(`[ModuleLoaderHub] impl load error file=${implFile} err=${e?.message || e}`);
    return {
      moduleId: meta?.moduleId || 'ModuleLoader',
      priority: Number(meta?.priority ?? 9999) || 9999,
      async init() {},
      async handleMessage() {},
      async handleEvent() {}
    };
  }

  if (typeof implFactory !== 'function') {
    console.log(`[ModuleLoaderHub] impl not a function file=${implFile}`);
    return {
      moduleId: meta?.moduleId || 'ModuleLoader',
      priority: Number(meta?.priority ?? 9999) || 9999,
      async init() {},
      async handleMessage() {},
      async handleEvent() {}
    };
  }

  const meta2 = {
    ...meta,
    hubConfig: hubCfg,
    hubConfigPath: hubConfAbs,
    config: implCfg,
    configPath: implConfigAbs
  };

  const inst = implFactory(meta2, services) || {
    async init() {},
    async handleMessage() {},
    async handleEvent() {}
  };

  inst.moduleId = meta?.moduleId || inst.moduleId || 'ModuleLoader';
  inst.priority = Number(meta?.priority ?? inst.priority ?? 9999) || 9999;

  return inst;
};
