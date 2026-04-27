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

function readSettingText(conf, key) {
  const value = asText(readConf(conf, key, ''), '');
  if (!value) throw new Error('config_missing_' + key);
  return value;
}

function readSettingInt(conf, key) {
  const valueRaw = readSettingText(conf, key);
  const value = asInt(valueRaw, Number.NaN);
  if (!Number.isFinite(value)) throw new Error('config_invalid_' + key);
  return value;
}

function readSettingBool(conf, key) {
  const valueRaw = readSettingText(conf, key);
  const text = String(valueRaw).trim().toLowerCase();
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true;
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false;
  throw new Error('config_invalid_' + key);
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
    bypassRateLimit: opts.bypassRateLimit,
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

function isPriorityOptions(options) {
  const opts = options && typeof options === 'object' ? options : {};
  if (opts.manualReply === 1 || opts.manualReply === true) return true;
  if (opts.isAuto === 0 || opts.isAuto === false) return true;
  if (opts.bypassRateLimit === 1 || opts.bypassRateLimit === true) return true;
  return false;
}

module.exports = {
  init: async (meta) => {
    const tag = 'SendQueueCV';
    const conf = meta && meta.implConf ? meta.implConf : {};
    const log = meta && typeof meta.log === 'function' ? meta.log : () => {};

    let enabled;
    let moduleLog;
    let bugLog;
    let detailLog;
    let traceLog;
    let serviceName;
    let baseSend;
    let delayMs;
    let batchMax;
    let maxQueue;
    let minGapMsPerChat;
    let maxAttempts;
    let retryDelayMs;
    let deadMax;
    let dedupeMs;
    let dedupeMax;
    let dedupeLog;
    let defaultIsAuto;
    let defaultManualReply;

    try {
      enabled = readSettingBool(conf, 'enabled');
      moduleLog = readSettingBool(conf, 'moduleLog');
      bugLog = readSettingBool(conf, 'bugLog');
      detailLog = readSettingBool(conf, 'detailLog');
      traceLog = readSettingBool(conf, 'traceLog');
      serviceName = readSettingText(conf, 'serviceName');
      baseSend = readSettingText(conf, 'baseSend');
      delayMs = readSettingInt(conf, 'delayMs');
      batchMax = readSettingInt(conf, 'batchMax');
      maxQueue = readSettingInt(conf, 'maxQueue');
      minGapMsPerChat = readSettingInt(conf, 'minGapMsPerChat');
      maxAttempts = readSettingInt(conf, 'maxAttempts');
      retryDelayMs = readSettingInt(conf, 'retryDelayMs');
      deadMax = readSettingInt(conf, 'deadMax');
      dedupeMs = readSettingInt(conf, 'dedupeMs');
      dedupeMax = readSettingInt(conf, 'dedupeMax');
      dedupeLog = readSettingBool(conf, 'dedupeLog');
      defaultIsAuto = readSettingBool(conf, 'defaultIsAuto');
      defaultManualReply = readSettingBool(conf, 'defaultManualReply');
    } catch (err) {
      log(tag, 'disabled config_error=' + errText(err));
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    if (!enabled) {
      if (moduleLog) log(tag, 'disabled enabled=0');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    let seq = 0;
    let queue = [];
    let dead = [];
    const dedupeMap = new Map();
    const nextAllowedAtMs = new Map();
    let running = false;

    function buildOptions(options) {
      const opts = options && typeof options === 'object' ? Object.assign({}, options) : {};
      if (!Object.prototype.hasOwnProperty.call(opts, 'isAuto')) opts.isAuto = defaultIsAuto ? 1 : 0;
      if (!Object.prototype.hasOwnProperty.call(opts, 'manualReply')) opts.manualReply = defaultManualReply ? 1 : 0;
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

    function insertQueue(item, priority) {
      const normalized = normalizeItem(item);
      if (!priority || queue.length === 0) {
        queue.push(normalized);
        return;
      }

      let insertAt = 0;
      while (insertAt < queue.length && isPriorityOptions(queue[insertAt].options)) {
        insertAt += 1;
      }
      queue.splice(insertAt, 0, normalized);
    }

    function schedulePumpSoon() {
      setTimeout(() => {
        pumpOnce().catch((err) => {
          if (bugLog) log(tag, 'pump_error err=' + errText(err));
        });
      }, 0);
    }

    async function tryImmediate(chatId, payload, options) {
      const downstream = meta.getService(baseSend);
      if (!downstream) {
        const err = new Error('downstream_missing');
        err.code = 'downstream_missing';
        throw err;
      }
      if (typeof downstream.sendImmediate !== 'function') {
        const err = new Error('downstream_immediate_unavailable');
        err.code = 'downstream_immediate_unavailable';
        throw err;
      }
      return await downstream.sendImmediate(chatId, payload, options || {});
    }

    async function enqueue(chatId, payload, options) {
      const chat = asText(chatId, '');
      if (!chat) return 0;

      const opts = buildOptions(options);
      const priority = isPriorityOptions(opts);

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

      seq += 1;
      const item = normalizeItem({
        id: seq,
        chatId: chat,
        payload,
        options: opts,
        createdAtMs: Date.now(),
        attempts: 0,
        nextTryAtMs: 0,
        lastError: '',
      });

      if (priority) {
        try {
          const directId = await tryImmediate(chat, payload, opts);
          return Number.isFinite(Number(directId)) && Number(directId) > 0 ? Number(directId) : item.id;
        } catch (err) {
          item.lastError = errText(err);
          if (detailLog || traceLog) {
            log(tag, 'priority_fallback_queue chatId=' + chat + ' err=' + item.lastError);
          }
        }
      }

      if (queue.length >= maxQueue) {
        if (bugLog) log(tag, 'queue_full maxQueue=' + maxQueue + ' chatId=' + chat);
        return 0;
      }

      insertQueue(item, priority);
      if (priority) schedulePumpSoon();
      return item.id;
    }

    function findEligibleIndex(now) {
      for (let pass = 0; pass < 2; pass += 1) {
        const wantPriority = pass === 0;
        for (let i = 0; i < queue.length; i += 1) {
          const item = normalizeItem(queue[i]);
          queue[i] = item;
          if (isPriorityOptions(item.options) !== wantPriority) continue;
          const nextTryAtMs = Number(item.nextTryAtMs || 0);
          const nextAllowed = Number(nextAllowedAtMs.get(item.chatId) || 0);
          if (now >= nextTryAtMs && now >= nextAllowed) return i;
        }
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
            if (traceLog || detailLog) {
              log(tag, 'send_ok chatId=' + item.chatId + ' sent=' + sent + ' remain=' + queue.length);
            }
          } catch (err) {
            item.attempts += 1;
            item.lastError = errText(err);
            item.nextTryAtMs = Date.now() + retryDelayMs;
            if (item.attempts >= maxAttempts) {
              pushDead(item);
              queue.splice(idx, 1);
              if (detailLog || traceLog) {
                log(tag, 'dead_push chatId=' + item.chatId + ' attempts=' + item.attempts + ' reason=' + item.lastError);
              }
            } else {
              queue[idx] = item;
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
      log(tag, 'ready enabled=' + (enabled ? '1' : '0') + ' serviceName=' + serviceName + ' baseSend=' + baseSend + ' delayMs=' + delayMs + ' batchMax=' + batchMax + ' maxQueue=' + maxQueue + ' minGapMsPerChat=' + minGapMsPerChat + ' maxAttempts=' + maxAttempts + ' retryDelayMs=' + retryDelayMs + ' deadMax=' + deadMax + ' detailLog=' + (detailLog ? '1' : '0') + ' traceLog=' + (traceLog ? '1' : '0'));
    }

    return {
      onMessage: async () => {},
      onEvent: async () => {},
    };
  },
};