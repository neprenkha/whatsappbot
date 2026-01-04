'use strict';

function create(meta, transportServiceName) {
  function getTransport() {
    if (!meta || !meta.getService) return null;
    return meta.getService(transportServiceName || 'transport') || null;
  }

  async function sendDirect(chatId, content, options) {
    const t = getTransport();
    if (!t || typeof t.sendDirect !== 'function') return { ok: false, reason: 'transport.missing' };

    const text = (typeof content === 'string') ? content : String(content || '');
    try {
      await t.sendDirect(chatId, text, options || {});
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e && e.message) ? e.message : String(e) };
    }
  }

  return { sendDirect };
}

module.exports = { create };
