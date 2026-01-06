'use strict';

const Conf = require('../Shared/SharedConfV1');
const SharedLog = require('../Shared/SharedLogV1');
const TicketCore = require('../Shared/SharedTicketCoreV1');

const TicketCard = require('./FallbackTicketCardV1');
const QuoteReply = require('./FallbackQuoteReplyV1');
const MediaQ = require('./FallbackMediaForwardQueueV1');

function safeStr(x) {
  if (x === null || x === undefined) return '';
  return String(x);
}

function getRaw(ctx) {
  if (!ctx) return null;
  return ctx.raw || ctx.message || null;
}

function isControlGroup(ctx, controlGroupId) {
  if (!ctx) return false;
  if (!ctx.isGroup) return false;
  const id = safeStr(ctx.chatId);
  return !!controlGroupId && id === String(controlGroupId);
}

function isDmToBot(ctx) {
  if (!ctx) return false;
  return !ctx.isGroup && !!ctx.chatId;
}

function isMedia(ctx) {
  const raw = getRaw(ctx);
  if (!raw) return false;
  const t = (raw.type ? String(raw.type).toLowerCase() : '');
  if (!t) return false;
  return t !== 'chat' && t !== 'text';
}

function hasQuoted(raw) {
  if (!raw) return false;
  if (typeof raw.getQuotedMessage === 'function') return true;
  try {
    if (raw._data && raw._data.quotedMsg) return true;
    if (raw._data && raw._data.contextInfo && raw._data.contextInfo.quotedMessage) return true;
  } catch (e) {}
  return false;
}

function buildMediaCaption(ctx, ticket, seq, hideTicket) {
  const raw = getRaw(ctx);
  const type = raw && raw.type ? String(raw.type) : '';
  const phone = ctx && ctx.sender && ctx.sender.phone ? String(ctx.sender.phone) : '';
  const name = ctx && ctx.sender && ctx.sender.name ? String(ctx.sender.name) : '';

  const parts = [];
  parts.push('Media from customer');
  if (!hideTicket) parts.push('Ticket: ' + safeStr(ticket));
  parts.push('Seq: ' + safeStr(seq));
  if (phone) parts.push('Phone: ' + phone);
  if (name) parts.push('Name: ' + name);
  if (type) parts.push('Type: ' + type);
  return parts.join('\n');
}

function normalizeTicketCfg(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  if (c.ticketStore && !c.ticketStoreSpec) c.ticketStoreSpec = c.ticketStore;
  if (c.ticketStore && !c.storeSpec) c.storeSpec = c.ticketStore;
  return c;
}

async function init(meta) {
  const confWrap = Conf.load(meta);
  const rawConf =
    (confWrap && confWrap.raw && typeof confWrap.raw === 'object')
      ? confWrap.raw
      : (meta && meta.implConf ? meta.implConf : {});

  const debugEnabled = confWrap && typeof confWrap.getBool === 'function'
    ? confWrap.getBool('debugLog', confWrap.getBool('debug', false))
    : false;

  const traceEnabled = confWrap && typeof confWrap.getBool === 'function'
    ? confWrap.getBool('traceLog', confWrap.getBool('trace', false))
    : false;

  const log = SharedLog.create(meta, 'FallbackCV', { debugEnabled, traceEnabled });

  const controlGroupId = confWrap && typeof confWrap.getStr === 'function'
    ? confWrap.getStr('controlGroupId', '').trim()
    : safeStr(rawConf.controlGroupId).trim();

  if (!controlGroupId) {
    log.error('missing controlGroupId - module disabled');
    return { onMessage: async () => {} };
  }

  const stripTicketInCustomerReply = confWrap && typeof confWrap.getBool === 'function'
    ? confWrap.getBool('hideTicket', false)
    : !!rawConf.hideTicket;

  const groupCardHideTicket = confWrap && typeof confWrap.getBool === 'function'
    ? confWrap.getBool('groupCardHideTicket', false)
    : !!rawConf.groupCardHideTicket;

  // IMPORTANT: default = 1 (hide ticket in every media caption) to avoid "ticket spam"
  let groupMediaHideTicket = (confWrap && typeof confWrap.getBool === 'function')
    ? confWrap.getBool('groupMediaHideTicket', true)
    : (rawConf.groupMediaHideTicket === undefined ? true : !!rawConf.groupMediaHideTicket);

  const ticketStore = confWrap && typeof confWrap.getStr === 'function'
    ? confWrap.getStr('ticketStore', 'jsonstore:Fallback/tickets')
    : safeStr(rawConf.ticketStore || 'jsonstore:Fallback/tickets');

  const ticketType = confWrap && typeof confWrap.getStr === 'function'
    ? confWrap.getStr('ticketType', 'fallback')
    : safeStr(rawConf.ticketType || 'fallback');

  // IMPORTANT: default burst window longer (15s) so 1 ticket card covers album/doc burst
  const burstMs = confWrap && typeof confWrap.getInt === 'function'
    ? confWrap.getInt('burstMs', 15000)
    : Number(rawConf.burstMs || 15000);

  const cfgBase = normalizeTicketCfg(Object.assign({}, rawConf, {
    controlGroupId,
    ticketStore,
    ticketType,
    stripTicketInCustomerReply,
    groupCardHideTicket,
    groupMediaHideTicket,
    debugLog: debugEnabled ? 1 : 0,
    traceLog: traceEnabled ? 1 : 0,
    burstMs,
  }));

  log.info(
    'ready controlGroupId=' + controlGroupId +
    ' ticketStore=' + ticketStore +
    ' stripTicketInCustomerReply=' + (stripTicketInCustomerReply ? '1' : '0') +
    ' groupCardHideTicket=' + (groupCardHideTicket ? '1' : '0') +
    ' groupMediaHideTicket=' + (groupMediaHideTicket ? '1' : '0')
  );

  const lastCardAtByTicket = new Map();

  async function onMessage(ctx) {
    const raw = getRaw(ctx);

    try {
      // CONTROL GROUP: allow staff reply even if fromMe
      if (isControlGroup(ctx, controlGroupId)) {
        // Prevent loop: ignore bot's own non-quoted messages (cards/feeds)
        if (ctx && ctx.fromMe && !hasQuoted(raw)) return;

        const r = await QuoteReply.handle(meta, cfgBase, ctx);

        // Tips only for staff manual action (fromMe) - BUT avoid spam if message not quoted
        if (!r.ok && !ctx.fromMe) return;
        if (!r.ok && r.reason === 'noquote') return;

        return;
      }

      // DM -> Control Group (ignore bot-sent DM)
      if (isDmToBot(ctx)) {
        if (ctx && ctx.fromMe) return;
        if (!raw) return;

        const info = {
          fromName: safeStr(ctx.sender && ctx.sender.name),
          fromPhone: safeStr(ctx.sender && ctx.sender.phone),
        };

        const ticketRes = await TicketCore.touch(meta, cfgBase, ticketType, ctx.chatId, info);
        if (!ticketRes || !ticketRes.ok) {
          log.error('touch ticket failed reason=' + safeStr(ticketRes && ticketRes.reason));
          return;
        }

        const ticket = ticketRes.ticket;
        const seq = ticketRes.seq;

        const now = Date.now();
        const last = lastCardAtByTicket.get(ticket) || 0;
        const suppressCard = (now - last) < burstMs;

        if (!suppressCard) {
          lastCardAtByTicket.set(ticket, now);

          let rendered = await TicketCard.render(
            meta,
            cfgBase,
            safeStr(raw && raw.type),
            {
              ticket: groupCardHideTicket ? '**' : ticket,
              seq,
              phone: safeStr(ctx.sender && ctx.sender.phone),
              name: safeStr(ctx.sender && ctx.sender.name),
              chatId: safeStr(ctx.chatId),
              text: safeStr(ctx.text || ''),
              type: safeStr(raw && raw.type),
            }
          );

          rendered = safeStr(rendered).trim();
          if (!rendered) {
            rendered = 'Ticket: ' + (groupCardHideTicket ? '**' : ticket) + '\nSeq: ' + safeStr(seq);
          }

          const send = meta.getService('outsend') || meta.getService('sendout') || meta.getService('send');
          if (send) await send(controlGroupId, rendered);
        }

        // Media -> forward (caption hides ticket by default)
        if (isMedia(ctx)) {
          const cap = buildMediaCaption(ctx, ticket, seq, groupMediaHideTicket);
          await MediaQ.forward(meta, cfgBase, controlGroupId, ctx, cap);
        }

        return;
      }
    } catch (e) {
      log.error('onMessage error err=' + safeStr(e && e.message ? e.message : e));
    }
  }

  return { onMessage };
}

module.exports = { init };
