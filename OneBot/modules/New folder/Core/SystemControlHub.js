'use strict';

/*
  SystemControlHub (CORE, FREEZE)
  - Loads implementation file + impl conf from hub .conf
  - Must be compatible with init(meta) loader style
  - Also safe if called in older factory(meta, services) style
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

function makeMetaHelpers(meta, services) {
  const kernel =
    meta?.kernel ||
    services?.kernel ||
    meta?.services?.kernel ||
    null;

  const botName = meta?.botName || kernel?.botName || process.env.ONEBOT_BOT_NAME || 'ONEBOT';
  const codeRoot = meta?.codeRoot || kernel?.codeRoot || process.env.ONEBOT_CODE_ROOT || 'X:\\OneBot';
  const dataRoot = meta?.dataRoot || kernel?.dataRoot || process.env.ONEBOT_DATA_ROOT || 'X:\\OneData';

  const botConfigRoot = path.join(dataRoot, 'bots', botName, 'config');

  const log = (tag, msg) => {
    if (typeof meta?.log === 'function') return meta.log(tag, msg);
    try { console.log(`[${tag}] ${msg}`); } catch {}
  };

  const loadConfRel = (relPath) => {
    if (typeof meta?.loadConfRel === 'function') return meta.loadConfRel(relPath);

    const absPath = resolveMaybeAbsolute(botConfigRoot, relPath);
    const conf = parseKV(safeReadText(absPath));
    return { absPath, conf };
  };

  return { kernel, botName, codeRoot, dataRoot, botConfigRoot, log, loadConfRel };
}

async function buildInstance(meta, services) {
  meta = meta || {};
  const H = makeMetaHelpers(meta, services);

  // hubConf can come from loader (preferred) OR we load from meta.raw/config
  const hubConf =
    meta?.hubConf ||
    meta?.config ||
    null;

  let hubCfg = hubConf && typeof hubConf === 'object' ? hubConf : null;

  // If hubConf not provided as object, try load from configPath / raw.config
  if (!hubCfg) {
    const hubConfRel =
      meta?.hubConfPath ||
      meta?.configPath ||
      meta?.raw?.config ||
      meta?.config ||
      '';

    if (hubConfRel && typeof hubConfRel === 'string') {
      const absHub = resolveMaybeAbsolute(H.botConfigRoot, hubConfRel);
      hubCfg = parseKV(safeReadText(absHub));
      meta.hubConfPath = absHub;
    }
  }

  if (!hubCfg) {
    H.log('SystemControlHub', `module.error id=${meta.id || meta.moduleId || 'SystemControl'} err=Missing hubConf`);
    return null;
  }

  const implFile = String(hubCfg.implFile || '').trim();
  const implConfig = String(hubCfg.implConfig || '').trim();

  if (!implFile) {
    H.log('SystemControlHub', `module.error id=${meta.id || meta.moduleId || 'SystemControl'} err=Missing implFile`);
    return null;
  }

  const absImpl = resolveMaybeAbsolute(H.codeRoot, implFile);
  const impl = require(absImpl);

  const cfg = implConfig ? H.loadConfRel(implConfig) : { absPath: '', conf: {} };

  const meta2 = {
    ...meta,
    kernel: H.kernel,
    botName: H.botName,
    codeRoot: H.codeRoot,
    dataRoot: H.dataRoot,

    hubConf: hubCfg,
    hubConfPath: meta?.hubConfPath || meta?.configPath || '',

    implConf: cfg.conf,
    implConfPath: cfg.absPath,
  };

  // Preferred: impl.init(meta)
  if (impl && typeof impl.init === 'function') {
    return impl.init(meta2);
  }

  // Fallback: old style factory(meta, services)
  if (typeof impl === 'function') {
    const inst = impl(meta2, services) || null;
    return inst;
  }

  H.log('SystemControlHub', `module.error id=${meta.id || meta.moduleId || 'SystemControl'} err=Bad impl export`);
  return null;
}

// Export as function (old style safe) + .init (new style safe)
function SystemControlHub(meta, services) {
  // old style factory call
  return {
    init: async () => buildInstance(meta, services),
    handleMessage: async () => {},
    handleEvent: async () => {},
    onMessage: async () => {},
    onEvent: async () => {},
  };
}

SystemControlHub.init = async function init(meta) {
  // new style init(meta)
  return buildInstance(meta, null);
};

module.exports = SystemControlHub;
