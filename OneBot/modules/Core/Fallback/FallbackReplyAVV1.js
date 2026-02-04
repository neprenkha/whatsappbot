'use strict';

const SafeSend = require('../Shared/SharedSafeSendV1');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function downloadWithTimeout(raw, timeoutMs) {
  const to = Number(timeoutMs) || 90000;
  if (!raw || typeof raw.downloadMedia !== 'function') return null;

  return await Promise.race([
    raw.downloadMedia(),
    (async () => { await sleep(to); throw new Error('download timeout'); })(),
  ]);
}

async function handle(meta, cfg, toChatId, raw, captionText) {
  const tag = 'FallbackReplyAVV1';
  try {
    const media = await downloadWithTimeout(raw, cfg && cfg.mediaTimeoutMs);
    if (!media) {
      meta && meta.log && meta.log(tag, 'warn media download returned empty');
      return { ok: false, reason: 'download_empty' };
    }

    const type = (raw && raw.type) ? String(raw.type) : '';
    const options = {};
    const cap = String(captionText || '').trim();
    if (cap) options.caption = cap;

    // Keep video inline: do not force document.
    if (type === 'ptt' || type === 'voice') options.sendAudioAsVoice = true;

    await SafeSend.send(meta, cfg, toChatId, media, options);
    return { ok: true };
  } catch (e) {
    meta && meta.log && meta.log(tag, `error send failed err=${e && e.message ? e.message : e}`);
    return { ok: false, reason: e && e.message ? e.message : 'send_failed' };
  }
}

module.exports = { handle };
