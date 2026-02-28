'use strict';

function firstLine(s) {
  return String(s || '').split('\n')[0].trim();
}

function describeError(err) {
  const reason = String((err && (err.code || err.message || err.reason)) || 'send_failed');
  const detail = firstLine((err && (err.stack || err.message || err.reason || err.code)) || 'send_failed_no_detail');
  return { reason, detail };
}

function create(meta, transportServiceName) {
  function getTransport() {
    if (!meta || !meta.getService) return null;
    return meta.getService(transportServiceName || 'transport') || null;
  }

  function isReady() {
    const t = getTransport();
    return !!(t && typeof t.sendDirect === 'function');
  }

  async function sendDirect(chatId, content, options) {
    const t = getTransport();
    if (!t || typeof t.sendDirect !== 'function') {
      return {
        ok: false,
        reason: 'transport.missing',
        detail: 'service missing: ' + String(transportServiceName || 'transport'),
      };
    }

    try {
      await t.sendDirect(chatId, content, options || {});
      return { ok: true };
    } catch (e) {
      const d = describeError(e);
      return {
        ok: false,
        reason: d.reason,
        detail: d.detail,
        retryable: e && e.retryable === true ? 1 : 0,
        waitMs: e && typeof e.waitMs === 'number' ? e.waitMs : 0,
      };
    }
  }

  return { sendDirect, isReady };
}

module.exports = { create };