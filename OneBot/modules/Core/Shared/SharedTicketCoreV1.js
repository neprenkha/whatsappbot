'use strict';

/**
 * SharedTicketCoreV1
 * - Ticket store berasaskan jsonstore (atau memori jika jsonstore tiada)
 * - Format tiket: YYYYMMT########## (counter global, 10 digit, auto-increment)
 * - Reuse tiket per chat selagi status bukan "closed"
 * - Simpan medan asas: chatId, fromName, fromPhone, status, seq, lastAt, lastCustomerAt, lastStaffAt, note
 */

const path = require('path');

function parseJsonStoreSpec(spec) {
  const s = String(spec || '').trim();
  if (!s.toLowerCase().startsWith('jsonstore:')) return null;
  const rest = s.substring('jsonstore:'.length).trim(); // e.g. Fallback/tickets
  if (!rest) return null;
  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const ns = parts.shift();
  const key = parts.join('/'); // allow nested path like tickets/state.json
  return { ns, key };
}

function makeMemStore() {
  let doc = { counter: 1, byChat: {}, tickets: {} };
  return {
    async load() { return doc; },
    async save(next) { doc = next; return true; }
  };
}

function makeJsonStore(meta, spec) {
  const svc = meta.getService ? meta.getService('jsonstore') : null;
  if (!svc || typeof svc.open !== 'function') return makeMemStore();
  const nsStore = svc.open(spec.ns);
  return {
    async load() {
      const v = await nsStore.get(spec.key, null);
      if (!v || typeof v !== 'object') return { counter: 1, byChat: {}, tickets: {} };
      if (typeof v.counter !== 'number') v.counter = 1;
      if (!v.byChat || typeof v.byChat !== 'object') v.byChat = {};
      if (!v.tickets || typeof v.tickets !== 'object') v.tickets = {};
      return v;
    },
    async save(next) {
      await nsStore.set(spec.key, next);
      return true;
    }
  };
}

function normalizeChatId(v) {
  return String(v || '').trim();
}

function generateTicket(doc) {
  const now = new Date();
  const y = now.getFullYear().toString();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `${y}${m}`;
  const counter = doc.counter || 1;
  const ticket = `${prefix}T${String(counter).padStart(10, '0')}`;
  doc.counter = counter + 1;
  return ticket;
}

async function loadDoc(store) {
  return await store.load();
}

async function saveDoc(store, doc) {
  await store.save(doc);
}

async function touch(meta, cfg, ticketType, chatId, info, opts = {}) {
  const spec = parseJsonStoreSpec(cfg.ticketStoreSpec || cfg.storeSpec);
  const store = spec ? makeJsonStore(meta, spec) : makeMemStore();
  const doc = await loadDoc(store);

  const cid = normalizeChatId(chatId);
  if (!cid) return { ok: false, reason: 'nochat' };

  const now = Date.now();
  let ticketId = doc.byChat[cid];

  // Reuse ticket jika belum closed
  if (ticketId) {
    const t = doc.tickets[ticketId];
    if (t && t.status !== 'closed') {
      t.seq = (t.seq || 1) + 1;
      t.lastAt = now;
      t.lastCustomerAt = now;
      t.fromName = info && info.fromName || t.fromName || '';
      t.fromPhone = info && info.fromPhone || t.fromPhone || '';
      doc.tickets[ticketId] = t;
      await saveDoc(store, doc);
      return { ok: true, ticket: ticketId, seq: t.seq, status: t.status };
    }
  }

  // Baru: cipta ticket
  ticketId = generateTicket(doc);
  const rec = {
    ticket: ticketId,
    chatId: cid,
    type: ticketType || 'fallback',
    status: 'open',
    seq: 1,
    createdAt: now,
    lastAt: now,
    lastCustomerAt: now,
    lastStaffAt: 0,
    fromName: info && info.fromName || '',
    fromPhone: info && info.fromPhone || '',
    note: info && info.note || ''
  };
  doc.byChat[cid] = ticketId;
  doc.tickets[ticketId] = rec;
  await saveDoc(store, doc);
  return { ok: true, ticket: ticketId, seq: 1, status: 'open' };
}

async function resolve(meta, cfg, ticketType, ticket, opts = {}) {
  const spec = parseJsonStoreSpec(cfg.ticketStoreSpec || cfg.storeSpec);
  const store = spec ? makeJsonStore(meta, spec) : makeMemStore();
  const doc = await loadDoc(store);

  const t = doc.tickets[String(ticket || '').trim()];
  if (!t) return { ok: false, reason: 'notfound' };
  // Optional: check ticketType if provided
  if (ticketType && t.type && t.type !== ticketType) {
    return { ok: false, reason: 'wrongtype' };
  }
  return { ok: true, ...t };
}

// Backward-compat: alias get -> resolve
async function get(meta, cfg, ticket, opts = {}) {
  const ticketType = opts.ticketType || opts.type || null;
  return resolve(meta, cfg, ticketType, ticket, opts);
}

async function setStatus(meta, cfg, ticket, status, payload = {}) {
  const spec = parseJsonStoreSpec(cfg.ticketStoreSpec || cfg.storeSpec);
  const store = spec ? makeJsonStore(meta, spec) : makeMemStore();
  const doc = await loadDoc(store);

  const id = String(ticket || '').trim();
  const t = doc.tickets[id];
  if (!t) return { ok: false, reason: 'notfound' };

  t.status = status || t.status || 'open';
  if (payload.staffAt) t.lastStaffAt = payload.staffAt;
  if (payload.customerAt) t.lastCustomerAt = payload.customerAt;
  if (payload.note !== undefined) t.note = payload.note;

  doc.tickets[id] = t;
  await saveDoc(store, doc);
  return { ok: true };
}

async function updateNote(meta, cfg, ticket, note) {
  return setStatus(meta, cfg, ticket, undefined, { note });
}

async function list(meta, cfg, statusFilter = null) {
  const spec = parseJsonStoreSpec(cfg.ticketStoreSpec || cfg.storeSpec);
  const store = spec ? makeJsonStore(meta, spec) : makeMemStore();
  const doc = await loadDoc(store);
  const arr = Object.values(doc.tickets || {});
  if (statusFilter) {
    return arr.filter(t => String(t.status || '').toLowerCase() === String(statusFilter).toLowerCase());
  }
  return arr;
}

module.exports = {
  touch,
  resolve,
  get,          // new alias for compatibility
  setStatus,
  updateNote,
  list,
};