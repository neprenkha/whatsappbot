'use strict';

/*
FallbackTicketCardV1
- Build ticket card text from template file (ASCII-only)
- No hardcoded chatId/text; all text comes from template

Config keys (canonical):
- templateRel=ui/Fallback/ticketcard.txt
*/

const fs = require('fs');
const path = require('path');
const Template = require('../Shared/SharedTemplateEngineV1');

function toStr(v, defVal) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s ? s : (defVal || '');
}

function safeReadText(p) {
  try {
    if (!p) return '';
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8').toString();
  } catch (_) {
    return '';
  }
}

function buildTemplateAbs(meta, templateRel) {
  const rel = toStr(templateRel, '');
  if (!rel) return '';
  const root = meta && meta.botConfigRoot ? String(meta.botConfigRoot) : '';
  if (!root) return '';
  return path.resolve(root, rel);
}

function buildVars(data) {
  return {
    TICKET_ID: toStr(data.ticketId, ''),
    TIME_LOCAL: toStr(data.timeLocal, ''),
    FROM_NAME: toStr(data.fromName, ''),
    FROM_PHONE: toStr(data.fromPhone, ''),
    FROM_CHATID: toStr(data.fromChatId, ''),
    TEXT: toStr(data.text, ''),
    MEDIA_COUNT: String(data.mediaCount === undefined || data.mediaCount === null ? '' : data.mediaCount),
    MEDIA_TYPES: toStr(data.mediaTypes, ''),
    STATUS: toStr(data.status, ''),
  };
}

function build(meta, cfg, data) {
  const templateRel = toStr(cfg && cfg.templateRel, 'ui/Fallback/ticketcard.txt');
  const absPath = buildTemplateAbs(meta, templateRel);
  const template = safeReadText(absPath);

  const vars = buildVars(data || {});

  if (!template) {
    // Fail-soft fallback (still ASCII-only).
    return (
      'Ticket: ' + vars.TICKET_ID + '\n' +
      'Time: ' + vars.TIME_LOCAL + '\n' +
      'FromName: ' + vars.FROM_NAME + '\n' +
      'FromPhone: ' + vars.FROM_PHONE + '\n' +
      'FromChatId: ' + vars.FROM_CHATID + '\n' +
      'Text:\n' + vars.TEXT + '\n' +
      'Attachments: ' + vars.MEDIA_COUNT + '\n' +
      'AttachTypes: ' + vars.MEDIA_TYPES + '\n' +
      'Status: ' + vars.STATUS + '\n'
    );
  }

  return Template.render(template, vars);
}

module.exports = { build };
