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
    log.warn(`downloadMedia failed ${e && e.message ? e.message : e}`);
    return { ok: false, reason: 'downloadFail' };
  }
}

async function tryForwardRaw(raw, toChatId, log) {
  if (!raw || typeof raw.forward !== 'function') return { ok: false, reason: 'noForward' };
  try {
    await raw.forward(toChatId);
    return { ok: true };
  } catch (e) {
    log.warn(`raw.forward failed ${e && e.message ? e.message : e}`);
    return { ok: false, reason: 'forwardFail' };
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
  const prefix = TypeUtil.formatInboundPrefix(ticketCtx.ticketId, ticketCtx.fromPhone, ticketCtx.fromName, ticketCtx.seq);

  // Reupload image/doc with caption that contains ticket id (so quote-reply can extract ticket from the quote)
  const captionParts = [prefix];
  if (t) captionParts.push(`Type: ${t}`);
  if (fname) captionParts.push(`File: ${fname}`);

  const caption = TypeUtil.cleanText(captionParts.join('\n'), cfg.forwardMediaCaptionMaxLen || 900);

  const dl = await tryDownloadMedia(raw, log);
  if (dl.ok) {
    const r = await SharedSafeSend.send(log, outsend, ticketCtx.controlGroupId, dl.media, {
      caption,
      tag: 'fallback.in.media',
    });
    if (!r.ok) log.error(`send media failed reason=${r.reason || ''}`);
    return r;
  }

  // If download fails, fallback to forward + send caption-only text (still includes ticket id)
  const fwd = await tryForwardRaw(raw, ticketCtx.controlGroupId, log);
  if (!fwd.ok) return fwd;

  const r2 = await SharedSafeSend.send(log, outsend, ticketCtx.controlGroupId, caption, {
    tag: 'fallback.in.media.caption',
  });
  if (!r2.ok) log.error(`send caption failed reason=${r2.reason || ''}`);
  return r2;
}

module.exports = { handle };
