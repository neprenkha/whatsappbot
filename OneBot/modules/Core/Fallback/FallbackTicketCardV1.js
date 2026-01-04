'use strict';

// Updated: default card now includes Seq for visibility.

const fs = require('fs');
const Template = require('../Shared/SharedTemplateEngineV1');

function safeStr(v) { return String(v || '').trim(); }

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

function buildVars(data) {
  const x = data && typeof data === 'object' ? data : {};
  return {
    TICKET: safeStr(x.ticket),
    SEQ: safeStr(x.seq),
    FROM_NAME: safeStr(x.fromName),
    FROM_PHONE: safeStr(x.fromPhone),
    FROM_CHATID: safeStr(x.fromChatId),
    TIME: safeStr(x.time),
    TEXT: safeStr(x.text),
    ATTACH_COUNT: safeStr(x.attachCount),
    ATTACH_TYPES: safeStr(x.attachTypes),
    STATUS: safeStr(x.status),
    NOTE: safeStr(x.note),
    TIPS: safeStr(x.tips),
  };
}

async function render(meta, cfg, mode, data) {
  const templateRel = safeStr(cfg && cfg.templateRel) || '';
  const templateFile = safeStr(cfg && cfg.templateFile) || '';

  let templateText = '';
  if (templateRel && meta && typeof meta.loadTextRel === 'function') {
    templateText = await meta.loadTextRel(templateRel);
  } else if (templateFile) {
    try { templateText = fs.readFileSync(templateFile, 'utf8'); } catch (e) {
      meta.log && meta.log('FallbackTicketCardV1', `templateFile read fail file=${templateFile} err=${e && e.message ? e.message : e}`);
      templateText = '';
    }
  }

  const vars = buildVars(data);
  let block = '';
  if (mode === 'NEW' || mode === 'UPDATE' || mode === 'ACK') {
    block = extractBlock(templateText, mode);
  }
  const body = (block || templateText || '').trim();
  const rendered = Template.render(body || '', vars);
  if (rendered) return rendered;

  // Default fallback card (with Seq)
  return [
    mode === 'ACK' ? (vars.STATUS ? `${vars.STATUS} Ticket ${vars.TICKET}` : `Ticket ${vars.TICKET}`) : `Ticket: ${vars.TICKET}`,
    vars.SEQ ? `Seq: ${vars.SEQ}` : '',
    vars.FROM_NAME || vars.FROM_PHONE ? `Customer: ${vars.FROM_NAME || '-'} (${vars.FROM_PHONE || '-'})` : '',
    vars.FROM_CHATID ? `ChatId: ${vars.FROM_CHATID}` : '',
    vars.TEXT ? `\n${vars.TEXT}` : '',
    vars.ATTACH_COUNT ? `\nAttachments: ${vars.ATTACH_COUNT}${vars.ATTACH_TYPES ? ' (' + vars.ATTACH_TYPES + ')' : ''}` : '',
    vars.TIPS ? `\n\nTips:\n${vars.TIPS}` : ''
  ].filter(Boolean).join('\n');
}

module.exports = {
  render,
  extractBlock,
  buildVars,
};