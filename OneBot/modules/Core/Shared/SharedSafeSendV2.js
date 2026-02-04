'use strict';

/*
SharedSafeSendV2

Purpose:
- Provide a defensive wrapper for sending through the configured send pipeline.
- Enforce sendSeen=false by default to avoid WhatsApp Web internal errors when chat state is not ready.

Exports:
- pickSend(meta, prefer)
- send(log, sendOrMeta, chatId, payload, options)

All ASCII only.
*/

function _asArray(prefer) {
  if (!prefer) return [];
  if (Array.isArray(prefer)) return prefer;
  if (typeof prefer === 'string') {
    return prefer
      .split(',')
      .map(function (s) { return String(s || '').trim(); })
      .filter(function (s) { return !!s; });
  }
  return [];
}

function _resolveSendFn(meta, name) {
  if (!meta || !meta.getService) return null;
  var svc = meta.getService(String(name || '').trim());
  if (!svc) return null;

  if (typeof svc === 'function') return svc;
  if (typeof svc.sendDirect === 'function') return function (chatId, payload, options) {
    return svc.sendDirect(chatId, payload, options);
  };
  if (typeof svc.send === 'function') return function (chatId, payload, options) {
    return svc.send(chatId, payload, options);
  };

  return null;
}

function pickSend(meta, prefer) {
  var names = _asArray(prefer);

  // Prefer list first.
  for (var i = 0; i < names.length; i++) {
    var fn = _resolveSendFn(meta, names[i]);
    if (fn) return fn;
  }

  // Common fallbacks.
  var fallback = ['outsend', 'sendout', 'send', 'transport'];
  for (var j = 0; j < fallback.length; j++) {
    var fn2 = _resolveSendFn(meta, fallback[j]);
    if (fn2) return fn2;
  }

  return null;
}

function _mergeOptions(options) {
  var o = options && typeof options === 'object' ? options : {};
  var out = {};
  Object.keys(o).forEach(function (k) { out[k] = o[k]; });

  // Enforce sendSeen=false unless explicitly set.
  if (typeof out.sendSeen === 'undefined') out.sendSeen = false;

  return out;
}

async function send(log, sendOrMeta, chatId, payload, options) {
  try {
    if (!chatId) {
      if (log && log.error) log.error('missing chatId');
      return { ok: false, reason: 'missing chatId' };
    }

    var sendFn = null;
    var meta = null;

    if (typeof sendOrMeta === 'function') {
      sendFn = sendOrMeta;
    } else {
      meta = sendOrMeta;
      var prefer = options && options.sendPrefer ? options.sendPrefer : null;
      sendFn = pickSend(meta, prefer);
    }

    if (!sendFn) {
      if (log && log.error) log.error('no senders available');
      return { ok: false, reason: 'no senders available' };
    }

    var opts = _mergeOptions(options);

    await sendFn(chatId, payload, opts);

    return { ok: true };
  } catch (e) {
    var reason = (e && e.message) ? e.message : String(e || 'error');
    if (log && log.error) log.error('send failed reason=' + reason);
    return { ok: false, reason: reason };
  }
}

module.exports = {
  pickSend: pickSend,
  send: send
};
