'use strict';

/*
FallbackReplyTextV1
- Send text Control Group -> Customer (DM)
- Fix: treat whatsapp-web.js Message object as SUCCESS (not only {ok:true})
- Add: dedupe same (toChatId + body) within short window to prevent double
- Optional: if reason=window, queue to outbox and STOP
- Always strip ticket token for customer
*/

const SharedLog = require('../Shared/SharedLogV1');

function s(v) { return v === null || v === undefined ? '' : String(v); }
function trim(v) { return s(v).trim(); }
function toInt(v, d) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : (d || 0);
}
function parseCsv(v) {
  return trim(v).split(',').map(x => x.trim()).filter(Boolean);
}

function stripTicket(text) {
  let t = s(text);
  t = t.replace(/\[\s*ticket[^\]]*\]/ig, '').trim();
  t = t.replace(/\bTicket\s*[:#]?\s*[A-Za-z0-9]+\b/ig, '').trim();
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

function normalizeSendResult(via, res) {
  if (res === undefined) return { ok: true, via };
  if (res && typeof res === 'object' && Object.prototype.hasOwnProperty.call(res, 'ok')) {
    if (res.ok === false) return Object.assign({ ok: false, via }, res);
    return Object.assign({ ok: true, via }, res);
  }
  if (res) return Object.assign({ ok: true, via }, (typeof res === 'object' ? res : { value: res }));
  return { ok: false, via, reason: 'failed' };
}

async function trySend(meta, svcName, chatId, text) {
  if (!meta || typeof meta.getService !== 'function') return { ok: false, via: svcName, reason: 'noMeta' };
  const svc = meta.getService(svcName);
  if (!svc) return { ok: false, via: svcName, reason: 'noSvc' };

  if (typeof svc === 'function') {
    const r = await svc(chatId, text, {});
    return normalizeSendResult(svcName, r);
  }

  if (typeof svc.sendDirect === 'function') {
    const r = await svc.sendDirect(chatId, text, {});
    return normalizeSendResult(svcName, r);
  }

  if (typeof svc.enqueue === 'function') {
    const r = await svc.enqueue(chatId, text, {});
    return normalizeSendResult(svcName, r);
  }
  if (typeof svc.push === 'function') {
    const r = await svc.push(chatId, text, {});
    return normalizeSendResult(svcName, r);
  }

  if (typeof svc.send === 'function') {
    const r = await svc.send(chatId, text, {});
    return normalizeSendResult(svcName, r);
  }

  return { ok: false, via: svcName, reason: 'badSvc' };
}

// in-memory dedupe for actual outbound text
const recentSend = new Map();
function shouldDropDuplicate(key, ttlMs) {
  const now = Date.now();
  for (const [k, t] of recentSend.entries()) {
    if ((now - t) > ttlMs) recentSend.delete(k);
  }
  const prev = recentSend.get(key);
  if (prev && (now - prev) <= ttlMs) return true;
  recentSend.set(key, now);
  return false;
}

async function sendText(meta, cfg, toChatId, text) {
  const log = SharedLog.makeLog(meta, 'FallbackReplyTextV1', {
    debugEnabled: cfg && cfg.debugLog,
    traceEnabled: cfg && cfg.traceLog
  });

  const chatId = trim(toChatId);
  if (!chatId) return { ok: false, reason: 'noChatId' };

  let body = trim(text);
  if (!body) return { ok: false, reason: 'emptyText' };

  if (toInt(cfg && cfg.stripTicketInCustomerReply, 1)) {
    body = stripTicket(body);
  }

  // DEDUPE: stop duplicate sends (even if handler called twice)
  const dedupeMs = toInt(cfg && cfg.replyTextDedupeMs, 4000);
  const dedupeKey = `${chatId}|${body}`;
  if (dedupeMs > 0 && shouldDropDuplicate(dedupeKey, dedupeMs)) {
    if (log && log.info) log.info('dedupeDrop', { to: chatId, ttlMs: dedupeMs });
    return { ok: true, via: 'dedupe', deduped: true };
  }

  const bypass = toInt(cfg && cfg.humanReplyBypass, 1);
  const allowQueueOnWindow = toInt(cfg && cfg.queueOnWindow, 1);

  let prefer = parseCsv((cfg && (cfg.replySendPrefer || cfg.sendPrefer)) || 'outsend,sendout,send');
  if (bypass) {
    prefer = ['transport'].concat(prefer.filter(x => x.toLowerCase() !== 'transport'));
  }

  let last = '';
  for (const name of prefer) {
    try {
      if (log && log.debug) log.debug('trying service: ' + name);
      const r = await trySend(meta, name, chatId, body);

      if (r && r.ok) {
        if (log && log.info) log.info('sendOk', { to: chatId, via: r.via || name });
        return r;
      }

      const reason = (r && (r.reason || r.err)) ? String(r.reason || r.err) : 'failed';
      last = reason;

      if (log && log.info) log.info('sendFail', { to: chatId, via: name, reason });

      if (allowQueueOnWindow && reason === 'window') {
        const outbox = meta.getService('outbox');
        if (outbox && typeof outbox.enqueue === 'function') {
          if (log && log.debug) log.debug('queueing to outbox due to window');
          const qr = await outbox.enqueue(chatId, body, {});
          const qn = normalizeSendResult('outbox', qr);
          if (log && log.info) log.info('queued', { to: chatId, ok: !!qn.ok, reason: 'window' });
          return qn.ok ? qn : { ok: false, reason: 'queueFailed' };
        }
        if (log && log.warn) log.warn('window detected but no outbox service available');
        return { ok: false, reason: 'window' };
      }
    } catch (e) {
      last = e && e.message ? e.message : String(e || '');
      if (log && log.info) log.info('sendErr', { to: chatId, via: name, err: last });
    }
  }

  if (log && log.error) log.error('allFailed after trying: ' + prefer.join(', ') + ' lastErr: ' + last);
  return { ok: false, reason: 'allFailed', err: last };
}

module.exports = { sendText };
