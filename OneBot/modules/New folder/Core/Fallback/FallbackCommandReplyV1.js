'use strict';

// FallbackCommandReplyV1
// Purpose: handle !r <TicketId> <text> from allowed work group and send to customer.

const Wid = require('../Shared/SharedWidUtilV1');
const RoleGate = require('../Shared/SharedRoleGateV1');
const TicketCore = require('../Shared/SharedTicketCoreV1');
const SafeSend = require('../Shared/SharedSafeSendV1');

function safeStr(v) {
  return String(v || '').trim();
}

function isAllowedGroup(meta, cfg, chatId) {
  const cid = safeStr(cfg && cfg.controlGroupId);
  if (cid && chatId === cid) return true;

  const svcName = safeStr(cfg && cfg.workgroupsService) || 'workgroups';
  const wg = meta.getService(svcName);
  if (wg && typeof wg.isAllowedGroup === 'function') {
    try { return !!wg.isAllowedGroup(chatId); } catch (_) { return false; }
  }
  return false;
}

function joinRest(args, fromIndex) {
  const a = Array.isArray(args) ? args : [];
  if (a.length <= fromIndex) return '';
  return a.slice(fromIndex).join(' ').trim();
}

async function handle(meta, cfg, ctx, args) {
  const cmdReply = safeStr(cfg && cfg.cmdReply) || 'r';
  const chatId = safeStr(ctx && ctx.chatId);
  if (!isAllowedGroup(meta, cfg, chatId)) return { ok: false, reason: 'wronggroup' };

  const requiredRole = safeStr(cfg && cfg.requiredRole) || 'staff';
  const accessService = safeStr(cfg && cfg.accessService) || 'accessroles';
  const senderId = safeStr(ctx && ctx.sender && ctx.sender.id);
  if (!RoleGate.isAllowed(meta, accessService, senderId, requiredRole)) {
    return { ok: false, reason: 'denied' };
  }

  const a = Array.isArray(args) ? args : [];
  const first = safeStr(a[0]);
  if (!first) return { ok: false, reason: 'noticket' };

  const ticket = Wid.extractTicket(first) || Wid.extractTicket(safeStr(ctx && ctx.text));
  if (!ticket) return { ok: false, reason: 'noticket' };

  const msgText = joinRest(a, 1);
  const ticketType = safeStr(cfg && cfg.ticketType) || 'fallback';
  const resolved = await TicketCore.resolve(meta, cfg, ticketType, ticket, {});
  if (!resolved || !resolved.ok) return { ok: false, reason: 'notfound' };

  const sendFn = SafeSend.pickSend(meta, cfg);
  if (!sendFn) return { ok: false, reason: 'nosend' };

  // Text
  if (msgText) {
    await SafeSend.sendOrQueue(meta, cfg, resolved.chatId, msgText, {});
  }

  // Media best-effort
  try {
    if (ctx && ctx.raw && typeof ctx.raw.downloadMedia === 'function') {
      const media = await ctx.raw.downloadMedia();
      if (media) await sendFn(resolved.chatId, media, {});
    }
  } catch (_) {}

  // Optional ack in group
  const ack = Number(cfg && cfg.replyAck) || 0;
  if (ack && typeof ctx.reply === 'function') {
    const ackText = `✅ Sent to customer. (${ticket})\nTip: quote the ticket card to reply, or use !${cmdReply} ${ticket} <text>`;
    await ctx.reply(ackText);
  }

  return { ok: true, ticket, chatId: resolved.chatId };
}

module.exports = {
  handle,
};
