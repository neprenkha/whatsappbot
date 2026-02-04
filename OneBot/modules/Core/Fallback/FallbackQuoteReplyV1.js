'use strict';

const SharedLog = require('../Shared/SharedLogV1');
const TicketCore = require('../Shared/SharedTicketCoreV2');
const SafeSend = require('../Shared/SharedSafeSendV1');
const TypeUtil = require('./FallbackTypeUtilV1');

async function handle(meta, cfg, ctx) {
  const log = SharedLog.create('FallbackQuoteReplyV1');
  const raw = TypeUtil.getRaw(ctx);
  if (!raw) return;

  const quotedText = TypeUtil.getQuotedText(raw);
  const ticketId = TypeUtil.parseTicketId(quotedText);
  if (!ticketId) return;

  const r = await TicketCore.resolve(meta, cfg, cfg.ticketType, ticketId);
  if (!r || !r.ok || !r.chatId) return;

  // Prefer forwarding media as-is if staff sends media
  if (raw.hasMedia && typeof raw.forward === 'function') {
    try {
      await raw.forward(r.chatId);
    } catch (e) {
      if (cfg.bugLog) log.error('raw.forward to customer failed', { err: String(e && e.message ? e.message : e) });
    }
  }

  const body = TypeUtil.cleanText(ctx.text || '');
  if (body) {
    await SafeSend.send(log, meta, r.chatId, body, { sendPrefer: cfg.sendPrefer });
  }

  if (cfg.detailLog) log.info('quote replied', { ticketId, chatId: r.chatId });
}

module.exports = { handle };
