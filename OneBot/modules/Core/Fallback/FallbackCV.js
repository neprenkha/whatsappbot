'use strict';

/*
  FixedFallback.js (Buffered Version)
  - Fix: Added missing 'FallbackReplyMediaV1' require (fixes load failure).
  - Fix: Uses 3s buffer to merge bulk messages/media into ONE ticket card.
  - Fix: Appends [Ticket:ID] to forwarded media captions so staff can reply easily.
*/

const Conf = require('../Shared/SharedConfV1');
const SharedLog = require('../Shared/SharedLogV1');
const TicketCore = require('../Shared/SharedTicketCoreV1');
const TicketCard = require('./FallbackTicketCardV1');
const ReplyText = require('./FallbackReplyTextV1');
const ReplyMedia = require('./FallbackReplyMediaV1'); // Added missing require
const QuoteReply = require('./FallbackQuoteReplyV1');

function safeStr(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function pickSendFn(meta, sendPrefer) {
  const prefer = safeStr(sendPrefer).split(',').map(s => s.trim()).filter(Boolean);

  for (const name of prefer) {
    const svc = meta.getService(name);
    if (svc && typeof svc === 'function') return svc;
  }

  // fallback
  const send = meta.getService('send');
  if (send && typeof send === 'function') return send;

  throw new Error('No send function available.');
}

async function init(meta) {
  const conf = Conf.load(meta);
  const log = SharedLog.create(meta, 'FixedFallback');

  // Plain config object for handlers (do NOT pass Conf wrapper to TicketCore/QuoteReply)
  const cfg = (conf && conf.raw && typeof conf.raw === 'object') ? conf.raw : {};
  if (cfg.enabled === undefined) cfg.enabled = 1;

  const controlGroupId = conf.getStr('controlGroupId', '');
  if (!controlGroupId) {
    log.error('controlGroupId missing, module disabled.');
    return { onMessage: async () => {} };
  }

  cfg.controlGroupId = controlGroupId;

  const sendPrefer = conf.getStr('sendPrefer', 'outsend,sendout,send');
  const ticketType = conf.getStr('ticketType', 'fallback');

  cfg.ticketType = ticketType;
  cfg.sendPrefer = sendPrefer;

  // Ticket store mapping (SharedTicketCoreV1 expects ticketStoreSpec or storeSpec)
  cfg.ticketStoreSpec = cfg.ticketStoreSpec || cfg.ticketStore || cfg.storeSpec || conf.getStr('ticketStore', '');
  if (!cfg.storeSpec && cfg.ticketStoreSpec) cfg.storeSpec = cfg.ticketStoreSpec;

  // Visibility rules
  cfg.hideTicket = conf.getBool('hideTicket', true) ? 1 : 0;
  cfg.groupCardHideTicket = conf.getBool('groupCardHideTicket', false) ? 1 : 0;
  cfg.groupMediaHideTicket = conf.getBool('groupMediaHideTicket', true) ? 1 : 0;

  cfg.debugLog = conf.getBool('debugLog', conf.getBool('debug', false)) ? 1 : 0;
  cfg.traceLog = conf.getBool('traceLog', conf.getBool('trace', false)) ? 1 : 0;

  const bufferMs = conf.getInt('burstMs', 3000); // buffer window
  const sendFn = pickSendFn(meta, sendPrefer);

  // Buffer Storage: { chatId: { timer, items: [] } }
  const buffers = {};

  function scheduleFlush(chatId) {
    if (!buffers[chatId]) return;
    if (buffers[chatId].timer) return;

    buffers[chatId].timer = setTimeout(async () => {
      const batch = buffers[chatId].items || [];
      delete buffers[chatId];

      if (!batch.length) return;

      // 1. Analyze Batch
      let combinedText = [];
      let mediaItems = [];
      let senderInfo = {};

      for (const ctx of batch) {
        const txt = safeStr(ctx.text);
        if (txt) combinedText.push(txt);

        const raw = ctx.message || ctx.raw;
        if (raw && raw.hasMedia) {
          mediaItems.push(raw);
        }

        if (ctx.sender) {
          senderInfo = {
            name: ctx.sender.name || '',
            phone: ctx.sender.phone || ''
          };
        }
      }

      const finalText = combinedText.join('\n\n');

      // 2. Touch Ticket (MUST use cfg for JsonStore persistence)
      const ticketData = await TicketCore.touch(meta, cfg, ticketType, batch[0].chatId, {
        sender: senderInfo,
        lastText: finalText,
        mediaCount: mediaItems.length,
      });

      const ticket = ticketData && ticketData.ticket ? ticketData.ticket : '';

      // 3. Send Ticket Card to Control Group (ONE per batch)
      const cardText = await TicketCard.render(meta, cfg, 'UPDATE', {
        ticket,
        fromChatId: batch[0].chatId,
        fromPhone: senderInfo.phone || '',
        fromName: senderInfo.name || '',
        text: finalText,
        mediaCount: mediaItems.length,
      });

      await sendFn(controlGroupId, cardText, {});
      log.info(`Ticket card sent: ${ticket} (${mediaItems.length} media)`);

      // 4. Forward Media Items (optional, keep ticket in caption for staff)
      for (const raw of mediaItems) {
        try {
          const captionBase = safeStr(raw && raw._data ? raw._data.caption : '');
          let caption = captionBase;

          // Optional: hide ticket in media caption to reduce spam
          if (!cfg.groupMediaHideTicket) {
            if (ticket) caption = (caption ? caption + '\n' : '') + `[Ticket:${ticket}]`;
          }

          // Reuse ReplyMedia sender (Control Group target)
          await ReplyMedia.sendMedia(meta, cfg, controlGroupId, raw, caption);
        } catch (e) {
          log.error('Failed to forward media', { error: e.message });
        }
      }

    }, bufferMs);
  }

  async function processMessage(ctx) {
    const chatId = safeStr(ctx.chatId);
    const isGroup = !!ctx.isGroup;

    // Group Logic - Quote Reply
    if (isGroup) {
      if (chatId === controlGroupId) {
        await QuoteReply.handle(meta, cfg, ctx);
        return;
      }
      return;
    }

    // Customer Logic - Buffer for Anti-Spam
    const text = safeStr(ctx.text);
    const rawMessage = ctx.message || ctx.raw;
    const hasMedia = rawMessage ? rawMessage.hasMedia : false;

    if (!text && !hasMedia) return;

    // Initialize buffer
    if (!buffers[chatId]) {
      buffers[chatId] = { items: [] };
    }

    buffers[chatId].items.push(ctx);
    scheduleFlush(chatId);
  }

  return {
    onMessage: async (ctx) => {
      try {
        await processMessage(ctx);
      } catch (e) {
        log.error('Error processing message', { error: e.message });
      }
    },
  };
}

module.exports = { init };
