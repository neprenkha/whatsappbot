'use strict';

/*
  FallbackCV (2026.01.x debug+trace toggle) - logging standardized via SharedLogV1
  - Reuse ticket per chat (status != closed), format di SharedTicketCore: YYYYMMT##########
  - Dedupe inbound: msgId OR hash(chatId+textNorm+mediaFlag) TTL 15s
  - Dedupe outbound (ticket+hash) TTL configurable
  - Dedupe command !r: hash(chatId+textNorm) TTL 15s
  - Dedupe forward-to-group per (ticket, seq) TTL 60s untuk cegah kad berganda ke group
  - Quote reply wajib (atau !r)
  - Debug/trace toggle via config: debugLog, traceLog
*/

const Conf = require('../Shared/SharedConfV1');
const SharedLog = require('../Shared/SharedLogV1');

const TicketCore = require('../Shared/SharedTicketCoreV1');
const TicketCard = require('./FallbackTicketCardV1');
const MediaQ = require('./FallbackMediaForwardQueueV1');
const CmdReply = require('./FallbackCommandReplyV1');
const QuoteReply = require('./FallbackQuoteReplyV1');
const SafeSend = require('../Shared/SharedSafeSendV1'); // keep (may be used by sub-modules)

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function toText(v) { return String(v == null ? '' : v); }
function safeStr(v) { return String(v || '').trim(); }
function hash(s) { return crypto.createHash('sha1').update(String(s || '')).digest('hex'); }
function normalizeText(s) {
  return toText(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function dedupeKey(ticket, text, kind) {
  return `${ticket}|${kind}|${hash(text || '')}`;
}

async function loadTips(meta, tipsRel, log) {
  try {
    if (meta && typeof meta.loadTextRel === 'function' && tipsRel) {
      const txt = await meta.loadTextRel(tipsRel);
      return txt || '';
    }
  } catch (e) {
    log && log(`warn loadTips err=${e.message || e}`);
  }
  return '';
}

async function appendContact(contactFile, name, phone, log) {
  if (!phone) return;
  try {
    fs.mkdirSync(path.dirname(contactFile), { recursive: true });
    const line = `${name || ''},${phone}\n`;
    fs.appendFileSync(contactFile, line, 'utf8');
    log && log(`contact saved file=${contactFile} phone=${phone}`);
  } catch (e) {
    log && log(`contact save failed file=${contactFile} err=${e.message || e}`);
  }
}

function msgIdOf(ctx) {
  try {
    const m = ctx && ctx.message;
    if (m && m.id) {
      if (typeof m.id === 'string') return m.id;
      if (m.id._serialized) return m.id._serialized;
      if (m.id.id) return m.id.id;
    }
    if (ctx && ctx.raw && ctx.raw.id) {
      const r = ctx.raw.id;
      if (typeof r === 'string') return r;
      if (r._serialized) return r._serialized;
    }
  } catch (_) {}
  return '';
}

module.exports.init = async function init(meta) {
  const hub = Conf.load(meta);
  const implRel = hub.getStr('implConfig', 'modules/Core/Impl/FallbackCV.conf');
  const conf = Conf.load(meta, implRel);

  // Debug/Trace keys MUST exist and MUST be supported
  const debugEnabled = conf.getBool('debugLog', true);
  const traceEnabled = conf.getBool('traceLog', true);

  const logger = SharedLog.create(meta, 'FallbackCV', { debugEnabled, traceEnabled });
  const log = (msg) => logger.debug(msg);
  const trace = (msg) => logger.trace(msg);

  const enabled = conf.getBool('enabled', true);
  if (!enabled) {
    logger.info('disabled');
    return { onMessage: async () => null };
  }

  const controlGroupId = conf.getStr('controlGroupId', '');
  const sendServiceName = conf.getStr('sendService', 'send');
  const commandServiceName = conf.getStr('commandService', 'command');
  const accessServiceName = conf.getStr('accessService', 'access');
  const ticketType = conf.getStr('ticketType', 'fallback');
  const ticketStoreSpec = conf.getStr('ticketStoreSpec', 'jsonstore:Fallback/tickets');
  const tipsFile = conf.getStr('tipsFile', 'config/ui/Tips.conf');
  const contactsCsvFile = conf.getStr('contactsCsvFile', '');
  const hideTicketInCustomerReply = conf.getBool('hideTicketInCustomerReply', false);
  const dedupeOutboundMs = conf.getInt('dedupeOutboundMs', 8000);

  const cmdReply = conf.getStr('cmdReply', 'r');
  const cmdList = conf.getStr('cmdList', 'list');
  const cmdPending = conf.getStr('cmdPending', 'pending');
  const cmdEdit = conf.getStr('cmdEdit', 'edit');
  const cmdDel = conf.getStr('cmdDel', 'del');
  const cmdClose = conf.getStr('cmdClose', 'close');
  const cmdRemind = conf.getStr('cmdRemind', 'remind');
  const remindIntervalMin = conf.getInt('remindIntervalMin', 30);

  const includeBody = conf.getBool('includeBody', true);
  const includeMediaHint = conf.getBool('includeMediaHint', true);
  const maxBodyChars = conf.getInt('maxBodyChars', 1200);

  const send = meta.getService(sendServiceName);
  const commands = meta.getService(commandServiceName);
  const access = meta.getService(accessServiceName);

  if (!controlGroupId) {
    logger.error('error: controlGroupId empty');
    return { onMessage: async () => null };
  }
  if (typeof send !== 'function') {
    logger.error(`error: send service "${sendServiceName}" missing`);
    return { onMessage: async () => null };
  }

  const tipsText = await loadTips(meta, tipsFile, log);

  const dedupeMap = new Map();       // outbound dedupe
  const inboundSeen = new Map();     // inbound dedupe (msgId or hash)
  const cmdSeen = new Map();         // command dedupe (chat+text)
  const forwardSeen = new Map();     // forward dedupe (ticket+seq) -> avoid double card to group

  const inboundTtlMs = 15000;
  const forwardTtlMs = 60000;

  function inboundKey(ctx) {
    const mid = msgIdOf(ctx);
    if (mid) return `id:${mid}`;
    const textNorm = normalizeText(ctx && ctx.text);
    const mediaFlag = (ctx && ctx.raw && ctx.raw.hasMedia) ? 'm1' : 'm0';
    return `h:${hash(`${ctx && ctx.chatId}|${textNorm}|${mediaFlag}`)}`;
  }

  function isDupInbound(ctx) {
    const key = inboundKey(ctx);
    if (!key) return false;
    const now = Date.now();
    const prev = inboundSeen.get(key);
    inboundSeen.set(key, now + inboundTtlMs);
    if (inboundSeen.size > 4000) {
      for (const [k, v] of inboundSeen.entries()) if (v < now) inboundSeen.delete(k);
    }
    if (prev && prev > now) {
      trace(`drop inbound dup key=${key}`);
      return true;
    }
    return false;
  }

  function isDupCommand(ctx) {
    const textNorm = normalizeText(ctx && ctx.text);
    const key = `cmd:${ctx && ctx.chatId}|${hash(textNorm)}`;
    const now = Date.now();
    const prev = cmdSeen.get(key);
    cmdSeen.set(key, now + inboundTtlMs);
    if (cmdSeen.size > 2000) {
      for (const [k, v] of cmdSeen.entries()) if (v < now) cmdSeen.delete(k);
    }
    if (prev && prev > now) {
      trace(`drop command dup key=${key}`);
      return true;
    }
    return false;
  }

  function isDupForward(ticket, seq) {
    const key = `${ticket}|${seq}`;
    const now = Date.now();
    const prev = forwardSeen.get(key);
    forwardSeen.set(key, now + forwardTtlMs);
    if (forwardSeen.size > 4000) {
      for (const [k, v] of forwardSeen.entries()) if (v < now) forwardSeen.delete(k);
    }
    if (prev && prev > now) {
      trace(`drop forward dup ticket=${ticket} seq=${seq}`);
      return true;
    }
    return false;
  }

  async function buildCard(ctx, ticket, seq, info) {
    const textRaw = toText(ctx.text || ctx.body || '');
    const body = includeBody ? textRaw.slice(0, maxBodyChars) : '';
    
    // Enhanced media detection for all types
    let mediaHint = '';
    let mediaType = '';
    if (includeMediaHint && ctx && ctx.raw) {
      const raw = ctx.raw;
      if (raw.hasMedia || raw.hasDocument || 
          (raw.type && ['image', 'video', 'audio', 'document', 'ptt', 'sticker'].includes(raw.type))) {
        // Determine specific media type
        if (raw.type) {
          mediaType = raw.type;
        } else if (raw.hasDocument) {
          mediaType = 'document';
        } else if (raw.hasMedia) {
          mediaType = 'media';
        }
        mediaHint = `Attachment: ${mediaType}`;
      }
    }

    const data = {
      ticket,
      seq,
      fromName: info.fromName || '',
      fromPhone: info.fromPhone || '',
      fromChatId: ctx.chatId || '',
      time: new Date().toISOString(),
      text: [body, mediaHint].filter(Boolean).join('\n'),
      tips: tipsText,
      attachCount: mediaHint ? '1' : '',
      attachTypes: mediaType || '',
    };

    return TicketCard.render(meta, conf.raw, seq === 1 ? 'NEW' : 'UPDATE', data);
  }

  async function forwardDmToGroup(ctx) {
    if (!ctx || ctx.isGroup) return false;
    if (ctx.fromMe) return false;
    if (isDupInbound(ctx)) return true;

    const sender = ctx.sender || {};
    const fromName = toText(sender.name || '');
    const fromPhone = toText(sender.phone || '');
    const chatId = toText(ctx.chatId || '');

    const ticketRes = await TicketCore.touch(meta, { ticketStoreSpec }, ticketType, chatId, {
      fromName,
      fromPhone,
      text: ctx.text || '',
    });
    if (!ticketRes || !ticketRes.ok) {
      logger.error(`error ticket touch failed chatId=${chatId}`);
      return false;
    }

    if (isDupForward(ticketRes.ticket, ticketRes.seq || 1)) return true;

    const card = await buildCard(ctx, ticketRes.ticket, ticketRes.seq || 1, { fromName, fromPhone });
    log(`forward DM -> group ticket=${ticketRes.ticket} chatId=${chatId} seq=${ticketRes.seq || 1}`);
    await send(controlGroupId, card, { type: 'text' });

    if (contactsCsvFile) {
      await appendContact(contactsCsvFile, fromName || fromPhone, fromPhone, log);
    }

    // Enhanced media detection and forwarding for all types
    if (ctx && ctx.raw) {
      const raw = ctx.raw;
      const hasAnyMedia = raw.hasMedia || raw.hasDocument || 
                         (raw.type && ['image', 'video', 'audio', 'document', 'ptt', 'sticker'].includes(raw.type));
      
      if (hasAnyMedia) {
        try {
          const cap = hideTicketInCustomerReply ? '' : `Ticket ${ticketRes.ticket}`;
          const mediaResult = await MediaQ.forward(meta, conf.raw, controlGroupId, ctx, cap, hideTicketInCustomerReply);
          if (mediaResult && !mediaResult.ok) {
            logger.error(`error media forward failed ticket=${ticketRes.ticket} reason=${mediaResult.reason || 'unknown'}`);
          } else if (mediaResult && mediaResult.ok) {
            log(`media forwarded ticket=${ticketRes.ticket} sent=${mediaResult.sent || 0}`);
          }
        } catch (e) {
          logger.error(`error media forward exception ticket=${ticketRes.ticket} err=${e && e.message ? e.message : e}`);
        }
      }
    }
    return true;
  }

  async function handleQuoteReply(ctx) {
    const res = await QuoteReply.handle(
      meta,
      { ...conf.raw, ticketStoreSpec, ticketType, debugLog: debugEnabled, traceLog: traceEnabled },
      ctx,
      { hideTicket: hideTicketInCustomerReply }
    );
    if (res && res.ok) log(`quote reply sent ticket=${res.ticket} dest=${res.chatId}`);
    return res && res.ok;
  }

  async function handleReplyCommand(ctx, args) {
    if (isDupCommand(ctx)) return { ok: false, reason: 'cmddup' };
    const res = await CmdReply.handle(
      meta,
      { ...conf.raw, ticketStoreSpec, ticketType, debugLog: debugEnabled, traceLog: traceEnabled },
      ctx,
      args,
      { hideTicket: hideTicketInCustomerReply }
    );
    if (res && res.ok) log(`cmd reply sent ticket=${res.ticket} dest=${res.chatId}`);
    return res && res.ok;
  }

  // Commands
  if (commands && typeof commands.register === 'function') {
    commands.register(cmdReply, async (ctx, args) => { await handleReplyCommand(ctx, args || []); }, { desc: 'Reply customer by ticket', usage: `!${cmdReply} <ticket> <text>` });

    commands.register(cmdList, async (ctx) => {
      const list = await TicketCore.list(meta, { ticketStoreSpec }, null);
      const lines = ['Tickets:'];
      list.forEach((t) => lines.push(`- ${t.ticket} [${t.status}] ${t.fromPhone || ''} ${t.note || ''}`));
      await ctx.reply(lines.join('\n'));
    }, { desc: 'List tickets' });

    commands.register(cmdPending, async (ctx) => {
      const list = await TicketCore.list(meta, { ticketStoreSpec }, 'open');
      const lines = ['Pending:'];
      list.forEach((t) => lines.push(`- ${t.ticket} ${t.fromPhone || ''} (last customer ${(new Date(t.lastCustomerAt || t.lastAt)).toISOString()})`));
      await ctx.reply(lines.join('\n'));
    }, { desc: 'Pending tickets' });

    commands.register(cmdEdit, async (ctx, args) => {
      const ticket = safeStr(args[0]);
      const note = args.slice(1).join(' ');
      if (!ticket || !note) return ctx.reply(`Usage: !${cmdEdit} <ticket> <note>`);
      const r = await TicketCore.updateNote(meta, { ticketStoreSpec }, ticket, note);
      if (!r || !r.ok) return ctx.reply('Not found.');
      await ctx.reply(`Updated note for ${ticket}`);
    }, { desc: 'Edit note' });

    commands.register(cmdDel, async (ctx, args) => {
      const ticket = safeStr(args[0]);
      if (!ticket) return ctx.reply(`Usage: !${cmdDel} <ticket>`);
      const r = await TicketCore.setStatus(meta, { ticketStoreSpec }, ticket, 'closed');
      await ctx.reply(r && r.ok ? `Closed ${ticket}` : 'Not found');
    }, { desc: 'Close ticket' });

    commands.register(cmdClose, async (ctx, args) => {
      const ticket = safeStr(args[0]);
      if (!ticket) return ctx.reply(`Usage: !${cmdClose} <ticket>`);
      const r = await TicketCore.setStatus(meta, { ticketStoreSpec }, ticket, 'closed');
      await ctx.reply(r && r.ok ? `Closed ${ticket}` : 'Not found');
    }, { desc: 'Close ticket (alias)' });

    commands.register(cmdRemind, async (ctx) => {
      await scheduleReminder();
      await ctx.reply('Reminder scheduled.');
    }, { desc: 'Trigger reminder scan' });

  } else {
    logger.warn('warn: command service missing, commands not registered');
  }

  // Reminder using scheduler
  const scheduler = meta.getService && meta.getService('scheduler');

  async function reminderJob() {
    const list = await TicketCore.list(meta, { ticketStoreSpec }, 'open');
    const now = Date.now();
    const pending = list.filter((t) => (t.lastCustomerAt || 0) > (t.lastStaffAt || 0));
    if (!pending.length) return;

    const lines = ['Pending replies:'];
    pending.forEach((t) => {
      const ageMin = Math.round((now - (t.lastCustomerAt || t.lastAt)) / 60000);
      lines.push(`- ${t.ticket} ${t.fromPhone || ''} (${ageMin}m) ${t.note ? '[note]' : ''}`);
    });
    await send(controlGroupId, lines.join('\n'), {});
  }

  async function scheduleReminder() {
    if (!scheduler || typeof scheduler.scheduleIn !== 'function' || remindIntervalMin <= 0) return;
    const id = 'fallback.reminder';
    try { scheduler.cancel && scheduler.cancel(id); } catch (_) {}
    scheduler.scheduleIn({
      id,
      delayMs: remindIntervalMin * 60000,
      handlerId: 'fallback.reminder',
      data: {},
      owner: 'FallbackCV',
    });
  }

  if (scheduler && typeof scheduler.registerHandler === 'function') {
    scheduler.registerHandler('fallback.reminder', async () => {
      await reminderJob();
      await scheduleReminder();
    });
    await scheduleReminder();
  }

  logger.info(`ready controlGroupId=${controlGroupId} hideTicket=${hideTicketInCustomerReply ? 1 : 0} ticketStore=${ticketStoreSpec} debug=${debugEnabled ? 1 : 0} trace=${traceEnabled ? 1 : 0}`);

  return {
    onMessage: async (ctx) => {
      try {
        if (!ctx) return;
        trace(`onMessage chatId=${ctx.chatId} isGroup=${ctx.isGroup} text=${safeStr(ctx.text)}`);

        // command !r
        if (ctx.text && ctx.text.trim().startsWith('!' + cmdReply)) {
          await handleReplyCommand(ctx, ctx.text.trim().split(/\s+/).slice(1));
          return;
        }

        // quote reply
        const qr = await handleQuoteReply(ctx);
        if (qr) return;

        // customer DM
        const fw = await forwardDmToGroup(ctx);
        if (fw) return;

      } catch (e) {
        logger.error(`error ${e && e.message ? e.message : e}`);
      }
    }
  };
};
