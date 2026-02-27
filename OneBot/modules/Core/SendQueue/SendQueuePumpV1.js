'use strict';

// SendQueuePumpV1
// Contract:
// - Export { create }.
// - create(meta, cfg, store, transport) -> { start, kick }
//
// Behavior:
// - No log spam when queue is empty.
// - No drop: if send fails, keep item in store for retry.
// - Avoid overlapping flush runs.

function create(meta, cfg, store, transport) {
  var timer = null;
  var lastAt = 0;
  var busy = false;

  function log(msg) {
    try {
      if (meta && typeof meta.log === 'function') {
        meta.log((cfg && cfg.logPrefix) ? cfg.logPrefix : 'SendQueue', msg);
      }
    } catch (_) {}
  }

  async function flushBatch() {
    if (busy) return;
    busy = true;

    try {
      var now = Date.now();
      if (cfg && cfg.delayMs && (now - lastAt) < cfg.delayMs) return;

      var batchMax = (cfg && cfg.batchMax) ? cfg.batchMax : 1;
      if (batchMax < 1) batchMax = 1;

      for (var i = 0; i < batchMax; i++) {
        var item = store.peek();
        if (!item) {
          // Empty queue: exit silently.
          break;
        }

        var res = null;
        try {
          res = await transport.sendDirect(item.chatId, item.content, item.options || {});
        } catch (e) {
          res = { ok: false, reason: e && e.message ? String(e.message) : 'error' };
        }

        if (!res || res.ok === false) {
          // Keep item for retry later.
          // Only log when there is an actual failure.
          log('blocked chatId=' + item.chatId + ' reason=' + (res && res.reason ? res.reason : 'unknown') + ' detail=' + (res && res.detail ? res.detail : 'no_detail'));
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
    var t = (cfg && cfg.delayMs) ? Number(cfg.delayMs) : 800;
    if (!isFinite(t) || t < 100) t = 100;
    timer = setInterval(function() {
      flushBatch().catch(function() {});
    }, t);
  }

  function kick() {
    flushBatch().catch(function() {});
  }

  return { start: start, kick: kick };
}

module.exports = { create: create };