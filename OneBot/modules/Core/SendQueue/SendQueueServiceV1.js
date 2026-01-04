'use strict';

const crypto = require('crypto');

function sha1(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex');
}

function toInt(v, d) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : d;
}

function createSend(meta, cfg, store, pump, Normalize) {
  const dedupeMs = Math.max(0, toInt(cfg.dedupeMs, 6000));
  const dedupeMax = Math.max(1000, toInt(cfg.dedupeMax, 8000));
  const dedupeLog = !!cfg.dedupeLog;

  const seen = new Map();
  let tick = 0;

  function sweep(now) {
    for (const [k, exp] of seen.entries()) {
      if (!exp || exp <= now) seen.delete(k);
    }
    if (seen.size > dedupeMax) {
      const extra = seen.size - dedupeMax;
      let i = 0;
      for (const k of seen.keys()) {
        if (i >= extra) break;
        seen.delete(k);
        i++;
      }
    }
  }

  function shouldDrop(id, body) {
    if (!dedupeMs) return false;
    const now = Date.now();

    tick++;
    if (tick % 50 === 0 || seen.size > dedupeMax) sweep(now);

    const key = id + '|' + sha1(body);
    const exp = seen.get(key);
    if (exp && exp > now) return true;

    // only mark as seen when we decide to enqueue (success path handles it)
    return false;
  }

  function markSent(id, body) {
    if (!dedupeMs) return;
    const now = Date.now();
    const key = id + '|' + sha1(body);
    seen.set(key, now + dedupeMs);
  }

  return async function send(chatId, text, options = {}) {
    const id = Normalize.normalize(chatId);
    if (!id) return false;

    const body = (typeof text === 'string') ? text : String(text || '');

    if (shouldDrop(id, body)) {
      if (dedupeLog) {
        try { meta.log(cfg.logPrefix || 'SendQueue', `dedupe drop chatId=${id} len=${body.length}`); } catch (_) {}
      }
      return true; // treat as already-sent (prevents upstream retry/fallback)
    }

    const item = { chatId: id, text: body, options: options || {} };

    const r = store.enqueue(item);
    if (!r.ok) {
      try { meta.log(cfg.logPrefix || 'SendQueue', `drop chatId=${id} reason=${r.reason} max=${cfg.maxQueue}`); } catch (_) {}
      return false;
    }

    markSent(id, body);
    pump.kick();
    return true;
  };
}

module.exports = { createSend };
