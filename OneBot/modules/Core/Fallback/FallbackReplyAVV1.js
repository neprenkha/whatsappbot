'use strict';

const SharedLog = require('../Shared/SharedLogV1');
const MediaSend = require('../Shared/SharedMediaSendV1');

function _safeStr(x) { return String(x == null ? '' : x); }
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

async function _downloadWithRetry(log, rawMsg, maxRetry, baseDelayMs) {
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    try {
      const media = await rawMsg.downloadMedia();
      if (media) return media;
      log.error('downloadMedia empty (attempt ' + attempt + '/' + maxRetry + ')');
    } catch (e) {
      log.error('downloadMedia error attempt=' + attempt + ' err=' + _safeStr(e && e.message ? e.message : e));
    }
    if (attempt < maxRetry) await _sleep(baseDelayMs + attempt * 900);
  }
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

  const media = await _downloadWithRetry(log, rawMsg, Number(cfg.replyMediaRetry || 6), Number(cfg.replyMediaRetryDelayMs || 2200));
  if (!media) return { ok: false, reason: 'downloadFailed' };

  const type = rawMsg && rawMsg.type ? String(rawMsg.type).toLowerCase() : '';

  let cap = _safeStr(caption || '');
  if (cfg.stripTicketInCustomerReply) cap = _stripTicketLines(cap);

  const opt = {};
  if (cap) opt.caption = cap;

  if (type === 'ptt') opt.sendAudioAsVoice = true;
  if (type === 'audio' && (cfg.sendAudioAsVoice || cfg.audioAsVoice)) opt.sendAudioAsVoice = true;

  try {
    const r = await MediaSend.sendDirectWithFallback(log, transport, toChatId, media, opt, rawMsg);
    return { ok: !!(r && r.ok), mode: r && r.mode };
  } catch (e) {
    log.error('sendAv failed err=' + _safeStr(e && e.message ? e.message : e));
    return { ok: false, reason: 'sendFailed' };
  }
}

module.exports = { sendAv };
