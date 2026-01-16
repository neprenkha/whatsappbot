'use strict';

/**
 * SharedSafeSendV1
 * Adds consistent debug logging, boolean contract, and retry with exponential backoff.
 */

// Non-retryable error reasons - errors that indicate a permanent failure
const NON_RETRYABLE_REASONS = new Set([
  'ratelimit',
  'window',
  'missingControlGroupId',
  'invalidControlGroupId',
  'nosend',
  'noMeta',
  'noSvc',
  'badSvc'
]);

/**
 * Sleep helper for retry delays
 */
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * safeSend with retry logic and exponential backoff
 */
module.exports.safeSend = async function safeSend(meta, sendFn, chatId, text, options = {}) {
  const tag = 'SharedSafeSendV1';
  const log = (lvl, msg) => meta && meta.log && meta.log(tag, `${lvl} ${msg}`);
  
  if (!sendFn || typeof sendFn !== 'function') {
    log('error', `no send function chatId=${chatId}`);
    return { ok: false, reason: 'nosend' };
  }

  // Retry configuration
  const maxRetries = options.maxRetries !== undefined ? options.maxRetries : 2;
  const baseDelayMs = options.retryBaseMs !== undefined ? options.retryBaseMs : 500;
  const maxDelayMs = options.retryMaxMs !== undefined ? options.retryMaxMs : 5000;

  let lastError = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delayMs = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
        log('info', `retry attempt=${attempt} chatId=${chatId} delayMs=${delayMs}`);
        await sleep(delayMs);
      }
      
      const res = await sendFn(chatId, text, options || {});
      const ok = !(res && res.ok === false);
      
      if (ok) {
        if (attempt > 0) {
          log('info', `sent after retry attempt=${attempt} chatId=${chatId} len=${String(text || '').length}`);
        } else {
          log('info', `sent chatId=${chatId} len=${String(text || '').length}`);
        }
        return { ok: true };
      } else {
        const reason = res && res.reason ? res.reason : 'unknown';
        lastError = reason;
        
        // Don't retry on certain errors
        if (NON_RETRYABLE_REASONS.has(reason)) {
          log('error', `failed chatId=${chatId} reason=${reason} noRetry=true`);
          return { ok: false, reason };
        }
        
        log('warn', `failed attempt=${attempt} chatId=${chatId} reason=${reason}`);
      }
    } catch (e) {
      const errMsg = e && e.message ? e.message : String(e);
      lastError = errMsg;
      log('error', `exception attempt=${attempt} chatId=${chatId} err=${errMsg}`);
    }
  }
  
  log('error', `all attempts failed chatId=${chatId} maxRetries=${maxRetries} lastError=${lastError}`);
  return { ok: false, reason: lastError || 'allFailed' };
};

/**
 * Helper for backward compatibility - wraps safeSend with logger
 */
module.exports.send = async function send(log, sendFn, chatId, text, options = {}) {
  // Convert log object to meta-like object for safeSend
  const meta = { 
    log: (tag, msg) => {
      if (!log) return;
      // Parse level from message format: "level message"
      const parts = String(msg).match(/^(\w+)\s+(.+)$/);
      if (parts) {
        const level = parts[1];
        const message = parts[2];
        if (level === 'error' && typeof log.error === 'function') {
          log.error(message);
        } else if (level === 'warn' && typeof log.warn === 'function') {
          log.warn(message);
        } else if (typeof log.info === 'function') {
          log.info(message);
        }
      } else if (typeof log.info === 'function') {
        log.info(msg);
      }
    }
  };
  return await module.exports.safeSend(meta, sendFn, chatId, text, options);
};

module.exports.pickSend = function pickSend(meta, preferred) {
  const tag = 'SharedSafeSendV1';
  const log = (msg) => meta && meta.log && meta.log(tag, msg);
  const prefers = Array.isArray(preferred)
    ? preferred
    : String(preferred || 'outsend,sendout,send').split(',').map((s) => s.trim()).filter(Boolean);

  if (meta && typeof meta.getService === 'function') {
    for (const n of prefers) {
      const fn = meta.getService(n);
      if (typeof fn === 'function') return [{ name: n, fn }];
    }
    const base = meta.getService('send');
    if (typeof base === 'function') return [{ name: 'send', fn: base }];
  }
  log('fallback to no-op sender');
  return [];
};