'use strict';

/**
 * FallbackReplyRouterV1.js
 * Optional router to send a reply to the last pending ticket/customer.
 * (Some setups use this for non-quote “quick reply” flows.)
 */

const TicketCore = require('../Shared/SharedTicketCoreV1');
const SafeSend = require('../Shared/SharedSafeSendV1');

function safeStr(v) { return String(v || '').trim(); }

async function reply(meta, ctx, args) {
  const sendServiceName = safeStr(args && args.sendService) || 'send';
  const sendService = meta.getService(sendServiceName);
  if (typeof sendService !== 'function') return { ok: false, reason: 'nosend' };

  const replyText = safeStr(args && args.text);
  if (!replyText) return { ok: false, reason: 'empty' };

  const ticketType = safeStr(args && args.ticketType) || 'T';

  // Prefer explicitly provided ticket
  const ticket = safeStr(args && args.ticket);
  let ticketInfo = null;

  if (ticket) {
    ticketInfo = await TicketCore.resolve(meta, args, ticketType, ticket);
  } else {
    // Fallback to last pending ticket
    ticketInfo = await TicketCore.getLastPending(meta, args, ticketType);
    if (!ticketInfo || ticketInfo.ok !== true) {
      ctx.reply('No pending ticket/customer. Use quote reply or !r.');
      return { ok: true };
    }
  }

  if (!ticketInfo || ticketInfo.ok !== true || !ticketInfo.chatId) {
    ctx.reply('Ticket/customer not resolved.');
    return { ok: true };
  }

  const result = await SafeSend.safeSend(
    meta,
    sendService,
    ticketInfo.chatId,
    replyText,
    { ticket, bypass: true }
  );

  if (!result || result.ok !== true) {
    ctx.reply('Send failed.');
    return { ok: true };
  }

  if (ticket) ctx.reply(`Sent reply for ticket ${ticket}.`);
  else ctx.reply('Sent reply to last pending customer.');

  return { ok: true };
}

module.exports = { reply };
