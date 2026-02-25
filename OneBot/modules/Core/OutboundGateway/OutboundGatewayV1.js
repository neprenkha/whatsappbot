// OneBot/modules/Core/OutboundGateway/OutboundGatewayV1.js
'use strict';

/**
 * OutboundGatewayV1
 *
 * Wrap base send service with RateLimit service.
 * Exposes: sendout(chatId,payload,opts), outsend(chatId,payload,opts)
 *
 * Manual staff replies must be able to bypass WINDOW-only blocks when enabled.
 * ASCII-only.
 */

function toBool(v, dflt) {
  if (v === undefined || v === null || v === '') return !!dflt;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return !!dflt;
}

function toInt(v, dflt) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : dflt;
}

function splitCsv(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function safeJson(x) {
  try { return JSON.stringify(x); } catch (e) { return String(x); }
}

function confGet(cfg, key, dflt) {
  if (!cfg) return dflt;
  if (typeof cfg.get === 'function') return cfg.get(key, dflt);
  if (Object.prototype.hasOwnProperty.call(cfg, key)) return cfg[key];
  return dflt;
}

function resolveBaseSend(meta, baseSendName) {
  const svc = meta.getService(baseSendName);
  if (typeof svc === 'function') return svc;
  if (svc && typeof svc.sendDirect === 'function') {
    return async (chatId, payload, opts) => await svc.sendDirect(chatId, payload, opts);
  }
  if (svc && typeof svc.send === 'function') {
    return async (chatId, payload, opts) => await svc.send(chatId, payload, opts);
  }
  return null;
}

function isManualReply(opts) {
  if (!opts || typeof opts !== 'object') return false;
  return toBool(opts.manualReply, false);
}

module.exports = function init(meta) {
  const tag = 'OutboundGatewayV1';
  const log = meta.log || function () {};
  const cfg = meta.implConf || {};

  const enabled = toBool(confGet(cfg, 'enabled', '1'), true);
  if (!enabled) {
    log(tag, 'disabled enabled=0');
    return {};
  }

  const moduleLog = toBool(confGet(cfg, 'moduleLog', '1'), true);
  const bugLog = toBool(confGet(cfg, 'bugLog', '1'), true);
  const detailLog = toBool(confGet(cfg, 'detailLog', '0'), false);
  const traceLog = toBool(confGet(cfg, 'traceLog', '0'), false);

  const baseSendName = String(confGet(cfg, 'baseSend', 'transport')).trim();
  const ratelimitService = String(confGet(cfg, 'ratelimitService', 'ratelimit')).trim();

  // WINDOW-only bypass for manual staff replies.
  const allowManualReplyBypassWindow = toBool(confGet(cfg, 'allowManualReplyBypassWindow', '1'), true);

  const rateLimitLogDebounceMs = Math.max(1000, toInt(confGet(cfg, 'rateLimitLogDebounceMs', '30000'), 30000));
  const rateLimitLogTrackerMaxSize = Math.max(100, toInt(confGet(cfg, 'rateLimitLogTrackerMaxSize', '1000'), 1000));

  const rl = meta.getService(ratelimitService);
  const baseSend = resolveBaseSend(meta, baseSendName);

  if (!baseSend) {
    if (bugLog) log(tag, 'missing.baseSend ' + safeJson({ baseSend: baseSendName }));
    return {};
  }
  if (!rl || typeof rl.check !== 'function') {
    if (bugLog) log(tag, 'missing.ratelimit ' + safeJson({ ratelimitService }));
    return {};
  }

  const bypassChatIds = new Set(splitCsv(confGet(cfg, 'bypassChatIds', '')));
  const warnMap = new Map();

  function shouldWarn(chatId) {
    const now = Date.now();
    const key = String(chatId || '').trim();
    const prev = warnMap.get(key);
    if (!prev || (now - prev) >= rateLimitLogDebounceMs) {
      warnMap.set(key, now);
      if (warnMap.size > rateLimitLogTrackerMaxSize) {
        const firstKey = warnMap.keys().next().value;
        warnMap.delete(firstKey);
      }
      return true;
    }
    return false;
  }

  async function sendWrapped(chatId, payload, opts) {
    const cid = String(chatId || '').trim();
    if (!cid) throw new Error('missing_chatId');

    const o = opts && typeof opts === 'object' ? opts : {};

    if (bypassChatIds.has(cid)) {
      return await baseSend(cid, payload, o);
    }

    const r = rl.check({ chatId: cid });
    if (!r || r.ok !== true) {
      const reason = r && r.reason ? String(r.reason) : 'blocked';
      const waitMs = r && Number.isFinite(Number(r.waitMs)) ? Number(r.waitMs) : 0;

      if (reason === 'window' && allowManualReplyBypassWindow && isManualReply(o)) {
        if (traceLog) log(tag, 'trace bypass.window.manual chatId=' + cid);
        return await baseSend(cid, payload, o);
      }

      if (moduleLog && shouldWarn(cid)) {
        log(tag, 'warn ratelimit.block chat=' + cid + ' reason=' + safeJson({ ok: false, reason, waitMs }));
      }

      const err = new Error('ratelimit.block');
      err.code = 'ratelimit.block';
      err.reason = reason;
      err.waitMs = waitMs;
      throw err;
    }

    if (detailLog) log(tag, 'detail send.ok chat=' + cid);
    return await baseSend(cid, payload, o);
  }

  meta.registerService('sendout', sendWrapped);
  meta.registerService('outsend', sendWrapped);

  if (moduleLog) {
    log(
      tag,
      'ready enabled=1 baseSend=' + baseSendName +
      ' rl=' + ratelimitService +
      ' allowManualReplyBypassWindow=' + (allowManualReplyBypassWindow ? 1 : 0) +
      ' svc=sendout,outsend bypassChatIds=' + bypassChatIds.size
    );
  }

  return {};
};
