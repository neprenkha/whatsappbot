'use strict';

function text(value) {
  return String(value ?? '').trim();
}

function keyText(value) {
  return text(value).toLowerCase();
}

function splitArgs(raw) {
  return text(raw).split(/\s+/).filter(Boolean);
}

function parseCommand(ctx, cfg) {
  const body = text(
    (ctx && ctx.text) ||
    (ctx && ctx.message && (ctx.message.body || ctx.message.caption)) ||
    ''
  );
  if (!body) return null;

  const parts = splitArgs(body);
  if (!parts.length) return null;

  const cmd = keyText(parts[0]);
  if (cmd !== keyText(cfg.cmdReply)) return null;

  const ticketId = text(parts[1] || '');
  const replyText = text(parts.slice(2).join(' '));

  return {
    source: 'command',
    ticketId,
    body: replyText,
  };
}

function create(deps) {
  const cfg = deps.cfg;

  async function onGroupMessage(ctx) {
    if (!ctx || !ctx.isGroup) return;
    if (!(await deps.canReply(ctx))) {
      await deps.sendStaffReply(ctx, cfg.replyNoAccess);
      return;
    }

    const quoteParsed = deps.parseQuote(ctx, cfg);
    const commandParsed = parseCommand(ctx, cfg);

    let payload = null;
    if (quoteParsed && text(quoteParsed.ticketId)) payload = quoteParsed;
    if (!payload && commandParsed) payload = commandParsed;
    if (!payload) return;

    const ticketId = text(payload.ticketId);
    const body = text(payload.body);

    if (!ticketId) {
      await deps.sendStaffReply(ctx, cfg.replyNeedTicket);
      return;
    }

    if (!body) {
      await deps.sendStaffReply(ctx, cfg.replyNeedText);
      return;
    }

    const result = await deps.sendReplyText({
      ticketId,
      body,
      source: payload.source,
    });

    if (!result || !result.ok) {
      if (result && result.code === 'ticket_not_found') {
        await deps.sendStaffReply(ctx, cfg.replyTicketNotFound);
        return;
      }
      if (result && result.code === 'ticket_closed') {
        await deps.sendStaffReply(ctx, cfg.replyTicketClosed);
        return;
      }
      if (result && result.code === 'need_ticket') {
        await deps.sendStaffReply(ctx, cfg.replyNeedTicket);
        return;
      }
      if (result && result.code === 'need_text') {
        await deps.sendStaffReply(ctx, cfg.replyNeedText);
        return;
      }
      await deps.sendStaffReply(ctx, cfg.replyTicketNotFound);
      return;
    }

    await deps.sendStaffReply(ctx, cfg.replyReplySent);
    if (typeof ctx.stopPropagation === 'function') {
      ctx.stopPropagation();
    }
  }

  return { onGroupMessage };
}

module.exports = {
  create,
};