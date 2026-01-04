'use strict';

// InboundDedupeHub
// Loads Current impl and passes implConf to meta.implConf.

const path = require('path');
const fs = require('fs');

function readConf(meta, confRelPath) {
  if (!confRelPath) return {};
  const p = path.join(meta.dataRoot, confRelPath); // dataRoot points to X:\OneData\bots\ONEBOT
  try {
    const raw = fs.readFileSync(p, 'utf8');
    // conf format is simple key=value lines; meta.parseConf exists in Kernel typically.
    if (typeof meta.parseConf === 'function') return meta.parseConf(raw);
    // fallback parser
    const cfg = {};
    for (const line of raw.split(/\r?\n/)) {
      const t = String(line || '').trim();
      if (!t || t.startsWith('#') || t.startsWith('//')) continue;
      const idx = t.indexOf('=');
      if (idx <= 0) continue;
      const k = t.slice(0, idx).trim();
      const v = t.slice(idx + 1).trim();
      cfg[k] = v;
    }
    return cfg;
  } catch (_e) {
    return {};
  }
}

module.exports.init = async function init(meta) {
  const hub = meta.hubConf || {};
  const enabled = String(hub.enabled || '1') === '1';
  if (!enabled) return;

  const implFile = String(hub.implFile || '').trim();
  const implConfig = String(hub.implConfig || '').trim();
  if (!implFile) throw new Error('[InboundDedupeHub] implFile missing');

  const implPath = path.join(meta.codeRoot, implFile);
  const impl = require(implPath);

  const implConf = readConf(meta, implConfig);

  const meta2 = Object.assign({}, meta, { implConf });
  if (!impl || typeof impl.init !== 'function') {
    throw new Error(`[InboundDedupeHub] impl.init not found: ${implPath}`);
  }
  return impl.init(meta2);
};
