'use strict';

/*
  FallbackCV (Fixed Logging)
  - Added logging for ignored/failed quote replies to diagnose issues.
  - Handles DM->Group and Group->DM logic.
*/

const Conf = require('../Shared/SharedConfV1');
const SharedLog = require('../Shared/SharedLogV1');

const TicketCore = require('../Shared/SharedTicketCoreV1');
const TicketCard = require('./FallbackTicketCardV1');
const MediaQ = require('./FallbackMediaForwardQueueV1');
const CmdReply = require('./FallbackCommandReplyV1');
const QuoteReply = require('./FallbackQuoteReplyV1');

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function toText(v) { return String(v == null ? '' : v); }
function safeStr(v) { return String(v || '').trim(); }
function hash(s) { return crypto.createHash('sha1').update(String(s || '')).digest('hex'); }
function normalizeText(s) { return toText(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim(); }

function bridgeRaw(ctx) {
  if (!ctx) return;
  if (!ctx.raw && ctx.message) ctx.raw = ctx.message;
  if (!ctx.message && ctx.raw) ctx.message = ctx.raw;
}

function hasAnyMedia(ctx) {
  const m = ctx && (ctx.raw || ctx.message);
  if (!m) return false;
  return !!(m.hasMedia || m.media || m.mediaContent || (m._data && (m._data.media || m._data.mimetype)));
}

function msgIdOf(ctx) {
  try {
    const m = ctx && (ctx.message || ctx.raw);
    if (!m) return '';
    const id = m.id || (m._data && m._data.id);
    if (!id) return '';
    if (typeof id === 'string') return id;
    if (id._serialized) return id._serialized;
    if (id.id) return id.id;
  } catch (_) {}
  return '';
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

module.exports.init = async function init(meta) {
  const hub = Conf.load(meta);
  const implRel = hub.getStr('implConfig', 'modules/Core/Impl/FallbackCV.conf');
  const conf = Conf.load(meta, implRel);

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
  const ticketType = conf.getStr('ticketType', 'fallback');
  const ticketStoreSpec = conf.getStr('ticketStoreSpec', 'jsonstore:Fallback/tickets');

  const tipsFile = conf.getStr('tipsFile', 'config/ui/Tips.conf');
  const contactsCsvFile = conf.getStr('contactsCsvFile', '');
  const hideTicketInCustomerReply = conf.getBool('hideTicketInCustomerReply', false);

  const cmdReply = conf.getStr('cmdReply', 'r');

  const includeBody = conf.getBool('includeBody', true);
  const includeMediaHint = conf.getBool('includeMediaHint', true);
  const maxBodyChars = conf.getInt('maxBodyChars', 1200);

  // Burst window ms: suppress extra ticket cards for rapid media/doc album
  const burstMs = conf.getInt('ticketCardBurstMs', conf.getInt('dmTicketCardWindowMs', 3000));

  const send = meta.getService(sendServiceName);
  const commands = meta.getService(commandServiceName);

  if (!controlGroupId) {
    logger.error('error: controlGroupId empty');
    return { onMessage: async () => null };
  }
  if (typeof send !== 'function') {
    logger.error(`error: send service "${sendServiceName}" missing`);
    return { onMessage: async () => null };
  }

  const tipsText = await loadTips(meta, tipsFile, log);

  // inbound dedupe inside fallback: only for non-media without msgId
  const inboundSeen = new Map();
  const inboundTtlMs = 15000;

  function inboundKey(ctx) {
    const mid = msgIdOf(ctx);
    if (mid) return `id:${mid}`;
    if (hasAnyMedia(ctx)) return ''; // do not dedupe media without msgId
    const textNorm = normalizeText(ctx && ctx.text);
    return `h:${hash(`${ctx && ctx.chatId}|${textNorm}`)}`;
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

  // prevent double card to group per (ticket, seq)
  const forwardSeen = new Map();
  const forwardTtlMs = 60000;
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

  const lastCardAt = new Map();

  async function buildCard(ctx, ticket, seq, info) {
    const textRaw = toText(ctx.text || ctx.body || '');
    const body = includeBody ? textRaw.slice(0, maxBodyChars) : '';
    const mediaHint = includeMediaHint && hasAnyMedia(ctx) ? 'Attachment: media' : '';

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
      attachTypes: mediaHint ? 'media' : '',
    };

    return TicketCard.render(meta, conf.raw, seq === 1 ? 'NEW' : 'UPDATE', data);
  }

  async function forwardDmToGroup(ctx) {
    if (!ctx || ctx.isGroup) return false;
    if (ctx.fromMe) return false;

    bridgeRaw(ctx);

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

    const now = Date.now();
    const media0 = hasAnyMedia(ctx);
    const last = lastCardAt.get(chatId) || 0;
    const suppressCard = media0 && last && (now - last) < burstMs;

    // ticket card (only if not suppressed)
    if (!suppressCard) {
      if (!isDupForward(ticketRes.ticket, ticketRes.seq || 1)) {
        const card = await buildCard(ctx, ticketRes.ticket, ticketRes.seq || 1, { fromName, fromPhone });
        log(`forward DM -> group ticket=${ticketRes.ticket} chatId=${chatId} seq=${ticketRes.seq || 1}`);
        await send(controlGroupId, card, { type: 'text' });
        lastCardAt.set(chatId, now);
      }
      if (contactsCsvFile) {
        await appendContact(contactsCsvFile, fromName || fromPhone, fromPhone, log);
      }
    } else {
      trace(`ticket card suppressed chatId=${chatId} ticket=${ticketRes.ticket} winMs=${burstMs}`);
    }

    // media forward
    if (media0) {
      const cap = hideTicketInCustomerReply ? '' : `Ticket ${ticketRes.ticket}`;
      await MediaQ.forward(meta, conf.raw, controlGroupId, ctx, cap, hideTicketInCustomerReply);
    }

    return true;
  }

  async function handleQuoteReply(ctx) {
    bridgeRaw(ctx);
    const res = await QuoteReply.handle(
      meta,
      { ...conf.raw, ticketStoreSpec, ticketType, debugLog: debugEnabled, traceLog: traceEnabled },
      ctx,
      { hideTicket: hideTicketInCustomerReply }
    );
    if (res && res.ok) {
      log(`quote reply sent ticket=${res.ticket} dest=${res.chatId}`);
    } else if (res && res.reason && res.reason !== 'wronggroup' && res.reason !== 'empty') {
      // LOG FAILURE REASON TO DEBUG
      log(`quote reply ignored reason=${res.reason} ticket=${res.ticket || 'none'} text=${safeStr(ctx.text).slice(0, 20)}...`);
    }
    return res && res.ok;
  }

  async function handleReplyCommand(ctx, args) {
    bridgeRaw(ctx);
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

  // register minimal command hook for !r
  if (commands && typeof commands.register === 'function') {
    commands.register(cmdReply, async (ctx, args) => { await handleReplyCommand(ctx, args || []); }, { desc: 'Reply customer by ticket', usage: `!${cmdReply} <ticket> <text>` });
  }

  logger.info(`ready controlGroupId=${controlGroupId} hideTicket=${hideTicketInCustomerReply ? 1 : 0} ticketStore=${ticketStoreSpec} debug=${debugEnabled ? 1 : 0} trace=${traceEnabled ? 1 : 0}`);

  return {
    onMessage: async (ctx) => {
      try {
        if (!ctx) return;
        bridgeRaw(ctx);

        trace(`onMessage chatId=${ctx.chatId} isGroup=${ctx.isGroup} text=${safeStr(ctx.text)}`);

        // command !r
        if (ctx.text && ctx.text.trim().startsWith('!' + cmdReply)) {
          await handleReplyCommand(ctx, ctx.text.trim().split(/\s+/).slice(1));
          return;
        }

        // quote reply
        if (await handleQuoteReply(ctx)) return;

        // customer DM
        if (await forwardDmToGroup(ctx)) return;

      } catch (e) {
        logger.error(`error ${e && e.message ? e.message : e}`);
      }
    }
  };
};