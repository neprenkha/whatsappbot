'use strict';

function toInt(v, d) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : d;
}

function toBool(v, d) {
  if (v === undefined || v === null || v === '') return !!d;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return !!d;
}

function toStr(v, d) {
  const s = (v === undefined || v === null) ? '' : String(v);
  return s.trim() ? s.trim() : (d || '');
}

function read(meta) {
  const c = (meta && meta.implConf) ? meta.implConf : {};
  return {
    enabled: toBool(c.enabled, true),
    serviceName: toStr(c.serviceName, 'send'),
    transportService: toStr(c.transportService, 'transport'),
    delayMs: Math.max(0, toInt(c.delayMs, 800)),
    maxQueue: Math.max(50, toInt(c.maxQueue, 2000)),
    batchMax: Math.max(1, toInt(c.batchMax, 30)),
    dedupeMs: Math.max(0, toInt(c.dedupeMs, 6000)),
    dedupeMax: Math.max(1000, toInt(c.dedupeMax, 8000)),
    dedupeLog: toBool(c.dedupeLog, false),
    logPrefix: toStr(c.logPrefix, 'SendQueue'),
  };
}

function log(meta, cfg, msg) {
  try { meta.log(cfg.logPrefix || 'SendQueue', msg); } catch (_) {}
}

module.exports = { read, log };
