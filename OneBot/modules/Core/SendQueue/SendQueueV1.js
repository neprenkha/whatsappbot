'use strict';

/**
 * SendQueueV1 (Core)
 * - Global outgoing queue (single pipe)
 * - Registers service: send(chatId, text, options)
 */

function toInt(v, def = 0) {
  const n = parseInt(String(v || '').trim(), 10);
  return Number.isFinite(n) ? n : def;
}

module.exports.init = async function init(meta) {
  const delayMs = toInt(meta.implConf.delayMs, 800);
  const maxQueue = toInt(meta.implConf.maxQueue, 500);

  const queue = [];
  let busy = false;
  const recentSends = new Map(); // for deduplication
  const DEDUPE_CLEANUP_MULTIPLIER = 2; // Clean up entries older than 2x dedupe window

  function makeDedupeKey(chatId, text) {
    const cid = String(chatId || '').trim();
    const txt = String(text || '').slice(0, 100); // first 100 chars for deduplication
    return `${cid}:${txt}`;
  }

  function isDuplicate(chatId, text, dedupeMs = 3000) {
    const key = makeDedupeKey(chatId, text);
    const now = Date.now();
    
    // Clean old entries (older than 2x dedupe window to ensure we don't clean too early)
    for (const [k, t] of recentSends.entries()) {
      if (now - t > dedupeMs * DEDUPE_CLEANUP_MULTIPLIER) recentSends.delete(k);
    }
    
    const lastSeen = recentSends.get(key);
    if (lastSeen && (now - lastSeen) < dedupeMs) {
      return true;
    }
    recentSends.set(key, now);
    return false;
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length > 0) {
        const job = queue.shift();
        try {
          meta.log('SendQueueV1', `sending chatId=${job.chatId} queueLen=${queue.length}`);
          await meta.getService('transport').sendDirect(job.chatId, job.text, job.options || {});
          meta.log('SendQueueV1', `sent success chatId=${job.chatId}`);
        } catch (e) {
          const errMsg = e && e.message ? e.message : e;
          meta.log('SendQueueV1', `send error chatId=${job.chatId} err=${errMsg}`);
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
    } finally {
      busy = false;
    }
  }

  async function send(chatId, text, options = {}) {
    if (!chatId) {
      meta.log('SendQueueV1', 'drop: empty chatId');
      return false;
    }
    
    // Check for duplicates
    if (isDuplicate(chatId, text, 3000)) {
      meta.log('SendQueueV1', `drop duplicate chatId=${chatId} dedupeMs=3000`);
      return true; // return true to indicate it was handled (deduplicated)
    }
    
    if (queue.length >= maxQueue) {
      meta.log('SendQueueV1', `drop chatId=${chatId} reason=queue_full max=${maxQueue}`);
      return false;
    }
    queue.push({ chatId, text: String(text || ''), options });
    meta.log('SendQueueV1', `enqueued chatId=${chatId} queueLen=${queue.length}`);
    pump();
    return true;
  }

  meta.registerService('send', send);

  meta.log('SendQueueV1', `ready delayMs=${delayMs} maxQueue=${maxQueue} deduplication=enabled`);

  return {
    onEvent: async () => {},
    onMessage: async () => {},
  };
};
