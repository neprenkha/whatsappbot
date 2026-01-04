'use strict';

// FallbackTicketCardV1
// Purpose: build ticket card text from template blocks [NEW]/[UPDATE]/[ACK].

const fs = require('fs');
const Template = require('../Shared/SharedTemplateEngineV1');

function safeStr(v) {
  return String(v || '').trim();
}

function extractBlock(tpl, tag) {
  const text = safeStr(tpl);
  if (!text) return '';
  const marker = `[${tag}]`;
  const i = text.indexOf(marker);
  if (i < 0) return '';
  const after = text.slice(i + marker.length);
  const start = after.startsWith('\n') ? 1 : 0;
  const rest = after.slice(start);

  const next = rest.search(/\n\[[A-Z]+\]\s*\n/);
  if (next < 0) return rest.trim();

  return rest.slice(0, next).trim();
}

function buildVars(d) {
  const x = d && typeof d === 'object' ? d : {};
  const ticket = safeStr(x.ticket);
  const seq = safeStr(x.seq);
  const fromName = safeStr(x.fromName);
  const fromPhone = safeStr(x.fromPhone);
  const fromChatId = safeStr(x.fromChatId);
  const time = safeStr(x.time);
  const text = safeStr(x.text);
  const attachCount = safeStr(x.attachCount);
  const attachTypes = safeStr(x.attachTypes);
  const status = safeStr(x.status);
  const note = safeStr(x.note);

  return {
    // Primary (template expects uppercase)
    TICKET: ticket,
    SEQ: seq,
    FROM_NAME: fromName,
    FROM_PHONE: fromPhone,
    FROM_CHATID: fromChatId,
    TIME: time,
    TEXT: text,
    ATTACH_COUNT: attachCount,
    ATTACH_TYPES: attachTypes,
    STATUS: status,
    NOTE: note,

    // Compatibility (older templates or debug)
    ticket,
    seq,
    fromName,
    fromPhone,
    fromChatId,
    time,
    text,
    attachCount,
    attachTypes,
    status,
    note,
  };
}

async function render(meta, cfg, mode, data) {
  const templateRel = safeStr(cfg && cfg.templateRel) || '';
  const templateFile = safeStr(cfg && cfg.templateFile) || '';

  let templateText = '';
  if (templateRel) {
    templateText = await meta.loadTextRel(templateRel);
  } else if (templateFile) {
    try {
      templateText = fs.readFileSync(templateFile, 'utf8');
    } catch (e) {
      meta.log?.('FallbackTicketCardV1', `templateFile read fail file=${templateFile} err=${e && e.message ? e.message : String(e)}`);
      templateText = '';
    }
  }
  const vars = buildVars(data);

  let block = '';
  if (mode === 'NEW' || mode === 'UPDATE' || mode === 'ACK') {
    block = extractBlock(templateText, mode);
  }
  const body = block || templateText || '';
  return Template.render(body, vars);
}

module.exports = {
  render,
  extractBlock,
  buildVars,
};
