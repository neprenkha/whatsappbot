'use strict';

const util = require('util');

const SharedLog = require('../Shared/SharedLogV1');
const SharedSafeSend = require('../Shared/SharedSafeSendV1');
const TypeUtil = require('./FallbackTypeUtilV1');

function createLogger(meta, cfg) {
  const c = cfg || {};
  const make = SharedLog.createLogger || SharedLog.create;
  return make('FallbackForwardMediaV1', meta, {
    debug: !!c.debug,
    trace: !!c.trace,
  });
}

function splitCsv(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function retryMeta(err) {
  const out = { retryable: 0, waitMs: 0 };
  if (err && err.retryable === true) out.retryable = 1;
  if (err && typeof err.waitMs === 'number' && err.waitMs > 0) out.waitMs = err.waitMs;
  return out;
}

function errDetail(err) {
  try {
    if (!err) return '';
    if (typeof err === 'string') return err;
    const msg = err.message ? String(err.message) : '';
    const stack = err.stack ? String(err.stack).split('\n')[0] : '';
    const obj = util.inspect(err, { depth: 3, breakLength: 140, maxArrayLength: 20 });
    return [msg, stack, obj].filter(Boolean).join(' | ');
  } catch (_) {
    return String(err || '');
  }
}

function getFileName(raw) {
  const d = (raw && raw._data) || {};
  return d.filename || d.fileName || '';
}

function toBool(v, dflt) {
  if (v === undefined || v === null || v === '') return !!dflt;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return !!dflt;
}

function messageOf(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return String(err.message || err.code || err.reason || '');
}

function normalizeSendResult(res) {
  if (res === false) {
    return { ok: false, reason: 'send_returned_false', detail: 'sender returned false' };
  }
  if (res && res.ok === false) {
    return {
      ok: false,
      reason: String(res.reason || res.code || 'send_failed'),
      detail: String(res.detail || res.message || ''),
      retryable: res.retryable === true ? 1 : 0,
      waitMs: typeof res.waitMs === 'number' && res.waitMs > 0 ? res.waitMs : 0,
    };
  }
  return { ok: true, raw: res };
}

function pickSender(meta, cfg) {
  const names = splitCsv(cfg.forwardMediaSendPrefer || cfg.sendPrefer || 'outsend,sendout,transport,send');
  for (const name of names) {
    const svc = meta.getService(name);
    if (typeof svc === 'function') return { name, fn: svc };
    if (svc && typeof svc.sendDirect === 'function') return { name, fn: async (chatId, payload, opts) => await svc.sendDirect(chatId, payload, opts || {}) };
    if (svc && typeof svc.send === 'function') return { name, fn: async (chatId, payload, opts) => await svc.send(chatId, payload, opts || {}) };
  }
  return { name: '', fn: null };
}

async function tryDownloadMedia(raw, log) {
  if (!raw || typeof raw.downloadMedia !== 'function') return { ok: false, reason: 'noDownloadMedia', detail: 'raw.downloadMedia is missing' };
  try {
    const m = await raw.downloadMedia();
    if (!m) return { ok: false, reason: 'downloadNull', detail: 'downloadMedia returned null' };
    return { ok: true, media: m };
  } catch (e) {
    const detail = errDetail(e);
    log.warn('downloadMedia failed ' + detail);
    return { ok: false, reason: 'downloadFail', detail: detail };
  }
}

async function handle(meta, cfg, ticketCtx, ctx) {
  const c = cfg || {};
  const log = createLogger(meta, c);

  if (!ticketCtx || !ticketCtx.controlGroupId) {
    log.error('CRITICAL: missing ticketCtx.controlGroupId - cannot forward media');
    return { ok: false, reason: 'missingControlGroupId', detail: 'ticketCtx.controlGroupId is required' };
  }

  const sender = pickSender(meta, c);
  if (typeof sender.fn !== 'function') {
    log.error('missing sender service for media forwarding');
    return { ok: false, reason: 'missingSender', detail: 'no sender in forwardMediaSendPrefer/sendPrefer' };
  }

  const raw = ctx.raw;
  if (!raw || !raw.hasMedia) return { ok: true, skipped: true, reason: 'noMedia' };

  const t = TypeUtil.getRawType(raw);
  const fname = getFileName(raw);

  const captionParts = [];
  if (t) captionParts.push('Type: ' + t);
  if (fname) captionParts.push('File: ' + fname);
  const caption = TypeUtil.cleanText(captionParts.join('\n'), c.forwardMediaCaptionMaxLen || 900);

  const dl = await tryDownloadMedia(raw, log);
  if (dl.ok) {
    const sendOpt = {
      tag: 'fallback.in.media',
      manualReply: toBool(c.forwardMediaManualReply, true) ? 1 : 0,
      allowOutsideWindow: toBool(c.forwardMediaAllowOutsideWindow, true) ? 1 : 0,
      bypassRateLimit: toBool(c.forwardMediaBypassRateLimit, false) ? 1 : 0,
    };
    if (caption) sendOpt.caption = caption;

    try {
      const sent = await SharedSafeSend.send(log, sender.fn, ticketCtx.controlGroupId, dl.media, sendOpt);
      const nr = normalizeSendResult(sent);
      if (!nr.ok) {
        const reason = nr.reason || 'send_failed';
        const detail = nr.detail || 'send returned non-ok result';
        log.error('send media failed ticketId=' + String(ticketCtx.ticketId || '') + ' target=' + ticketCtx.controlGroupId + ' svc=' + sender.name + ' retryable=' + String(nr.retryable || 0) + ' waitMs=' + String(nr.waitMs || 0) + ' reason=' + reason + ' detail=' + detail);
        return { ok: false, reason, detail, svc: sender.name, retryable: nr.retryable || 0, waitMs: nr.waitMs || 0 };
      }
      log.trace('media forwarded successfully ticketId=' + String(ticketCtx.ticketId || '') + ' target=' + ticketCtx.controlGroupId + ' svc=' + sender.name);
      return { ok: true, svc: sender.name };
    } catch (e) {
      const detail = errDetail(e);
      const msg = messageOf(e) || 'sendException';
      const r = retryMeta(e);
      log.error('send media exception ticketId=' + String(ticketCtx.ticketId || '') + ' target=' + ticketCtx.controlGroupId + ' svc=' + sender.name + ' retryable=' + String(r.retryable) + ' waitMs=' + String(r.waitMs) + ' reason=' + msg + ' detail=' + detail);
      return { ok: false, reason: msg, detail: detail, svc: sender.name, retryable: r.retryable, waitMs: r.waitMs };
    }
  }

  log.warn('media download failed ticketId=' + String(ticketCtx.ticketId || '') + ' target=' + ticketCtx.controlGroupId + ' svc=' + sender.name + ' reason=' + String(dl.reason || 'downloadFail') + ' detail=' + String(dl.detail || ''));
  if (typeof raw.forward === 'function') {
    try {
      await raw.forward(ticketCtx.controlGroupId);
      log.trace('raw.forward success ticketId=' + String(ticketCtx.ticketId || '') + ' target=' + ticketCtx.controlGroupId);
      return { ok: true, mode: 'forward', svc: 'raw.forward' };
    } catch (e) {
      const detail = errDetail(e);
      const r = retryMeta(e);
      const msg = messageOf(e) || 'forwardFail';
      log.warn('raw.forward failed ticketId=' + String(ticketCtx.ticketId || '') + ' target=' + ticketCtx.controlGroupId + ' svc=raw.forward retryable=' + String(r.retryable) + ' waitMs=' + String(r.waitMs) + ' reason=' + msg + ' detail=' + detail);
      return { ok: false, reason: msg, detail: detail, svc: 'raw.forward', retryable: r.retryable, waitMs: r.waitMs };
    }
  }

  log.error('no forward method available ticketId=' + String(ticketCtx.ticketId || '') + ' target=' + ticketCtx.controlGroupId + ' svc=' + sender.name + ' reason=noForward detail=raw.forward missing');
  return { ok: false, reason: 'noForward', detail: 'raw.forward missing', svc: sender.name };
}

module.exports = { handle };