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
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function resolveMaybeAbsolute(baseRoot, maybePath) {
  if (!maybePath) return '';
  return path.isAbsolute(maybePath) ? maybePath : path.join(baseRoot, maybePath);
}

function makeMetaHelpers(meta, services) {
  const kernel = meta?.services?.kernel || services?.kernel || null;
  const botName = meta?.botName || kernel?.botName || 'ONEBOT';
  const codeRoot = meta?.codeRoot || kernel?.codeRoot || 'X:\\OneBot';
  const dataRoot = meta?.dataRoot || kernel?.dataRoot || 'X:\\OneData';
  const botConfigRoot = path.join(dataRoot, 'bots', botName, 'config');

  const log = (tag, msg) => {
    try {
      if (typeof meta?.log === 'function') meta.log(tag, msg);
      else console.log(`[${tag}] ${msg}`);
    } catch (_) {}
  };

  const loadConfRel = (relPath) => {
    const absPath = resolveMaybeAbsolute(botConfigRoot, relPath || '');
    const conf = parseKV(safeReadText(absPath));
    return { absPath, conf };
  };

  return { kernel, botName, codeRoot, dataRoot, botConfigRoot, log, loadConfRel };
}

async function buildInstance(meta, services) {
  const H = makeMetaHelpers(meta, services);

  const hubConf = meta.hubConf || parseKV(safeReadText(H.resolveMaybeAbsolute(H.botConfigRoot, meta.raw?.config || '')));
  if (!hubConf) {
    H.log('SystemControlHub', `Error: Missing hubConf in meta or config path.`);
    return null;
  }

  const implFile = hubConf.implFile?.trim();
  if (!implFile) {
    H.log('SystemControlHub', `Error: Missing implFile in hubConf.`);
    return null;
  }

  const implPath = resolveMaybeAbsolute(H.codeRoot, implFile);
  let impl;
  try {
    impl = require(implPath);
  } catch (e) {
    H.log('SystemControlHub', `Error: Failed to load implementation file="${implFile}". Error=${e.message}`);
    return null;
  }

  const cfg = hubConf.implConfig ? H.loadConfRel(hubConf.implConfig) : { absPath: '', conf: {} };
  const metaWithImpl = { ...meta, implConf: cfg.conf, implConfPath: cfg.absPath };

  if (impl && typeof impl.init === 'function') return impl.init(metaWithImpl);

  H.log('SystemControlHub', `Error: Bad export from implementation file="${implFile}".`);
  return null;
}

function SystemControlHub(meta, services) {
  return {
    init: async () => buildInstance(meta, services),
    onMessage: async () => {},
    onEvent: async () => {},
  };
}

SystemControlHub.init = async function init(meta) {
  return buildInstance(meta, null);
};

module.exports = SystemControlHub;