'use strict';

/*
SharedLogV1
Minimal logger wrapper.

Exports:
- create(meta, tag)
- makeLog(meta, tag) (back-compat alias)
*/

function _ts(meta) {
  try {
    if (meta && typeof meta.now === 'function') return meta.now();
  } catch (e) {}
  return new Date().toISOString();
}

function _safe(v) {
  try {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v instanceof Error) return v.stack || v.message || String(v);
    return JSON.stringify(v);
  } catch (e) {
    try { return String(v); } catch (e2) { return ''; }
  }
}

function create(meta, tag) {
  const tg = tag ? String(tag) : 'Log';

  function write(level, args) {
    const t = _ts(meta);
    const lv = level ? String(level) : 'info';
    let msg = '';
    try {
      msg = Array.prototype.slice.call(args || []).map(_safe).filter(Boolean).join(' ');
    } catch (e) {
      msg = '';
    }

    const line = `${t} [${tg}] ${lv} ${msg}`.trim();

    try {
      if (meta && typeof meta.log === 'function') {
        meta.log(line);
        return;
      }
    } catch (e) {}

    try {
      if (lv === 'error') return console.error(line);
      if (lv === 'warn') return console.warn(line);
      return console.log(line);
    } catch (e) {}
  }

  return {
    info: function() { write('info', arguments); },
    warn: function() { write('warn', arguments); },
    error: function() { write('error', arguments); },
    debug: function() { write('debug', arguments); },
    trace: function() { write('trace', arguments); }
  };
}

function makeLog(meta, tag) {
  return create(meta, tag);
}

module.exports = {
  create,
  makeLog
};
