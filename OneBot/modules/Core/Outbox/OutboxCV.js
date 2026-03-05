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

function getErrText(err) {
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
    const tag = 'OutboxCV';
    const conf = meta && meta.implConf ? meta.implConf : {};
    const log = meta && typeof meta.log === 'function' ? meta.log : () => {};

    const enabled = asBool(readConf(conf, 'enabled', 1), true);
    const moduleLog = asBool(readConf(conf, 'moduleLog', 1), true);
    const bugLog = asBool(readConf(conf, 'bugLog', 1), true);
    const detailLog = asBool(readConf(conf, 'detailLog', 0), false);
    const traceLog = asBool(readConf(conf, 'traceLog', 0), false);

    if (!enabled) {
      if (moduleLog) log(tag, 'disabled enabled=0');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const loadedGlobal = typeof meta.loadConfRel === 'function'
      ? (meta.loadConfRel(asText(readConf(conf, 'globalConfRel', ''), '')) || {})
      : {};
    const globalConf = loadedGlobal && loadedGlobal.conf && typeof loadedGlobal.conf === 'object'
      ? loadedGlobal.conf
      : (loadedGlobal && typeof loadedGlobal === 'object' ? loadedGlobal : {});

    const serviceName = asText(readConf(conf, 'serviceName', 'outbox'), 'outbox');
    const namespace = asText(readConf(conf, 'namespace', 'Outbox'), 'Outbox');
    const storeKey = asText(readConf(conf, 'storeKey', 'state'), 'state');

    const tickMs = Math.max(100, asInt(readConf(conf, 'tickMs', 2000), 2000));
    const batchMax = Math.max(1, asInt(readConf(conf, 'batchMax', 5), 5));
    const maxAttempts = Math.max(0, asInt(readConf(conf, 'maxAttempts', 5), 5));
    const retryDelayMs = Math.max(0, asInt(readConf(conf, 'retryDelayMs', 5000), 5000));
    const deadMax = Math.max(1, asInt(readConf(conf, 'deadMax', 500), 500));

    const sendPreferCsv = asText(
      readConf(conf, 'sendPrefer', ''),
      asText(readConf(globalConf, 'sendPrefer', ''), '')
    );
    const sendPrefer = asList(sendPreferCsv);

    const jsonstore = meta.getService('jsonstore');

    let queue = [];
    let dead = [];
    let lastId = 0;
    let timer = null;
    let running = false;
    let ready = false;

    function openStore() {
      if (!jsonstore || typeof jsonstore.open !== 'function') return null;
      return jsonstore.open(namespace);
    }

    function resolveSender() {
      for (let i = 0; i < sendPrefer.length; i += 1) {
        const name = sendPrefer[i];
        const svc = meta.getService(name);
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
        lastId = Number.isFinite(Number(state && state.lastId)) ? Number(state.lastId) : 0;
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

    async function enqueue(chatId, payload, options) {
      const itemOptions = options && typeof options === 'object' ? Object.assign({}, options) : {};
      if (!Object.prototype.hasOwnProperty.call(itemOptions, 'isAuto')) itemOptions.isAuto = 1;
      if (!Object.prototype.hasOwnProperty.call(itemOptions, 'manualReply')) itemOptions.manualReply = 0;

      const item = normalizeItem({
        id: lastId + 1,
        chatId,
        payload,
        options: itemOptions,
        attempts: 0,
        nextTryAtMs: 0,
        createdAtMs: Date.now(),
        lastError: '',
      });
      lastId = item.id;
      queue.push(item);
      await saveState().catch(() => {});
      return item.id;
    }

    async function flushOnce() {
      if (!ready || running) return;
      running = true;
      try {
        const sender = resolveSender();
        if (typeof sender !== 'function') {
          if (bugLog) log(tag, 'sender_missing sendPrefer=' + sendPrefer.join(','));
          return;
        }

        let sentCount = 0;
        const now = Date.now();

        while (queue.length > 0 && sentCount < batchMax) {
          const item = normalizeItem(queue[0]);
          queue[0] = item;

          if (item.nextTryAtMs > now) break;

          if (item.attempts >= maxAttempts) {
            pushDead(item, item.lastError || 'max_attempts');
            queue.shift();
            await saveState().catch(() => {});
            continue;
          }

          try {
            await sender(item.chatId, item.payload, item.options || {});
            queue.shift();
            sentCount += 1;
          } catch (err) {
            item.attempts += 1;
            item.lastError = getErrText(err);
            item.nextTryAtMs = Date.now() + retryDelayMs;

            if (item.attempts >= maxAttempts) {
              pushDead(item, item.lastError || 'max_attempts');
              queue.shift();
            }
            await saveState().catch(() => {});
            break;
          }
        }

        if (sentCount > 0) {
          await saveState().catch(() => {});
          if (traceLog || detailLog) log(tag, 'flush sent=' + sentCount + ' remain=' + queue.length);
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

    const api = {
      send: async (chatId, payload, options) => await enqueue(chatId, payload, options),
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
        log(tag, 'ready enabled=1 serviceName=' + serviceName + ' sendPrefer=' + sendPrefer.join(',') + ' tickMs=' + tickMs + ' batchMax=' + batchMax);
      }
    } catch (err) {
      ready = true;
      startLoop();
      if (bugLog) log(tag, 'ready.degraded enabled=1 serviceName=' + serviceName + ' err=' + getErrText(err));
    }

    return {
      onMessage: async () => {},
      onEvent: async () => {},
    };
  },
};