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

function asList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
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
  return String(err.code || err.reason || err.message || '');
}

function normalizeItem(raw) {
  const item = raw && typeof raw === 'object' ? Object.assign({}, raw) : {};

  if (item.attempts === undefined && item.retries !== undefined) item.attempts = item.retries;
  if (item.nextTryAtMs === undefined && item.nextAt !== undefined) item.nextTryAtMs = item.nextAt;

  item.attempts = Number.isFinite(Number(item.attempts)) ? Number(item.attempts) : 0;
  item.nextTryAtMs = Number.isFinite(Number(item.nextTryAtMs)) ? Number(item.nextTryAtMs) : 0;
  item.id = Number.isFinite(Number(item.id)) ? Number(item.id) : 0;

  if (!Object.prototype.hasOwnProperty.call(item, 'options') || !item.options || typeof item.options !== 'object') {
    item.options = {};
  }
  if (!Object.prototype.hasOwnProperty.call(item, 'lastError')) item.lastError = '';
  if (!Object.prototype.hasOwnProperty.call(item, 'createdAtMs')) {
    item.createdAtMs = Number.isFinite(Number(item.createdAtMs)) ? Number(item.createdAtMs) : Date.now();
  }

  return item;
}

module.exports = {
  init: async (meta) => {
    const conf = meta && meta.implConf ? meta.implConf : {};
    const log = meta && typeof meta.log === 'function' ? meta.log : () => {};
    const tag = 'OutboxCV';

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

    const serviceName = asText(readConf(conf, 'serviceName', 'outbox'), 'outbox');
    const namespace = asText(readConf(conf, 'namespace', 'Outbox'), 'Outbox');
    const storeKey = asText(readConf(conf, 'storeKey', 'state'), 'state');
    const tickMs = Math.max(100, asInt(readConf(conf, 'tickMs', 2000), 2000));
    const batchMax = Math.max(1, asInt(readConf(conf, 'batchMax', 5), 5));
    const maxAttempts = Math.max(0, asInt(readConf(conf, 'maxAttempts', 5), 5));
    const retryDelayMs = Math.max(0, asInt(readConf(conf, 'retryDelayMs', 5000), 5000));
    const deadMax = Math.max(1, asInt(readConf(conf, 'deadMax', 500), 500));

    const sendPreferText = asText(readConf(conf, 'sendPrefer', ''), asText(readConf(globalConf, 'sendPrefer', ''), ''));
    const sendPrefer = asList(sendPreferText);

    const jsonstore = meta.getService('jsonstore');
    let queue = [];
    let dead = [];
    let lastId = 0;
    let timer = null;
    let running = false;
    let ready = false;

    function resolveSender() {
      for (let i = 0; i < sendPrefer.length; i += 1) {
        const name = sendPrefer[i];
        const svc = meta.getService(name);
        if (typeof svc === 'function') return svc;
        if (svc && typeof svc.send === 'function') return async (chatId, payload, options) => await svc.send(chatId, payload, options || {});
      }
      return null;
    }

    async function loadState() {
      if (!jsonstore || typeof jsonstore.open !== 'function') {
        ready = true;
        return;
      }
      const store = jsonstore.open(namespace);
      const state = await store.get(storeKey);

      const loadedQueue = state && Array.isArray(state.queue)
        ? state.queue
        : (state && Array.isArray(state.q) ? state.q : []);
      queue = loadedQueue.map(normalizeItem);

      const loadedDead = state && Array.isArray(state.dead) ? state.dead : [];
      dead = loadedDead.map((item) => (item && typeof item === 'object' ? Object.assign({}, item) : {}));

      if (state && typeof state.lastId === 'number') lastId = state.lastId;
      ready = true;
    }

    async function saveState() {
      if (!jsonstore || typeof jsonstore.open !== 'function') return;
      const store = jsonstore.open(namespace);
      await store.set(storeKey, { queue, dead, lastId });
    }

    function pushDead(item, lastError) {
      const deadItem = Object.assign({}, item, {
        lastError: String(lastError || ''),
        failedAtMs: Date.now(),
      });
      dead.push(deadItem);
      if (dead.length > deadMax) {
        dead = dead.slice(dead.length - deadMax);
      }
    }

    async function enqueue(chatId, payload, options) {
      const baseOptions = options && typeof options === 'object' ? Object.assign({}, options) : {};
      if (!Object.prototype.hasOwnProperty.call(baseOptions, 'isAuto')) baseOptions.isAuto = 1;
      if (!Object.prototype.hasOwnProperty.call(baseOptions, 'manualReply')) baseOptions.manualReply = 0;

      const item = normalizeItem({
        id: ++lastId,
        chatId,
        payload,
        options: baseOptions,
        attempts: 0,
        nextTryAtMs: 0,
        createdAtMs: Date.now(),
        lastError: '',
      });
      queue.push(item);
      await saveState();
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
        while (queue.length > 0 && sentCount < batchMax) {
          const first = normalizeItem(queue[0]);
          queue[0] = first;

          if (first.nextTryAtMs > Date.now()) break;

          if (first.attempts > maxAttempts) {
            pushDead(first, first.lastError || 'maxAttempts.exceeded');
            queue.shift();
            await saveState();
            continue;
          }

          try {
            await sender(first.chatId, first.payload, first.options || {});
            queue.shift();
            sentCount += 1;
          } catch (err) {
            const errText = getErrText(err);
            first.lastError = errText;

            if (err && err.code === 'ratelimit.block' && typeof err.waitMs === 'number' && err.waitMs > 0) {
              first.nextTryAtMs = Date.now() + err.waitMs;
            } else {
              first.attempts += 1;
              first.nextTryAtMs = Date.now() + retryDelayMs;
            }

            if (first.attempts > maxAttempts) {
              pushDead(first, first.lastError || 'maxAttempts.exceeded');
              queue.shift();
            }

            await saveState();
            break;
          }
        }

        if (sentCount > 0) {
          await saveState();
          if (traceLog || detailLog) log(tag, 'flush sent=' + sentCount + ' remain=' + queue.length);
        }
      } finally {
        running = false;
      }
    }

    function startLoop() {
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        flushOnce().catch(() => {});
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

    return { onMessage: async () => {}, onEvent: async () => {} };
  },
};