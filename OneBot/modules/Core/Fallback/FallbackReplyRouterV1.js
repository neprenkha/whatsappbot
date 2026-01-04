'use strict';

/**
 * FallbackReplyRouterV1
 * - Routes Control Group replies to customer.
 * - Processes quote-reply and command-reply `!r <ticket> <text>`.
 */

const TicketCore = require('../Shared/SharedTicketCoreV1');
const SafeSend = require('../Shared/SharedSafeSendV1');

async function reply(meta, ctx, args) {
  const config = meta.implConf || {};
  const sendService = SafeSend.pickSend(meta, config.sendPrefer);
  const ticket = args[0] ? String(args[0]).trim() : null;
  const replyText = args.slice(1).join(' ').trim();

  if (!ticket || !replyText) {
    ctx.reply('Usage: !r <ticket> <text>');
    return { ok: false, reason: 'bad.command' };
  }

  const ticketInfo = await TicketCore.resolve(meta, config, ticket);
  if (!ticketInfo || !ticketInfo.chatId) {
    ctx.reply(`Ticket not found: ${ticket}`);
    return { ok: false, reason: 'ticket.not.found' };
  }

  const result = await SafeSend.safeSend(meta, sendService, ticketInfo.chatId, replyText, { ticket });
  if (result.ok) {
    ctx.reply(`✅ Sent reply for ticket ${ticket}`);
  } else {
    ctx.reply(`❌ Failed to send reply. Ticket: ${ticket}`);
  }

  return result;
}

module.exports = { reply };