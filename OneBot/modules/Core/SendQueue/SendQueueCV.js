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

function loadGlobalConf(meta, cfg, bugLog) {
  const rel = toStr(cfg.globalConfRel, '');
  if (!rel) {
    if (bugLog) meta.log('SendQueueCV', 'global_conf_missing_key globalConfRel');
    return {};
  }
  try {
    const loaded = meta.loadConfRel(rel);
    if (loaded && loaded.conf && typeof loaded.conf === 'object') return loaded.conf;
    return {};
  } catch (e) {
    if (bugLog) meta.log('SendQueueCV', 'global_conf_load_failed err=' + String(e && e.message ? e.message : e));
    return {};
  }
}

function normalizeChatId(v) {
  return String(v || '').trim();
}

function normalizeOptions(v) {
  if (!v || typeof v !== 'object') return {};
  return Object.assign({}, v);
}

module.exports.init = async function init(meta) {
  const cfg = meta && meta.implConf ? meta.implConf : {};

  const enabled = toBool(cfg.enabled, true);
  const moduleLog = toBool(cfg.moduleLog, true);
  const bugLog = toBool(cfg.bugLog, true);
  const detailLog = toBool(cfg.detailLog, false);
  const traceLog = toBool(cfg.traceLog, false);

  if (!enabled) {
    if (moduleLog) meta.log('SendQueueCV', 'disabled');
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const globalConf = loadGlobalConf(meta, cfg, bugLog);

  const serviceName = toStr(cfg.serviceName, 'send');
  const outboxServiceName = toStr(cfg.outboxServiceName, 'outbox');
  const maxQueue = Math.max(1, toInt(cfg.maxQueue, 2000));
  const dedupeMs = Math.max(0, toInt(cfg.dedupeMs, 6000));
  const dedupeMax = Math.max(100, toInt(cfg.dedupeMax, 8000));
  const sendPrefer = toStr(globalConf.sendPrefer, 'sendout,outsend');

  const outbox = meta.getService(outboxServiceName);
  if (!outbox || typeof outbox.send !== 'function') {
    if (bugLog) meta.log('SendQueueCV', 'missing_outbox_service name=' + outboxServiceName);
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const queue = [];
  const dedupeMap = new Map();
  let flushing = false;

  function dedupeKey(chatId, payload, options) {
    const p = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
    const o = JSON.stringify(options || {});
    return chatId + '|' + p + '|' + o;
  }

  function cleanDedupe(now) {
    for (const entry of dedupeMap.entries()) {
      const k = entry[0];
      const exp = entry[1];
      if (exp <= now) dedupeMap.delete(k);
    }
    if (dedupeMap.size > dedupeMax) dedupeMap.clear();
  }

  async function flushQueue() {
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length > 0) {
        const head = queue[0];
        await outbox.send(head.chatId, head.payload, head.options);
        queue.shift();
      }
    } finally {
      flushing = false;
    }
  }

  async function send(chatId, payload, options) {
    const id = normalizeChatId(chatId);
    if (!id) throw new Error('sendqueue.invalid_chatId');

    const opts = normalizeOptions(options);

    if (opts.isAuto === undefined) opts.isAuto = 0;
    if (opts.manualReply === undefined) opts.manualReply = 0;
    if (opts.bypassRateLimit === undefined) opts.bypassRateLimit = 0;

    const now = Date.now();
    cleanDedupe(now);

    if (dedupeMs > 0) {
      const key = dedupeKey(id, payload, opts);
      const exp = Number(dedupeMap.get(key) || 0);
      if (exp > now) {
        if (traceLog) meta.log('SendQueueCV', 'dedupe_drop chatId=' + id);
        return { ok: true, dedupe: 1 };
      }
      dedupeMap.set(key, now + dedupeMs);
    }

    if (queue.length >= maxQueue) {
      throw new Error('sendqueue.full');
    }

    queue.push({
      chatId: id,
      payload: payload,
      options: opts,
      createdAtMs: now
    });

    try {
      await flushQueue();
    } catch (e) {
      if (bugLog) meta.log('SendQueueCV', 'flush_failed err=' + String(e && e.message ? e.message : e));
      throw e;
    }

    if (detailLog || traceLog) {
      meta.log('SendQueueCV', 'queued chatId=' + id + ' queueSize=' + String(queue.length) + ' isAuto=' + (toBool(opts.isAuto, false) ? '1' : '0') + ' manualReply=' + (toBool(opts.manualReply, false) ? '1' : '0') + ' bypassRateLimit=' + (toBool(opts.bypassRateLimit, false) ? '1' : '0'));
    }

    return { ok: true, queued: 1, sendPrefer: sendPrefer };
  }

  meta.registerService(serviceName, send);

  if (moduleLog) {
    meta.log('SendQueueCV', 'ready service=' + serviceName + ' outboxService=' + outboxServiceName + ' maxQueue=' + String(maxQueue) + ' dedupeMs=' + String(dedupeMs));
  }

  return { onMessage: async () => {}, onEvent: async () => {} };
};