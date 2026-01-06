'use strict';

const TicketCore = require('../Shared/SharedTicketCoreV1');
const SafeSend = require('../Shared/SharedSafeSendV1');
const SharedLog = require('../Shared/SharedLogV1');
const Wid = require('../Shared/SharedWidUtilV1');

function safeStr(v) {
  if (v === null || v === undefined) return '';
  try { return String(v); } catch (_) { return ''; }
}

function makeLogger(meta, cfg) {
  const debugEnabled = Number(cfg && cfg.debugLog) ? 1 : 0;
  const traceEnabled = Number(cfg && cfg.traceLog) ? 1 : 0;

  if (SharedLog && typeof SharedLog.create === 'function') {
    const base = SharedLog.create(meta, 'FallbackCommandReplyV1', { debugEnabled: !!debugEnabled, traceEnabled: !!traceEnabled });
    return {
      info: (m) => { try { base.info(m); } catch (_) {} },
      warn: (m) => { try { base.warn(m); } catch (_) {} },
      error: (m) => { try { base.error(m); } catch (_) {} },
      debug: (m) => { try { base.debug(m); } catch (_) {} },
      trace: (m) => { try { base.trace(m); } catch (_) {} },
      debugEnabled: !!debugEnabled,
      traceEnabled: !!traceEnabled,
    };
  }

  const tag = 'FallbackCommandReplyV1';
  return {
    info: (m) => { try { meta.log(tag, safeStr(m)); } catch (_) {} },
    warn: (m) => { try { meta.log(tag, 'warn ' + safeStr(m)); } catch (_) {} },
    error: (m) => { try { meta.log(tag, 'error ' + safeStr(m)); } catch (_) {} },
    debug: (m) => debugEnabled ? (function () { try { meta.log(tag, 'debug ' + safeStr(m)); } catch (_) {} })() : null,
    trace: (m) => traceEnabled ? (function () { try { meta.log(tag, 'trace ' + safeStr(m)); } catch (_) {} })() : null,
    debugEnabled: !!debugEnabled,
    traceEnabled: !!traceEnabled,
  };
}

async function maybeAwait(v) {
  if (v && typeof v.then === 'function') return await v;
  return v;
}

async function allowStaff(meta, cfg, staffWid, logger) {
  const requiredRole = safeStr(cfg && cfg.requiredRole);
  if (!requiredRole) return true;

  const accessName = safeStr(cfg && (cfg.accessService || cfg.accessSvc || cfg.access)) || 'access';
  const access = meta && typeof meta.getService === 'function' ? meta.getService(accessName) : null;
  if (!access) return true;

  try {
    if (typeof access.hasRole === 'function') return !!(await maybeAwait(access.hasRole(staffWid, requiredRole)));
    if (typeof access.isAllowed === 'function') return !!(await maybeAwait(access.isAllowed(staffWid, requiredRole)));
    if (typeof access.allow === 'function') return !!(await maybeAwait(access.allow(staffWid, requiredRole)));
    if (typeof access.check === 'function') {
      const r = await maybeAwait(access.check({ wid: staffWid, role: requiredRole }));
      if (r && r.ok === false) return false;
      if (r && r.allowed === false) return false;
      return true;
    }
  } catch (e) {
    logger.warn('access check failed staff=' + safeStr(staffWid) + ' err=' + safeStr(e && e.message ? e.message : e));
  }

  return true;
}

function getGroupSendFn(meta, cfg) {
  const prefer = safeStr(cfg && cfg.sendService) || 'send';
  const picks = SafeSend.pickSend(meta, prefer);
  if (picks && picks.length && picks[0].fn) return picks[0].fn;
  const base = meta && typeof meta.getService === 'function' ? meta.getService('send') : null;
  return typeof base === 'function' ? base : null;
}

async function sendGroupTip(meta, cfg, groupId, text) {
  const sendFn = getGroupSendFn(meta, cfg);
  if (!sendFn) return { ok: false, reason: 'nosend' };
  return SafeSend.safeSend(meta, sendFn, groupId, safeStr(text), { __from: 'FallbackCommandReplyV1' });
}

function parseArgs(args, ctxText) {
  // Return { ticket, text }
  const rawText = safeStr(ctxText).trim();

  // 1) args.tokens
  if (args && Array.isArray(args.tokens)) {
    const t = args.tokens.map(safeStr);
    return { ticket: safeStr(t[0]).trim(), text: t.slice(1).join(' ').trim() };
  }

  // 2) args array
  if (Array.isArray(args)) {
    const t = args.map(safeStr);
    return { ticket: safeStr(t[0]).trim(), text: t.slice(1).join(' ').trim() };
  }

  // 3) args.text / args.raw
  if (args && typeof args.text === 'string') {
    const s = args.text.trim();
    const parts = s.split(/\s+/);
    const ticket = parts.shift() || '';
    const rest = s.substring(ticket.length).trim();
    return { ticket: ticket.trim(), text: rest };
  }
  if (args && typeof args.raw === 'string') {
    const s = args.raw.trim();
    const parts = s.split(/\s+/);
    const ticket = parts.shift() || '';
    const rest = s.substring(ticket.length).trim();
    return { ticket: ticket.trim(), text: rest };
  }

  // 4) fallback parse from ctx text: "!r <ticket> <text>"
  if (rawText.startsWith('!')) {
    const s = rawText.replace(/^!\S+\s*/, '').trim();
    const parts = s.split(/\s+/);
    const ticket = parts.shift() || '';
    const rest = s.substring(ticket.length).trim();
    return { ticket: ticket.trim(), text: rest };
  }

  return { ticket: '', text: '' };
}

function extractMediaList(ctx) {
  const list = [];
  try {
    if (ctx && Array.isArray(ctx.attachments) && ctx.attachments.length) {
      for (const a of ctx.attachments) list.push(a);
    }
  } catch (_) {}
  return list;
}

async function downloadSingleMedia(ctx) {
  try {
    const raw = ctx && ctx.raw ? ctx.raw : null;
    if (raw && raw.hasMedia && typeof raw.downloadMedia === 'function') {
      const m = await raw.downloadMedia();
      if (m) return m;
    }
  } catch (_) {}
  return null;
}

function getCustomerSendFn(meta, cfg) {
  const prefer = safeStr(cfg && (cfg.sendPreferReply || cfg.sendPreferCustomer || cfg.sendPrefer)) || 'sendout,outsend,send';
  const picks = SafeSend.pickSend(meta, prefer);
  if (picks && picks.length && picks[0].fn) return picks[0].fn;
  const base = meta && typeof meta.getService === 'function' ? meta.getService('send') : null;
  return typeof base === 'function' ? base : null;
}

async function sendTextToCustomer(meta, cfg, destChatId, text) {
  const sendFn = getCustomerSendFn(meta, cfg);
  if (!sendFn) return { ok: false, reason: 'nosend' };
  return SafeSend.safeSend(meta, sendFn, destChatId, safeStr(text), { __from: 'FallbackCommandReplyV1', manual: true, bypass: true });
}

async function sendMediaToCustomer(meta, cfg, destChatId, media, caption) {
  const sendFn = getCustomerSendFn(meta, cfg);
  if (!sendFn) return { ok: false, reason: 'nosend' };
  const opts = {};
  const cap = safeStr(caption).trim();
  if (cap) opts.caption = cap;
  opts.manual = true;
  opts.bypass = true;
  opts.__from = 'FallbackCommandReplyV1';
  try {
    await sendFn(destChatId, media, opts);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: safeStr(e && e.message ? e.message : e) };
  }
}

async function handle(meta, cfg, ctx, args, opts) {
  const logger = makeLogger(meta, cfg);
  opts = opts || {};

  const controlGroupId = safeStr(cfg && cfg.controlGroupId);
  if (!controlGroupId) return { ok: false, reason: 'nogroup' };

  const chatId = safeStr(Wid && Wid.getChatId ? Wid.getChatId(ctx) : (ctx && ctx.chatId));
  const isGroup = !!(Wid && Wid.isGroup ? Wid.isGroup(ctx) : (ctx && ctx.isGroup));

  if (!isGroup || chatId !== controlGroupId) return { ok: false, reason: 'notgroup' };

  const staffWid = safeStr(Wid && Wid.getSenderId ? Wid.getSenderId(ctx) : (ctx && ctx.from));
  if (!staffWid) return { ok: false, reason: 'nostaff' };

  const okRole = await allowStaff(meta, cfg, staffWid, logger);
  if (!okRole) {
    await sendGroupTip(meta, cfg, controlGroupId, 'Not allowed.');
    return { ok: false, reason: 'notallowed' };
  }

  const parsed = parseArgs(args, (ctx && ctx.text) || '');
  let ticket = safeStr(parsed.ticket).trim();

  // If ticket is missing, try extract from quoted text (sometimes staff writes only text while quoting card)
  if (!ticket) {
    try {
      const q = Wid && typeof Wid.getQuotedText === 'function' ? Wid.getQuotedText(meta, ctx) : '';
      ticket = Wid && typeof Wid.extractTicket === 'function' ? safeStr(Wid.extractTicket(q)).trim() : '';
    } catch (_) {}
  }

  if (!ticket) {
    const cmd = safeStr(cfg && cfg.cmdReply) || 'r';
    await sendGroupTip(meta, cfg, controlGroupId, `Usage: !${cmd} <ticket> <text>`);
    return { ok: false, reason: 'noticket' };
  }

  const ticketType = safeStr(cfg && (cfg.ticketType || cfg.type)) || null;
  const resolved = await TicketCore.resolve(meta, cfg, ticketType, ticket, {});
  if (!resolved || !resolved.ok || !resolved.chatId) {
    await sendGroupTip(meta, cfg, controlGroupId, `Ticket not found: ${ticket}`);
    return { ok: false, reason: 'notfound' };
  }

  const destChatId = safeStr(resolved.chatId);
  const hideTicket = (opts && (opts.hideTicket === 1 || opts.hideTicket === true)) ? 1 : (Number(cfg && cfg.hideTicket) ? 1 : 0);

  // Collect media
  let mediaList = extractMediaList(ctx);
  if (!mediaList.length) {
    const single = await downloadSingleMedia(ctx);
    if (single) mediaList = [single];
  }

  const text = safeStr(parsed.text).trim();

  // Nothing to send?
  if (!text && !mediaList.length) {
    const cmd = safeStr(cfg && cfg.cmdReply) || 'r';
    await sendGroupTip(meta, cfg, controlGroupId, `Usage: !${cmd} <ticket> <text>`);
    return { ok: false, reason: 'empty' };
  }

  // Send text (if any)
  if (text) {
    const outText = hideTicket ? text : (`Ticket: ${ticket}\n` + text);
    const r = await sendTextToCustomer(meta, cfg, destChatId, outText);
    if (!r || !r.ok) {
      logger.warn('send text failed dest=' + destChatId + ' ticket=' + ticket + ' reason=' + safeStr(r && r.reason));
      await sendGroupTip(meta, cfg, controlGroupId, 'Send failed.');
      return { ok: false, reason: 'sendfail' };
    }
  }

  // Send media (if any)
  if (mediaList.length) {
    const cap = text ? (hideTicket ? text : (`Ticket: ${ticket}\n` + text)) : (hideTicket ? '' : `Ticket: ${ticket}`);
    for (const media of mediaList) {
      const mr = await sendMediaToCustomer(meta, cfg, destChatId, media, cap);
      if (!mr || !mr.ok) {
        logger.warn('send media failed dest=' + destChatId + ' ticket=' + ticket + ' reason=' + safeStr(mr && mr.reason));
        await sendGroupTip(meta, cfg, controlGroupId, 'Send failed (media).');
        return { ok: false, reason: 'sendfail' };
      }
    }
  }

  // Update ticket status (keep as open)
  try {
    await TicketCore.setStatus(meta, cfg, ticket, resolved.status || 'open', { staffAt: Date.now() });
  } catch (e) {
    logger.warn('setStatus failed ticket=' + ticket + ' err=' + safeStr(e && e.message ? e.message : e));
  }

  return { ok: true, ticket, chatId: destChatId };
}

module.exports = { handle };
