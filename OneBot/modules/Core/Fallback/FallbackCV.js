// FallbackCV.js
// Core Fallback module implementation (CV)
// - Receives DM messages, creates ticket, sends to Control Group
// - Supports buffered "album" collection
// - Reply flow handled by other modules (QuoteReply / Media / AV split)
//
// HARD RULES:
// - ASCII-only for logs and any bot-facing defaults.
// - Fail-soft: never crash on missing config; log and continue.
// - Do not edit frozen foundation files (Kernel/Connector/Hub loaders).

'use strict';

const path = require('path');

const SharedConf = require('../Shared/SharedConfV1');
const SharedLog = require('../Shared/SharedLogV1');

const SharedTicketCore = require('../Shared/SharedTicketCoreV1');
const SharedSafeSend = require('../Shared/SharedSafeSendV1');

const FallbackTicketCard = require('./FallbackTicketCardV1');
const SharedMessageTicketMap = require('./SharedMessageTicketMapV1');

function init(meta) {
  const tag = 'FallbackCV';
  const log = SharedLog.create(meta, tag);

  const cfg = loadConf(meta, log);

  const state = {
    buffer: {},            // chatId -> { firstAt, lastAt, items: [ { msg, text } ], timer }
    lastTicketByChat: {},  // chatId -> ticketId
  };

  log.info('ready', {
    enabled: cfg.enabled ? 1 : 0,
    controlGroupId: cfg.controlGroupId || '',
    albumWindowMs: cfg.albumWindowMs,
    debugLog: cfg.debugLog ? 1 : 0,
    traceLog: cfg.traceLog ? 1 : 0,
  });

  return {
    id: 'Fallback',
    onMessage: (ctx) => onMessage(meta, cfg, state, log, ctx),
  };
}

function loadConf(meta, log) {
  // Defaults MUST be safe and not crash
  const conf = SharedConf.load(meta, 'FallbackCV', {
    enabled: '1',
    controlGroupId: '',
    ticketPrefix: 'T',
    debugLog: '0',
    traceLog: '0',

    albumWindowMs: '2500',
    albumMaxItems: '20',

    // Safety / rules
    dropFromMe: '0',
    dropGroup: '1',
  });

  const cfg = {
    enabled: conf.enabled === '1',
    controlGroupId: String(conf.controlGroupId || '').trim(),
    ticketPrefix: String(conf.ticketPrefix || 'T').trim() || 'T',

    debugLog: conf.debugLog === '1',
    traceLog: conf.traceLog === '1',

    albumWindowMs: toInt(conf.albumWindowMs, 2500, 500, 15000),
    albumMaxItems: toInt(conf.albumMaxItems, 20, 1, 50),

    dropFromMe: conf.dropFromMe === '1',
    dropGroup: conf.dropGroup === '1',
  };

  if (!cfg.controlGroupId) {
    // Fail-soft: do NOT throw. Keep module alive but effectively disabled.
    log.error('missing controlGroupId - fallback disabled');
    cfg.enabled = false;
  }

  return cfg;
}

function onMessage(meta, cfg, state, log, ctx) {
  try {
    if (!cfg.enabled) return;

    const msg = ctx && ctx.message ? ctx.message : null;
    if (!msg) return;

    const chatId = String(ctx.chatId || '');
    const isGroup = !!ctx.isGroup;
    const fromMe = !!msg.fromMe;

    if (cfg.dropFromMe && fromMe) return;
    if (cfg.dropGroup && isGroup) return;

    // Buffer album/messages for a short window to ensure 1 ticket per batch
    bufferAdd(meta, cfg, state, log, chatId, ctx);

  } catch (err) {
    log.error('onMessage error', { err: String(err && err.stack ? err.stack : err) });
  }
}

function bufferAdd(meta, cfg, state, log, chatId, ctx) {
  const now = Date.now();

  if (!state.buffer[chatId]) {
    state.buffer[chatId] = {
      firstAt: now,
      lastAt: now,
      items: [],
      timer: null,
    };
  }

  const b = state.buffer[chatId];
  b.lastAt = now;

  // Capture minimal fields
  const text = safeText(ctx && ctx.text ? ctx.text : '');
  b.items.push({ ctx, text });

  if (cfg.traceLog) {
    log.info('buffer.add', {
      chatId,
      items: b.items.length,
      textLen: text.length,
    });
  }

  // Cap
  if (b.items.length >= cfg.albumMaxItems) {
    flushBuffer(meta, cfg, state, log, chatId);
    return;
  }

  // Reset timer
  if (b.timer) clearTimeout(b.timer);
  b.timer = setTimeout(() => {
    flushBuffer(meta, cfg, state, log, chatId);
  }, cfg.albumWindowMs);
}

function flushBuffer(meta, cfg, state, log, chatId) {
  const b = state.buffer[chatId];
  if (!b) return;

  if (b.timer) clearTimeout(b.timer);
  delete state.buffer[chatId];

  const items = b.items || [];
  if (!items.length) return;

  // Create 1 ticket for the whole batch
  const ticketId = SharedTicketCore.nextTicketId(meta, cfg.ticketPrefix);
  state.lastTicketByChat[chatId] = ticketId;

  if (cfg.traceLog) {
    log.info('buffer.flush', { chatId, ticketId, count: items.length });
  }

  // Build card for Control Group (ticket visible in group)
  const card = FallbackTicketCard.build(meta, {
    ticketId,
    chatId,
    firstAt: b.firstAt,
    lastAt: b.lastAt,
    items,
  });

  // Send to Control Group via safe outbound pipeline
  sendToControlGroup(meta, cfg, log, ticketId, card, items);
}

function sendToControlGroup(meta, cfg, log, ticketId, cardText, items) {
  const controlGroupId = cfg.controlGroupId;

  // 1) Send ticket card text
  SharedSafeSend.sendText(meta, {
    chatId: controlGroupId,
    text: cardText,
    reason: 'fallback.ticketCard',
    meta: { ticketId },
  });

  // 2) Forward media/doc if any (best-effort)
  for (const it of items) {
    const ctx = it.ctx;
    const msg = ctx && ctx.message ? ctx.message : null;
    if (!msg) continue;

    if (msg.hasMedia || msg.type === 'document' || msg.type === 'image' || msg.type === 'video' || msg.type === 'audio') {
      // Best-effort forwarding using raw forward if available, else safe send via pipeline (if supported)
      tryForward(meta, log, controlGroupId, msg, ticketId);
    }
  }
}

function tryForward(meta, log, toChatId, msg, ticketId) {
  try {
    const raw = meta && meta.services && meta.services.transport && meta.services.transport.raw;
    if (raw && typeof raw.forward === 'function') {
      raw.forward(toChatId, msg);
      return;
    }
  } catch (e) {
    // continue to fallback
  }

  // Fallback path: attempt download+reupload via transport if present
  try {
    const transport = meta && meta.services ? meta.services.transport : null;
    if (!transport) return;

    if (typeof transport.downloadMedia === 'function' && typeof transport.sendMedia === 'function') {
      const media = transport.downloadMedia(msg);
      if (media) {
        transport.sendMedia(toChatId, media, { caption: '', meta: { ticketId } });
      }
    }
  } catch (err) {
    log.error('forward failed', { ticketId, err: String(err && err.stack ? err.stack : err) });
  }
}

function safeText(s) {
  s = String(s || '');
  // ASCII-safe: strip non-ASCII
  return s.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '?');
}

function toInt(v, def, min, max) {
  const n = parseInt(String(v || ''), 10);
  if (!Number.isFinite(n)) return def;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

module.exports = { init };
