'use strict';

const fs = require('fs');

function parseConf(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    out[k] = v;
  }
  return out;
}

function loadTipsMap(filePath) {
  if (!filePath) return {};
  try { return parseConf(fs.readFileSync(String(filePath), 'utf8')); } catch (_) { return {}; }
}

function getTips(tipsMap, key) {
  const m = tipsMap || {};
  return String(m[key] || m['global.default'] || '').trim();
}

module.exports = { loadTipsMap, getTips };
