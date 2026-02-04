'use strict';

function nowMs() {
  return Date.now();
}

function toStr(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function cleanText(t) {
  const s = toStr(t);
  return s.replace(/\r/g, '').trim();
}

function getRaw(ctx) {
  if (!ctx) return null;
  if (ctx.message) return ctx.message;
  if (ctx.raw) return ctx.raw;
  return ctx;
}

function getRawType(raw) {
  if (!raw) return '';
  if (typeof raw.type === 'string') return raw.type;
  if (raw._data && typeof raw._data.type === 'string') return raw._data.type;
  return '';
}

function isFromMe(ctx) {
  const raw = getRaw(ctx);
  if (!raw) return false;
  if (typeof raw.fromMe === 'boolean') return raw.fromMe;
  if (raw._data && typeof raw._data.fromMe === 'boolean') return raw._data.fromMe;
  return false;
}

function digitsOnly(s) {
  return toStr(s).replace(/[^0-9]/g, '');
}

function chatIdToPhone(chatId) {
  // 60123456789@c.us -> 60123456789
  const v = toStr(chatId);
  const m = v.match(/^([0-9]+)@/);
  if (m && m[1]) return m[1];
  return digitsOnly(v);
}

function getSender(ctx) {
  const raw = getRaw(ctx);
  const chatId = toStr(ctx && ctx.chatId ? ctx.chatId : raw && raw.from ? raw.from : '');
  const fromName = toStr(ctx && ctx.senderName ? ctx.senderName : raw && raw._data && raw._data.notifyName ? raw._data.notifyName : '');
  const fromPhone = chatIdToPhone(chatId);
  return { chatId, fromName, fromPhone };
}

function parseTicketId(text) {
  const t = toStr(text);
  // Ticket format agreed: YYMMT + 7 digits, example: 2601T0000001
  const m = t.match(/\b\d{4}T\d{7}\b/);
  return m ? m[0] : '';
}

function getQuotedText(raw) {
  if (!raw) return '';
  // whatsapp-web.js: quotedMsg exists in some builds; otherwise in _data.quotedMsg
  if (raw.quotedMsg && typeof raw.quotedMsg.body === 'string') return raw.quotedMsg.body;
  if (raw._data && raw._data.quotedMsg) {
    const q = raw._data.quotedMsg;
    if (typeof q.body === 'string') return q.body;
    if (typeof q.caption === 'string') return q.caption;
  }
  return '';
}

function formatInboundPrefix(ticketId, fromPhone, fromName, seq) {
  const tid = toStr(ticketId);
  const ph = toStr(fromPhone);
  const nm = toStr(fromName);
  const sq = Number.isFinite(seq) ? String(seq) : '';
  // Keep ASCII and stable.
  // Example: [2601T0000001] 60123456789 Name #3
  let out = '[' + tid + ']';
  if (ph) out += ' ' + ph;
  if (nm) out += ' ' + nm;
  if (sq) out += ' #' + sq;
  return out.trim();
}

function cfgGetBool(cfg, k, d) {
  if (!cfg || typeof cfg !== 'object') return d;
  if (!(k in cfg)) return d;
  const v = cfg[k];
  if (typeof v === 'boolean') return v;
  const s = toStr(v).toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return d;
}

function cfgGetInt(cfg, k, d) {
  const n = parseInt(toStr(cfg && cfg[k]), 10);
  return Number.isFinite(n) ? n : d;
}

function cfgGetStr(cfg, k, d) {
  const v = cfg && cfg[k];
  const s = toStr(v);
  return s.length ? s : d;
}

function normalizeTicketCfg(implConf) {
  const cfg = Object.assign({}, implConf || {});
  cfg.enabled = cfgGetBool(cfg, 'enabled', true);

  // Canonical key only:
  cfg.controlGroupId = cfgGetStr(cfg, 'controlGroupId', '');

  cfg.ticketType = cfgGetStr(cfg, 'ticketType', 'fallback');
  cfg.ticketPrefix = cfgGetStr(cfg, 'ticketPrefix', '');
  cfg.ticketStoreSpec = cfgGetStr(cfg, 'ticketStoreSpec', '');
  cfg.templateRel = cfgGetStr(cfg, 'templateRel', '');
  cfg.sendPrefer = cfgGetStr(cfg, 'sendPrefer', 'sendout,outsend,send,transport');

  cfg.msgBufferMax = cfgGetInt(cfg, 'msgBufferMax', 8);
  cfg.burstMs = cfgGetInt(cfg, 'burstMs', 1500);
  cfg.mediaTimeoutMs = cfgGetInt(cfg, 'mediaTimeoutMs', 120000);

  cfg.moduleLog = cfgGetBool(cfg, 'moduleLog', true);
  cfg.bugLog = cfgGetBool(cfg, 'bugLog', true);
  cfg.detailLog = cfgGetBool(cfg, 'detailLog', false);
  cfg.traceLog = cfgGetBool(cfg, 'traceLog', false);

  cfg.cmdReply = cfgGetStr(cfg, 'cmdReply', 'r');

  // Optional header key (still config-driven)
  cfg.phoneHeaderKey = cfgGetStr(cfg, 'phoneHeaderKey', 'phone');

  return cfg;
}

function classifyMessage(raw) {
  const t = getRawType(raw);
  if (t === 'chat' || t === 'text') return 'text';
  if (t === 'image' || t === 'document' || t === 'sticker') return 'media';
  if (t === 'video' || t === 'audio' || t === 'ptt' || t === 'voice') return 'av';
  if (raw && raw.hasMedia) return 'media';
  return 'text';
}

module.exports = {
  nowMs,
  cleanText,
  getRaw,
  getRawType,
  isFromMe,
  getSender,
  parseTicketId,
  getQuotedText,
  formatInboundPrefix,
  normalizeTicketCfg,
  classifyMessage,
};
