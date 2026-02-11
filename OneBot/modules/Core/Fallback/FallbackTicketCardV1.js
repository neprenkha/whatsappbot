'use strict';

/*
FallbackTicketCardV1
- Build ticket card text from template file (ASCII-only)
- Template path is read from canonical config key only:
  ticketCardTemplateRel
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
  const root = meta && meta.confRoot ? String(meta.confRoot) : '';
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

function toCardData(envelope, ticketId, kinds) {
  const env = envelope && typeof envelope === 'object' ? envelope : {};
  const k = kinds && typeof kinds === 'object' ? kinds : {};
  const count = (Number(k.pic || 0) + Number(k.doc || 0) + Number(k.av || 0));

  const mediaTypes = [];
  if (Number(k.pic || 0) > 0) mediaTypes.push('pic');
  if (Number(k.doc || 0) > 0) mediaTypes.push('doc');
  if (Number(k.av || 0) > 0) mediaTypes.push('av');

  return {
    ticketId: toStr(ticketId, ''),
    timeLocal: toStr(env.at, ''),
    fromName: toStr(env.authorName, ''),
    fromPhone: toStr(env.authorPhone, ''),
    fromChatId: toStr(env.chatId, ''),
    text: toStr(env.text, ''),
    mediaCount: count,
    mediaTypes: mediaTypes.join(','),
    status: 'OPEN',
  };
}

function build(meta, cfg, data) {
  const templateRel = toStr(cfg && cfg.ticketCardTemplateRel, '');
  const absPath = buildTemplateAbs(meta, templateRel);
  const template = safeReadText(absPath);

  if (!template) {
    throw new Error('FallbackTicketCardV1: template missing or empty. key=ticketCardTemplateRel');
  }

  const vars = buildVars(data || {});
  return Template.render(template, vars);
}

module.exports = {
  init: async function init(meta, cfg) {
    return {
      render: async function render(envelope, ticketId, kinds) {
        const data = toCardData(envelope, ticketId, kinds);
        return build(meta, cfg, data);
      },
    };
  },
};
