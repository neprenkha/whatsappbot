'use strict';

/*
  FallbackCV.js (Stable Buffered)
  - Fail-soft: no missing requires.
  - Buffer DM burst to ONE ticket card (bufferMs from conf).
  - Media forward uses media-safe send prefer (skips outbox/send).
  - No ticket appended into every media caption (ticket stays in ticket card).
*/

const Conf = require('../Shared/SharedConfV1');
const SharedLog = require('../Shared/SharedLogV1');
const TicketCore = require('../Shared/SharedTicketCoreV1');
const TicketCard = require('./FallbackTicketCardV1');
const QuoteReply = require('./FallbackQuoteReplyV1');
const MessageTicketMap = require('../Shared/SharedMessageTicketMapV1');

function safeStr(v) {
  return String(v || '').trim();
}

function splitCsv(str) {
  return String(str || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function mkLog(meta, conf, tag) {
  const base = SharedLog.create(meta, tag);
  const debugOn = Number(conf.getInt('debugLog', 0)) === 1;
  const traceOn = Number(conf.getInt('traceLog', 0)) === 1;

  return {
    info: (...a) => base.info(...a),
    warn: (...a) => base.warn(...a),
    error: (...a) => base.error(...a),
    debug: (...a) => { if (debugOn) base.debug(...a); },
    trace: (...a) => { if (traceOn) base.trace(...a); }
  };
}

function hasMediaContent(raw) {
  if (!raw) return false;
  
  // Check hasMedia property
  if (raw.hasMedia) return true;
  
  // Explicitly check for audio/video/ptt types that might not set hasMedia
  const type = String(raw.type || '').toLowerCase();
  if (type === 'audio' || type === 'video' || type === 'ptt') return true;
  
  // Check if downloadMedia function exists (indicates media presence)
  if (typeof raw.downloadMedia === 'function') {
    // Additional type checks
    if (type === 'image' || type === 'document' || type === 'sticker') return true;
  }
  
  return false;
}

function pickSendFn(meta, preferCsv, mode) {
  const prefer = splitCsv(preferCsv || 'outsend,sendout,send');

  for (const rawName of prefer) {
    const name = String(rawName || '').toLowerCase();

    // Media must never go through outbox/send (text-only).
    if (mode === 'media') {
      if (name === 'outbox' || name === 'send') continue;
    }

    try {
      const svc = meta.getService(name);
      if (typeof svc === 'function') return { via: name, fn: svc };
      if (svc && typeof svc.sendDirect === 'function') {
        return {
          via: name,
          fn: async (chatId, payload, opts) => svc.sendDirect(chatId, payload, opts || {})
        };
      }
    } catch (_e) {}
  }

  // fallback to transport
  try {
    const transport = meta.getService('transport');
    if (transport && typeof transport.sendDirect === 'function') {
      return {
        via: 'transport',
        fn: async (chatId, payload, opts) => transport.sendDirect(chatId, payload, opts || {})
      };
    }
  } catch (_e) {}

  return {
    via: 'none',
    fn: async () => { throw new Error('No outbound send service'); }
  };
}

async function forwardMedia(log, mediaSendFn, toChatId, rawMsg, ticketId) {
  try {
    const msgType = rawMsg && rawMsg.type ? String(rawMsg.type) : 'unknown';
    log.debug('media.forward.attempt', { type: msgType, hasDownload: typeof rawMsg?.downloadMedia === 'function', hasForward: typeof rawMsg?.forward === 'function' });
    
    let media = null;

    if (rawMsg && typeof rawMsg.downloadMedia === 'function') {
      try {
        media = await rawMsg.downloadMedia();
        if (media) {
          log.debug('media.download.ok', { type: msgType, size: media?.data?.length || 0 });
        } else {
          log.warn('media.download.null', { type: msgType });
        }
      } catch (e) {
        log.warn('media.download.fail', { type: msgType, err: e && e.message ? e.message : String(e) });
      }
    }

    // keep original caption only (no ticket injected)
    let caption = '';
    try {
      caption = safeStr(rawMsg && (rawMsg.body || (rawMsg._data && rawMsg._data.caption)));
    } catch (_e) {}

    if (media) {
      const result = await mediaSendFn(toChatId, media, caption ? { caption } : {});
      log.info('media.forward.sent', { type: msgType, via: 'download' });
      
      // Store message ID mapping
      if (ticketId && result) {
        const MessageTicketMap = require('../Shared/SharedMessageTicketMapV1');
        if (result.id) {
          MessageTicketMap.set(result.id, ticketId);
          log.trace('msgmap.set.media', { msgId: result.id, ticket: ticketId, type: msgType });
        } else if (result._data && result._data.id && result._data.id._serialized) {
          MessageTicketMap.set(result._data.id._serialized, ticketId);
          log.trace('msgmap.set.media', { msgId: result._data.id._serialized, ticket: ticketId, type: msgType });
        }
      }
      
      return true;
    }

    // fallback: forward raw message if download failed
    if (rawMsg && typeof rawMsg.forward === 'function') {
      log.debug('media.forward.trying.forward', { type: msgType });
      const result = await rawMsg.forward(toChatId);
      log.info('media.forward.sent', { type: msgType, via: 'forward' });
      
      // Store message ID mapping (result from forward is the forwarded message)
      if (ticketId && result) {
        const MessageTicketMap = require('../Shared/SharedMessageTicketMapV1');
        if (result.id) {
          MessageTicketMap.set(result.id, ticketId);
          log.trace('msgmap.set.media.fwd', { msgId: result.id, ticket: ticketId, type: msgType });
        } else if (result._data && result._data.id && result._data.id._serialized) {
          MessageTicketMap.set(result._data.id._serialized, ticketId);
          log.trace('msgmap.set.media.fwd', { msgId: result._data.id._serialized, ticket: ticketId, type: msgType });
        }
      }
      
      return true;
    }
    
    log.error('media.forward.no.method', { type: msgType });
  } catch (e) {
    log.error('media.forward.failed', { type: rawMsg && rawMsg.type, error: e && e.message ? e.message : String(e) });
  }
  return false;
}

async function init(meta) {
  const conf = Conf.load(meta);
  const log = mkLog(meta, conf, 'FallbackCV');

  const controlGroupId = conf.getStr('controlGroupId', '');
  if (!controlGroupId) throw new Error('controlGroupId must not be empty');

  const ticketType = conf.getStr('ticketType', 'fallback');

  const bufferMs = Number(conf.getInt('bufferMs', 3000));
  const mediaDelayMs = Number(conf.getInt('mediaDelayMs', 500));

  const sendPrefer = conf.getStr('sendPrefer', 'outsend,sendout,send');

  const textSender = pickSendFn(meta, sendPrefer, 'text');
  const mediaSender = pickSendFn(meta, sendPrefer, 'media');

  log.info('ready', {
    controlGroupId,
    ticketType,
    bufferMs,
    mediaDelayMs,
    textVia: textSender.via,
    mediaVia: mediaSender.via
  });

  // buffers[chatId] = { timer, items: [] }
  const buffers = {};

  async function flushBuffer(chatId) {
    const entry = buffers[chatId];
    if (!entry) return;

    const batch = entry.items || [];
    delete buffers[chatId];

    if (!batch.length) return;

    const combinedText = [];
    const mediaItems = [];
    let senderInfo = {};

    for (const ctx of batch) {
      const txt = safeStr(ctx.text);
      if (txt) combinedText.push(txt);

      const raw = ctx.message || ctx.msg || ctx.raw || ctx.rawMsg;
      if (raw && hasMediaContent(raw)) {
        log.trace('media.detected', { type: raw.type, hasMedia: raw.hasMedia });
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

    let ticketData;
    try {
      ticketData = await TicketCore.touch(meta, conf, ticketType, chatId, senderInfo);
    } catch (e) {
      log.error('ticket.touch.failed', { error: e && e.message ? e.message : String(e) });
      return;
    }

    // ticketData.ticket is the ticket object, ticketData.ticket.id is the ticket ID
    const ticketObj = ticketData.ticket || {};
    const ticketId = ticketObj.id || '';

    const cardText = await TicketCard.render(meta, conf, 'UPDATE', {
      ticket: ticketId,
      text: finalText,
      attachCount: mediaItems.length,
      fromChatId: chatId,
      fromName: senderInfo.name,
      fromPhone: senderInfo.phone,
      seq: ticketObj.seq || '',
      status: ticketObj.status || 'open'
    });

    try {
      const cardResult = await textSender.fn(controlGroupId, cardText, {});
      log.info('ticket.card.sent', { ticket: ticketId, media: mediaItems.length });
      
      // Store message ID mapping for quote-reply resolution
      if (cardResult && cardResult.id) {
        MessageTicketMap.set(cardResult.id, ticketId);
        log.trace('msgmap.set', { msgId: cardResult.id, ticket: ticketId });
      } else if (cardResult && cardResult._data && cardResult._data.id && cardResult._data.id._serialized) {
        MessageTicketMap.set(cardResult._data.id._serialized, ticketId);
        log.trace('msgmap.set', { msgId: cardResult._data.id._serialized, ticket: ticketId });
      }
    } catch (e) {
      log.error('ticket.card.send.fail', { error: e && e.message ? e.message : String(e) });
      return;
    }

    for (const rawMsg of mediaItems) {
      const mediaResult = await forwardMedia(log, mediaSender.fn, controlGroupId, rawMsg, ticketId);
      if (mediaDelayMs > 0) {
        await new Promise(r => setTimeout(r, mediaDelayMs));
      }
    }
  }

  async function processMessage(ctx) {
    if (!ctx) return;

    const chatId = ctx.chatId || (ctx.msg && ctx.msg.chatId) || (ctx.message && ctx.message.from) || '';
    if (!chatId) return;

    const isGroup = Boolean(ctx.isGroup);

    // Control Group: handle quote-reply (text/media) only
    if (isGroup) {
      if (chatId === controlGroupId) {
        await QuoteReply.handle(meta, conf, ctx);
      }
      return;
    }

    // Customer DM: buffer burst
    const raw = ctx.message || ctx.msg || ctx.raw || ctx.rawMsg;
    const text = safeStr(ctx.text);
    const hasMedia = hasMediaContent(raw);

    if (!text && !hasMedia) return;

    if (!buffers[chatId]) buffers[chatId] = { items: [], timer: null };
    buffers[chatId].items.push(ctx);

    if (buffers[chatId].timer) clearTimeout(buffers[chatId].timer);
    buffers[chatId].timer = setTimeout(() => {
      flushBuffer(chatId).catch(e => log.error('flush.fail', { error: e && e.message ? e.message : String(e) }));
    }, bufferMs);
  }

  return {
    onMessage: async (ctx) => {
      try {
        await processMessage(ctx);
      } catch (e) {
        log.error('onMessage.error', { error: e && e.message ? e.message : String(e) });
      }
    }
  };
}

module.exports = { init };
