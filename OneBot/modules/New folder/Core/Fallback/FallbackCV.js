'use strict';

/*
  FallbackCV
  Purpose:
    - Customer DM -> forward to Control Group with Ticket
    - Control Group reply (quote-reply OR !r <ticket> <text>) -> send back to customer DM

  Guarantees:
    - No foundation changes (Kernel/Connector/Start untouched)
    - No send window for fallback (always allowed)
    - All outbound still uses the single global send service (queue) for safety

  Fixes in this build:
    - Internal dedupe to prevent duplicate forwards/replies caused by duplicate inbound events
  Version: 2026.01.01c
*/

const Conf = require('../Shared/SharedConfV1');
const TicketCore = require('../Shared/SharedTicketCoreV1');

function toText(v) {
  return String(v == null ? '' : v);
}

function toDigits(v) {
  return String(v || '').replace(/[^\d]/g, '');
}

function isFromMe(ctx) {
  return !!(ctx && ctx.message && ctx.message.fromMe);
}

function isStatusBroadcast(chatId) {
  const s = toText(chatId);
  return s === 'status@broadcast' || s.endsWith('@broadcast');
}

function isCommandText(text, prefix) {
  const s = toText(text || '').trim();
  if (!s) return false;
  if (!prefix) return false;
  return s.startsWith(prefix);
}

function getSenderId(ctx) {
  return (ctx && ctx.sender && ctx.sender.id) ? toText(ctx.sender.id) : '';
}

function getSenderPhone(ctx) {
  return (ctx && ctx.sender && ctx.sender.phone) ? toText(ctx.sender.phone) : '';
}

function getSenderName(ctx) {
  return (ctx && ctx.sender && ctx.sender.name) ? toText(ctx.sender.name) : '';
}

function clampText(s, maxChars) {
  const t = toText(s);
  const m = Number(maxChars) || 0;
  if (m <= 0) return t;
  if (t.length <= m) return t;
  return t.slice(0, m) + '...';
}

function extractTicket(text) {
  const s = toText(text || '');
  const m1 = s.match(/\b(\d{6}T\d{10})\b/);
  if (m1 && m1[1]) return m1[1];
  const m2 = s.match(/Ticket\s*:\s*([A-Za-z0-9]+)/i);
  if (m2 && m2[1]) return m2[1];
  const m3 = s.match(/\b(\d{10,})\b/);
  if (m3 && m3[1]) return m3[1];
  return '';
}

function getMsgId(msg) {
  if (!msg) return '';
  try {
    if (msg.id && msg.id._serialized) return String(msg.id._serialized);
    if (typeof msg.id === 'string') return String(msg.id);
    if (msg.id && msg.id.id) return String(msg.id.id);
  } catch (_) {}
  return '';
}

function djb2Hash(s) {
  const str = toText(s);
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) + str.charCodeAt(i);
    h = h | 0;
  }
  return (h >>> 0).toString(16);
}

// In-module dedupe (protect against duplicate inbound events / double processing)
const _seenMap = new Map();
let _seenTick = 0;

function seenOnce(key, ttlMs) {
  const now = Date.now();
  const ttl = Math.max(1000, Number(ttlMs) || 12000);

  // periodic cleanup (cheap)
  _seenTick++;
  if (_seenTick % 50 === 0 || _seenMap.size > 1000) {
    for (const [k, ts] of _seenMap.entries()) {
      if (now - ts > ttl) _seenMap.delete(k);
    }
  }

  const prev = _seenMap.get(key);
  if (prev && (now - prev) < ttl) return true;

  _seenMap.set(key, now);
  return false;
}

module.exports.init = async function init(meta) {
  const log = {
    info: (m) => meta && typeof meta.log === 'function' ? meta.log('FallbackCV', String(m)) : null,
    error: (m) => meta && typeof meta.log === 'function' ? meta.log('FallbackCV', String(m)) : null,
  };

  const hub = Conf.load(meta);
  const implRel = hub.getStr('implConfig', 'modules/Core/Impl/FallbackCV.conf');
  const conf = Conf.load(meta, implRel);

  const enabled = conf.getBool('enabled', true);
  if (!enabled) {
    log.info('disabled');
    return { onMessage: async () => null };
  }

  const controlGroupId = conf.getStr('controlGroupId', '');
  const sendServiceName = conf.getStr('sendService', 'send');
  const commandServiceName = conf.getStr('commandService', 'command');
  const accessServiceName = conf.getStr('accessService', 'access');

  const requiredRole = conf.getStr('requiredRole', 'staff');
  const cmdReply = conf.getStr('cmdReply', 'r');

  const ticketType = conf.getStr('ticketType', 'fallback');
  const ticketStoreSpec = conf.getStr('ticketStoreSpec', 'jsonstore:Fallback/tickets');

  const forwardMyMessages = conf.getBool('forwardMyMessages', false);
  const includeBody = conf.getBool('includeBody', true);
  const includeMediaHint = conf.getBool('includeMediaHint', true);
  const maxBodyChars = conf.getInt('maxBodyChars', 1200);

  const ackInControlGroup = conf.getBool('ackInControlGroup', true);

  const send = meta.getService(sendServiceName);
  const commands = meta.getService(commandServiceName);
  const access = meta.getService(accessServiceName);

  const commandPrefix = (commands && commands.prefix) ? toText(commands.prefix) : '!';

  if (!controlGroupId) {
    log.error('controlGroupId is empty');
    return { onMessage: async () => null };
  }
  if (typeof send !== 'function') {
    log.error(`missing send service (${sendServiceName})`);
    return { onMessage: async () => null };
  }

  const ticketCfg = { storeSpec: ticketStoreSpec, maxOpenPerChat: 50 };

  function isStaff(ctx) {
    if (!access) return false;
    const sid = getSenderId(ctx);
    if (!sid) return false;
    return !!access.hasAtLeast(sid, requiredRole);
  }

  async function safeSend(chatId, text, opts) {
    try {
      await send(toText(chatId), toText(text), opts || {});
      return true;
    } catch (e) {
      log.error(`send failed chatId=${toText(chatId)} err=${e && e.message ? e.message : String(e)}`);
      return false;
    }
  }

  async function sendTextToCustomer(customerChatId, text) {
    const cid = toText(customerChatId);
    if (!cid) return false;
    return safeSend(cid, text, {});
  }

  function buildForwardText(ticket, customerChatId, customerPhone, body, mediaHint) {
    const lines = [];
    lines.push('FALLBACK DM');
    lines.push(`Ticket: ${ticket}`);
    if (customerPhone) lines.push(`Customer: ${customerPhone}`);
    if (customerChatId) lines.push(`ChatId: ${customerChatId}`);

    if (includeBody) {
      const b = clampText(toText(body || ''), maxBodyChars).trim();
      if (b) {
        lines.push('');
        lines.push(b);
      }
    }

    if (includeMediaHint && mediaHint) {
      lines.push('');
      lines.push(mediaHint);
    }

    lines.push('');
    lines.push('Reply: quote-reply this message OR use !r <ticket> <text>');
    return lines.join('\n');
  }

  async function forwardDmToControlGroup(ctx) {
    if (!ctx || ctx.isGroup) return false;
    if (isStatusBroadcast(ctx.chatId)) return false;

    if (isFromMe(ctx) && !forwardMyMessages) return false;

    // If DM is from staff/controller, do not forward.
    if (isStaff(ctx)) return false;

    const msg = ctx.message || null;

    // Dedupe DM processing
    const dmMsgId = getMsgId(msg);
    const bodyTmp = toText(ctx.text || (msg && msg.body) || '').trim();
    const fallbackKey = `dm:${toText(ctx.chatId)}:${toText(msg && msg.timestamp)}:${djb2Hash(bodyTmp)}:${(msg && msg.hasMedia) ? 'm' : 't'}`;
    const dedupeKey = 'dm:' + (dmMsgId || fallbackKey);
    if (seenOnce(dedupeKey, 15000)) return true;

    const dmWid = toText(ctx.chatId);
    const senderId = getSenderId(ctx);
    const senderPhone = getSenderPhone(ctx) || toDigits(senderId) || toDigits(dmWid);
    const senderName = getSenderName(ctx);

    const bodyRaw = bodyTmp;

    const hasMedia = !!(msg && msg.hasMedia);
    const mediaType = hasMedia ? toText(msg.type || (msg._data && msg._data.type) || 'media') : '';
    const mediaHint = hasMedia ? `Attachment: ${mediaType} (not forwarded as file in this baseline)` : '';

    const info = {
      fromName: senderName,
      fromPhone: senderPhone,
      fromChatId: dmWid,
      text: bodyRaw,
      attachCount: hasMedia ? 1 : 0,
      attachTypes: hasMedia ? [mediaType] : [],
    };

    let touched = null;
    try {
      touched = await TicketCore.touch(meta, ticketCfg, ticketType, dmWid, info, { storeSpec: ticketStoreSpec });
    } catch (e) {
      log.error(`ticket touch failed err=${e && e.message ? e.message : String(e)}`);
      return false;
    }

    const ticket = touched && touched.ticket ? toText(touched.ticket) : '';
    if (!ticket) return false;

    const forwardText = buildForwardText(ticket, dmWid, senderPhone, bodyRaw, mediaHint);
    const ok = await safeSend(controlGroupId, forwardText, {});
    return !!ok;
  }

  async function handleQuoteReply(ctx) {
    if (!ctx || !ctx.isGroup) return false;
    if (toText(ctx.chatId) !== controlGroupId) return false;

    if (!isStaff(ctx)) return false;

    const msg = ctx.message || null;

    // Dedupe group reply processing
    const grpMsgId = getMsgId(msg);
    const body = toText(ctx.text || (msg && msg.body) || '').trim();
    const fallbackKey = `qr:${toText(ctx.chatId)}:${djb2Hash(body)}`;
    const dedupeKey = 'qr:' + (grpMsgId || fallbackKey);
    if (seenOnce(dedupeKey, 15000)) return true;

    if (!body) return false;

    if (isCommandText(body, commandPrefix) || isFromMe(ctx)) return false;

    if (!msg || !msg.hasQuotedMsg || typeof msg.getQuotedMessage !== 'function') return false;

    let quoted = null;
    try {
      quoted = await msg.getQuotedMessage();
    } catch (e) {
      quoted = null;
    }
    if (!quoted) return false;

    const quotedText = toText(quoted.body || '').trim();
    const ticket = extractTicket(quotedText);
    if (!ticket) return false;

    let resolved = null;
    try {
      resolved = await TicketCore.resolve(meta, ticketCfg, ticketType, ticket, { storeSpec: ticketStoreSpec });
    } catch (e) {
      resolved = null;
    }
    const customerChatId = resolved && resolved.chatId ? toText(resolved.chatId) : '';
    if (!customerChatId) {
      await safeSend(controlGroupId, `Ticket not found: ${ticket}`, {});
      return true;
    }

    const ok = await sendTextToCustomer(customerChatId, body);
    if (ok && ackInControlGroup) {
      await safeSend(controlGroupId, `Sent to customer. Ticket: ${ticket}`, {});
    }
    return true;
  }

  async function handleReplyCommand(ctx, args) {
    if (!ctx) return;

    // Dedupe command message processing (rare but safe)
    const msg = ctx.message || null;
    const cmdMsgId = getMsgId(msg);
    if (cmdMsgId) {
      const dedupeKey = 'rc:' + cmdMsgId;
      if (seenOnce(dedupeKey, 15000)) return;
    }

    if (toText(ctx.chatId) !== controlGroupId) {
      await ctx.reply('This command is only allowed in Control Group.');
      return;
    }
    if (!isStaff(ctx)) {
      await ctx.reply('Not allowed.');
      return;
    }

    const ticket = toText(args && args[0]).trim();
    const text = toText(args && args.slice(1).join(' ')).trim();

    if (!ticket || !text) {
      await ctx.reply('Usage: !r <ticket> <text>');
      return;
    }

    let resolved = null;
    try {
      resolved = await TicketCore.resolve(meta, ticketCfg, ticketType, ticket, { storeSpec: ticketStoreSpec });
    } catch (e) {
      resolved = null;
    }
    const customerChatId = resolved && resolved.chatId ? toText(resolved.chatId) : '';
    if (!customerChatId) {
      await ctx.reply(`Ticket not found: ${ticket}`);
      return;
    }

    const ok = await sendTextToCustomer(customerChatId, text);
    if (ok && ackInControlGroup) {
      await ctx.reply(`Sent. Ticket: ${ticket}`);
    }
  }

  if (commands && typeof commands.register === 'function') {
    commands.register(cmdReply, async (ctx, args) => {
      await handleReplyCommand(ctx, args || []);
    }, {
      desc: 'Reply customer by ticket (Control Group)',
      usage: '!r <ticket> <text>',
    });
  }

  log.info('ready');

  return {
    onMessage: async (ctx) => {
      // Control Group quote-reply (primary UX)
      try {
        const qr = await handleQuoteReply(ctx);
        if (qr) return;
      } catch (e) {
        log.error(`quote reply failed err=${e && e.message ? e.message : String(e)}`);
      }

      // Customer DM forwarding
      try {
        const fw = await forwardDmToControlGroup(ctx);
        if (fw) return;
      } catch (e) {
        log.error(`forward failed err=${e && e.message ? e.message : String(e)}`);
      }
    }
  };
};
