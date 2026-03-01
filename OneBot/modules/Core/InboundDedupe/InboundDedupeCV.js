'use strict';

// REWRITTEN: standalone CV implementation with config-driven inbound dedupe.

function toBool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return d;
}

function toInt(v, d) {
  const n = parseInt(String(v === undefined || v === null ? '' : v), 10);
  return Number.isFinite(n) ? n : d;
}

function toStr(v, d) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s || d;
}

function toList(v, d) {
  const raw = toStr(v, '');
  if (!raw) return Array.isArray(d) ? d.slice() : [];
  const parts = raw.split(',');
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const item = String(parts[i] || '').trim();
    if (item) out.push(item);
  }
  return out;
}

function loadGlobalConf(meta, cfg, bugLog) {
  const rel = toStr(cfg.globalConfRel, '');
  if (!rel) {
    if (bugLog) meta.log('InboundDedupeCV', 'global_conf_missing_key globalConfRel');
    return {};
  }
  try {
    const loaded = meta.loadConfRel(rel);
    return loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
  } catch (e) {
    if (bugLog) meta.log('InboundDedupeCV', 'global_conf_load_failed err=' + String(e && e.message ? e.message : e));
    return {};
  }
}

function getByPath(obj, pathExpr) {
  if (!obj || !pathExpr) return '';
  const parts = String(pathExpr).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length; i += 1) {
    const key = String(parts[i] || '').trim();
    if (!key) return '';
    if (!cur || typeof cur !== 'object' || !(key in cur)) return '';
    cur = cur[key];
  }
  if (cur === undefined || cur === null) return '';
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  try {
    return JSON.stringify(cur);
  } catch (e) {
    return '';
  }
}

function normalizeValue(v) {
  return String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

module.exports.init = async function init(meta) {
  const cfg = meta && meta.implConf ? meta.implConf : {};

  const enabled = toBool(cfg.enabled, true);
  const moduleLog = toBool(cfg.moduleLog, true);
  const bugLog = toBool(cfg.bugLog, true);
  const detailLog = toBool(cfg.detailLog, false);
  const traceLog = toBool(cfg.traceLog, false);

  if (!enabled) {
    if (moduleLog) meta.log('InboundDedupeCV', 'disabled');
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const globalConf = loadGlobalConf(meta, cfg, bugLog);
  void globalConf;

  const dedupeMs = Math.max(1, toInt(cfg.dedupeMs, 6000));
  const maxKeys = Math.max(100, toInt(cfg.maxKeys, 8000));
  const keyFields = toList(cfg.keyFields, ['chatId', 'sender.id', 'text', 'raw.id._serialized']);
  const keyMode = toStr(cfg.keyMode, 'all');
  const skipWhenFromMe = toBool(cfg.skipWhenFromMe, false);
  const skipWhenCommand = toBool(cfg.skipWhenCommand, false);
  const commandPrefixes = toList(cfg.commandPrefixes, ['!', '/', '#']);

  const seenMap = new Map();

  function cleanup(nowMs) {
    for (const row of seenMap.entries()) {
      const k = row[0];
      const exp = row[1];
      if (exp <= nowMs) seenMap.delete(k);
    }
    if (seenMap.size > maxKeys) {
      const overflow = seenMap.size - maxKeys;
      let removed = 0;
      for (const k of seenMap.keys()) {
        seenMap.delete(k);
        removed += 1;
        if (removed >= overflow) break;
      }
    }
  }

  function isCommand(text) {
    const s = String(text || '').trim();
    if (!s) return false;
    for (let i = 0; i < commandPrefixes.length; i += 1) {
      const p = String(commandPrefixes[i] || '');
      if (p && s.indexOf(p) === 0) return true;
    }
    return false;
  }

  function buildParts(ev) {
    const parts = [];
    for (let i = 0; i < keyFields.length; i += 1) {
      const p = keyFields[i];
      const val = normalizeValue(getByPath(ev, p));
      if (keyMode === 'all') {
        parts.push(val || '-');
      } else if (val) {
        parts.push(val);
      }
    }
    return parts;
  }

  function shouldSkip(ev) {
    if (skipWhenFromMe && toBool(getByPath(ev, 'raw.fromMe') || ev.fromMe, false)) return true;
    if (skipWhenCommand && isCommand(getByPath(ev, 'text'))) return true;
    return false;
  }

  async function onMessage(ctx) {
    try {
      const ev = ctx && ctx.message ? ctx.message : ctx;
      if (!ev || typeof ev !== 'object') return;

      if (shouldSkip(ev)) return;

      const parts = buildParts(ev);
      if (!parts.length) return;

      const key = parts.join('|');
      const nowMs = Date.now();

      cleanup(nowMs);

      const exp = Number(seenMap.get(key) || 0);
      if (exp > nowMs) {
        if (traceLog || detailLog) {
          const chatId = toStr(getByPath(ev, 'chatId'), '');
          meta.log('InboundDedupeCV', 'dedupe_drop chatId=' + chatId + ' key=' + key.slice(0, 120));
        }
        if (ctx && typeof ctx.stopPropagation === 'function') ctx.stopPropagation();
        return;
      }

      seenMap.set(key, nowMs + dedupeMs);
    } catch (e) {
      if (bugLog) meta.log('InboundDedupeCV', 'onMessage_error err=' + String(e && e.message ? e.message : e));
    }
  }

  if (moduleLog) {
    meta.log('InboundDedupeCV', 'ready dedupeMs=' + String(dedupeMs) + ' maxKeys=' + String(maxKeys) + ' keyMode=' + keyMode + ' keyFields=' + keyFields.join(','));
  }

  return {
    onMessage,
    onEvent: async () => {}
  };
};