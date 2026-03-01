'use strict';

/*
  SharedConfV1
  - Lightweight .conf helpers (key=value)
  - Provides Conf.load(meta, relPath) -> wrapper with getStr/getBool/getInt/getCsv
  - Compatible with existing imports: toStr/toBool/toInt/parseCsv/readKv
  Version: 2026.01.01
*/

function toStr(v, defVal = '') {
  if (v === null || typeof v === 'undefined') return String(defVal || '');
  return String(v);
}

function toBool(v, defVal = false) {
  if (typeof v === 'boolean') return v;
  const s = toStr(v, '').trim().toLowerCase();
  if (!s) return !!defVal;
  if (['1', 'true', 'yes', 'y', 'on', 'enable', 'enabled'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'disable', 'disabled'].includes(s)) return false;
  return !!defVal;
}

function toInt(v, defVal = 0) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  const n = parseInt(toStr(v, '').trim(), 10);
  return Number.isFinite(n) ? n : (Number.isFinite(defVal) ? defVal : 0);
}

function parseCsv(v) {
  const s = toStr(v, '').trim();
  if (!s) return [];
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

function readKv(obj, key, defVal = '') {
  if (!obj || typeof obj !== 'object') return defVal;
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return defVal;
  const v = obj[key];
  if (v === null || typeof v === 'undefined') return defVal;
  return v;
}

function wrap(confObj) {
  const raw = (confObj && typeof confObj === 'object') ? confObj : {};
  return {
    raw,
    get: (k, defVal) => readKv(raw, k, defVal),
    getStr: (k, defVal = '') => toStr(readKv(raw, k, defVal), defVal).trim(),
    getBool: (k, defVal = false) => toBool(readKv(raw, k, defVal), defVal),
    getInt: (k, defVal = 0) => toInt(readKv(raw, k, defVal), defVal),
    getCsv: (k, defVal = []) => {
      const a = parseCsv(readKv(raw, k, ''));
      return a.length ? a : (Array.isArray(defVal) ? defVal : []);
    }
  };
}

/**
 * Conf.load(meta, relPath?)
 * - If relPath is provided and meta.loadConfRel exists, it loads that file.
 * - Otherwise, it wraps meta.implConf (preferred) or meta.hubConf.
 */
function load(meta, relPath) {
  try {
    if (relPath && meta && typeof meta.loadConfRel === 'function') {
      const loaded = meta.loadConfRel(relPath);
      return wrap(loaded && loaded.conf ? loaded.conf : {});
    }
  } catch (e) {
    // fall through
  }
  if (meta && meta.implConf && typeof meta.implConf === 'object') return wrap(meta.implConf);
  if (meta && meta.hubConf && typeof meta.hubConf === 'object') return wrap(meta.hubConf);
  return wrap({});
}

module.exports = {
  toStr,
  toBool,
  toInt,
  parseCsv,
  readKv,
  wrap,
  load
};
