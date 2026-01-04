'use strict';

// FallbackQuoteReplyV1
// Purpose: route a normal WhatsApp quote-reply in allowed work group back to customer.

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

async function handle(meta, cfg, ctx) {
  const enabled = Number(cfg && cfg.allowQuoteReply) || 0;
  if (!enabled) return { ok: false, reason: 'disabled' };

  const chatId = safeStr(ctx && ctx.chatId);
  if (!isAllowedGroup(meta, cfg, chatId)) return { ok: false, reason: 'wronggroup' };

  const requiredRole = safeStr(cfg && cfg.requiredRole) || 'staff';
  const accessService = safeStr(cfg && cfg.accessService) || 'accessroles';
  const senderId = safeStr(ctx && ctx.sender && ctx.sender.id);
  if (!RoleGate.isAllowed(meta, accessService, senderId, requiredRole)) {
    return { ok: false, reason: 'denied' };
  }

  const quoted = Wid.getQuotedText(ctx);
  const ticket = Wid.extractTicket(quoted);
  if (!ticket) return { ok: false, reason: 'noticket' };

  const ticketType = safeStr(cfg && cfg.ticketType) || 'fallback';
  const resolved = await TicketCore.resolve(meta, cfg, ticketType, ticket, {});
  if (!resolved || !resolved.ok) return { ok: false, reason: 'notfound' };

  const sendFn = SafeSend.pickSend(meta, cfg);
  if (!sendFn) return { ok: false, reason: 'nosend' };

  const text = safeStr(ctx && ctx.text);
  if (!text && !(ctx && ctx.raw && ctx.raw.hasMedia)) return { ok: false, reason: 'empty' };

  // Send text first
  if (text) {
    await SafeSend.sendOrQueue(meta, cfg, resolved.chatId, text, {});
  }

  // Media (best effort)
  try {
    const hasMedia = !!(ctx && ctx.raw && ctx.raw.hasMedia && typeof ctx.raw.downloadMedia === 'function');
    if (hasMedia) {
      const media = await ctx.raw.downloadMedia();
      if (media) await sendFn(resolved.chatId, media, {});
    }
  } catch (_) {}

  return { ok: true, ticket, chatId: resolved.chatId };
}

module.exports = {
  handle,
};
