'use strict';

function text(value) {
  return String(value ?? '').trim();
}

function toInt(value, fallback) {
  const n = Number.parseInt(text(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function applyTemplate(template, vars) {
  let out = String(template || '');
  Object.keys(vars).forEach((name) => {
    out = out.split(`{${name}}`).join(String(vars[name] ?? ''));
  });
  return out;
}

function renderBatch(meta, cfg, payload) {
  const maxLen = Math.max(1, toInt(cfg.forwardTextMaxLen, 3500));
  const lines = Array.isArray(payload.messages) ? payload.messages.map((x) => text(x)).filter(Boolean) : [];
  if (!lines.length) return '';

  const header = applyTemplate(cfg.forwardTextPrefixTemplate, {
    TICKETID: text(payload.ticketId),
    FROM: text(payload.customerName),
    CHATID: text(payload.customerChatId),
    COUNT: String(lines.length),
  });

  const body = lines.join('\n');
  const full = header ? `${header}\n${body}` : body;
  return full.slice(0, maxLen).trim();
}

module.exports = {
  renderBatch,
};