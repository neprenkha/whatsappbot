'use strict';

// Detailed logging for !r path with debug/trace toggles.
// Quote tetap diperlukan untuk tahu ticket, atau user guna !r <ticket> <text>.

const Wid = require('../Shared/SharedWidUtilV1');
const RoleGate = require('../Shared/SharedRoleGateV1');
const TicketCore = require('../Shared/SharedTicketCoreV1');
const SafeSend = require('../Shared/SharedSafeSendV1');

function safeStr(v) { return String(v || '').trim(); }
function makeLog(meta, cfg) {
  const dbg = cfg && cfg.debugLog !== undefined ? !!cfg.debugLog : true;
  const trc = cfg && cfg.traceLog !== undefined ? !!cfg.traceLog : true;
  const log = (msg) => dbg && meta && meta.log && meta.log('FallbackCmdReply', msg);
  const trace = (msg) => trc && meta && meta.log && meta.log('FallbackCmdReply', `trace ${msg}`);
  return { log, trace };
}

function isAllowedGroup(meta, cfg, chatId, trace) {
  const cid = safeStr(cfg && cfg.controlGroupId);
  if (cid && chatId === cid) return true;

  const svcName = safeStr(cfg && cfg.workgroupsService) || 'workgroups';
  const wg = meta.getService(svcName);
  if (wg && typeof wg.isAllowedGroup === 'function') {
    try { return !!wg.isAllowedGroup(chatId); } catch (e) { trace && trace(`wg err=${e.message || e}`); return false; }
  }
  return false;
}

function joinRest(args, fromIndex) {
  const a = Array.isArray(args) ? args : [];
  if (a.length <= fromIndex) return '';
  return a.slice(fromIndex).join(' ').trim();
}

async function handle(meta, cfg, ctx, args, opts = {}) {
  const { log, trace } = makeLog(meta, cfg);
  const cmdReply = safeStr(cfg && cfg.cmdReply) || 'r';
  const chatId = safeStr(ctx && ctx.chatId);
  const hideTicket = !!opts.hideTicket;

  if (!isAllowedGroup(meta, cfg, chatId, trace)) {
    log(`blocked wronggroup chatId=${chatId}`);
    return { ok: false, reason: 'wronggroup' };
  }

  const requiredRole = safeStr(cfg && cfg.requiredRole) || 'staff';
  const accessService = safeStr(cfg && cfg.accessService) || 'accessroles';
  const senderId = safeStr(ctx && ctx.sender && ctx.sender.id);
  if (!RoleGate.isAllowed(meta, accessService, senderId, requiredRole)) {
    log(`blocked denied sender=${senderId}`);
    return { ok: false, reason: 'denied' };
  }

  const a = Array.isArray(args) ? args : [];
  const first = safeStr(a[0]);
  if (!first) {
    log('blocked noticket (arg empty)');
    return { ok: false, reason: 'noticket' };
  }

  const ticket = Wid.extractTicket(first) || Wid.extractTicket(safeStr(ctx && ctx.text));
  if (!ticket) {
    log('blocked noticket (parse fail)');
    return { ok: false, reason: 'noticket' };
  }

  const msgText = joinRest(a, 1);
  const ticketType = safeStr(cfg && cfg.ticketType) || 'fallback';
  const resolved = await TicketCore.resolve(meta, cfg, ticketType, ticket, { storeSpec: cfg.ticketStoreSpec });
  if (!resolved || !resolved.ok) {
    log(`blocked notfound ticket=${ticket}`);
    return { ok: false, reason: 'notfound' };
  }

  const sendPick = SafeSend.pickSend(meta, cfg.groupMediaSendPrefer || cfg.sendPrefer);
  const sendFn = sendPick[0] && sendPick[0].fn ? sendPick[0].fn : meta.getService('send');
  if (!sendFn) {
    log('blocked nosend');
    return { ok: false, reason: 'nosend' };
  }

  if (!msgText) {
    log('blocked empty message');
    if (ctx && typeof ctx.reply === 'function') await ctx.reply(`Usage: !${cmdReply} <ticket> <text>`);
    return { ok: false, reason: 'empty' };
  }

  const textOut = hideTicket ? msgText : `Ticket: ${ticket}\n${msgText}`;
  trace(`send text dest=${resolved.chatId} ticket=${ticket} hideTicket=${hideTicket}`);
  await SafeSend.safeSend(meta, sendFn, resolved.chatId, textOut, {});

  try {
    if (ctx && ctx.raw && typeof ctx.raw.downloadMedia === 'function' && ctx.raw.hasMedia) {
      const media = await ctx.raw.downloadMedia();
      if (media) {
        const cap = hideTicket ? '' : `Ticket ${ticket}`;
        trace(`send media dest=${resolved.chatId} ticket=${ticket} hideTicket=${hideTicket}`);
        await sendFn(resolved.chatId, media, cap ? { caption: cap } : {});
      }
    }
  } catch (e) {
    log(`media fail ticket=${ticket} err=${e && e.message ? e.message : e}`);
  }

  const ack = Number(cfg && cfg.replyAck) || 0;
  if (ack && typeof ctx.reply === 'function') {
    const ackText = hideTicket
      ? `✅ Sent to customer.`
      : `✅ Sent to customer. Ticket: ${ticket}`;
    await ctx.reply(ackText);
  }

  await TicketCore.setStatus(meta, cfg, ticket, resolved.status || 'open', { staffAt: Date.now() });

  return { ok: true, ticket, chatId: resolved.chatId };
}

module.exports = { handle };