'use strict';

function toCsvList(csv) {
  if (!csv || typeof csv !== 'string') return [];
  return csv
    .split(',')
    .map((s) => String(s || '').trim())
    .filter((s) => s.length > 0);
}

function normalizeSendResult(res, senderName) {
  if (res === true) return { ok: true, sender: senderName || '', result: true };
  if (res === false) return { ok: false, sender: senderName || '', reason: 'send_failed', detail: 'sender returned false' };

  if (res && typeof res === 'object') {
    if (Object.prototype.hasOwnProperty.call(res, 'ok')) {
      const out = Object.assign({}, res);
      if (!out.sender && senderName) out.sender = senderName;
      if (out.ok === false) {
        if (!out.reason) out.reason = 'send_failed';
        if (!out.detail) out.detail = String(out.reason || 'send_failed');
      }
      return out;
    }
    return { ok: true, sender: senderName || '', result: res };
  }

  return { ok: true, sender: senderName || '', result: res };
}

function toErrResult(err, senderName) {
  const reason = String((err && (err.code || err.message || err.reason)) || 'send_failed');
  const detail = String((err && (err.stack || err.message || err.reason || err.code)) || 'send_failed_no_detail').split('\n')[0];
  return {
    ok: false,
    sender: senderName || '',
    reason,
    detail,
    retryable: err && err.retryable === true ? 1 : 0,
    waitMs: err && typeof err.waitMs === 'number' ? err.waitMs : 0,
  };
}

function pickSend(meta, preferCsv) {
  const prefer = toCsvList(preferCsv);
  const out = [];
  const services = (meta && meta.services) || {};

  for (const name of prefer) {
    const svc = services[name];
    if (!svc) continue;
    out.push({ name, sender: svc });
  }
  return out;
}

async function invokeSender(sender, chatId, payload, opts) {
  if (!sender) throw new Error('sender_missing');

  if (typeof sender === 'function') {
    return await sender(chatId, payload, opts || {});
  }

  if (typeof sender.send === 'function') {
    return await sender.send(chatId, payload, opts || {});
  }

  if (typeof payload === 'string' && typeof sender.sendText === 'function') {
    return await sender.sendText(chatId, payload, opts || {});
  }

  if (typeof sender.sendMedia === 'function') {
    return await sender.sendMedia(chatId, payload, opts || {});
  }

  throw new Error('sender_unsupported');
}

// safeSend(meta, preferCsv, doSendFn, opts, log)
// doSendFn is function(sender) -> Promise
async function safeSend(meta, preferCsv, doSendFn, opts, log) {
  const prefer = preferCsv || 'sendout,outsend,send,transport';
  const senders = pickSend(meta, prefer);
  if (!senders.length) throw new Error('no_senders_available');

  let lastErr = null;
  for (const it of senders) {
    try {
      const res = await doSendFn(it.sender, it.name);
      const normalized = normalizeSendResult(res, it.name);
      if (normalized.ok === true) return normalized;
      lastErr = new Error(normalized.reason || 'send_failed');
      lastErr.code = normalized.reason || 'send_failed';
      lastErr.detail = normalized.detail || 'send failed';
      if (log && log.error) {
        log.error('send failed', { sender: it.name, err: String(normalized.reason || 'send_failed'), detail: String(normalized.detail || '') });
      }
    } catch (e) {
      lastErr = e;
      if (log && log.error) {
        log.error('send failed', { sender: it.name, err: String(e && e.message ? e.message : e) });
      }
    }
  }
  throw lastErr || new Error('send_failed');
}

// Compatibility send() used by repo modules:
//  - send(log, outsendFn, chatId, payload, opts)
//  - send(log, meta, chatId, payload, opts)
async function send(log, senderOrMeta, chatId, payload, opts) {
  const o = opts || {};
  if (!chatId) throw new Error('chatId_missing');

  // Pattern A: sender function or sender object passed directly
  if (typeof senderOrMeta === 'function' || (senderOrMeta && typeof senderOrMeta === 'object' && senderOrMeta !== null && !senderOrMeta.services)) {
    try {
      const res = await invokeSender(senderOrMeta, chatId, payload, o);
      const out = normalizeSendResult(res, 'direct');
      if (log && log.info) {
        const len = typeof payload === 'string' ? payload.length : 0;
        log.info('sent', { chatId, len, ok: out.ok ? 1 : 0 });
      }
      if (out.ok === false && log && log.error) {
        log.error('send failed reason=' + String(out.reason || 'send_failed') + ' detail=' + String(out.detail || ''));
      }
      return out;
    } catch (e) {
      const out = toErrResult(e, 'direct');
      if (log && log.error) {
        log.error('send failed reason=' + out.reason + ' detail=' + out.detail);
      }
      return out;
    }
  }

  // Pattern B: meta passed (pick sender from prefer list)
  const meta = senderOrMeta;
  const prefer = o.sendPrefer || 'sendout,outsend,send,transport';

  try {
    const r = await safeSend(
      meta,
      prefer,
      async (sender) => {
        return await invokeSender(sender, chatId, payload, o);
      },
      o,
      log
    );

    if (log && log.info) {
      const len = typeof payload === 'string' ? payload.length : 0;
      log.info('sent', { chatId, sender: r.sender, len, ok: r.ok ? 1 : 0 });
    }
    return r;
  } catch (e) {
    const out = toErrResult(e, 'meta');
    if (log && log.error) {
      log.error('send failed reason=' + out.reason + ' detail=' + out.detail);
    }
    return out;
  }
}

module.exports = {
  pickSend,
  safeSend,
  send,
};