'use strict';

function asBool(value, fallback) {
  if (value === undefined || value === null || value === '') return !!fallback;
  const text = String(value).trim().toLowerCase();
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true;
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false;
  return !!fallback;
}

function asInt(value, fallback) {
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asText(value, fallback) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return text || fallback;
}

function readConf(conf, key, fallback) {
  if (!conf) return fallback;
  if (typeof conf.get === 'function') return conf.get(key, fallback);
  if (Object.prototype.hasOwnProperty.call(conf, key)) return conf[key];
  return fallback;
}

function safePayloadText(payload) {
  if (typeof payload === 'string') return payload.slice(0, 200);
  try {
    return JSON.stringify(payload === undefined ? '' : payload).slice(0, 400);
  } catch (err) {
    return String(payload === undefined ? '' : payload).slice(0, 400);
  }
}

function optionsKey(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const stable = {
    isAuto: opts.isAuto,
    manualReply: opts.manualReply,
    bypassRateLimit: opts.bypassRateLimit,
    allowOutsideWindow: opts.allowOutsideWindow,
    bypassWindow: opts.bypassWindow,
    weight: opts.weight,
  };
  return JSON.stringify(stable);
}

function makeDedupeKey(chatId, payload, options) {
  const cid = String(chatId || '').trim();
  return cid + '|' + safePayloadText(payload) + '|' + optionsKey(options);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return String(err.code || err.reason || err.message || '');
}

module.exports = {
  init: async (meta) => {
    const conf = meta.implConf || {};
    const log = typeof meta.log === 'function' ? meta.log : () => {};
    const tag = 'SendQueueCV';

    const enabled = asBool(readConf(conf, 'enabled', 1), true);
    if (!enabled) {
      log(tag, 'disabled enabled=0');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const serviceName = asText(readConf(conf, 'serviceName', 'send'), 'send');
    const outboxService = asText(readConf(conf, 'outboxService', 'outbox'), 'outbox');
    const delayMs = Math.max(0, asInt(readConf(conf, 'delayMs', 800), 800));
    const retryDelayMs = Math.max(0, asInt(readConf(conf, 'retryDelayMs', delayMs), delayMs));
    const tickMs = Math.max(100, asInt(readConf(conf, 'tickMs', delayMs || 800), delayMs || 800));
    const maxQueue = Math.max(1, asInt(readConf(conf, 'maxQueue', 2000), 2000));
    const batchMax = Math.max(1, asInt(readConf(conf, 'batchMax', 30), 30));
    const dedupeMs = Math.max(0, asInt(readConf(conf, 'dedupeMs', 6000), 6000));
    const dedupeMax = Math.max(0, asInt(readConf(conf, 'dedupeMax', 8000), 8000));
    const dedupeLog = asBool(readConf(conf, 'dedupeLog', 1), true);

    const queue = [];
    const recentMap = new Map();
    let pumping = false;

    function pruneDedupe(nowMs) {
      if (dedupeMs <= 0 || recentMap.size === 0) return;
      const cutoff = nowMs - (dedupeMs * 2);
      for (const [key, ts] of recentMap.entries()) {
        if (ts < cutoff) recentMap.delete(key);
      }
      if (dedupeMax > 0 && recentMap.size > dedupeMax) {
        const removeCount = recentMap.size - dedupeMax;
        let removed = 0;
        for (const key of recentMap.keys()) {
          recentMap.delete(key);
          removed += 1;
          if (removed >= removeCount) break;
        }
      }
    }

    function isDuplicate(chatId, payload, options) {
      if (dedupeMs <= 0) return false;
      const nowMs = Date.now();
      pruneDedupe(nowMs);
      const key = makeDedupeKey(chatId, payload, options);
      const prev = recentMap.get(key);
      if (prev && nowMs - prev < dedupeMs) return true;
      recentMap.set(key, nowMs);
      return false;
    }

    async function pump() {
      if (pumping) return;
      pumping = true;
      try {
        while (queue.length > 0) {
          const outbox = meta.getService(outboxService);
          if (!outbox || typeof outbox.send !== 'function') break;

          let accepted = 0;
          while (queue.length > 0 && accepted < batchMax) {
            const nowMs = Date.now();
            const job = queue[0];
            if (!job) break;

            const nextTryAtMs = Number.isFinite(Number(job.nextTryAtMs)) ? Number(job.nextTryAtMs) : 0;
            if (nextTryAtMs > nowMs) break;

            try {
              await outbox.send(job.chatId, job.payload, job.options || {});
              queue.shift();
              accepted += 1;
            } catch (err) {
              job.nextTryAtMs = nowMs + retryDelayMs;
              job.lastError = errText(err);
              break;
            }
          }

          if (queue.length > 0) await wait(delayMs);
        }
      } finally {
        pumping = false;
      }
    }

    const timer = setInterval(() => {
      pump().catch(() => {});
    }, tickMs);

    async function send(chatId, payload, options) {
      const cid = String(chatId || '').trim();
      const opts = options && typeof options === 'object' ? options : {};
      if (!cid) return false;

      if (isDuplicate(cid, payload, opts)) {
        if (dedupeLog) log(tag, 'drop.duplicate chatId=' + cid + ' dedupeMs=' + dedupeMs);
        return true;
      }

      if (queue.length >= maxQueue) {
        log(tag, 'reject.queue_full chatId=' + cid + ' maxQueue=' + maxQueue);
        return false;
      }

      queue.push({
        chatId: cid,
        payload,
        options: opts,
        nextTryAtMs: 0,
        lastError: '',
      });

      pump().catch(() => {});
      return true;
    }

    meta.registerService(serviceName, send);
    log(tag, 'ready enabled=1 serviceName=' + serviceName + ' outboxService=' + outboxService + ' delayMs=' + delayMs + ' retryDelayMs=' + retryDelayMs + ' tickMs=' + tickMs + ' maxQueue=' + maxQueue + ' batchMax=' + batchMax + ' dedupeMs=' + dedupeMs);

    return {
      onMessage: async () => {},
      onEvent: async () => {},
      shutdown: async () => {
        clearInterval(timer);
      },
    };
  },
};