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

function asList(value) {
  return String(value || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
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

function getErrText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return String(err.code || err.reason || err.message || err);
}

function isPromiseLike(value) {
  return !!value && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
}

async function resolveChatId(value) {
  const resolved = isPromiseLike(value) ? await value : value;
  return asText(resolved, '');
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
    const tag = 'OutboxCV';
    const conf = meta && meta.implConf ? meta.implConf : {};
    const log = meta && typeof meta.log === 'function' ? meta.log : () => {};

    let enabled;
    let moduleLog;
    let bugLog;
    let detailLog;
    let traceLog;
    let globalConfRel;
    let serviceName;
    let namespace;
    let storeKey;
    let tickMs;
    let batchMax;
    let maxAttempts;
    let retryDelayMs;
    let deadMax;
    let defaultIsAuto;
    let defaultManualReply;

    try {
      enabled = readSettingBool(conf, 'enabled');
      moduleLog = readSettingBool(conf, 'moduleLog');
      bugLog = readSettingBool(conf, 'bugLog');
      detailLog = readSettingBool(conf, 'detailLog');
      traceLog = readSettingBool(conf, 'traceLog');
      globalConfRel = readSettingText(conf, 'globalConfRel');
      serviceName = readSettingText(conf, 'serviceName');
      namespace = readSettingText(conf, 'namespace');
      storeKey = readSettingText(conf, 'storeKey');
      tickMs = readSettingInt(conf, 'tickMs');
      batchMax = readSettingInt(conf, 'batchMax');
      maxAttempts = readSettingInt(conf, 'maxAttempts');
      retryDelayMs = readSettingInt(conf, 'retryDelayMs');
      deadMax = readSettingInt(conf, 'deadMax');
      defaultIsAuto = readSettingBool(conf, 'defaultIsAuto');
      defaultManualReply = readSettingBool(conf, 'defaultManualReply');
    } catch (err) {
      log(tag, 'disabled config_error=' + getErrText(err));
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    if (!enabled) {
      if (moduleLog) log(tag, 'disabled enabled=0');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const loadedGlobal = typeof meta.loadConfRel === 'function'
      ? (meta.loadConfRel(globalConfRel) || {})
      : {};
    const globalConf = loadedGlobal && loadedGlobal.conf && typeof loadedGlobal.conf === 'object'
      ? loadedGlobal.conf
      : (loadedGlobal && typeof loadedGlobal === 'object' ? loadedGlobal : {});

    const sendPreferCsv = asText(readConf(conf, 'sendPrefer', ''), '') || asText(readConf(globalConf, 'sendPrefer', ''), '');
    const sendPrefer = asList(sendPreferCsv);

    const jsonstore = meta.getService('jsonstore');

    let queue = [];
    let dead = [];
    let lastId = 0;
    let timer = null;
    let running = false;
    let ready = false;
    let api = null;
    let transportBusy = false;

    function openStore() {
      if (!jsonstore || typeof jsonstore.open !== 'function') return null;
      return jsonstore.open(namespace);
    }

    function buildOptions(options) {
      const opts = options && typeof options === 'object' ? Object.assign({}, options) : {};
      if (!Object.prototype.hasOwnProperty.call(opts, 'isAuto')) opts.isAuto = defaultIsAuto ? 1 : 0;
      if (!Object.prototype.hasOwnProperty.call(opts, 'manualReply')) opts.manualReply = defaultManualReply ? 1 : 0;
      return opts;
    }

    function resolveSender() {
      for (let i = 0; i < sendPrefer.length; i += 1) {
        const name = sendPrefer[i];
        if (!name || name === serviceName) {
          if (bugLog) log(tag, 'sender_skip_self serviceName=' + name);
          continue;
        }
        if (traceLog || detailLog) log(tag, 'outbox_sendprefer serviceName=' + name);
        const svc = meta.getService(name);
        if (!svc) continue;
        if (api && svc === api) {
          if (bugLog) log(tag, 'sender_skip_self_service serviceName=' + name);
          continue;
        }
        if (svc && typeof svc.enqueue === 'function') {
          if (bugLog) log(tag, 'sender_skip_queue_like serviceName=' + name);
          continue;
        }
        if (typeof svc === 'function') return svc;
        if (svc && typeof svc.send === 'function') {
          return async (chatId, payload, options) => await svc.send(chatId, payload, options || {});
        }
      }
      return null;
    }

    async function loadState() {
      if (!jsonstore || typeof jsonstore.open !== 'function') {
        ready = true;
        return;
      }
      try {
        const store = openStore();
        if (!store || typeof store.get !== 'function') throw new Error('jsonstore_store_invalid');
        const state = await store.get(storeKey, { queue: [], dead: [], lastId: 0 });

        queue = Array.isArray(state && state.queue) ? state.queue.map(normalizeItem) : [];
        dead = Array.isArray(state && state.dead) ? state.dead.slice() : [];
        lastId = Number.isFinite(Number(state && state.lastId)) ? Number(state && state.lastId) : 0;
      } catch (err) {
        if (bugLog) log(tag, 'persist_error op=load err=' + getErrText(err));
      }
      ready = true;
    }

    async function saveState() {
      if (!jsonstore || typeof jsonstore.open !== 'function') return;
      try {
        const store = openStore();
        if (!store || typeof store.set !== 'function') throw new Error('jsonstore_store_invalid');
        await store.set(storeKey, { queue, dead, lastId });
      } catch (err) {
        if (bugLog) log(tag, 'persist_error op=save err=' + getErrText(err));
      }
    }

    function pushDead(item, lastError) {
      dead.push(Object.assign({}, item, {
        lastError: asText(lastError, ''),
        failedAtMs: Date.now(),
      }));
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

    function scheduleFlushSoon() {
      setTimeout(() => {
        flushOnce().catch((err) => {
          if (bugLog) log(tag, 'flush_loop_error err=' + getErrText(err));
        });
      }, 0);
    }

    async function deliverWithSender(sender, item) {
      if (transportBusy) {
        const err = new Error('transport.busy');
        err.code = 'transport.busy';
        throw err;
      }

      const outChatId = await resolveChatId(item.chatId);
      if (!outChatId || outChatId === '[object Promise]') {
        const err = new Error('outbox.invalid_chatId');
        err.code = 'outbox.invalid_chatId';
        throw err;
      }

      transportBusy = true;
      try {
        if (traceLog || detailLog) {
          log(tag, 'outbox_sender_target chatId=' + outChatId + ' payloadType=' + (typeof item.payload === 'string' ? 'text' : 'media'));
        }
        await sender(outChatId, item.payload, item.options || {});
      } finally {
        transportBusy = false;
      }
    }

    async function enqueueInternal(chatId, payload, options, priority, attempts, nextTryAtMs, lastError) {
      const outChatId = await resolveChatId(chatId);
      if (!outChatId || outChatId === '[object Promise]') return 0;

      const itemOptions = buildOptions(options);
      const item = normalizeItem({
        id: lastId + 1,
        chatId: outChatId,
        payload,
        options: itemOptions,
        attempts: Number.isFinite(Number(attempts)) ? Number(attempts) : 0,
        nextTryAtMs: Number.isFinite(Number(nextTryAtMs)) ? Number(nextTryAtMs) : 0,
        createdAtMs: Date.now(),
        lastError: asText(lastError, ''),
      });
      lastId = item.id;
      insertQueue(item, !!priority);
      await saveState().catch(() => {});
      return item.id;
    }

    async function sendImmediate(chatId, payload, options) {
      const opts = buildOptions(options);
      const priority = isPriorityOptions(opts);
      const sender = resolveSender();

      if (typeof sender === 'function' && !transportBusy) {
        const immediateItem = normalizeItem({
          id: lastId + 1,
          chatId: await resolveChatId(chatId),
          payload,
          options: opts,
          attempts: 0,
          nextTryAtMs: 0,
          createdAtMs: Date.now(),
          lastError: '',
        });

        if (immediateItem.chatId && immediateItem.chatId !== '[object Promise]') {
          lastId = immediateItem.id;
          try {
            await deliverWithSender(sender, immediateItem);
            return immediateItem.id;
          } catch (err) {
            const code = getErrText(err);
            if (detailLog || traceLog) {
              log(tag, 'sendImmediate_fallback_queue chatId=' + immediateItem.chatId + ' err=' + code);
            }
            if (code !== 'transport.busy') {
              immediateItem.attempts = 1;
              immediateItem.lastError = code;
              immediateItem.nextTryAtMs = Date.now() + retryDelayMs;
            }
            insertQueue(immediateItem, priority);
            await saveState().catch(() => {});
            scheduleFlushSoon();
            return immediateItem.id;
          }
        }
      }

      const queuedId = await enqueueInternal(chatId, payload, opts, priority, 0, 0, '');
      if (queuedId > 0) scheduleFlushSoon();
      return queuedId;
    }

    async function enqueue(chatId, payload, options) {
      return await enqueueInternal(chatId, payload, options, isPriorityOptions(options), 0, 0, '');
    }

    function findEligibleIndex(now, blockedChats) {
      for (let pass = 0; pass < 2; pass += 1) {
        const wantPriority = pass === 0;
        for (let i = 0; i < queue.length; i += 1) {
          const item = normalizeItem(queue[i]);
          queue[i] = item;
          if (isPriorityOptions(item.options) !== wantPriority) continue;
          if (blockedChats && blockedChats.has(item.chatId)) continue;
          if (item.nextTryAtMs > now) continue;
          return i;
        }
      }
      return -1;
    }

    async function flushOnce() {
      if (!ready || running || transportBusy) return;
      running = true;
      try {
        const sender = resolveSender();
        if (typeof sender !== 'function') {
          if (bugLog) log(tag, 'sender_missing sendPrefer=' + sendPrefer.join(','));
          return;
        }

        let sentCount = 0;
        let changed = false;
        const now = Date.now();
        const blockedChats = new Set();

        while (sentCount < batchMax && queue.length > 0) {
          const idx = findEligibleIndex(now, blockedChats);
          if (idx < 0) break;

          const item = normalizeItem(queue[idx]);
          queue[idx] = item;

          if (!item.chatId || item.chatId === '[object Promise]') {
            pushDead(item, 'outbox.invalid_chatId');
            queue.splice(idx, 1);
            changed = true;
            continue;
          }

          if (item.attempts >= maxAttempts) {
            pushDead(item, item.lastError || 'max_attempts');
            queue.splice(idx, 1);
            changed = true;
            continue;
          }

          try {
            await deliverWithSender(sender, item);
            queue.splice(idx, 1);
            sentCount += 1;
            changed = true;
          } catch (err) {
            item.attempts += 1;
            item.lastError = getErrText(err);
            item.nextTryAtMs = Date.now() + retryDelayMs;
            blockedChats.add(item.chatId);

            if (item.attempts >= maxAttempts) {
              pushDead(item, item.lastError || 'max_attempts');
              queue.splice(idx, 1);
            } else {
              queue[idx] = item;
            }
            changed = true;
          }
        }

        if (changed) {
          await saveState().catch(() => {});
        }

        if (sentCount > 0 && (traceLog || detailLog)) {
          log(tag, 'flush sent=' + sentCount + ' remain=' + queue.length);
        }
      } finally {
        running = false;
      }
    }

    function startLoop() {
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        flushOnce().catch((err) => {
          if (bugLog) log(tag, 'flush_loop_error err=' + getErrText(err));
        });
      }, tickMs);
    }

    api = {
      send: async (chatId, payload, options) => {
        if (isPriorityOptions(options)) {
          return await sendImmediate(chatId, payload, options);
        }
        return await enqueue(chatId, payload, options);
      },
      sendImmediate: async (chatId, payload, options) => await sendImmediate(chatId, payload, options),
      size: () => queue.length,
      flush: async () => await flushOnce(),
      stop: () => {
        if (timer) clearInterval(timer);
        timer = null;
      },
    };

    meta.registerService(serviceName, api);

    try {
      await loadState();
      startLoop();
      if (moduleLog) {
        log(tag, 'ready enabled=' + (enabled ? '1' : '0') + ' serviceName=' + serviceName + ' sendPrefer=' + sendPrefer.join(',') + ' tickMs=' + tickMs + ' batchMax=' + batchMax);
      }
    } catch (err) {
      ready = true;
      startLoop();
      if (bugLog) log(tag, 'ready.degraded enabled=' + (enabled ? '1' : '0') + ' serviceName=' + serviceName + ' err=' + getErrText(err));
    }

    return {
      onMessage: async () => {},
      onEvent: async () => {},
    };
  },
};