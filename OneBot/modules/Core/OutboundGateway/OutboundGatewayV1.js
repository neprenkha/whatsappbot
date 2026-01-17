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
 * - Debounced logging for ratelimit.block to avoid log spam (2-minute interval per chatId)
 */
'use strict';

// Debounce state for ratelimit.block logs (2-minute interval)
const rateLimitLogDebounce = new Map(); // chatId -> lastLogTime
const RATELIMIT_LOG_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const MAX_DEBOUNCE_ENTRIES = 1000; // Limit map size to prevent memory leaks

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

function cleanupDebounceMap() {
  // Remove entries older than 10 minutes to prevent memory leaks
  const now = Date.now();
  const maxAge = 10 * 60 * 1000; // 10 minutes
  
  for (const [chatId, lastLog] of rateLimitLogDebounce.entries()) {
    if (now - lastLog > maxAge) {
      rateLimitLogDebounce.delete(chatId);
    }
  }
  
  // If still too large, remove oldest entries
  if (rateLimitLogDebounce.size > MAX_DEBOUNCE_ENTRIES) {
    const entries = Array.from(rateLimitLogDebounce.entries());
    entries.sort((a, b) => a[1] - b[1]); // Sort by timestamp
    const toRemove = entries.slice(0, entries.length - MAX_DEBOUNCE_ENTRIES);
    for (const [chatId] of toRemove) {
      rateLimitLogDebounce.delete(chatId);
    }
  }
}

function shouldLogRateLimit(chatId) {
  const now = Date.now();
  const lastLog = rateLimitLogDebounce.get(chatId);
  
  if (!lastLog || (now - lastLog) >= RATELIMIT_LOG_INTERVAL_MS) {
    rateLimitLogDebounce.set(chatId, now);
    
    // Periodically cleanup old entries (every 100th call)
    if (Math.random() < 0.01) {
      cleanupDebounceMap();
    }
    
    return true;
  }
  return false;
}

function getPayloadPreview(payload, maxLen = 80) {
  if (typeof payload === 'string') {
    return payload.length > maxLen ? payload.substring(0, maxLen) + '...' : payload;
  }
  if (payload && typeof payload === 'object') {
    return '[non-string]';
  }
  return String(payload || '');
}

module.exports.init = async (meta) => {
  const cfg = meta.implConf || {};
  const enabled = toBool(cfg.enabled, true);
  const debugLog = toBool(cfg.debugLog, false);
  const errorLog = toBool(cfg.errorLog, true);

  const baseSendName = String(cfg.baseSend || 'send').trim() || 'send';
  const rlName = String(cfg.ratelimitService || cfg.rateLimitService || 'ratelimit').trim() || 'ratelimit';
  const svcNames = splitCsv(cfg.services || cfg.service || 'sendout,outsend');
  const bypassChatIds = new Set(splitCsv(cfg.bypassChatIds || cfg.bypassChats || ''));

  function log(level, msg) {
    // Only log if the level is enabled
    if (level === 'debug' && !debugLog) return;
    if (level === 'error' && !errorLog) return;
    if (level === 'info') {
      // 'info' level is always logged
      try {
        meta.log('OutboundGatewayV1', msg);
      } catch (_) {}
      return;
    }
    // For any other level, log it
    try {
      meta.log('OutboundGatewayV1', msg);
    } catch (_) {}
  }

  if (!enabled) {
    log('info', 'disabled enabled=0');
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const baseSend = resolveBaseSend(meta, baseSendName);
  if (typeof baseSend !== 'function') {
    throw new Error(`OutboundGatewayV1: baseSend "${baseSendName}" not found`);
  }

  const rl = meta.getService ? meta.getService(rlName) : null;

  async function sendout(chatId, payload, opts = {}) {
    const at = Date.now();
    const key = `out:${chatId}`;
    const weight = toInt(opts.weight, 1);

    // Debug log for request
    if (debugLog) {
      const preview = getPayloadPreview(payload);
      log('debug', `request chat=${chatId} preview="${preview}" opts=${JSON.stringify(opts)}`);
    }

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
          // Debounced error logging for ratelimit blocks
          if (shouldLogRateLimit(chatId)) {
            log('error', `ratelimit.block chat=${chatId} reason=${JSON.stringify(res)}`);
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

  const rlState = (rl && typeof rl.check === 'function') ? rlName : 'none';
  log('info',
    `ready enabled=1 baseSend=${baseSendName} rl=${rlState} svc=${svcNames.join(',')} bypassChatIds=${bypassChatIds.size} debugLog=${debugLog ? 1 : 0}`
  );

  return { onMessage: async () => {}, onEvent: async () => {} };
};
