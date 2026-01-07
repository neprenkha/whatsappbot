'use strict';

/*
FallbackReplyAVV1

Send audio/video from Control Group to customer (resolved by ticket).
- Prefer global outbound pipeline (outsend/sendout/send)
- Download media from the quoted message via msg.downloadMedia()
- Fallback to raw forward when reupload fails

Note: audio/video are more fragile; we avoid captions for audio by default.
*/

const Conf = require('../Shared/SharedConfV1');
const SharedLog = require('../Shared/SharedLogV1');
const SafeSend = require('../Shared/SharedSafeSendV1');
const MediaSend = require('../Shared/SharedMediaSendV1');

function _safeStr(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function _resolveSendService(meta, cfg) {
  const prefer = cfg.getCsv('sendPrefer', ['outsend', 'sendout', 'send']);
  return SafeSend.pickSend(meta, prefer);
}

async function _downloadFromMsg(msg) {
  try {
    if (!msg || typeof msg.downloadMedia !== 'function') return { ok: false, reason: 'noDownloadMedia' };
    const media = await msg.downloadMedia();
    if (!media) return { ok: false, reason: 'empty' };
    return { ok: true, media };
  } catch (e) {
    return { ok: false, reason: 'exception', error: (e && e.message) || String(e) };
  }
}

async function replyAV(meta, cfg, job) {
  const logMaker = SharedLog.create || SharedLog.makeLog;
  const log = logMaker ? logMaker(meta, 'FallbackReplyAVV1') : console;

  const toChatId = _safeStr(job && job.chatId);
  if (!toChatId) return { ok: false, reason: 'noChatId' };

  const sendService = _resolveSendService(meta, cfg);
  const transport = meta.getService('transport') || null;

  const dl = await _downloadFromMsg(job && job.msg);
  if (!dl.ok) {
    log.warn('download failed', { reason: dl.reason, error: dl.error || '' });
    try {
      if (job && job.msg && typeof job.msg.forward === 'function') {
        await job.msg.forward(toChatId);
        return { ok: true, mode: 'forward' };
      }
    } catch (e) {}
    return { ok: false, reason: 'downloadFailed', error: dl.error || dl.reason };
  }

  const options = {};

  const forwardFn = (job && job.msg && typeof job.msg.forward === 'function')
    ? async (cid) => {
        await job.msg.forward(cid);
        return { ok: true, mode: 'forward' };
      }
    : null;

  const res = await MediaSend.sendDirectWithFallback(log, transport, toChatId, dl.media, options, job.msg, sendService, forwardFn);
  if (!res || !res.ok) {
    log.error('send failed', { reason: (res && res.reason) || 'unknown', error: (res && res.error) || '' });
    return res || { ok: false, reason: 'sendFailed' };
  }

  return res;
}

module.exports = {
  replyAV,
};
