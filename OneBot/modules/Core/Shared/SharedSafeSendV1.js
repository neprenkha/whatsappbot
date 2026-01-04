'use strict';

/**
 * SharedSafeSendV1
 * Adds consistent debug logging and boolean contract.
 */
module.exports.safeSend = async function safeSend(meta, sendFn, chatId, text, options = {}) {
  const tag = 'SharedSafeSendV1';
  const log = (lvl, msg) => meta && meta.log && meta.log(tag, `${lvl} ${msg}`);
  if (!sendFn || typeof sendFn !== 'function') {
    log('error', `no send function chatId=${chatId}`);
    return { ok: false, reason: 'nosend' };
  }
  try {
    const res = await sendFn(chatId, text, options || {});
    const ok = !(res && res.ok === false);
    if (ok) log('info', `sent chatId=${chatId} len=${String(text || '').length}`);
    else log('error', `failed chatId=${chatId} reason=${res && res.reason ? res.reason : 'unknown'}`);
    return ok ? { ok: true } : { ok: false, reason: res && res.reason };
  } catch (e) {
    log('error', `exception chatId=${chatId} err=${e && e.message ? e.message : e}`);
    return { ok: false, reason: e && e.message };
  }
};

module.exports.pickSend = function pickSend(meta, preferred) {
  const tag = 'SharedSafeSendV1';
  const log = (msg) => meta && meta.log && meta.log(tag, msg);
  const prefers = Array.isArray(preferred)
    ? preferred
    : String(preferred || 'outsend,sendout,send').split(',').map((s) => s.trim()).filter(Boolean);

  if (meta && typeof meta.getService === 'function') {
    for (const n of prefers) {
      const fn = meta.getService(n);
      if (typeof fn === 'function') return [{ name: n, fn }];
    }
    const base = meta.getService('send');
    if (typeof base === 'function') return [{ name: 'send', fn: base }];
  }
  log('fallback to no-op sender');
  return [];
};