'use strict';

const fs = require('fs');
const path = require('path');

function toInt(v, d) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
}
function toStr(v, d = '') {
  return v === undefined || v === null ? d : String(v).trim();
}
const SharedLog = require('../Shared/SharedLogV1');
const Template = require('../Shared/SharedTemplateEngineV1');

function loadTemplate(meta, templateRel) {
  try {
    const filePath = path.resolve(meta.implConf.configRoot || process.cwd(), templateRel);
    if (!fs.existsSync(filePath)) throw new Error('Template not found');
    return fs.readFileSync(filePath, 'utf8').toString();
  } catch (e) {
    meta.log('FallbackV2', `Error loading template: ${e.message}`);
    return '';
  }
}

async function downloadMedia(meta, msg) {
  if (!msg || typeof msg.downloadMedia !== 'function') {
    meta.log('FallbackV2', 'No media to download.');
    return null;
  }
  try {
    return await msg.downloadMedia();
  } catch (e) {
    meta.log('FallbackV2', `Media download failed: ${e.message}`);
    return null;
  }
}

function buildTicketCard(meta, data) {
  const vars = {
    TICKET: data.ticket,
    NAME: data.name,
    PHONE: data.phone,
    TEXT: data.message,
    ATTACHMENTS: data.attachmentCount || 0,
    ATTACH_TYPE: data.attachmentType || 'None',
  };

  const template = loadTemplate(meta, meta.implConf.templateRel);
  if (!template) {
    meta.log('FallbackV2', 'Template missing; fallback to default.');
    return `Ticket: ${vars.TICKET}\nName: ${vars.NAME}\nText: ${vars.TEXT}\n`;
  }

  return Template.render(template, vars);
}

async function handleInboundMessage(meta, cfg, ctx) {
  const log = SharedLog.create(meta, 'FallbackV2');
  const { chatId, isGroup, text: message } = ctx;

  if (isGroup) {
    log.info('Skipping group message', { chatId });
    return;
  }

  const ticketId = `${chatId}-TICKET-${Date.now()}`;
  const customerDetails = {
    ticket: ticketId,
    name: toStr(ctx.sender?.name, 'Anonymous'),
    phone: toStr(ctx.sender?.phone, ''),
    message: message || 'No text provided',
  };

  const ticketCard = buildTicketCard(meta, customerDetails);
  const groupId = toStr(cfg.controlGroupId, '');
  if (!groupId) {
    log.error('No control group configured');
    return;
  }

  const media = await downloadMedia(meta, ctx.message);
  try {
    await meta.services.send(groupId, ticketCard, {});
    if (media) {
      const caption = `Ticket ${ticketId} (with media)`;
      await meta.services.send(groupId, media, { caption });
    }
    log.info('Message and media forwarded to group', { groupId });
  } catch (e) {
    log.error('Failed to forward to group', { error: e.message });
  }
}

async function handleQuotedReply(meta, cfg, ctx) {
  const log = SharedLog.create(meta, 'FallbackV2');
  if (!ctx.message?.hasQuotedMsg) return;

  const quoted = await ctx.message.getQuotedMessage();
  const ticketId = quoted?.body?.match(/Ticket: (\S+)/)?.[1];
  const groupId = toStr(cfg.controlGroupId, '');

  if (!ticketId || !groupId) {
    log.error('Failed to resolve quoted reply ticket', { ticketId, groupId });
    return;
  }

  const replyText = toStr(ctx.text, 'No Reply Text');
  try {
    await meta.services.send(ticketId, replyText, {});
    log.info('Reply forwarded to customer', { ticketId });
  } catch (e) {
    log.error('Failed to forward reply to customer', { error: e.message });
  }
}

async function onMessage(ctx, cfg) {
  const { isGroup, message } = ctx;

  if (isGroup && message?.hasQuotedMsg) {
    await handleQuotedReply(ctx);
  } else {
    await handleInboundMessage(ctx);
  }
}

module.exports = { onMessage };