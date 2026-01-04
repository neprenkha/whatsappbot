'use strict';

function create(meta, cfg, store, transport) {
  let timer = null;
  let lastAt = 0;
  let busy = false;

  function log(msg) {
    try { meta.log(cfg.logPrefix || 'SendQueue', msg); } catch (_) {}
  }

  async function flushBatch() {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      if ((now - lastAt) < cfg.delayMs) return;

      for (let i = 0; i < cfg.batchMax; i++) {
        const item = store.peek();
        if (!item) break;

        const res = await transport.sendDirect(item.chatId, item.text, item.options || {});
        if (!res || res.ok === false) {
          log(`blocked chatId=${item.chatId} reason=${(res && res.reason) ? res.reason : 'unknown'}`);
          break;
        }

        store.shift();
        lastAt = Date.now();
      }
    } finally {
      busy = false;
    }
  }

  function start() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { flushBatch().catch(() => {}); }, Math.max(100, cfg.delayMs));
  }

  function kick() {
    flushBatch().catch(() => {});
  }

  return { start, kick };
}

module.exports = { create };