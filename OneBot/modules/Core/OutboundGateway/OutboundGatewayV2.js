'use strict';

// OutboundGatewayV2
// Fix: return real transport message result (msgId) instead of always ok:true.
// Uses RateLimit service to gate + commit after successful send.

const TAG = 'OutboundGatewayV2';

function toInt(v, defVal) {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : defVal;
}

function toBool(v, defVal) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return defVal;
  return !(s === '0' || s === 'false' || s === 'no' || s === 'off');
}

function toStr(v, defVal) {
  const s = String(v ?? '').trim();
  return s ? s : defVal;
}

function parseCsv(csv) {
  return String(csv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBypassSet(csv) {
  const set = new Set();
  for (const id of parseCsv(csv)) set.add(id);
  return set;
}

function pickSendFn(meta, preferCsv) {
  const names = parseCsv(preferCsv);
  for (const name of names) {
    const svc = meta.getService(name);
    if (typeof svc === 'function') return { name, fn: svc };
    if (svc && typeof svc.sendDirect === 'function') return { name, fn: (chatId, payload, opts) => svc.sendDirect(chatId, payload, opts || {}) };
  }
  const t = meta.getService('transport');
  if (t && typeof t.sendDirect === 'function') return { name: 'transport', fn: (chatId, payload, opts) => t.sendDirect(chatId, payload, opts || {}) };
  return { name: '', fn: null };
}

module.exports.init = async function init(meta) {
  const cfg = meta.implConf || {};

  const enabled = toBool(cfg.enabled, true);
  const baseSendPrefer = toStr(cfg.baseSend, 'transport');
  const services = toStr(cfg.services, 'outsend,sendout');
  const ratelimitService = toStr(cfg.ratelimitService, 'ratelimit');
  const bypassChatIds = parseBypassSet(cfg.bypassChatIds);

  const moduleLog = toBool(cfg.moduleLog, true);
  const bugLog = toBool(cfg.bugLog, true);
  const traceLog = toBool(cfg.traceLog, false);

  const base = pickSendFn(meta, baseSendPrefer);
  if (!base.fn) {
    meta.log(TAG, `disabled: baseSend missing baseSend=${baseSendPrefer}`);
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const rl = meta.getService(ratelimitService);
  const hasRl = !!(rl && typeof rl.check === 'function' && typeof rl.commit === 'function');

  function log(msg) { if (moduleLog) meta.log(TAG, msg); }
  function warn(msg) { if (bugLog) meta.log(TAG, `warn ${msg}`); }
  function trace(msg) { if (traceLog) meta.log(TAG, `trace ${msg}`); }

  async function gatewaySend(chatId, payload, options) {
    if (!enabled) {
      return { ok: false, reason: 'disabled' };
    }

    const id = String(chatId || '').trim();
    if (!id) return { ok: false, reason: 'chatId' };

    const opts = options || {};
    const weight = Math.max(1, toInt(opts.weight, 1));

    const manualReply = toBool(opts.manualReply, false);
    const allowOutsideWindow = toBool(opts.allowOutsideWindow, false) || toBool(opts.bypassWindow, false);
    const bypassRateLimit = toBool(opts.bypassRateLimit, false);

    if (bypassChatIds.has(id)) {
      trace(`bypass chatId=${id}`);
      return base.fn(id, payload, opts);
    }

    if (hasRl && !bypassRateLimit) {
      const ck = rl.check({ chatId: id, weight });
      if (!ck || !ck.ok) {
        const reason = ck ? String(ck.reason || 'rate') : 'rate';
        if (allowOutsideWindow && reason === 'window') {
          trace(`window bypass chatId=${id} manualReply=${manualReply ? 1 : 0}`);
        } else {
          const w = ck ? toInt(ck.waitMs, 0) : 0;
          return { ok: false, reason, waitMs: w };
        }
      }
    }

    try {
      const res = await base.fn(id, payload, opts);
      if (hasRl && !bypassRateLimit) rl.commit({ chatId: id, weight });
      return res;
    } catch (e) {
      warn(`send failed chatId=${id} reason=${e && e.message ? e.message : 'error'}`);
      throw e;
    }
  }

  // register services
  for (const name of parseCsv(services)) {
    meta.registerService(name, gatewaySend);
  }

  log(`ready enabled=${enabled ? 1 : 0} baseSend=${base.name} rl=${hasRl ? ratelimitService : 'none'} svc=${services} bypassChatIds=${bypassChatIds.size}`);
  return { onMessage: async () => {}, onEvent: async () => {} };
};
