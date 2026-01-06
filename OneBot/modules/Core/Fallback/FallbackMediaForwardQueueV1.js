'use strict';

const SharedLog = require('../Shared/SharedLogV1');
const MediaSend = require('../Shared/SharedMediaSendV1');

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function _safeStr(x) { return String(x == null ? '' : x); }
function _getRaw(ctx) { return ctx ? (ctx.raw || ctx.message || null) : null; }

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
      log.error('downloadMedia returned empty (attempt ' + attempt + '/' + maxRetry + ')');
    } catch (e) {
      log.error('downloadMedia error attempt=' + attempt + ' err=' + _safeStr(e && e.message ? e.message : e));
    }
    if (attempt < maxRetry) {
      const wait = baseDelayMs + (attempt * 800);
      await _sleep(wait);
    }
  }
  return null;
}

const _queue = [];
let _running = false;

async function _runItem(item) {
  const { meta, cfg, log, groupChatId, rawMsg, caption } = item;

  const transport = _getSendTransport(meta);
  if (!transport) {
    log.error('no send transport');
    return false;
  }

  const maxRetry = Number(cfg.mediaForwardRetry || 6);
  const baseDelayMs = Number(cfg.mediaForwardRetryDelayMs || 2000);

  if (!rawMsg || typeof rawMsg.downloadMedia !== 'function') {
    log.error('rawMsg.downloadMedia not available');
    return false;
  }

  const media = await _downloadWithRetry(log, rawMsg, maxRetry, baseDelayMs);
  if (!media) return false;

  const opt = { caption: _safeStr(caption || '') };

  try {
    const r = await MediaSend.sendDirectWithFallback(log, transport, groupChatId, media, opt, rawMsg);
    return !!(r && r.ok);
  } catch (e) {
    log.error('forward failed err=' + _safeStr(e && e.message ? e.message : e));
    return false;
  }
}

async function _pump() {
  if (_running) return;
  _running = true;
  try {
    while (_queue.length > 0) {
      const item = _queue.shift();
      await _runItem(item);
      await _sleep(50);
    }
  } finally {
    _running = false;
  }
}

async function forward(meta, cfgRaw, groupChatId, ctx, caption) {
  const cfg = (cfgRaw && typeof cfgRaw === 'object') ? cfgRaw : {};
  const debugEnabled = !!(cfg.debugLog || cfg.debug);
  const traceEnabled = !!(cfg.traceLog || cfg.trace);
  const log = SharedLog.create(meta, 'FallbackMediaForwardQueueV1', { debugEnabled, traceEnabled });

  const raw = _getRaw(ctx);
  if (!raw) return { ok: false, reason: 'noraw' };
  if (!groupChatId) return { ok: false, reason: 'nogroup' };

  _queue.push({ meta, cfg, log, groupChatId, rawMsg: raw, caption: caption || '' });
  _pump().catch(() => {});
  return { ok: true };
}

module.exports = { forward };
