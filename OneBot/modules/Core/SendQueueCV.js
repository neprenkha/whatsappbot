'use strict';

function asBool(value, fallback) {
  if (value === undefined || value === null || value === '') return !!fallback;
  const text = String(value).trim().toLowerCase();
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true;
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false;
  return !!fallback;
}

function asInt(value, fallback) {
  const parsed = parseInt(String(value === undefined || value === null ? '' : value), 10);
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

function errText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return String(err.code || err.reason || err.message || '');
}

function normalizeJob(raw) {
  const item = raw && typeof raw === 'object' ? Object.assign({}, raw) : {};
  item.chatId = asText(item.chatId, '');
  item.options = item.options && typeof item.options === 'object' ? Object.assign({}, item.options) : {};
  item.attempts = Number.isFinite(Number(item.attempts)) ? Number(item.attempts) : 0;
  item.nextTryAtMs = Number.isFinite(Number(item.nextTryAtMs)) ? Number(item.nextTryAtMs) : 0;
  item.createdAtMs = Number.isFinite(Number(item.createdAtMs)) ? Number(item.createdAtMs) : Date.now();
  item.lastError = asText(item.lastError, '');
  return item;
}

module.exports = {
  init: async (meta) => {
    const conf = meta && meta.implConf ? meta.implConf : {};
    const log = meta && typeof meta.log === 'function' ? meta.log : () => {};
    const tag = 'SendQueueCV';

    const enabled = asBool(readConf(conf, 'enabled', 1), true);
    const moduleLog = asBool(readConf(conf, 'moduleLog', 1), true);
    const bugLog = asBool(readConf(conf, 'bugLog', 1), true);
    const detailLog = asBool(readConf(conf, 'detailLog', 0), false);
    const traceLog = asBool(readConf(conf, 'traceLog', 0), false);

    if (!enabled) {
      if (moduleLog) log(tag, 'disabled enabled=0');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const loaded = typeof meta.loadConfRel === 'function'
      ? (meta.loadConfRel(asText(readConf(conf, 'globalConfRel', ''), '')) || {})
      : {};
    const globalConf = loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};

    const serviceName = asText(readConf(conf, 'serviceName', 'send'), 'send');
    const baseSend = asText(readConf(conf, 'baseSend', ''), asText(readConf(globalConf, 'baseSend', 'outbox'), 'outbox'));

    const delayMs = Math.max(0, asInt(readConf(conf, 'delayMs', 800), 800));
    const batchMax = Math.max(1, asInt(readConf(conf, 'batchMax', 30), 30));
    const maxQueue = Math.max(1, asInt(readConf(conf, 'maxQueue', 2000), 2000));
    const minGapMsPerChat = Math.max(0, asInt(readConf(conf, 'minGapMsPerChat', 0), 0));
    const maxAttempts = Math.max(0, asInt(readConf(conf, 'maxAttempts', 5), 5));
    const retryDelayMs = Math.max(0, asInt(readConf(conf, 'retryDelayMs', delayMs), delayMs));
    const deadMax = Math.max(1, asInt(readConf(conf, 'deadMax', 500), 500));

    const dedupeMs = Math.max(0, asInt(readConf(conf, 'dedupeMs', 6000), 6000));
    const dedupeMax = Math.max(0, asInt(readConf(conf, 'dedupeMax', 8000), 8000));
    const dedupeLog = asBool(readConf(conf, 'dedupeLog', 1), true);

    const queue = [];
    const dead = [];
    const recentMap = new Map();
    const chatNextAllowedMap = new Map();
    let pumping = false;

    function resolveSender() {
      const svc = meta.getService(baseSend);
      if (typeof svc === 'function') return svc;
      if (svc && typeof svc.send === 'function') return async (chatId, payload, options) => await svc.send(chatId, payload, options || {});
      return null;
    }

    function pruneDedupe(nowMs) {
      if (dedupeMs <= 0 || recentMap.size === 0) return;
      const cutoff = nowMs - (dedupeMs * 2);
      for (const pair of recentMap.entries()) {
        if (pair[1] < cutoff) recentMap.delete(pair[0]);
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

    function pushDead(item, reason) {
      const deadItem = Object.assign({}, item, {
        deadAtMs: Date.now(),
        lastError: asText(reason, item.lastError || 'failed'),
      });
      dead.push(deadItem);
      if (dead.length > deadMax) {
        dead.splice(0, dead.length - deadMax);
      }
    }

    async function pump() {
      if (pumping) return;
      pumping = true;
      try {
        while (queue.length > 0) {
          const sender = resolveSender();
          if (typeof sender !== 'function') {
            if (bugLog) log(tag, 'sender_missing baseSend=' + baseSend);
            break;
          }

          let sentCount = 0;
          const nowMs = Date.now();
          let earliestWaitMs = 0;

          for (let i = 0; i < queue.length && sentCount < batchMax; i += 1) {
            const item = normalizeJob(queue[i]);
            queue[i] = item;
            if (!item.chatId) {
              queue.splice(i, 1);
              i -= 1;
              continue;
            }

            if (item.nextTryAtMs > nowMs) {
              const waitMs = item.nextTryAtMs - nowMs;
              if (earliestWaitMs === 0 || waitMs < earliestWaitMs) earliestWaitMs = waitMs;
              continue;
            }

            const chatGate = Number(chatNextAllowedMap.get(item.chatId) || 0);
            if (chatGate > nowMs) {
              const waitMs = chatGate - nowMs;
              if (earliestWaitMs === 0 || waitMs < earliestWaitMs) earliestWaitMs = waitMs;
              continue;
            }

            try {
              await sender(item.chatId, item.payload, item.options || {});
              queue.splice(i, 1);
              i -= 1;
              sentCount += 1;
              if (minGapMsPerChat > 0) chatNextAllowedMap.set(item.chatId, Date.now() + minGapMsPerChat);
            } catch (err) {
              item.attempts += 1;
              item.lastError = errText(err);
              item.nextTryAtMs = Date.now() + retryDelayMs;

              if (item.attempts > maxAttempts) {
                pushDead(item, item.lastError || 'maxAttempts.exceeded');
                queue.splice(i, 1);
                i -= 1;
              } else {
                queue[i] = item;
              }
            }
          }

          if (sentCount <= 0) {
            const waitMs = earliestWaitMs > 0 ? Math.min(delayMs > 0 ? delayMs : earliestWaitMs, earliestWaitMs) : delayMs;
            if (waitMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, waitMs));
              continue;
            }
            break;
          }

          if (traceLog || detailLog) log(tag, 'pump sent=' + sentCount + ' remain=' + queue.length + ' dead=' + dead.length);
          if (delayMs > 0 && queue.length > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      } finally {
        pumping = false;
      }
    }

    async function send(chatId, payload, options) {
      const cid = asText(chatId, '');
      if (!cid) return false;

      const opts = options && typeof options === 'object' ? Object.assign({}, options) : {};
      if (isDuplicate(cid, payload, opts)) {
        if (dedupeLog) log(tag, 'drop.duplicate chatId=' + cid + ' dedupeMs=' + dedupeMs);
        return true;
      }

      if (queue.length >= maxQueue) {
        if (bugLog) log(tag, 'reject.queue_full chatId=' + cid + ' maxQueue=' + maxQueue);
        return false;
      }

      queue.push(normalizeJob({
        chatId: cid,
        payload,
        options: opts,
        attempts: 0,
        nextTryAtMs: 0,
        createdAtMs: Date.now(),
        lastError: '',
      }));

      pump().catch(() => {});
      return true;
    }

    const api = {
      send,
      size: () => queue.length,
      deadSize: () => dead.length,
      flush: async () => await pump(),
    };

    meta.registerService(serviceName, api);
    if (moduleLog) {
      log(tag, 'ready enabled=1 serviceName=' + serviceName + ' baseSend=' + baseSend + ' delayMs=' + delayMs + ' batchMax=' + batchMax + ' maxQueue=' + maxQueue + ' minGapMsPerChat=' + minGapMsPerChat + ' maxAttempts=' + maxAttempts + ' retryDelayMs=' + retryDelayMs + ' deadMax=' + deadMax + ' dedupeMs=' + dedupeMs);
    }

    const timer = setInterval(() => {
      pump().catch(() => {});
    }, Math.max(100, delayMs || 100));

    return {
      onMessage: async () => {},
      onEvent: async () => {},
      shutdown: async () => {
        clearInterval(timer);
      },
    };
  },
};