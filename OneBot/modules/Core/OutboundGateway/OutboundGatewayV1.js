'use strict';

/**
 * OutboundGatewayV1
 *
 * Wrap base send service with RateLimitV1 to provide:
 * - sendout(chatId, payload, opts)
 * - outsend(chatId, payload, opts)  (same behavior, different name)
 *
 * Notes:
 * - baseSendName may be "transport" or "send" depending on build.
 * - This module must not crash bot on missing config; it should disable itself.
 *
 * ASCII only.
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
    .map(s => s.trim())
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
  if (!baseSendName) return null;

  const svc = meta.getService(baseSendName);

  // Compat fallback: if config says transport but service missing, try send.
  if (!svc && baseSendName === 'transport') {
    const fallback = meta.getService('send');
    if (typeof fallback === 'function') return fallback;
    if (fallback && typeof fallback.sendDirect === 'function') {
      return async (chatId, payload, opts) => await fallback.sendDirect(chatId, payload, opts);
    }
    if (fallback && typeof fallback.send === 'function') {
      return async (chatId, payload, opts) => await fallback.send(chatId, payload, opts);
    }
    return null;
  }

  if (typeof svc === 'function') return svc;

  // Some builds expose a sender object with send/sendDirect.
  if (svc && typeof svc.sendDirect === 'function') {
    return async (chatId, payload, opts) => await svc.sendDirect(chatId, payload, opts);
  }
  if (svc && typeof svc.send === 'function') {
    return async (chatId, payload, opts) => await svc.send(chatId, payload, opts);
  }

  return null;
}

module.exports = function init(meta) {
  const tag = 'OutboundGatewayV1';
  const log = meta.log || function () {};

  const cfg = meta.implConf || null;
  const enabled = cfg ? toBool(confGet(cfg, 'enabled', '1'), true) : true;

  if (!enabled) {
    log(tag, 'disabled enabled=0');
    return {};
  }

  const baseSendName = cfg ? String(confGet(cfg, 'baseSend', 'transport')).trim() : 'transport';
  const rlSvcName = cfg ? String(confGet(cfg, 'rateLimit', 'ratelimit')).trim() : 'ratelimit';

  const rl = meta.getService(rlSvcName);
  const baseSend = resolveBaseSend(meta, baseSendName);

  if (!baseSend) {
    log(tag, 'missing.baseSend ' + safeJson({ baseSend: baseSendName }));
    return {};
  }
  if (!rl || typeof rl.check !== 'function') {
    log(tag, 'missing.ratelimit ' + safeJson({ rateLimit: rlSvcName }));
    return {};
  }

  const enabledLog = cfg ? toBool(confGet(cfg, 'enabledLog', '1'), true) : true;
  const rlLogDebounceMs = cfg ? toInt(confGet(cfg, 'rlLogDebounceMs', '30000'), 30000) : 30000;
  const rlLogMaxSize = cfg ? toInt(confGet(cfg, 'rlLogMaxSize', '1000'), 1000) : 1000;

  const bypassChatIds = new Set();
  const bypassList = cfg ? splitCsv(confGet(cfg, 'bypassChatIds', '') || '') : [];
  for (const id of bypassList) bypassChatIds.add(id);

  const warnMap = new Map(); // chatId -> {t, lastReason}
  function shouldWarn(chatId, reason) {
    const now = Date.now();
    const prev = warnMap.get(chatId);
    if (!prev || (now - prev.t) >= rlLogDebounceMs) {
      warnMap.set(chatId, { t: now, lastReason: reason });
      // keep map small
      if (warnMap.size > rlLogMaxSize) {
        const firstKey = warnMap.keys().next().value;
        warnMap.delete(firstKey);
      }
      return true;
    }
    return false;
  }

  async function sendWrapped(chatId, payload, opts) {
    if (!chatId) throw new Error('missing_chatId');

    // Bypass ratelimit for specific chats (e.g., control group manual sends)
    if (bypassChatIds.has(chatId)) {
      return await baseSend(chatId, payload, opts);
    }

    const r = rl.check({ chatId });
    if (!r || r.ok !== true) {
      const reason = r && r.reason ? r.reason : 'blocked';
      const waitMs = r && typeof r.waitMs === 'number' ? r.waitMs : 0;

      if (enabledLog && shouldWarn(chatId, reason)) {
        log(tag, 'warn ratelimit.block chat=' + chatId + ' reason=' + safeJson({ ok: false, reason, waitMs }));
      }
      const err = new Error('ratelimit.block');
      err.code = 'ratelimit.block';
      err.waitMs = waitMs;
      throw err;
    }

    return await baseSend(chatId, payload, opts);
  }

  // Register services
  meta.registerService('sendout', sendWrapped);
  meta.registerService('outsend', sendWrapped);

  log(tag, 'info ready enabled=1 baseSend=' + baseSendName + ' rl=' + rlSvcName + ' svc=sendout,outsend bypassChatIds=' + bypassChatIds.size);
  return {};
};
