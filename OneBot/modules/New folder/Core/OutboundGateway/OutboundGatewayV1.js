/**
 * OutboundGatewayV1.js
 * Outgoing send wrapper with RateLimit integration.
 *
 * Adds safe bypass for internal destinations (e.g. control group) so fallback never gets blocked by window.
 */
'use strict';

function toBool(v, dflt) {
  if (v === undefined || v === null || v === '') return !!dflt;
  const s = String(v).trim().toLowerCase();
  if (['1','true','yes','y','on'].includes(s)) return true;
  if (['0','false','no','n','off'].includes(s)) return false;
  return !!dflt;
}

function toInt(v, dflt) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : dflt;
}

function splitCsv(v) {
  return String(v || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

module.exports.init = async (meta) => {
  const cfg = meta.implConf || {};
  const enabled = toBool(cfg.enabled, true);

  const baseSendName = String(cfg.baseSend || 'send').trim() || 'send';
  const rlName = String(cfg.ratelimitService || 'ratelimit').trim() || 'ratelimit';
  const svcNames = splitCsv(cfg.service || cfg.services || 'sendout,outsend');
  const bypassChatIds = new Set(splitCsv(cfg.bypassChatIds || cfg.bypassChats || ''));

  const baseSend = meta.getService ? meta.getService(baseSendName) : null;
  const rl = meta.getService ? meta.getService(rlName) : null;

  if (!enabled) {
    try { meta.log('OutboundGatewayV1', `disabled enabled=0`); } catch (_) {}
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  if (typeof baseSend !== 'function') {
    throw new Error(`OutboundGatewayV1: baseSend "${baseSendName}" not found`);
  }

  async function sendout(chatId, text, opts = {}) {
    const at = Date.now();
    const key = `out:${chatId}`;
    const weight = toInt(opts.weight, 1);

    if (rl && typeof rl.check === 'function') {
      const res = await rl.check({
        key,
        direction: 'out',
        at,
        weight,
        chatId,
        isGroup: String(chatId || '').endsWith('@g.us'),
      });

      if (res && res.ok === false) {
        const bypass = toBool(opts.bypass, false) || bypassChatIds.has(chatId);
        if (!bypass) return res;
      }
    }

    await baseSend(chatId, text, opts);
    return { ok: true };
  }

  async function outsend(chatId, text, opts = {}) {
    return await sendout(chatId, text, opts);
  }

  if (meta.registerService) {
    for (const n of svcNames) {
      if (n === 'sendout') meta.registerService(n, sendout);
      else if (n === 'outsend') meta.registerService(n, outsend);
      else meta.registerService(n, sendout);
    }
  }

  try {
    meta.log('OutboundGatewayV1',
      `ready enabled=1 baseSend=${baseSendName} rl=${rl ? rlName : '(none)'} svc=${svcNames.join(',')} bypassChatIds=${bypassChatIds.size}`
    );
  } catch (_) {}

  return { onMessage: async () => {}, onEvent: async () => {} };
};
