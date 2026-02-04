'use strict';

const SharedLog = require('../Shared/SharedLogV1');

function safeStr(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

async function allowStaff(meta, cfg, staffWid, logger) {
  const requiredRole = safeStr(cfg.requiredRole);
  if (!requiredRole) return true;

  const accessService = safeStr(cfg.accessService || 'access');
  const access = meta.getService(accessService);
  if (!access) {
    logger.warn('Access service not found; skipping role check.');
    return true;
  }

  try {
    if (typeof access.hasRole === 'function') {
      return await access.hasRole(staffWid, requiredRole);
    }
    logger.warn('Access service does not implement required methods for role check.');
    return false;
  } catch (e) {
    logger.warn(`Role check failed for staff ${staffWid}: ${e.message}`);
    return false;
  }
}

async function sendToCustomer(meta, cfg, destChatId, text, logger) {
  const sendServiceName = safeStr(cfg.sendService || 'send');
  const sendService = meta.getService(sendServiceName);
  if (!sendService) {
    logger.error(`Send service "${sendServiceName}" not available.`);
    return { ok: false, reason: 'noservice' };
  }

  try {
    await sendService(destChatId, { type: 'text', text: text });
    logger.info(`Message sent to customer: ${destChatId}`);
    return { ok: true };
  } catch (e) {
    logger.error(`Failed to send to customer ${destChatId}: ${e.message}`);
    return { ok: false, reason: 'send_failed', error: e.message };
  }
}

function isCommandText(cfg, text) {
  const cmd = (cfg && cfg.cmdReply ? String(cfg.cmdReply) : '!r').trim();
  const t = String(text === undefined || text === null ? '' : text).trim();
  if (!cmd || !t) return false;
  return t === cmd || t.startsWith(cmd + ' ');
}

async function handle(meta, cfg, ctx) {
  const logger = SharedLog.create(meta, 'FallbackCommandReplyV1');
  const groupId = safeStr(cfg.controlGroupId);

  if (!ctx.isGroup || safeStr(ctx.chatId) !== groupId) {
    logger.warn('Received command in invalid group.');
    return { ok: false, reason: 'not_control_group' };
  }

  // Parse command
  const rawText = safeStr(ctx.text);
  if (!rawText.startsWith('!')) {
    logger.warn('Invalid command format.');
    return { ok: false, reason: 'invalid_command' };
  }

  // Extract sender info
  const staffWid = safeStr(ctx.sender?.id || ctx.sender?.phone || '');
  if (!staffWid) return { ok: false, reason: 'no_staff_id' };

  const staffAllowed = await allowStaff(meta, cfg, staffWid, logger);
  if (!staffAllowed) {
    logger.warn(`Staff ${staffWid} not allowed to reply.`);
    return { ok: false, reason: 'not_authorized' };
  }

  const ticket = rawText.split(/\s+/)[1] || '';
  const message = rawText.split(/\s+/).slice(2).join(' ');

  if (!ticket || !message) {
    logger.warn('Missing ticket or message in command.');
    return { ok: false, reason: !ticket ? 'no_ticket' : 'no_message' };
  }

  // Resolve ticket
  const resolved = await SharedTicketCoreV2.get(meta, cfg, ticket);
  if (!resolved || !resolved.chatId) {
    logger.error(`Failed to resolve ticket: ${ticket}`);
    return { ok: false, reason: 'ticket_not_resolved' };
  }

  const result = await sendToCustomer(meta, cfg, resolved.chatId, message, logger);
  if (!result.ok) {
    logger.error(`Failed to send reply to ticket ${ticket}`);
    return { ok: false, reason: result.reason };
  }

  logger.info(`Reply sent for ticket ${ticket} by staff ${staffWid}`);
  return { ok: true };
}

module.exports = { isCommandText, handle };