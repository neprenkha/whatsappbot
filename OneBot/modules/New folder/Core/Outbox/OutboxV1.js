/**
 * OutboxV1.js
 * Persistent outbox queue (optional) for delayed outbound sending.
 *
 * This module MUST NEVER crash the bot on missing config.
 */
'use strict';

function toBool(v, dflt) {
  if (v === undefined || v === null || v === '') return !!dflt;
  const s = String(v).trim().toLowerCase();
  if (['1','true','yes','y','on'].includes(s)) return true;
  if (['0','false','no','n','off'].includes(s)) return false;
  return !!dflt;
}

function toInt(v, dflt) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : dflt;
}

function splitCsv(v) {
  return String(v || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function parseJsonStoreSpec(spec) {
  // Expected: jsonstore:Namespace/file.json
  const s = String(spec || '').trim();
  if (!s.toLowerCase().startsWith('jsonstore:')) return null;

  const rest = s.substring('jsonstore:'.length).trim(); // e.g. Outbox/state.json
  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 2) return null;

  const ns = parts[0].trim();
  const file = parts.slice(1).join('/').trim(); // state.json
  const key = file.replace(/\.json$/i, '');
  if (!ns || !key) return null;

  return { ns, key };
}

module.exports.init = async (meta) => {
  const cfg = meta.implConf || {};
  const enabled = toBool(cfg.enabled, true);
  const serviceName = String(cfg.service || 'outbox').trim() || 'outbox';

  const storeSpec = String(cfg.store || 'jsonstore:Outbox/state.json').trim();
  const tickMs = toInt(cfg.tickMs, 2000);
  const batchMax = toInt(cfg.batchMax, 5);
  const sendPrefer = splitCsv(cfg.sendPrefer || 'outsend,sendout,send');

  const storeSvc = meta.getService ? meta.getService('jsonstore') : null;
  const storeSpecParsed = parseJsonStoreSpec(storeSpec);

  let store = null;
  let storeKey = null;

  if (storeSvc && typeof storeSvc.open === 'function' && storeSpecParsed) {
    try {
      store = storeSvc.open(storeSpecParsed.ns);
      storeKey = storeSpecParsed.key;
    } catch (_) {
      store = null;
      storeKey = null;
    }
  }

  const state = { q: [] };

  async function loadState() {
    if (!store || !storeKey) return;
    try {
      const saved = await store.get(storeKey, null);
      if (saved && Array.isArray(saved.q)) state.q = saved.q;
    } catch (_) {}
  }

  async function saveState() {
    if (!store || !storeKey) return;
    try {
      await store.set(storeKey, state);
    } catch (_) {}
  }

  function pickSender() {
    if (!meta.getService) return null;
    for (const n of sendPrefer) {
      const fn = meta.getService(n);
      if (typeof fn === 'function') return fn;
    }
    const fallback = meta.getService('send');
    return (typeof fallback === 'function') ? fallback : null;
  }

  async function enqueue(chatId, text, opts = {}) {
    if (!enabled) return { ok: false, reason: 'disabled' };
    if (!chatId || !text) return { ok: false, reason: 'invalid' };

    state.q.push({ chatId, text, opts, at: Date.now() });
    await saveState();
    return { ok: true, queued: true, size: state.q.length };
  }

  async function flushOnce() {
    if (!enabled) return;
    if (!state.q.length) return;

    const send = pickSender();
    if (typeof send !== 'function') return;

    let sent = 0;
    for (let i = 0; i < batchMax && state.q.length; i++) {
      const item = state.q[0];
      try {
        const res = await send(item.chatId, item.text, item.opts || {});
        if (res && res.ok === false) break;
        state.q.shift();
        sent++;
      } catch (_) {
        break;
      }
    }

    if (sent > 0) await saveState();
  }

  let timer = null;
  async function start() {
    await loadState();
    if (!enabled) return;
    if (timer) clearInterval(timer);
    timer = setInterval(() => { flushOnce().catch(() => {}); }, Math.max(500, tickMs));
  }

  await start();

  if (meta.registerService) {
    meta.registerService(serviceName, {
      enqueue,
      push: enqueue,
      size: () => state.q.length,
      flush: async () => { await flushOnce(); return { ok: true, size: state.q.length }; },
      clear: async () => { state.q = []; await saveState(); return { ok: true }; },
    });
  }

  try {
    meta.log('OutboxV1',
      `ready enabled=${enabled ? 1 : 0} service=${serviceName} store=${storeSpec} tickMs=${tickMs} batchMax=${batchMax} sendPrefer=${sendPrefer.join(',')}`
    );
  } catch (_) {}

  return { onMessage: async () => {}, onEvent: async () => {} };
};
