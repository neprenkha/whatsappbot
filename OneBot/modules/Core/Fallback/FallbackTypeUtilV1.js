'use strict';

const TICKET_RE = /\b(\d{6}T\d{10,})\b/;

function nowMs() {
  return Date.now();
}

function toStr(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function cleanText(s, maxLen) {
  const t = toStr(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  if (maxLen && t.length > maxLen) return t.slice(0, maxLen);
  return t;
}

function getRawType(raw) {
  if (!raw) return '';
  const t = (raw.type || (raw._data && raw._data.type) || '').toLowerCase();
  return t;
}

function isAvType(t) {
  const x = (t || '').toLowerCase();
  return x === 'video' || x === 'audio' || x === 'ptt' || x === 'voice' || x === 'voice_note' || x === 'gif';
}

function isImageType(t) {
  const x = (t || '').toLowerCase();
  return x === 'image' || x === 'sticker';
}

function isDocumentType(t) {
  const x = (t || '').toLowerCase();
  return x === 'document';
}

function classify(raw, text) {
  const t = getRawType(raw);

  if (raw && raw.hasMedia) {
    if (isAvType(t)) return 'av';
    return 'media';
  }

  if (isAvType(t)) return 'av';
  if (isImageType(t) || isDocumentType(t)) return 'media';

  const body = cleanText(text || (raw && raw.body) || '', 4096);
  if (body) return 'text';
  return 'text';
}

function extractTicketFromText(text) {
  const m = cleanText(text, 8000).match(TICKET_RE);
  return m ? m[1] : '';
}

function normalizeTicketCfg(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;

  // Backward compat: older configs use ticketStore=... (SharedTicketCore expects storeSpec/ticketStoreSpec)
  if (!cfg.storeSpec && cfg.ticketStore) cfg.storeSpec = cfg.ticketStore;
  if (!cfg.ticketStoreSpec && cfg.storeSpec) cfg.ticketStoreSpec = cfg.storeSpec;

  if (!cfg.ticketType) cfg.ticketType = 'fallback';
  return cfg;
}

function formatInboundPrefix(ticket, senderPhone, senderName, seq) {
  const parts = [];
  if (ticket) parts.push(`Ticket: ${ticket}`);
  if (senderPhone) parts.push(`From: +${senderPhone}`);
  if (senderName) parts.push(`Name: ${senderName}`);
  if (seq !== undefined && seq !== null) parts.push(`Seq: ${seq}`);
  return parts.join(' | ');
}

module.exports = {
  TICKET_RE,
  nowMs,
  toStr,
  cleanText,
  getRawType,
  isAvType,
  isImageType,
  isDocumentType,
  classify,
  extractTicketFromText,
  normalizeTicketCfg,
  formatInboundPrefix,
};
