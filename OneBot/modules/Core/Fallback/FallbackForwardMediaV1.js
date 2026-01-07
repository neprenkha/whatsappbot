'use strict';

const SharedLog = require('../Shared/SharedLogV1');
const SharedSafeSend = require('../Shared/SharedSafeSendV1');
const TypeUtil = require('./FallbackTypeUtilV1');

function createLogger(meta, cfg) {
  const make = SharedLog.createLogger || SharedLog.create;
  return make('FallbackForwardMediaV1', meta, {
    debug: !!cfg.debug,
    trace: !!cfg.trace,
  });
}

function getFileName(raw) {
  const d = (raw && raw._data) || {};
  return d.filename || d.fileName || '';
}

async function tryDownloadMedia(raw, log) {
  if (!raw || typeof raw.downloadMedia !== 'function') return { ok: false, reason: 'noDownloadMedia' };
  try {
    const m = await raw.downloadMedia();
    if (!m) return { ok: false, reason: 'downloadNull' };
    return { ok: true, media: m };
  } catch (e) {
    log.warn('downloadMedia failed ' + (e && e.message ? e.message : e));
    return { ok: false, reason: 'downloadFail' };
  }
}

async function handle(meta, cfg, ticketCtx, ctx) {
  const log = createLogger(meta, cfg);

  const outsend = meta.getService('outsend');
  if (typeof outsend !== 'function') {
    log.error('missing outsend service');
    return { ok: false, reason: 'missingOutsend' };
  }

  const raw = ctx.raw;
  if (!raw || !raw.hasMedia) return { ok: true, skipped: true, reason: 'noMedia' };

  const t = TypeUtil.getRawType(raw);
  const fname = getFileName(raw);

  // Minimal caption: do not repeat ticket lines on every attachment
  const captionParts = [];
  if (t) captionParts.push('Type: ' + t);
  if (fname) captionParts.push('File: ' + fname);
  const caption = TypeUtil.cleanText(captionParts.join('\n'), cfg.forwardMediaCaptionMaxLen || 900);

  const dl = await tryDownloadMedia(raw, log);
  if (dl.ok) {
    const sendOpt = { tag: 'fallback.in.media' };
    if (caption) sendOpt.caption = caption;

    const r = await SharedSafeSend.send(log, outsend, ticketCtx.controlGroupId, dl.media, sendOpt);
    if (!r.ok) log.error('send media failed reason=' + (r.reason || ''));
    return r;
  }

  // fallback: forward raw without caption
  if (typeof raw.forward === 'function') {
    try {
      await raw.forward(ticketCtx.controlGroupId);
      return { ok: true, mode: 'forward' };
    } catch (e) {
      log.warn('raw.forward failed ' + (e && e.message ? e.message : e));
      return { ok: false, reason: 'forwardFail' };
    }
  }

  return { ok: false, reason: 'noForward' };
}

module.exports = { handle };
