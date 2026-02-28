'use strict';

const crypto = require('crypto');

function sha1(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex');
}

function toInt(v, d) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : d;
}

function payloadFingerprint(payload) {
  if (typeof payload === 'string') return payload;
  if (payload === undefined || payload === null) return '';
  if (typeof payload === 'object') {
    const t = payload.mimetype || payload.type || payload.filename || payload.fileName || '';
    return '[media:' + String(t).slice(0, 120) + ']';
  }
  return String(payload);
}

function normalizePayload(payload) {
  if (payload === undefined || payload === null) {
    return { ok: false, reason: 'payload.invalid', detail: 'payload is null or undefined', value: null };
  }

  if (typeof payload === 'string') {
    const body = payload.trim();
    if (!body) return { ok: false, reason: 'payload.empty', detail: 'text payload is empty', value: null };
    return { ok: true, value: body };
  }

  if (typeof payload === 'object') {
    return { ok: true, value: payload };
  }

  return { ok: true, value: String(payload) };
}

function createSend(meta, cfg, store, pump, Normalize, transport) {
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
        i += 1;
      }
    }
  }

  function shouldDrop(id, payload) {
    if (!dedupeMs) return false;
    const now = Date.now();

    tick += 1;
    if (tick % 50 === 0 || seen.size > dedupeMax) sweep(now);

    const key = id + '|' + sha1(payloadFingerprint(payload));
    const exp = seen.get(key);
    if (exp && exp > now) return true;

    return false;
  }

  function markQueued(id, payload) {
    if (!dedupeMs) return;
    const now = Date.now();
    const key = id + '|' + sha1(payloadFingerprint(payload));
    seen.set(key, now + dedupeMs);
  }

  return async function send(chatId, payload, options = {}) {
    const id = Normalize.normalize(chatId);
    if (!id) return { ok: false, reason: 'chatid.empty', detail: 'empty chatId after normalization' };

    if (!transport || typeof transport.isReady !== 'function' || !transport.isReady()) {
      return { ok: false, reason: 'transport.missing', detail: 'sendqueue transport service unavailable' };
    }

    const normalized = normalizePayload(payload);
    if (!normalized.ok) {
      return { ok: false, reason: normalized.reason, detail: normalized.detail };
    }

    const content = normalized.value;

    if (shouldDrop(id, content)) {
      if (dedupeLog) {
        try { meta.log(cfg.logPrefix || 'SendQueue', 'dedupe drop chatId=' + id); } catch (_) {}
      }
      return { ok: true, deduped: true };
    }

    const item = { chatId: id, content: content, options: options || {} };

    const r = store.enqueue(item);
    if (!r.ok) {
      try { meta.log(cfg.logPrefix || 'SendQueue', 'drop chatId=' + id + ' reason=' + r.reason + ' max=' + cfg.maxQueue); } catch (_) {}
      return { ok: false, reason: r.reason || 'queue.full', detail: 'sendqueue enqueue failed' };
    }

    markQueued(id, content);
    pump.kick();
    return { ok: true, queued: true, size: r.size };
  };
}

module.exports = { createSend };