/**
 * OutboxV1.js
 * Persistent outbox queue (optional) for delayed outbound sending.
 *
 * This module MUST NEVER crash the bot on missing config.
 */
'use strict';

function toBool(v, dflt) {
  if (v === undefined || v === null || v === '') return !!dflt;
  const s = String(v).trim().toLowerCase();
  if (['1','true','yes','y','on'].includes(s)) return true;
  if (['0','false','no','n','off'].includes(s)) return false;
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

function parseJsonStoreSpec(spec) {
  // Expected: jsonstore:Namespace/file.json
  const s = String(spec || '').trim();
  if (!s.toLowerCase().startsWith('jsonstore:')) return null;

  const rest = s.substring('jsonstore:'.length).trim(); // e.g. Outbox/state.json
  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 2) return null;

  const ns = parts[0].trim();
  const file = parts.slice(1).join('/').trim(); // state.json
  const key = file.replace(/\.json$/i, '');

  return { ns, key };
}

function safeJson(x) {
  try { return JSON.stringify(x); } catch (e) { return String(x); }
}

function confGet(cfg, key, dflt) {
  if (!cfg) return dflt;
  if (typeof cfg.get === 'function') return cfg.get(key, dflt);
  if (Object.prototype.hasOwnProperty.call(cfg, key)) return cfg[key];
  return dflt;
}

module.exports = function init(meta) {
  const tag = 'OutboxV1';
  const log = meta.log || function () {};
  const cfg = meta.implConf || null;

  const enabled = toBool(confGet(cfg, 'enabled', '0'), false);
  if (!enabled) {
    log(tag, 'disabled enabled=0');
    return {};
  }

  const serviceName = String(confGet(cfg, 'serviceName', confGet(cfg, 'service', 'outbox')) || 'outbox').trim();
  const storeSpec = String(confGet(cfg, 'store', '') || '').trim();
  const tickMs = toInt(confGet(cfg, 'tickMs', 2000), 2000);
  const batchMax = toInt(confGet(cfg, 'batchMax', 5), 5);
  const sendPrefer = splitCsv(confGet(cfg, 'sendPrefer', '') || '');

  const storeInfo = parseJsonStoreSpec(storeSpec);
  const jsonstore = meta.getService('jsonstore');

  if (!storeInfo) {
    log(tag, 'missing.storeSpec ' + safeJson({ store: storeSpec }));
    return {};
  }
  if (!jsonstore || typeof jsonstore.open !== 'function') {
    log(tag, 'missing.jsonstore');
    // Still register service so callers do not crash; it becomes no-op queue.
  }

  // In-memory queue. Persisted state: { q:[{chatId,text,opts,at}], lastId:number }
  let q = [];
  let lastId = 0;
  let running = false;
  let timer = null;
  let ready = false;

  function pickSender() {
    for (const name of sendPrefer) {
      const s = meta.getService(name);
      if (typeof s === 'function') return s;
    }
    const transport = meta.getService('transport');
    if (typeof transport === 'function') return transport;
    const send = meta.getService('send');
    if (typeof send === 'function') return send;
    return null;
  }

  async function loadState() {
    if (!jsonstore || typeof jsonstore.open !== 'function') {
      ready = true;
      return;
    }
    const store = jsonstore.open(storeInfo.ns);
    const st = await store.get(storeInfo.key);
    if (st && Array.isArray(st.q)) q = st.q;
    if (st && typeof st.lastId === 'number') lastId = st.lastId;
    ready = true;
  }

  async function saveState() {
    if (!jsonstore || typeof jsonstore.open !== 'function') return;
    const store = jsonstore.open(storeInfo.ns);
    await store.set(storeInfo.key, { q, lastId });
  }

  function startTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(async () => {
      try { await tick(); } catch (e) { /* keep alive */ }
    }, tickMs);
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function enqueue(chatId, text, opts) {
    const item = { id: ++lastId, chatId, text, opts: opts || {}, at: Date.now() };
    q.push(item);
    await saveState();
    return item.id;
  }

  async function tick() {
    if (!ready) return;
    if (running) return;
    running = true;

    try {
      const sender = pickSender();
      if (!sender) {
        running = false;
        return;
      }

      let sent = 0;
      while (q.length > 0 && sent < batchMax) {
        const item = q[0];
        try {
          await sender(item.chatId, item.text, item.opts);
          q.shift();
          sent++;
        } catch (e) {
          // Stop on first failure; keep item in queue.
          break;
        }
      }

      if (sent > 0) await saveState();
    } finally {
      running = false;
    }
  }

  // Service API: outbox.send(chatId, text, opts)
  const svc = {
    send: async (chatId, text, opts) => await enqueue(chatId, text, opts),
    size: () => q.length,
    flush: async () => await tick(),
    stop: () => stopTimer(),
  };

  meta.registerService(serviceName, svc);

  (async () => {
    try {
      await loadState();
      startTimer();
      log(tag, 'ready enabled=1 serviceName=' + serviceName + ' store=' + storeSpec + ' tickMs=' + tickMs + ' batchMax=' + batchMax + ' sendPrefer=' + sendPrefer.join(','));
    } catch (e) {
      ready = true;
      startTimer();
      log(tag, 'ready enabled=1 serviceName=' + serviceName + ' store=' + storeSpec + ' tickMs=' + tickMs + ' batchMax=' + batchMax + ' sendPrefer=' + sendPrefer.join(','));
    }
  })();

  return {};
};
