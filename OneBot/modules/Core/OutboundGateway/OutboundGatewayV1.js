/**
 * OutboundGatewayV1.js
 * Outgoing send wrapper with RateLimit integration.
 *
 * Purpose:
 * - Expose function services: sendout / outsend (names configurable)
 * - Enforce outbound RateLimit (if ratelimit service exists)
 * - Support bypassChatIds or opts.bypass to skip RateLimit for internal destinations
 * - Support baseSend as:
 *     (1) a function(chatId, payload, opts)
 *     (2) an object with sendDirect(chatId, payload, opts)
 *     (3) an object with send(chatId, payload, opts)
 *
 * Notes:
 * - Keep ASCII-only logs to avoid console encoding issues.
 */
'use strict';

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

function resolveBaseSend(meta, baseSendName) {
  if (!meta || !meta.getService) return null;

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

module.exports.init = async (meta) => {
  const cfg = meta.implConf || {};
  const enabled = toBool(cfg.enabled, true);

  const baseSendName = String(cfg.baseSend || 'send').trim() || 'send';
  const rlName = String(cfg.ratelimitService || cfg.rateLimitService || 'ratelimit').trim() || 'ratelimit';
  const svcNames = splitCsv(cfg.services || cfg.service || 'sendout,outsend');
  const bypassChatIds = new Set(splitCsv(cfg.bypassChatIds || cfg.bypassChats || ''));
  const blockLogDebounceMs = toInt(cfg.blockLogDebounceMs, 300000); // 5 minutes default

  if (!enabled) {
    try { meta.log('OutboundGatewayV1', 'disabled enabled=0'); } catch (_) {}
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const baseSend = resolveBaseSend(meta, baseSendName);
  if (typeof baseSend !== 'function') {
    throw new Error(`OutboundGatewayV1: baseSend "${baseSendName}" not found`);
  }

  const rl = meta.getService ? meta.getService(rlName) : null;

  // Log debouncing for rate limit blocks
  const blockLogMap = new Map(); // chatId -> lastLoggedAt

  async function sendout(chatId, payload, opts = {}) {
    const at = Date.now();
    const key = `out:${chatId}`;
    const weight = toInt(opts.weight, 1);

    if (rl && typeof rl.check === 'function') {
      const res = await rl.check({
        key,
        direction: 'out',
        at,
        weight,
        chatId,
        isGroup: String(chatId || '').endsWith('@g.us'),
      });

      if (res && res.ok === false) {
        const bypass = toBool(opts.bypass, false) || bypassChatIds.has(chatId);
        if (!bypass) {
          // Log debouncing: only log once per chatId within debounce window
          const lastLogged = blockLogMap.get(chatId) || 0;
          if (blockLogDebounceMs <= 0 || (at - lastLogged) >= blockLogDebounceMs) {
            try {
              meta.log('OutboundGatewayV1',
                `ratelimit block chatId=${chatId} reason=${res.reason || 'limit'} waitMs=${res.waitMs || 0}`
              );
            } catch (_) {}
            blockLogMap.set(chatId, at);
          }
          return res;
        }
      }
    }

    await baseSend(chatId, payload, opts);
    return { ok: true };
  }

  async function outsend(chatId, payload, opts = {}) {
    return await sendout(chatId, payload, opts);
  }

  if (meta.registerService) {
    for (const n of svcNames) {
      if (n === 'sendout') meta.registerService(n, sendout);
      else if (n === 'outsend') meta.registerService(n, outsend);
      else meta.registerService(n, sendout);
    }
  }

  try {
    const rlState = (rl && typeof rl.check === 'function') ? rlName : 'none';
    meta.log('OutboundGatewayV1',
      `ready enabled=1 baseSend=${baseSendName} rl=${rlState} svc=${svcNames.join(',')} bypassChatIds=${bypassChatIds.size} blockLogDebounceMs=${blockLogDebounceMs}`
    );
  } catch (_) {}

  return { onMessage: async () => {}, onEvent: async () => {} };
};
