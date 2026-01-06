'use strict';

const SharedLog = require('../Shared/SharedLogV1');
const MediaSend = require('../Shared/SharedMediaSendV1');

function _safeStr(x) { return String(x == null ? '' : x); }

function _stripTicketLines(text) {
  if (!text) return '';
  const lines = String(text).split('\n');
  const kept = [];
  for (const l of lines) {
    const t = l.trim().toLowerCase();
    if (t.startsWith('ticket:')) continue;
    kept.push(l);
  }
  return kept.join('\n').trim();
}

function _getSendTransport(meta) {
  const fn = meta.getService('outsend') || meta.getService('sendout');
  if (typeof fn === 'function') return { sendDirect: fn };
  const transport = meta.getService('transport');
  if (transport && typeof transport.sendDirect === 'function') return transport;
  return null;
}

async function sendAv(meta, cfgRaw, rawMsg, toChatId, caption) {
  const cfg = (cfgRaw && typeof cfgRaw === 'object') ? cfgRaw : {};
  const debugEnabled = !!(cfg.debugLog || cfg.debug);
  const traceEnabled = !!(cfg.traceLog || cfg.trace);
  const log = SharedLog.create(meta, 'FallbackReplyAVV1', { debugEnabled, traceEnabled });

  const transport = _getSendTransport(meta);
  if (!transport) return { ok: false, reason: 'noTransport' };

  if (!rawMsg || typeof rawMsg.downloadMedia !== 'function') {
    return { ok: false, reason: 'noDownloadMedia' };
  }

  let media = null;
  try { media = await rawMsg.downloadMedia(); } catch (e) {
    log.error('downloadMedia failed err=' + _safeStr(e && e.message ? e.message : e));
  }
  if (!media) return { ok: false, reason: 'downloadFailed' };

  const type = rawMsg && rawMsg.type ? String(rawMsg.type).toLowerCase() : '';

  let cap = _safeStr(caption || '');
  if (cfg.stripTicketInCustomerReply) cap = _stripTicketLines(cap);

  const opt = {};
  if (cap) opt.caption = cap;

  if (type === 'ptt') opt.sendAudioAsVoice = true;
  if (type === 'audio' && (cfg.sendAudioAsVoice || cfg.audioAsVoice)) opt.sendAudioAsVoice = true;

  // IMPORTANT FIX: correct argument order
  const r = await MediaSend.sendDirectWithFallback(log, transport, toChatId, media, opt, rawMsg);
  return { ok: !!(r && r.ok) };
}

module.exports = { sendAv };
