'use strict';

// SharedTicketCoreV1
// Purpose: shared ticket id + state management (no listeners).
// TicketId format: YYYYMMT########## (10-digit sequence per YYYYMM).

const TicketStore = require('./SharedTicketStoreV1');

function nowMs() {
  return Date.now();
}

function safeStr(v) {
  return String(v || '').trim();
}

function pad10(n) {
  const s = String(Math.max(0, Number(n) || 0));
  return s.padStart(10, '0');
}

function ymFromMs(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}${m}`;
}

function ensureDoc(doc) {
  const x = doc && typeof doc === 'object' ? doc : {};
  if (!x.meta || typeof x.meta !== 'object') x.meta = {};
  if (!x.openByChatId || typeof x.openByChatId !== 'object') x.openByChatId = {};
  if (!x.lastByChatId || typeof x.lastByChatId !== 'object') x.lastByChatId = {};
  if (!x.byTicket || typeof x.byTicket !== 'object') x.byTicket = {};
  return x;
}

function makeTicketId(doc, ms) {
  const ym = ymFromMs(ms);
  if (doc.meta.ym !== ym) {
    doc.meta.ym = ym;
    doc.meta.seq = 0;
  }
  doc.meta.seq = (Number(doc.meta.seq) || 0) + 1;
  return `${ym}T${pad10(doc.meta.seq)}`;
}

function isOpen(rec) {
  return rec && rec.status !== 'closed';
}

function normalizeInfo(info) {
  const x = info && typeof info === 'object' ? info : {};
  return {
    fromName: safeStr(x.fromName),
    fromPhone: safeStr(x.fromPhone),
    fromChatId: safeStr(x.fromChatId),
    text: safeStr(x.text),
    attachCount: Number(x.attachCount) || 0,
    attachTypes: safeStr(x.attachTypes),
  };
}

async function touch(meta, cfg, ticketType, chatId, info, opts) {
  const type = safeStr(ticketType) || 'fallback';
  const cid = safeStr(chatId);
  if (!cid) return null;

  const storeSpec = (opts && opts.storeSpec) || (cfg && (cfg.ticketStoreSpec || cfg.ticketStore)) || `jsonstore:Tickets/${type}.json`;
  const reuseWindowSec = Number((opts && opts.reuseWindowSec) || (cfg && cfg.reuseWindowSec) || 1800);

  const ms = nowMs();
  const doc = ensureDoc(await TicketStore.load(meta, cfg, storeSpec, null));

  const existingTicket = safeStr(doc.openByChatId[cid]);
  const infoN = normalizeInfo(info);

  let ticket = existingTicket;
  let isNew = false;

  if (ticket && doc.byTicket && doc.byTicket[ticket] && isOpen(doc.byTicket[ticket])) {
    const last = Number(doc.byTicket[ticket].lastAt) || 0;
    const within = reuseWindowSec > 0 ? (ms - last) <= (reuseWindowSec * 1000) : true;

    if (!within) {
      // auto close old ticket and open new one
      doc.byTicket[ticket].status = 'closed';
      delete doc.openByChatId[cid];
      ticket = '';
    }
  } else {
    ticket = '';
  }

  if (!ticket) {
    ticket = makeTicketId(doc, ms);
    isNew = true;
    doc.openByChatId[cid] = ticket;
    doc.byTicket[ticket] = {
      ticket,
      type,
      chatId: cid,
      status: 'open',
      createdAt: ms,
      lastAt: ms,
      seq: 0,
      fromName: infoN.fromName,
      fromPhone: infoN.fromPhone,
      fromChatId: infoN.fromChatId,
    };
  }

  const rec = doc.byTicket[ticket];
  rec.lastAt = ms;
  rec.seq = (Number(rec.seq) || 0) + 1;

  if (infoN.fromName) rec.fromName = infoN.fromName;
  if (infoN.fromPhone) rec.fromPhone = infoN.fromPhone;
  if (infoN.fromChatId) rec.fromChatId = infoN.fromChatId;

  rec.lastText = infoN.text;
  rec.lastAttachCount = infoN.attachCount;
  rec.lastAttachTypes = infoN.attachTypes;

  doc.lastByChatId[cid] = {
    ticket,
    lastAt: rec.lastAt,
    seq: rec.seq,
  };

  doc.meta.updatedAt = ms;

  await TicketStore.save(meta, cfg, storeSpec, doc);

  return {
    ticket,
    isNew,
    seq: rec.seq,
    lastAt: rec.lastAt,
    info: rec,
    storeSpec,
  };
}

async function resolve(meta, cfg, ticketType, ticketId, opts) {
  const type = safeStr(ticketType) || 'fallback';
  const ticket = safeStr(ticketId);
  if (!ticket) return null;

  const storeSpec = (opts && opts.storeSpec) || (cfg && (cfg.ticketStoreSpec || cfg.ticketStore)) || `jsonstore:Tickets/${type}.json`;
  const doc = ensureDoc(await TicketStore.load(meta, cfg, storeSpec, null));

  const rec = doc.byTicket && doc.byTicket[ticket];
  if (!rec) return null;

  return {
    ticket,
    chatId: safeStr(rec.chatId),
    status: safeStr(rec.status),
    seq: Number(rec.seq) || 0,
    info: rec,
    storeSpec,
  };
}

module.exports = {
  touch,
  resolve,
};
