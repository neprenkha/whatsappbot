// ASCII-only

'use strict';

const SharedSafeSend = require('../Shared/SharedSafeSendV1');

function cfgGetStr(cfg, key, defVal) {
  if (!cfg || typeof cfg !== 'object') return defVal;
  const v = cfg[key];
  if (typeof v === 'string') {
    const s = v.trim();
    return s ? s : defVal;
  }
  return defVal;
}

function parseJsonStoreSpec(spec) {
  // Expect: jsonstore:<namespace>/<key>
  const s = (spec || '').trim();
  if (!s) return null;
  const pfx = 'jsonstore:';
  if (s.indexOf(pfx) !== 0) return null;
  const rest = s.slice(pfx.length);
  const parts = rest.split('/');
  const ns = (parts.shift() || '').trim();
  const key = parts.join('/').trim();
  if (!ns || !key) return null;
  return { ns, key };
}

function getJsonStore(meta) {
  if (!meta || typeof meta.getService !== 'function') return null;
  return meta.getService('jsonstore') || meta.getService('JsonStore') || null;
}

async function loadTicketDoc(meta, cfg) {
  const storeSpec = cfgGetStr(cfg, 'ticketStoreSpec', cfgGetStr(cfg, 'storeSpec', ''));
  const parsed = parseJsonStoreSpec(storeSpec);
  if (!parsed) return { ok: false, err: 'invalid_ticketStoreSpec', doc: null };

  const js = getJsonStore(meta);
  if (!js || typeof js.read !== 'function') {
    return { ok: false, err: 'missing_jsonstore_service', doc: null };
  }

  let doc = null;
  try {
    doc = await js.read(parsed.ns, parsed.key);
  } catch (e) {
    doc = null;
  }

  if (!doc || typeof doc !== 'object') doc = {};
  if (!doc.tickets || typeof doc.tickets !== 'object') doc.tickets = {};
  return { ok: true, err: null, doc };
}

async function getTicketById(meta, cfg, ticketId) {
  if (!ticketId) return null;
  const loaded = await loadTicketDoc(meta, cfg);
  if (!loaded.ok) return null;

  const tickets = loaded.doc && loaded.doc.tickets ? loaded.doc.tickets : {};
  const keys = Object.keys(tickets);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const raw = tickets[k];
    if (!raw || typeof raw !== 'object') continue;
    if (raw.ticketId !== ticketId) continue;

    const seg = String(k).split(':');
    if (seg.length < 2) continue;
    const ticketType = seg.shift();
    const chatId = seg.join(':');

    return {
      ticketId: raw.ticketId,
      ticketType: ticketType,
      chatId: chatId,
      raw: raw,
    };
  }

  return null;
}

function parseTicketId(text) {
  if (!text || typeof text !== 'string') return null;

  // Support common formats; keep permissive to avoid missing tickets.
  // Examples: YYMMT0000000, YYYYMMT0000000, T0000000, 202601T0000000
  const m = text.match(/\b([0-9]{4}[0-9]{2}T[0-9]{7}|[0-9]{4}T[0-9]{7}|T[0-9]{7,12})\b/i);
  if (m && m[1]) return String(m[1]).toUpperCase();

  return null;
}

function create(meta, cfg) {
  const log = meta.getLog();

  function shouldHandle(ev) {
    if (!ev || !ev.message) return false;
    if (!ev.isGroup) return false;
    if (!ev.body) return false;

    const controlGroupId = cfgGetStr(cfg, 'controlGroupId', '');
    if (!controlGroupId) return false;
    if (ev.chatId !== controlGroupId) return false;

    const text = String(ev.body || '');
    return !!parseTicketId(text);
  }

  async function handle(ev) {
    const ticketId = parseTicketId(String(ev.body || ''));
    if (!ticketId) return;

    const t = await getTicketById(meta, cfg, ticketId);
    if (!t || !t.chatId) {
      log && log.warn && log.warn('ticket not found', { ticketId });
      return;
    }

    const replyText = String(ev.body || '').trim();

    // Remove ticketId from start if present.
    let outboundText = replyText;
    const idx = outboundText.toUpperCase().indexOf(ticketId);
    if (idx === 0) {
      outboundText = outboundText.slice(ticketId.length).trim();
    }

    if (!outboundText) {
      // If staff only sent the ticket id, do nothing.
      return;
    }

    await SharedSafeSend.safeSendText(meta, {
      chatId: t.chatId,
      text: outboundText,
      sendPrefer: cfgGetStr(cfg, 'sendPrefer', 'outsend,sendout,send,transport'),
      // Reply to original DM is optional; safest is plain send.
    });
  }

  return { shouldHandle, handle };
}

module.exports = { create };
