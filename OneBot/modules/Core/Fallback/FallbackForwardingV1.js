'use strict';

const SharedLog = require('../Shared/SharedLogV1');
const TicketCore = require('../Shared/SharedTicketCoreV1');
const TypeUtil = require('./FallbackTypeUtilV1');

const ForwardText = require('./FallbackForwardTextV1');
const ForwardMedia = require('./FallbackForwardMediaV1');
const ForwardAv = require('./FallbackForwardAvV1');

function createLogger(meta, cfg) {
  const make = SharedLog.createLogger || SharedLog.create;
  return make('FallbackForwardingV1', meta, {
    debug: !!cfg.debug,
    trace: !!cfg.trace,
  });
}

function getSenderInfo(ctx) {
  const s = (ctx && ctx.sender) || {};
  return {
    phone: s.phone || '',
    name: s.name || '',
  };
}

async function handle(meta, cfg, ctx) {
  cfg = TypeUtil.normalizeTicketCfg(cfg || {});
  const log = createLogger(meta, cfg);

  if (!ctx) return { ok: false, reason: 'noCtx' };
  if (ctx.isGroup) return { ok: false, reason: 'skipGroup' };

  const raw = ctx.raw;
  const text = TypeUtil.cleanText(ctx.text || (raw && raw.body) || '', 6000);

  if (!cfg.controlGroupId) {
    log.error('CRITICAL: missing controlGroupId - cannot forward message');
    return { ok: false, reason: 'missingControlGroupId' };
  }

  // Validate controlGroupId format
  const isValidGroupId = String(cfg.controlGroupId).includes('@g.us');
  if (!isValidGroupId) {
    log.error(`CRITICAL: controlGroupId has invalid format: ${cfg.controlGroupId} - must be a group ID ending with @g.us`);
    return { ok: false, reason: 'invalidControlGroupId' };
  }

  const sender = getSenderInfo(ctx);

  // Use chatId as key so 1 customer = 1 ticket
  const key = ctx.chatId || '';
  if (!key) return { ok: false, reason: 'noChatId' };

  const t = await TicketCore.touch(meta, cfg, cfg.ticketType || 'fallback', key, {
    sourceChatId: key,
    controlGroupId: cfg.controlGroupId,
    fromPhone: sender.phone,
    fromName: sender.name,
  });

  if (!t || !t.ok) {
    log.error(`ticket touch failed key=${key}`);
    return { ok: false, reason: 'ticketTouchFailed' };
  }

  const ticketCtx = {
    controlGroupId: cfg.controlGroupId,
    ticketId: t.ticketId,
    seq: t.seq,
    fromPhone: sender.phone,
    fromName: sender.name,
  };

  const lane = TypeUtil.classify(raw, text);

  log.trace(`inbound lane=${lane} chatId=${key} ticket=${ticketCtx.ticketId} seq=${ticketCtx.seq} controlGroupId=${cfg.controlGroupId}`);

  if (lane === 'av') {
    log.trace('forwarding to av handler');
    return await ForwardAv.handle(meta, cfg, ticketCtx, ctx);
  }

  if (lane === 'media') {
    log.trace('forwarding to media handler');
    return await ForwardMedia.handle(meta, cfg, ticketCtx, ctx);
  }

  log.trace('forwarding to text handler');
  return await ForwardText.handle(meta, cfg, ticketCtx, ctx);
}

module.exports = { handle };
