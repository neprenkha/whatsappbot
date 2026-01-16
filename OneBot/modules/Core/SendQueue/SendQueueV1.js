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
  const errorLogDebounceMs = toInt(meta.implConf.errorLogDebounceMs, 60000); // 1 minute default
  const queueFullLogDebounceMs = toInt(meta.implConf.queueFullLogDebounceMs, 300000); // 5 minutes default
  const maxLogMapEntries = toInt(meta.implConf.maxLogMapEntries, 1000);

  const queue = [];
  let busy = false;

  // Log debouncing maps
  const errorLogMap = new Map(); // chatId -> lastLoggedAt
  const queueFullLogMap = new Map(); // chatId -> lastLoggedAt

  function cleanupLogMap(map) {
    if (map.size <= maxLogMapEntries) return;
    const entries = Array.from(map.entries());
    entries.sort((a, b) => a[1] - b[1]); // Sort by timestamp ascending
    const toDelete = entries.slice(0, Math.floor(map.size / 2));
    for (const [key] of toDelete) {
      map.delete(key);
    }
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length > 0) {
        const job = queue.shift();
        try {
          await meta.getService('transport').sendDirect(job.chatId, job.text, job.options || {});
        } catch (e) {
          // Log debouncing: only log once per chatId within debounce window
          const now = Date.now();
          const lastLogged = errorLogMap.get(job.chatId) || 0;
          if (errorLogDebounceMs <= 0 || (now - lastLogged) >= errorLogDebounceMs) {
            meta.log('send', `error chatId=${job.chatId} err=${e && e.message ? e.message : e}`);
            errorLogMap.set(job.chatId, now);
            cleanupLogMap(errorLogMap);
          }
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
    } finally {
      busy = false;
    }
  }

  async function send(chatId, text, options = {}) {
    if (!chatId) return false;
    if (queue.length >= maxQueue) {
      // Log debouncing: only log once per chatId within debounce window
      const now = Date.now();
      const lastLogged = queueFullLogMap.get(chatId) || 0;
      if (queueFullLogDebounceMs <= 0 || (now - lastLogged) >= queueFullLogDebounceMs) {
        meta.log('send', `drop chatId=${chatId} reason=queue_full max=${maxQueue}`);
        queueFullLogMap.set(chatId, now);
        cleanupLogMap(queueFullLogMap);
      }
      return false;
    }
    queue.push({ chatId, text: String(text || ''), options });
    pump();
    return true;
  }

  meta.registerService('send', send);

  meta.log('SendQueueV1', `ready delayMs=${delayMs} maxQueue=${maxQueue} errorLogDebounceMs=${errorLogDebounceMs} queueFullLogDebounceMs=${queueFullLogDebounceMs}`);

  return {
    onEvent: async () => {},
    onMessage: async () => {},
  };
};
