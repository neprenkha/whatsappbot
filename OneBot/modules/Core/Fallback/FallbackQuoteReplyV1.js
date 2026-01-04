'use strict';

/**
 * FallbackQuoteReplyV1.js
 * Control Group quote-reply to customer (text + media), with album collector.
 * - ASCII-only logs
 * - Primary workflow: quote-reply to Ticket Card
 * - Backup: !r <ticket> <text> (handled by FallbackCommandReplyV1)
 */

const TicketCore = require('../Shared/SharedTicketCoreV1');
const SafeSend = require('../Shared/SharedSafeSendV1');

const TICKET_RE = /\b\d{6}T\d{8,14}\b/;

// Hint anti-spam: key -> lastAt
const hintSeen = new Map();

// Album collector: key -> { ticket, destChatId, items, timer, startedAt }
const collectors = new Map();

function safeStr(v) { return String(v || '').trim(); }

function toBool(v, dflt) {
  if (v === undefined || v === null || v === '') return !!dflt;
  const s = String(v).trim().toLowerCase();
  if (['1','true','yes','y','on'].includes(s)) return true;
  if (['0','false','no','n','off'].includes(s)) return false;
  return !!dflt;
}

function nowMs() { return Date.now(); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeLogger(meta, cfg) {
  const dbg = cfg && cfg.debugLog !== undefined ? !!cfg.debugLog : true;
  const trc = cfg && cfg.traceLog !== undefined ? !!cfg.traceLog : true;

  const log = (tag, msg) => { try { meta && meta.log && meta.log(tag, msg); } catch (_) {} };

  return {
    info: (msg) => log('FallbackQuoteReply', msg),
    debug: (msg) => { if (dbg) log('FallbackQuoteReply', `debug ${msg}`); },
    trace: (msg) => { if (trc) log('FallbackQuoteReply', `trace ${msg}`); },
  };
}

function getSenderKey(ctx) {
  const s = ctx && ctx.sender ? ctx.sender : null;
  if (s && s.id) return String(s.id);
  if (s && s.phone) return String(s.phone);
  const raw = ctx && ctx.raw ? ctx.raw : null;
  const a = raw && (raw.author || (raw._data && raw._data.author));
  if (a) return String(a);
  return 'unknown';
}

function stripTicketFromText(text, ticket) {
  let s = String(text || '').trim();
  const t = safeStr(ticket);
  if (!s) return '';
  if (!t) return s;

  const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
  s = s.replace(re, '').trim();

  // clean common prefixes
  s = s.replace(/^ticket\s*[:#-]?\s*/i, '').trim();
  return s;
}

function extractTicket(quotedText, typedText) {
  const q = safeStr(quotedText);
  const t = safeStr(typedText);

  const qm = q.match(TICKET_RE);
  if (qm && qm[0]) return qm[0].toUpperCase();

  const tm = t.match(TICKET_RE);
  if (tm && tm[0]) return tm[0].toUpperCase();

  return '';
}

async function extractQuotedText(ctx) {
  // 1) Kernel-wrapped quotedMessage (if exists)
  try {
    const m = ctx && ctx.message ? ctx.message : null;
    const q = m && m.quotedMessage ? m.quotedMessage : null;
    if (q) {
      const t = safeStr(q.body || q.text || q.caption || '');
      if (t) return t;
    }
  } catch (_) {}

  // 2) WhatsApp Web raw message API: hasQuotedMsg + getQuotedMessage()
  try {
    const raw = ctx && ctx.raw ? ctx.raw : null;
    if (raw && raw.hasQuotedMsg && typeof raw.getQuotedMessage === 'function') {
      const qmsg = await raw.getQuotedMessage();
      if (qmsg) {
        const t = safeStr(
          qmsg.body ||
          qmsg.caption ||
          (qmsg._data && (qmsg._data.body || qmsg._data.caption)) ||
          ''
        );
        if (t) return t;
      }
    }
  } catch (_) {}

  return '';
}

function pickOutbox(meta) {
  if (!meta || !meta.getService) return null;
  const ob = meta.getService('outbox');
  if (ob && typeof ob.enqueue === 'function') return ob;
  return null;
}

function pickSendFn(meta, preferCsv) {
  const prefers = safeStr(preferCsv || 'outsend,sendout,send');
  const picks = SafeSend.pickSend(meta, prefers);
  if (picks && picks.length > 0) return picks[0].fn;
  return null;
}

async function sendToCustomer(meta, cfg, logger, destChatId, content, options) {
  // Prefer Outbox (single pipeline, supports objects)
  const ob = pickOutbox(meta);
  if (ob) {
    await ob.enqueue(destChatId, content, options || {});
    return { ok: true, via: 'outbox' };
  }

  // Fallback: direct send function (if any)
  const fn = pickSendFn(meta, (cfg && cfg.sendPrefer) || 'outsend,sendout,send');
  if (typeof fn !== 'function') return { ok: false, reason: 'nosend' };

  await fn(destChatId, content, options || {});
  return { ok: true, via: 'sendfn' };
}

async function maybeHint(meta, cfg, logger, ctx) {
  const groupId = safeStr(ctx && ctx.chatId);
  const senderKey = getSenderKey(ctx);
  const key = `${groupId}|${senderKey}`;

  const typedText = safeStr(ctx && (ctx.text || ctx.body || ''));
  if (!typedText) return;

  // do not hint for commands
  if (typedText.startsWith('!')) return;

  const last = hintSeen.get(key) || 0;
  if (nowMs() - last < 15000) return; // 15s anti-spam
  hintSeen.set(key, nowMs());

  const sendServiceName = safeStr((cfg && cfg.sendService) || 'send') || 'send';
  const send = meta && meta.getService ? meta.getService(sendServiceName) : null;
  if (typeof send !== 'function') return;

  const msg =
    'No ticket detected. Please quote-reply to the Ticket Card, or use !r <ticket> <text>.';

  try {
    await send(groupId, msg, { type: 'text' });
  } catch (_) {}
}

async function flushCollector(meta, cfg, logger, key) {
  const st = collectors.get(key);
  if (!st) return;
  collectors.delete(key);

  const items = st.items || [];
  logger.trace(`album flush ticket=${st.ticket} dest=${st.destChatId} items=${items.length}`);

  const paceMs = parseInt((cfg && cfg.mediaSendDelayMs) || '0', 10) || 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const opts = it.caption ? { type: 'media', caption: it.caption } : { type: 'media' };
    await sendToCustomer(meta, cfg, logger, st.destChatId, it.media, opts);
    if (paceMs > 0 && i < items.length - 1) await sleep(paceMs);
  }
}

async function handle(meta, cfg, ctx, opts = {}) {
  const logger = makeLogger(meta, cfg);

  if (!ctx || !ctx.isGroup) return { ok: false, reason: 'notgroup' };

  const controlGroupId = safeStr(cfg && cfg.controlGroupId);
  const groupId = safeStr(ctx.chatId);
  if (controlGroupId && groupId !== controlGroupId) return { ok: false, reason: 'wronggroup' };

  if (ctx.fromMe) return { ok: false, reason: 'fromme' };

  const raw = ctx.raw || null;
  // Enhanced media detection for all types
  const hasMedia = !!(raw && (raw.hasMedia || raw.hasDocument || 
                              (raw.type && ['image', 'video', 'audio', 'document', 'ptt', 'sticker'].includes(raw.type))));
  const typedText = safeStr(ctx.text || ctx.body || '');

  const ticketType = safeStr(cfg && cfg.ticketType) || 'T';
  const hideTicket = opts.hideTicket !== undefined ? !!opts.hideTicket : true;

  const senderKey = getSenderKey(ctx);
  const collectorKey = `${groupId}|${senderKey}`;

  // Try extract from quoted text
  const quotedText = await extractQuotedText(ctx);

  // Ticket detection from quote or typed text
  let ticket = extractTicket(quotedText, typedText);

  // Album continuation: if media and no ticket, attach to active collector
  const albumEnabled = toBool(cfg && cfg.albumCollectEnabled, true);
  const windowMs = parseInt((cfg && cfg.albumCollectWindowMs) || '2500', 10) || 2500;
  const maxItems = parseInt((cfg && cfg.albumCollectMaxItems) || '12', 10) || 12;

  if (hasMedia && !ticket && albumEnabled) {
    const st = collectors.get(collectorKey);
    if (st && st.ticket && st.destChatId) {
      ticket = st.ticket;
      logger.trace(`album continue ticket=${ticket}`);
    }
  }

  logger.trace(`ticket detect quoted=${quotedText ? 1 : 0} ticket=${ticket || '-'}`);

  if (!ticket) {
    await maybeHint(meta, cfg, logger, ctx);
    return { ok: false, reason: 'no_ticket' };
  }

  // Resolve ticket -> customer chatId
  const resolved = await TicketCore.resolve(meta, cfg, ticketType, ticket);
  if (!resolved || resolved.ok !== true || !resolved.chatId) {
    logger.debug(`resolve failed ticket=${ticket} reason=${resolved && resolved.reason ? resolved.reason : 'unknown'}`);
    return { ok: false, reason: 'notfound' };
  }
  const destChatId = String(resolved.chatId);

  // TEXT reply
  if (!hasMedia) {
    const clean = stripTicketFromText(typedText, ticket);
    const outText = hideTicket ? clean : (clean ? `Ticket: ${ticket}\n${clean}` : `Ticket: ${ticket}`);
    if (!outText) return { ok: false, reason: 'empty' };

    const r = await sendToCustomer(meta, cfg, logger, destChatId, outText, { type: 'text' });
    return { ok: r.ok, ticket, chatId: destChatId, via: r.via || '' };
  }

  // MEDIA reply
  if (!raw || typeof raw.downloadMedia !== 'function') {
    logger.debug(`media api missing ticket=${ticket}`);
    return { ok: false, reason: 'nomediaapi' };
  }

  let media = null;
  try {
    media = await raw.downloadMedia();
  } catch (e) {
    logger.debug(`downloadMedia failed ticket=${ticket} err=${e && e.message ? e.message : e}`);
    return { ok: false, reason: 'downloadfail' };
  }
  if (!media) return { ok: false, reason: 'nomedia' };

  const clean = stripTicketFromText(typedText, ticket);
  const caption = hideTicket ? clean : (clean ? `Ticket: ${ticket}\n${clean}` : `Ticket: ${ticket}`);

  if (albumEnabled) {
    const st = collectors.get(collectorKey);
    if (st && st.ticket === ticket) {
      if (st.items.length < maxItems) {
        // caption only on first item
        st.items.push({ media, caption: '' });
      }
      if (st.timer) clearTimeout(st.timer);
      st.timer = setTimeout(() => { flushCollector(meta, cfg, logger, collectorKey).catch(() => {}); }, windowMs);
      collectors.set(collectorKey, st);
      logger.trace(`album add ticket=${ticket} items=${st.items.length}`);
      return { ok: true, ticket, chatId: destChatId, queued: true, album: true };
    }

    const timer = setTimeout(() => { flushCollector(meta, cfg, logger, collectorKey).catch(() => {}); }, windowMs);
    collectors.set(collectorKey, {
      ticket,
      destChatId,
      items: [{ media, caption: caption || '' }],
      timer,
      startedAt: nowMs(),
    });
    logger.trace(`album start ticket=${ticket} windowMs=${windowMs}`);
    return { ok: true, ticket, chatId: destChatId, queued: true, album: true };
  }

  await sendToCustomer(meta, cfg, logger, destChatId, media, caption ? { type: 'media', caption } : { type: 'media' });
  return { ok: true, ticket, chatId: destChatId };
}

module.exports = { handle };
