'use strict';

/*
SharedMediaSendV1
- Centralized media sending with safe fallbacks for audio/video.
- Uses transport.sendDirect(chatId, media, options).
*/

function _asString(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err && err.message) return String(err.message);
  try { return JSON.stringify(err); } catch (e) { return String(err); }
}

function _classify(media, raw) {
  const mt = (media && media.mimetype) ? String(media.mimetype).toLowerCase() : '';
  const rt = (raw && raw.type) ? String(raw.type).toLowerCase() : '';
  const t = rt || mt;

  const isAudio = t.indexOf('audio') >= 0;
  const isVideo = t.indexOf('video') >= 0;
  const isImage = t.indexOf('image') >= 0;
  const isDoc = t.indexOf('document') >= 0 || t.indexOf('pdf') >= 0;

  return { isAudio, isVideo, isImage, isDoc, mt, rt };
}

function _cleanOptionsForAudio(options) {
  const o = Object.assign({}, options || {});
  // Audio commonly fails with caption. Keep it clean.
  if (Object.prototype.hasOwnProperty.call(o, 'caption')) delete o.caption;
  // Some engines accept these flags; harmless if ignored.
  o.sendAudioAsVoice = false;
  return o;
}

function _fallbackAsDocument(options) {
  const o = Object.assign({}, options || {});
  o.asDocument = true;
  return o;
}

async function sendDirectWithFallback(log, transport, chatId, media, options, raw) {
  if (!transport || typeof transport.sendDirect !== 'function') {
    const e = new Error('transport.sendDirect not available');
    if (log && log.error) log.error('sendDirectWithFallback no transport.sendDirect');
    throw e;
  }

  const info = _classify(media, raw);
  const baseOpt = options || {};

  // Attempt 1: normal send
  try {
    await transport.sendDirect(chatId, media, baseOpt);
    return { ok: true, mode: 'direct', info };
  } catch (e1) {
    const m1 = _asString(e1);
    if (log && log.warn) log.warn('media send failed mode=direct err=' + m1);

    // Attempt 2: audio clean (no caption)
    if (info.isAudio) {
      try {
        const opt2 = _cleanOptionsForAudio(baseOpt);
        await transport.sendDirect(chatId, media, opt2);
        return { ok: true, mode: 'audioClean', info };
      } catch (e2) {
        const m2 = _asString(e2);
        if (log && log.warn) log.warn('media send failed mode=audioClean err=' + m2);
      }

      // Attempt 3: audio as document
      try {
        const opt3 = _fallbackAsDocument(_cleanOptionsForAudio(baseOpt));
        await transport.sendDirect(chatId, media, opt3);
        return { ok: true, mode: 'audioAsDoc', info };
      } catch (e3) {
        const m3 = _asString(e3);
        if (log && log.error) log.error('media send failed mode=audioAsDoc err=' + m3);
        throw e3;
      }
    }

    // Attempt 2: video as document
    if (info.isVideo) {
      try {
        const opt2v = _fallbackAsDocument(baseOpt);
        await transport.sendDirect(chatId, media, opt2v);
        return { ok: true, mode: 'videoAsDoc', info };
      } catch (e2v) {
        const m2v = _asString(e2v);
        if (log && log.error) log.error('media send failed mode=videoAsDoc err=' + m2v);
        throw e2v;
      }
    }

    // For other types, no further fallback.
    throw e1;
  }
}

module.exports = {
  sendDirectWithFallback,
  _classify
};
