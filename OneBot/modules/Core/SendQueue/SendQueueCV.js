'use strict';

function asText(value, fallback) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return text || String(fallback === undefined || fallback === null ? '' : fallback).trim();
}

function asInt(value, fallback) {
  const parsed = Number.parseInt(String(value === undefined || value === null ? '' : value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBool(value, fallback) {
  const text = asText(value, '').toLowerCase();
  if (!text) return !!fallback;
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true;
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false;
  return !!fallback;
}

function readConf(conf, key, fallback) {
  if (!conf) return fallback;
  if (typeof conf.get === 'function') return conf.get(key, fallback);
  if (Object.prototype.hasOwnProperty.call(conf, key)) return conf[key];
  return fallback;
}

function payloadKey(payload) {
  if (typeof payload === 'string') return payload.slice(0, 200);
  try {
    return JSON.stringify(payload).slice(0, 400);
  } catch (err) {
    return String(payload).slice(0, 400);
  }
}

function optionsKey(options) {
  const opts = options && typeof options === 'object' ? options : {};
  return JSON.stringify({
    isAuto: opts.isAuto,
    manualReply: opts.manualReply,
  });
}

function errText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return String(err.code || err.reason || err.message || err);
}

function normalizeItem(raw) {
  const item = raw && typeof raw === 'object' ? Object.assign({}, raw) : {};
  item.id = Number.isFinite(Number(item.id)) ? Number(item.id) : 0;
  item.chatId = asText(item.chatId, '');
  item.attempts = Number.isFinite(Number(item.attempts)) ? Number(item.attempts) : 0;
  item.nextTryAtMs = Number.isFinite(Number(item.nextTryAtMs)) ? Number(item.nextTryAtMs) : 0;
  item.createdAtMs = Number.isFinite(Number(item.createdAtMs)) ? Number(item.createdAtMs) : Date.now();
  item.lastError = asText(item.lastError, '');
  if (!item.options || typeof item.options !== 'object') item.options = {};
  return item;
}

module.exports = {
  init: async (meta) => {
    const tag = 'SendQueueCV';
    const conf = meta && meta.implConf ? meta.implConf : {};
    const log = meta && typeof meta.log === 'function' ? meta.log : () => {};

    const enabled = asBool(readConf(conf, 'enabled', 1), true);
    const moduleLog = asBool(readConf(conf, 'moduleLog', 1), true);
    const bugLog = asBool(readConf(conf, 'bugLog', 1), true);

    if (!enabled) {
      if (moduleLog) log(tag, 'disabled enabled=0');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const serviceName = asText(readConf(conf, 'serviceName', 'send'), 'send');
    const baseSend = asText(readConf(conf, 'baseSend', 'outbox'), 'outbox');
    const delayMs = Math.max(100, asInt(readConf(conf, 'delayMs', 800), 800));
    const batchMax = Math.max(1, asInt(readConf(conf, 'batchMax', 5), 5));
    const maxQueue = Math.max(1, asInt(readConf(conf, 'maxQueue', 2000), 2000));
    const minGapMsPerChat = Math.max(0, asInt(readConf(conf, 'minGapMsPerChat', 0), 0));
    const maxAttempts = Math.max(1, asInt(readConf(conf, 'maxAttempts', 5), 5));
    const retryDelayMs = Math.max(0, asInt(readConf(conf, 'retryDelayMs', delayMs), delayMs));
    const deadMax = Math.max(1, asInt(readConf(conf, 'deadMax', 500), 500));
    const dedupeMs = Math.max(0, asInt(readConf(conf, 'dedupeMs', 0), 0));
    const dedupeMax = Math.max(0, asInt(readConf(conf, 'dedupeMax', 5000), 5000));
    const dedupeLog = asBool(readConf(conf, 'dedupeLog', 0), false);

    let seq = 0;
    let queue = [];
    let dead = [];
    const dedupeMap = new Map();
    const nextAllowedAtMs = new Map();
    let running = false;

    function buildOptions(options) {
      const opts = options && typeof options === 'object' ? Object.assign({}, options) : {};
      if (!Object.prototype.hasOwnProperty.call(opts, 'isAuto')) opts.isAuto = 1;
      if (!Object.prototype.hasOwnProperty.call(opts, 'manualReply')) opts.manualReply = 0;
      return opts;
    }

    function pruneDedupe(now) {
      if (dedupeMs <= 0 || dedupeMap.size === 0) return;
      const cutoff = now - dedupeMs;
      for (const entry of dedupeMap.entries()) {
        if (entry[1] <= cutoff) dedupeMap.delete(entry[0]);
      }
      if (dedupeMax > 0 && dedupeMap.size > dedupeMax) {
        const removeCount = dedupeMap.size - dedupeMax;
        let removed = 0;
        for (const key of dedupeMap.keys()) {
          dedupeMap.delete(key);
          removed += 1;
          if (removed >= removeCount) break;
        }
      }
    }

    function makeDedupe(chatId, payload, options) {
      return String(chatId) + '|' + payloadKey(payload) + '|' + optionsKey(options);
    }

    function pushDead(item) {
      dead.push(Object.assign({}, item, { failedAtMs: Date.now() }));
      if (dead.length > deadMax) dead = dead.slice(dead.length - deadMax);
    }

    async function enqueue(chatId, payload, options) {
      const chat = asText(chatId, '');
      if (!chat) return 0;

      const opts = buildOptions(options);

      if (dedupeMs > 0) {
        const now = Date.now();
        pruneDedupe(now);
        const key = makeDedupe(chat, payload, opts);
        const seenAt = Number(dedupeMap.get(key) || 0);
        if (seenAt > 0 && now - seenAt < dedupeMs) {
          if (dedupeLog && moduleLog) log(tag, 'dedupe.drop chatId=' + chat);
          return 0;
        }
        dedupeMap.set(key, now);
      }

      if (queue.length >= maxQueue) {
        if (bugLog) log(tag, 'queue_full maxQueue=' + maxQueue + ' chatId=' + chat);
        return 0;
      }

      seq += 1;
      queue.push(normalizeItem({
        id: seq,
        chatId: chat,
        payload,
        options: opts,
        createdAtMs: Date.now(),
        attempts: 0,
        nextTryAtMs: 0,
        lastError: '',
      }));
      return seq;
    }

    function findEligibleIndex(now) {
      for (let i = 0; i < queue.length; i += 1) {
        const item = normalizeItem(queue[i]);
        queue[i] = item;
        const nextTryAtMs = Number(item.nextTryAtMs || 0);
        const nextAllowed = Number(nextAllowedAtMs.get(item.chatId) || 0);
        if (now >= nextTryAtMs && now >= nextAllowed) return i;
      }
      return -1;
    }

    async function pumpOnce() {
      if (running) return;
      running = true;
      try {
        const outbox = meta.getService(baseSend);
        if (!outbox || typeof outbox.send !== 'function') {
          if (bugLog) log(tag, 'downstream_missing baseSend=' + baseSend + ' queued=' + queue.length);
          return;
        }

        let sent = 0;
        while (sent < batchMax && queue.length > 0) {
          const now = Date.now();
          pruneDedupe(now);
          const idx = findEligibleIndex(now);
          if (idx < 0) break;

          const item = queue[idx];
          try {
            await outbox.send(item.chatId, item.payload, item.options || {});
            queue.splice(idx, 1);
            nextAllowedAtMs.set(item.chatId, Date.now() + minGapMsPerChat);
            sent += 1;
          } catch (err) {
            item.attempts += 1;
            item.lastError = errText(err);
            item.nextTryAtMs = Date.now() + retryDelayMs;
            if (item.attempts >= maxAttempts) {
              pushDead(item);
              queue.splice(idx, 1);
            }
          }
        }
      } finally {
        running = false;
      }
    }

    const timer = setInterval(() => {
      pumpOnce().catch((err) => {
        if (bugLog) log(tag, 'pump_error err=' + errText(err));
      });
    }, delayMs);

    const api = {
      enqueue: async (chatId, payload, options) => await enqueue(chatId, payload, options),
      send: async (chatId, payload, options) => await enqueue(chatId, payload, options),
      size: () => queue.length,
      flush: async () => await pumpOnce(),
      stop: () => clearInterval(timer),
    };

    meta.registerService(serviceName, api);

    if (moduleLog) {
      log(tag, 'ready enabled=1 serviceName=' + serviceName + ' baseSend=' + baseSend + ' delayMs=' + delayMs + ' batchMax=' + batchMax + ' maxQueue=' + maxQueue + ' minGapMsPerChat=' + minGapMsPerChat + ' maxAttempts=' + maxAttempts + ' retryDelayMs=' + retryDelayMs + ' deadMax=' + deadMax);
    }

    return {
      onMessage: async () => {},
      onEvent: async () => {},
    };
  },
};