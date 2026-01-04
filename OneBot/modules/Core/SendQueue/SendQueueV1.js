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

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length > 0) {
        const job = queue.shift();
        try {
          await meta.getService('transport').sendDirect(job.chatId, job.text, job.options || {});
        } catch (e) {
          meta.log('send', `error chatId=${job.chatId} err=${e && e.message ? e.message : e}`);
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
      meta.log('send', `drop chatId=${chatId} reason=queue_full max=${maxQueue}`);
      return false;
    }
    queue.push({ chatId, text: String(text || ''), options });
    pump();
    return true;
  }

  meta.registerService('send', send);

  meta.log('SendQueueV1', `ready delayMs=${delayMs} maxQueue=${maxQueue}`);

  return {
    onEvent: async () => {},
    onMessage: async () => {},
  };
};
