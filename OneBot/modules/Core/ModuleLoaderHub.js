'use strict';

const fs = require('fs');
const path = require('path');

function safeReadText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function parseKV(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
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
  const hubConfRel = String(meta?.raw?.config || meta?.config || '').trim();
  const hubConfAbs = resolveMaybeAbsolute(botConfigRoot, hubConfRel);
  const hubCfg = parseKV(safeReadText(hubConfAbs));

  const implFile = hubCfg.implFile || 'Modules/Core/ModuleLoaderV1.js';
  const implConfigRel = hubCfg.implConfig || 'modules/Core/ModuleLoaderV1.conf';

  const implAbs = resolveMaybeAbsolute(kernel.codeRoot, implFile);
  const implConfigAbs = resolveMaybeAbsolute(botConfigRoot, implConfigRel);
  const implCfg = parseKV(safeReadText(implConfigAbs));

  let implFactory;
  try {
    implFactory = require(implAbs);
  } catch (e) {
    console.log(`[ModuleLoaderHub] Error: Unable to load implementation file="${implFile}" Error=${e.message}`);
    return {
      moduleId: 'ModuleLoader',
      priority: 9999,
      async init() {},
    };
  }

  // Ensure implementation is a function
  if (typeof implFactory !== 'function') {
    console.log(`[ModuleLoaderHub] Error: Implementation is not a valid function file="${implFile}"`);
    return {
      moduleId: 'ModuleLoader',
      priority: 9999,
      async init() {},
    };
  }

  const meta2 = {
    ...meta,
    hubConfig: hubCfg,
    hubConfigPath: hubConfAbs,
    config: implCfg,
    configPath: implConfigAbs,
  };

  const inst = implFactory(meta2, services) || {
    async init() {},
  };

  inst.moduleId = 'ModuleLoader';
  inst.priority = 9999;

  return inst;
};