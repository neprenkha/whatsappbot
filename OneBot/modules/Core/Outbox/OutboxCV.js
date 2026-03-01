'use strict';

// REWRITTEN: standalone CV implementation, no legacy imports.

function toBool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return d;
}

function toInt(v, d) {
  const n = parseInt(String(v === undefined || v === null ? '' : v), 10);
  return Number.isFinite(n) ? n : d;
}

function toStr(v, d) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s || d;
}

function splitCsv(v) {
  return String(v || '').split(',').map((x) => String(x || '').trim()).filter(Boolean);
}

function loadGlobalConf(meta, cfg, bugLog) {
  const rel = toStr(cfg.globalConfRel, '');
  if (!rel) {
    if (bugLog) meta.log('OutboxCV', 'global_conf_missing_key globalConfRel');
    return {};
  }
  try {
    const loaded = meta.loadConfRel(rel);
    return loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
  } catch (e) {
    if (bugLog) meta.log('OutboxCV', 'global_conf_load_failed err=' + String(e && e.message ? e.message : e));
    return {};
  }
}

function normalizeOptions(v) {
  if (!v || typeof v !== 'object') return {};
  return Object.assign({}, v);
}

function nowMs() {
  return Date.now();
}

function buildBackoffMs(attempts, retryBackoffMs, retryBackoffMaxMs) {
  const base = Math.max(1, retryBackoffMs);
  const cap = Math.max(base, retryBackoffMaxMs);
  const step = Math.max(0, attempts - 1);
  const raw = base * Math.pow(2, step);
  return Math.min(cap, raw);
}

module.exports.init = async function init(meta) {
  const cfg = meta && meta.implConf ? meta.implConf : {};

  const enabled = toBool(cfg.enabled, true);
  const moduleLog = toBool(cfg.moduleLog, true);
  const bugLog = toBool(cfg.bugLog, true);
  const detailLog = toBool(cfg.detailLog, false);
  const traceLog = toBool(cfg.traceLog, false);

  if (!enabled) {
    if (moduleLog) meta.log('OutboxCV', 'disabled');
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const globalConf = loadGlobalConf(meta, cfg, bugLog);

  const serviceName = toStr(cfg.serviceName, 'outbox');
  const storeServiceName = toStr(cfg.storeServiceName, 'jsonstore');
  const storeNamespace = toStr(cfg.storeNamespace, 'core');
  const storeKey = toStr(cfg.storeKey, 'Outbox/state');
  const pumpIntervalMs = Math.max(100, toInt(cfg.pumpIntervalMs, 2000));
  const batchMax = Math.max(1, toInt(cfg.batchMax, 5));
  const maxAttempts = Math.max(1, toInt(cfg.maxAttempts, 8));
  const retryBackoffMs = Math.max(100, toInt(cfg.retryBackoffMs, 1000));
  const retryBackoffMaxMs = Math.max(retryBackoffMs, toInt(cfg.retryBackoffMaxMs, 60000));
  const sendPrefer = splitCsv(toStr(cfg.sendPrefer, toStr(globalConf.sendPrefer, 'sendout,outsend')));

  const jsonstore = meta.getService(storeServiceName);
  if (!jsonstore || typeof jsonstore.open !== 'function') {
    if (bugLog) meta.log('OutboxCV', 'missing_store_service name=' + storeServiceName);
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const store = jsonstore.open(storeNamespace);

  let pumpBusy = false;

  async function loadState() {
    const rec = await store.get(storeKey, { queue: [] });
    const queue = rec && Array.isArray(rec.queue) ? rec.queue : [];
    return { queue };
  }

  async function saveState(state) {
    const queue = state && Array.isArray(state.queue) ? state.queue : [];
    await store.set(storeKey, { queue });
  }

  function resolveOutbound() {
    for (let i = 0; i < sendPrefer.length; i += 1) {
      const name = sendPrefer[i];
      const svc = meta.getService(name);
      if (!svc) continue;
      if (typeof svc === 'function') {
        return { name, fn: async (chatId, payload, opts) => await svc(chatId, payload, opts || {}) };
      }
      if (typeof svc.send === 'function') {
        return { name, fn: async (chatId, payload, opts) => await svc.send(chatId, payload, opts || {}) };
      }
    }
    return null;
  }

  async function enqueue(chatId, payload, options) {
    const id = String(chatId || '').trim();
    if (!id) throw new Error('outbox.invalid_chatId');

    const state = await loadState();
    state.queue.push({
      chatId: id,
      payload,
      options: normalizeOptions(options),
      createdAtMs: nowMs(),
      updatedAtMs: nowMs(),
      attempts: 0,
      nextTryAtMs: 0,
      status: 'queued',
      lastError: '',
    });
    await saveState(state);

    if (traceLog) meta.log('OutboxCV', 'enqueue chatId=' + id + ' queueSize=' + String(state.queue.length));
    return { ok: true, queued: 1, queueSize: state.queue.length };
  }

  async function pumpOnce() {
    if (pumpBusy) return;
    pumpBusy = true;

    try {
      const outbound = resolveOutbound();
      if (!outbound) {
        if (bugLog) meta.log('OutboxCV', 'outbound_service_missing prefer=' + sendPrefer.join(','));
        return;
      }

      const state = await loadState();
      if (!state.queue.length) return;

      let sentCount = 0;
      const now = nowMs();

      for (let i = 0; i < state.queue.length && sentCount < batchMax; i += 1) {
        const item = state.queue[i];
        if (!item || item.status === 'failed') continue;

        const nextTryAtMs = Math.max(0, toInt(item.nextTryAtMs, 0));
        if (nextTryAtMs > now) continue;

        try {
          await outbound.fn(item.chatId, item.payload, item.options || {});
          state.queue.splice(i, 1);
          i -= 1;
          sentCount += 1;
          continue;
        } catch (e) {
          const code = String((e && e.code) || '');
          const waitMs = Math.max(0, toInt(e && e.waitMs, 0));

          if (code === 'ratelimit.block' && waitMs > 0) {
            item.updatedAtMs = nowMs();
            item.nextTryAtMs = nowMs() + waitMs;
            item.lastError = 'ratelimit.block';
            item.status = 'queued';
            if (detailLog) meta.log('OutboxCV', 'pump_pause waitMs=' + String(waitMs));
            break;
          }

          const attempts = Math.max(0, toInt(item.attempts, 0)) + 1;
          item.attempts = attempts;
          item.updatedAtMs = nowMs();
          item.lastError = String(e && e.message ? e.message : e);

          if (attempts >= maxAttempts) {
            item.status = 'failed';
            item.nextTryAtMs = 0;
            if (bugLog) {
              meta.log('OutboxCV', 'item_failed chatId=' + String(item.chatId || '') + ' attempts=' + String(attempts) + ' err=' + item.lastError);
            }
          } else {
            item.status = 'queued';
            item.nextTryAtMs = nowMs() + buildBackoffMs(attempts, retryBackoffMs, retryBackoffMaxMs);
            if (bugLog) {
              meta.log('OutboxCV', 'item_retry chatId=' + String(item.chatId || '') + ' attempts=' + String(attempts) + ' nextTryAtMs=' + String(item.nextTryAtMs));
            }
          }
        }
      }

      await saveState(state);

      if (traceLog || detailLog) {
        meta.log('OutboxCV', 'pump_done sent=' + String(sentCount) + ' queueSize=' + String(state.queue.length));
      }
    } finally {
      pumpBusy = false;
    }
  }

  setInterval(() => {
    pumpOnce().catch((e) => {
      if (bugLog) meta.log('OutboxCV', 'pump_error err=' + String(e && e.message ? e.message : e));
    });
  }, pumpIntervalMs);

  const service = {
    send: async (chatId, payload, options) => await enqueue(chatId, payload, options),
    pumpNow: async () => await pumpOnce(),
  };

  meta.registerService(serviceName, service);

  if (moduleLog) {
    meta.log(
      'OutboxCV',
      'ready service=' + serviceName +
      ' pumpIntervalMs=' + String(pumpIntervalMs) +
      ' batchMax=' + String(batchMax) +
      ' maxAttempts=' + String(maxAttempts) +
      ' sendPrefer=' + sendPrefer.join(',')
    );
  }

  return { onMessage: async () => {}, onEvent: async () => {} };
};