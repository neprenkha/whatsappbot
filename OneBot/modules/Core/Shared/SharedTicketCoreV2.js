'use strict';

function cfgStr(cfg, key, defVal) {
  if (!cfg) return defVal;
  const v = cfg[key];
  if (v === undefined || v === null) return defVal;
  const s = String(v).trim();
  return s.length ? s : defVal;
}

function cfgInt(cfg, key, defVal) {
  const s = cfgStr(cfg, key, '');
  if (!s) return defVal;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : defVal;
}

function nowMs() {
  return Date.now();
}

function padLeft(s, n, ch) {
  const t = String(s);
  if (t.length >= n) return t;
  return (String(ch || '0').repeat(n - t.length)) + t;
}

function yymmFromMs(ms) {
  const d = new Date(ms);
  const yy = padLeft(d.getFullYear() % 100, 2, '0');
  const mm = padLeft(d.getMonth() + 1, 2, '0');
  return yy + mm;
}

function makeTicket(yymm, seq, seqDigits) {
  return yymm + 'T' + padLeft(seq, seqDigits, '0');
}

function parseStoreSpec(spec) {
  const raw = String(spec || '').trim();
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const svc = raw.slice(0, idx).trim();
  const rel = raw.slice(idx + 1).trim();
  if (!svc || !rel) return null;

  const parts = rel.split('/').filter(Boolean);
  if (parts.length < 2) return null;

  const ns = parts[0];
  const file = parts.slice(1).join('/');
  const key = file.toLowerCase().endsWith('.json') ? file.slice(0, -5) : file;
  return { svc, rel, ns, key };
}

function getService(meta, name) {
  if (!meta) return null;
  if (typeof meta.getService === 'function') {
    const s = meta.getService(name);
    if (s) return s;
  }
  if (meta.services && meta.services[name]) return meta.services[name];
  return null;
}

function getJsonStore(meta, tried) {
  const names = ['jsonstore', 'jsonStore'];
  for (const n of names) {
    tried.push(n);
    const s = getService(meta, n);
    if (s) return s;
  }
  return null;
}

async function storeRead(store, spec, defaultDoc) {
  if (store && typeof store.load === 'function') {
    return await store.load(spec.svc, spec.rel, defaultDoc);
  }
  if (store && typeof store.open === 'function') {
    const nsStore = store.open(spec.ns);
    if (nsStore && typeof nsStore.get === 'function') {
      return await nsStore.get(spec.key, defaultDoc);
    }
  }
  return null;
}

async function storeWrite(store, spec, doc) {
  if (store && typeof store.save === 'function') {
    await store.save(spec.svc, spec.rel, doc);
    return true;
  }
  if (store && typeof store.open === 'function') {
    const nsStore = store.open(spec.ns);
    if (nsStore && typeof nsStore.set === 'function') {
      await nsStore.set(spec.key, doc);
      return true;
    }
  }
  return false;
}

async function loadDoc(meta, cfg) {
  const storeSpec = cfgStr(cfg, 'ticketStoreSpec', '');
  if (!storeSpec) {
    return { ok: false, reason: 'missing.ticketStoreSpec' };
  }

  const parsed = parseStoreSpec(storeSpec);
  if (!parsed) {
    return { ok: false, reason: 'bad.ticketStoreSpec' };
  }

  const tried = [];
  const store = getJsonStore(meta, tried);
  if (!store) {
    if (meta && typeof meta.log === 'function') {
      meta.log('SharedTicketCoreV2', 'bug.missing.jsonstore tried=' + tried.join(','));
    }
    return { ok: false, reason: 'missing.jsonstore' };
  }

  const defaultDoc = { yymm: '', seq: 0, map: {} };
  const doc = await storeRead(store, parsed, defaultDoc);
  if (!doc || typeof doc !== 'object') {
    return { ok: false, reason: 'bad.store.doc' };
  }

  if (!doc.map || typeof doc.map !== 'object') doc.map = {};
  if (typeof doc.seq !== 'number') doc.seq = 0;
  if (typeof doc.yymm !== 'string') doc.yymm = '';

  return { ok: true, store, spec: parsed, doc };
}

async function saveDoc(meta, state) {
  const ok = await storeWrite(state.store, state.spec, state.doc);
  if (!ok) {
    if (meta && typeof meta.log === 'function') {
      meta.log('SharedTicketCoreV2', 'bug.missing.jsonstore tried=jsonstore,jsonStore');
    }
    return { ok: false, reason: 'missing.jsonstore' };
  }
  return { ok: true };
}

async function next(meta, cfg) {
  const state = await loadDoc(meta, cfg);
  if (!state.ok) return state;

  const seqDigits = cfgInt(cfg, 'ticketSeqDigits', 7);
  const yymm = yymmFromMs(nowMs());

  if (state.doc.yymm !== yymm) {
    state.doc.yymm = yymm;
    state.doc.seq = 0;
  }

  state.doc.seq = (state.doc.seq || 0) + 1;
  const ticketId = makeTicket(yymm, state.doc.seq, seqDigits);

  await saveDoc(meta, state);
  return { ok: true, ticketId };
}

function makeKey(chatId, authorId) {
  return String(chatId || '') + '|' + String(authorId || '');
}

async function resolve(meta, cfg, chatId, authorId, ttlMs) {
  const state = await loadDoc(meta, cfg);
  if (!state.ok) return state;

  const key = makeKey(chatId, authorId);
  const now = nowMs();
  const ttl = Number.isFinite(ttlMs) ? ttlMs : 0;

  const rec = state.doc.map[key];
  if (rec && rec.ticketId && rec.at && (ttl <= 0 || (now - rec.at) <= ttl)) {
    return { ok: true, ticketId: rec.ticketId, hit: 1 };
  }

  const r = await next(meta, cfg);
  if (!r.ok) return r;

  state.doc.map[key] = { ticketId: r.ticketId, at: now, status: 'open' };
  await saveDoc(meta, state);

  return { ok: true, ticketId: r.ticketId, hit: 0 };
}

async function touch(meta, cfg, chatId, authorId, ticketId) {
  const state = await loadDoc(meta, cfg);
  if (!state.ok) return state;

  const key = makeKey(chatId, authorId);
  const now = nowMs();

  const rec = state.doc.map[key] || {};
  rec.ticketId = ticketId || rec.ticketId || '';
  rec.at = now;
  if (!rec.status) rec.status = 'open';
  state.doc.map[key] = rec;

  await saveDoc(meta, state);
  return { ok: true };
}

async function get(meta, cfg, chatId, authorId) {
  const state = await loadDoc(meta, cfg);
  if (!state.ok) return state;

  const key = makeKey(chatId, authorId);
  const rec = state.doc.map[key];
  if (!rec) return { ok: true, found: 0 };

  return { ok: true, found: 1, ticketId: rec.ticketId || '', at: rec.at || 0, status: rec.status || 'open' };
}

async function setStatus(meta, cfg, chatId, authorId, status) {
  const state = await loadDoc(meta, cfg);
  if (!state.ok) return state;

  const key = makeKey(chatId, authorId);
  const rec = state.doc.map[key];
  if (!rec) return { ok: true, found: 0 };

  rec.status = String(status || 'open');
  rec.at = nowMs();
  state.doc.map[key] = rec;

  await saveDoc(meta, state);
  return { ok: true, found: 1 };
}

async function list(meta, cfg, limit) {
  const state = await loadDoc(meta, cfg);
  if (!state.ok) return state;

  const out = [];
  const lim = Number.isFinite(limit) ? limit : 50;
  const keys = Object.keys(state.doc.map || {});
  for (let i = 0; i < keys.length && out.length < lim; i++) {
    const k = keys[i];
    const rec = state.doc.map[k];
    out.push({ key: k, ticketId: rec && rec.ticketId ? rec.ticketId : '', at: rec && rec.at ? rec.at : 0, status: rec && rec.status ? rec.status : 'open' });
  }

  return { ok: true, items: out };
}

/*
  Compatibility aliases (older Fallback implementations):
  - initOrLoad(meta,cfg)
  - initTicketCore(meta,cfg)
  These should not be required by new code, but exist to prevent boot crashes.
*/
async function initOrLoad(meta, cfg) {
  await loadDoc(meta, cfg);
  return { ok: true };
}

async function initTicketCore(meta, cfg) {
  return await initOrLoad(meta, cfg);
}

module.exports = {
  initOrLoad,
  initTicketCore,
  next,
  resolve,
  touch,
  get,
  setStatus,
  list,
};
