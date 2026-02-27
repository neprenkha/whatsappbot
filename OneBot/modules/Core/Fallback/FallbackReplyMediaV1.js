'use strict';

const SafeSend = require('../Shared/SharedSafeSendV1');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function downloadWithTimeout(raw, timeoutMs) {
  const to = Number(timeoutMs) || 60000;
  if (!raw || typeof raw.downloadMedia !== 'function') return null;

  return await Promise.race([
    raw.downloadMedia(),
    (async () => { await sleep(to); throw new Error('download timeout'); })(),
  ]);
}

function toBool(v, dflt) {
  if (v === undefined || v === null || v === '') return !!dflt;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return !!dflt;
}

async function handle(meta, cfg, toChatId, raw, captionText) {
  const tag = 'FallbackReplyMediaV1';
  const c = cfg || {};
  try {
    const media = await downloadWithTimeout(raw, c.mediaTimeoutMs);
    if (!media) {
      meta && meta.log && meta.log(tag, 'warn media download returned empty');
      return { ok: false, reason: 'download_empty' };
    }

    const type = (raw && raw.type) ? String(raw.type) : '';
    const options = {};
    const cap = String(captionText || '').trim();
    if (cap) options.caption = cap;

    if (type === 'document') options.sendMediaAsDocument = true;

    options.manualReply = toBool(c.replyManualReply, true) ? 1 : 0;
    options.allowOutsideWindow = toBool(c.replyAllowOutsideWindow, true) ? 1 : 0;
    options.bypassRateLimit = toBool(c.replyBypassRateLimit, false) ? 1 : 0;

    await SafeSend.send(meta, c, toChatId, media, options);
    return { ok: true };
  } catch (e) {
    meta && meta.log && meta.log(tag, `error send failed err=${e && e.message ? e.message : e}`);
    return { ok: false, reason: e && e.message ? e.message : 'send_failed' };
  }
}

module.exports = { handle };