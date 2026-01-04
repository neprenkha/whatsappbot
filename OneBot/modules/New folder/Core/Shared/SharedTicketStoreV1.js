'use strict';

// SharedTicketStoreV1
// Purpose: minimal ticket state persistence using JsonStore service (no listeners).
// Storage layout: JsonStore/<ns>/<key>.json

function safeStr(v) {
  return String(v || '').trim();
}

function parseKeyPart(p) {
  const s = safeStr(p);
  if (!s) return '';
  // strip .json
  return s.toLowerCase().endsWith('.json') ? s.slice(0, -5) : s;
}

function parseJsonStoreSpec(spec, fallbackNs, fallbackKey) {
  const s = safeStr(spec);
  if (!s || !s.toLowerCase().startsWith('jsonstore:')) {
    return { ns: safeStr(fallbackNs), key: safeStr(fallbackKey) };
  }
  const rest = s.slice('jsonstore:'.length).trim();
  const parts = rest.split('/').filter(Boolean);
  const ns = safeStr(parts[0] || fallbackNs);
  const key = parseKeyPart(parts[1] || fallbackKey);
  return { ns, key };
}

function pickJsonStore(meta, preferredName) {
  const tryNames = [];
  if (preferredName) tryNames.push(String(preferredName));
  tryNames.push('jsonstore', 'JsonStore');
  for (const n of tryNames) {
    const svc = meta.getService(n);
    if (svc && typeof svc.open === 'function') return svc;
  }
  return null;
}

async function load(meta, cfg, storeSpec, defaults) {
  const jsonstore = pickJsonStore(meta, cfg && cfg.jsonStoreService);
  if (!jsonstore) return defaults || {};

  const parsed = parseJsonStoreSpec(storeSpec, 'Tickets', 'fallback');
  const ns = parsed.ns || 'Tickets';
  const key = parsed.key || 'fallback';

  const st = jsonstore.open(ns);
  const obj = await st.get(key);
  if (obj && typeof obj === 'object') return obj;

  const initObj = (defaults && typeof defaults === 'object') ? defaults : {};
  await st.set(key, initObj);
  return initObj;
}

async function save(meta, cfg, storeSpec, obj) {
  const jsonstore = pickJsonStore(meta, cfg && cfg.jsonStoreService);
  if (!jsonstore) return;

  const parsed = parseJsonStoreSpec(storeSpec, 'Tickets', 'fallback');
  const ns = parsed.ns || 'Tickets';
  const key = parsed.key || 'fallback';

  const st = jsonstore.open(ns);
  await st.set(key, obj && typeof obj === 'object' ? obj : {});
}

module.exports = {
  parseJsonStoreSpec,
  load,
  save,
};
