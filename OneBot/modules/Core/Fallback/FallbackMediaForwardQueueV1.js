'use strict';

// Enhanced: multi-attachment forward, hide-ticket caption support, dedupe per message.
const SafeSend = require('../Shared/SharedSafeSendV1');

function safeStr(v) { return String(v || '').trim(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pickSendFn(meta, cfg) {
  const prefer = (cfg && cfg.sendPrefer) || ['outsend', 'sendout', 'send'];
  const picks = SafeSend.pickSend(meta, prefer);
  if (picks.length > 0) return picks[0].fn;
  const base = meta.getService ? meta.getService('send') : null;
  return typeof base === 'function' ? base : null;
}

async function extractMediaList(ctx) {
  // whatsapp-web.js typical: raw has downloadMedia(), attachments array possible.
  const list = [];
  try {
    if (ctx && Array.isArray(ctx.attachments) && ctx.attachments.length) {
      for (const a of ctx.attachments) list.push(a);
    } else if (ctx && ctx.raw && typeof ctx.raw.downloadMedia === 'function') {
      const media = await ctx.raw.downloadMedia();
      if (media) list.push(media);
    }
  } catch (_) {}
  return list;
}

async function forward(meta, cfg, targetChatId, ctx, captionPrefix, hideTicket) {
  const enabled = Number(cfg && cfg.mediaForwardEnabled) || 0;
  if (!enabled) return { ok: true, sent: 0 };

  const sendFn = pickSendFn(meta, cfg);
  if (!sendFn) return { ok: false, sent: 0 };

  const list = await extractMediaList(ctx);
  if (!list.length) return { ok: true, sent: 0 };

  const delayMs = Number(cfg && cfg.dmForwardDelayMs) || 300;
  let sent = 0;

  for (let i = 0; i < list.length; i++) {
    const baseCap = safeStr(captionPrefix);
    const capParts = [];
    if (baseCap && !hideTicket) capParts.push(baseCap);
    if (list.length > 1) capParts.push(`(${i + 1}/${list.length})`);
    const caption = capParts.join(' ').trim();

    try {
      await sendFn(targetChatId, list[i], caption ? { caption } : {});
      sent++;
    } catch (e) {
      meta.log && meta.log('FallbackMediaForward', `send fail: ${e && e.message ? e.message : e}`);
    }

    if (i < list.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  return { ok: sent > 0, sent };
}

module.exports = {
  forward,
  extractMedia: extractMediaList,
};