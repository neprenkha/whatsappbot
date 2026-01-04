'use strict';

// SharedSafeSendV1
// Purpose: safest possible send wrapper for text and simple content.
// - Tries multiple send services (sendPrefer).
// - If content is STRING and all sends fail, optionally enqueue to Outbox (if available).
// - For NON-STRING content (e.g., MessageMedia), it will NOT enqueue to Outbox (best effort only).

function safeStr(v) {
  return String(v || '').trim();
}

function pickSend(meta, preferList) {
  const out = [];
  const seen = {};
  for (const n of preferList || []) {
    const name = safeStr(n).toLowerCase();
    if (!name || seen[name]) continue;
    seen[name] = true;
    const fn = meta.getService(name);
    if (typeof fn === 'function') out.push({ name, fn });
  }
  return out;
}

async function safeSend(meta, sendFn, chatId, content, options) {
  try {
    const res = await sendFn(chatId, content, options || {});
    return { ok: true, res };
  } catch (e) {
    return { ok: false, error: e };
  }
}

async function sendOrQueue(meta, cfg, chatId, content, options) {
  const prefer = (cfg && cfg.sendPrefer) || ['outsend', 'sendout', 'send'];
  const sendFns = pickSend(meta, prefer);

  for (const s of sendFns) {
    const r = await safeSend(meta, s.fn, chatId, content, options);
    if (r.ok) return { ok: true, via: s.name, queued: false };
  }

  // Only queue plain text
  if (typeof content !== 'string') {
    return { ok: false, via: 'none', queued: false };
  }

  const outboxName = safeStr(cfg && cfg.outboxService) || 'outbox';
  const outbox = meta.getService(outboxName);

  try {
    if (outbox && typeof outbox.enqueue === 'function') {
      await outbox.enqueue(chatId, safeStr(content));
      return { ok: true, via: 'outbox', queued: true };
    }
  } catch (_) {}

  return { ok: false, via: 'none', queued: false };
}

module.exports = {
  pickSend,
  safeSend,
  sendOrQueue,
};
