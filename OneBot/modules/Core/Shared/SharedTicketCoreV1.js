'use strict';

function cfgGetStr(cfg, key, defVal) {
  if (!cfg) return defVal;
  try {
    if (typeof cfg.getStr === 'function') return cfg.getStr(key, defVal);
  } catch (_) {}
  const v = cfg[key];
  if (v === undefined || v === null || v === '') return defVal;
  return String(v);
}

function parseJsonStoreSpec(spec) {
  if (!spec) return null;
  if (typeof spec !== 'string') return null;
  const s = spec.trim();
  if (!s) return null;
  if (!s.toLowerCase().startsWith('jsonstore:')) return null;
  const body = s.substring('jsonstore:'.length);
  const parts = body.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { ns: parts[0], key: parts.slice(1).join('/') };
}

function makeMemStore() {
  let doc = { tickets: {} };
  return {
    async load() {
      return doc;
    },
    async save(newDoc) {
      doc = newDoc && typeof newDoc === 'object' ? newDoc : { tickets: {} };
      if (!doc.tickets || typeof doc.tickets !== 'object') doc.tickets = {};
    }
  };
}

function makeJsonStore(meta, spec) {
  const js = meta && meta.getService ? meta.getService('jsonstore') : null;
  if (!js || !spec) return makeMemStore();
  const nsStore = js.open(spec.ns);
  return {
    async load() {
      const v = await nsStore.get(spec.key);
      if (!v || typeof v !== 'object') return { tickets: {} };
      if (!v.tickets || typeof v.tickets !== 'object') v.tickets = {};
      return v;
    },
    async save(newDoc) {
      const v = newDoc && typeof newDoc === 'object' ? newDoc : { tickets: {} };
      if (!v.tickets || typeof v.tickets !== 'object') v.tickets = {};
      await nsStore.set(spec.key, v);
    }
  };
}

async function createStore(meta, cfg) {
  const storeSpec = parseJsonStoreSpec(
    cfgGetStr(cfg, 'ticketStoreSpec', '') || cfgGetStr(cfg, 'storeSpec', '')
  );
  const store = storeSpec ? makeJsonStore(meta, storeSpec) : makeMemStore();
  const doc = await store.load();
  if (!doc || typeof doc !== 'object') return { store, doc: { tickets: {} } };
  if (!doc.tickets || typeof doc.tickets !== 'object') doc.tickets = {};
  return { store, doc };
}

function normalizeTicketType(ticketType) {
  if (!ticketType) return 'ticket';
  return String(ticketType).trim().toLowerCase();
}

async function touch(meta, cfg, ticketType, chatId, info) {
  const { store, doc } = await createStore(meta, cfg);

  const type = normalizeTicketType(ticketType);
  const key = type + ':' + String(chatId || '').trim();
  if (!chatId) return { ok: false, reason: 'missingChatId' };

  const now = Date.now();
  const fromName =
    info && (info.fromName || info.name) ? String(info.fromName || info.name) : '';
  const fromPhone =
    info && (info.fromPhone || info.phone) ? String(info.fromPhone || info.phone) : '';

  let t = doc.tickets[key];

  if (t) {
    t.updatedAt = now;
    if (fromName) t.fromName = fromName;
    if (fromPhone) t.fromPhone = fromPhone;
    await store.save(doc);
    return { ok: true, ticket: t };
  }

  const fs = require('fs');
  const path = require('path');

  const prefix = cfgGetStr(cfg, 'ticketPrefix', 'T');
  const seqDigits = parseInt(
    cfgGetStr(cfg, 'ticketSequenceDigits', '') ||
      cfgGetStr(cfg, 'sequenceDigits', '') ||
      '10',
    10
  ) || 10;

  const ym = new Date(now);
  const y = String(ym.getFullYear());
  const m = String(ym.getMonth() + 1).padStart(2, '0');
  const idPrefix = y + m + prefix;

  const seqFile =
    cfgGetStr(cfg, 'ticketSequenceFile', '') || cfgGetStr(cfg, 'sequenceFile', '');

  let seq = 1;

  if (seqFile) {
    try {
      const seqDir = path.dirname(seqFile);
      if (!fs.existsSync(seqDir)) fs.mkdirSync(seqDir, { recursive: true });

      let state = {};
      if (fs.existsSync(seqFile)) {
        try {
          state = JSON.parse(fs.readFileSync(seqFile, 'utf8')) || {};
        } catch (_) {
          state = {};
        }
      }

      const todayKey = idPrefix;
      const cur = state[todayKey] ? parseInt(state[todayKey], 10) : 0;
      seq = (cur || 0) + 1;
      state[todayKey] = seq;

      fs.writeFileSync(seqFile, JSON.stringify(state, null, 2), 'utf8');
    } catch (_) {
      // fallback to seq=1
      seq = 1;
    }
  }

  const seqStr = String(seq).padStart(seqDigits, '0');
  const ticketId = idPrefix + seqStr;

  t = {
    id: ticketId,
    type,
    chatId: String(chatId),
    status: 'open',
    createdAt: now,
    updatedAt: now,
    fromName: fromName || '',
    fromPhone: fromPhone || ''
  };

  doc.tickets[key] = t;
  await store.save(doc);

  return { ok: true, ticket: t };
}

async function resolve(meta, cfg, ticketType, ticketId, payload) {
  const { store, doc } = await createStore(meta, cfg);

  const type = normalizeTicketType(ticketType);
  const id = String(ticketId || '').trim();
  if (!id) return { ok: false, reason: 'missingTicketId' };

  const tickets = doc.tickets || {};
  for (const k of Object.keys(tickets)) {
    const t = tickets[k];
    if (!t || !t.id) continue;
    if (t.id === id && t.type === type) {
      t.updatedAt = Date.now();
      await store.save(doc);
      return { ok: true, ticket: t, payload: payload || {} };
    }
  }

  return { ok: false, reason: 'notFound' };
}

async function setStatus(meta, cfg, ticketType, ticketId, status) {
  const res = await resolve(meta, cfg, ticketType, ticketId, {});
  if (!res.ok) return res;
  const { store, doc } = await createStore(meta, cfg);

  const t = res.ticket;
  t.status = String(status || '').trim() || t.status;
  t.updatedAt = Date.now();

  // update by key
  const type = normalizeTicketType(ticketType);
  const key = type + ':' + String(t.chatId || '').trim();
  if (doc.tickets && doc.tickets[key]) doc.tickets[key] = t;

  await store.save(doc);
  return { ok: true, ticket: t };
}

async function list(meta, cfg, ticketType, status) {
  const { doc } = await createStore(meta, cfg);

  const type = normalizeTicketType(ticketType);
  const st = status ? String(status).trim() : '';
  const out = [];

  const tickets = doc.tickets || {};
  for (const k of Object.keys(tickets)) {
    const t = tickets[k];
    if (!t || t.type !== type) continue;
    if (st && t.status !== st) continue;
    out.push(t);
  }

  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { ok: true, tickets: out };
}

async function get(meta, cfg, ticketType, ticketId, payload) {
  return resolve(meta, cfg, ticketType, ticketId, payload);
}

module.exports = {
  touch,
  resolve,
  setStatus,
  list,
  get
};
