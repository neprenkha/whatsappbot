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

function messageTextFromCtx(ctx) {
  return text(
    (ctx && ctx.text) ||
    (ctx && ctx.message && (ctx.message.body || ctx.message.caption)) ||
    (ctx && ctx.message && ctx.message._data && (ctx.message._data.body || ctx.message._data.caption)) ||
    (ctx && ctx.raw && ctx.raw._data && (ctx.raw._data.body || ctx.raw._data.caption)) ||
    ''
  );
}

function commandPrefix(cmdReply) {
  const raw = text(cmdReply);
  const m = raw.match(/^[^a-z0-9]+/i);
  return m && m[0] ? m[0] : '';
}

function parseTicketId(raw, ticketIdRegex) {
  const source = text(raw);
  if (!source) return '';
  const re = new RegExp(text(ticketIdRegex), 'i');
  const m = source.match(re);
  return m && m[0] ? text(m[0]) : '';
}

function pick(obj, path) {
  let cur = obj;
  for (let i = 0; i < path.length; i += 1) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[path[i]];
  }
  return cur;
}

function quotedTextFromContextInfo(ctx) {
  const msg = ctx && ctx.message && typeof ctx.message === 'object' ? ctx.message : {};
  const raw = ctx && ctx.raw && typeof ctx.raw === 'object' ? ctx.raw : {};
  const msgData = msg && msg._data && typeof msg._data === 'object' ? msg._data : {};
  const rawData = raw && raw._data && typeof raw._data === 'object' ? raw._data : {};

  const sources = [
    msgData,
    rawData,
    msg,
    raw,
  ];

  const out = [];
  const push = (v) => {
    const t = text(v);
    if (t) out.push(t);
  };

  for (const src of sources) {
    const contextInfo = pick(src, ['contextInfo']) || pick(src, ['messageContextInfo']) || {};
    const quotedMessage = pick(contextInfo, ['quotedMessage']) || {};

    push(pick(quotedMessage, ['conversation']));
    push(pick(quotedMessage, ['extendedTextMessage', 'text']));
    push(pick(quotedMessage, ['imageMessage', 'caption']));
    push(pick(quotedMessage, ['videoMessage', 'caption']));
    push(pick(quotedMessage, ['documentMessage', 'caption']));
    push(pick(quotedMessage, ['documentWithCaptionMessage', 'message', 'documentMessage', 'caption']));
    push(pick(quotedMessage, ['ephemeralMessage', 'message', 'extendedTextMessage', 'text']));
    push(pick(quotedMessage, ['ephemeralMessage', 'message', 'conversation']));
    push(pick(quotedMessage, ['viewOnceMessage', 'message', 'extendedTextMessage', 'text']));
    push(pick(quotedMessage, ['viewOnceMessage', 'message', 'conversation']));
  }

  return out.join('\n');
}

function resolvedQuotedTicketId(ctx, cfg, quoteParsed) {
  const fromParsed = parseTicketId(quoteParsed && quoteParsed.ticketId, cfg.ticketIdRegex);
  if (fromParsed) return fromParsed;

  const fromQuotedText = parseTicketId(quoteParsed && quoteParsed.quotedText, cfg.ticketIdRegex);
  if (fromQuotedText) return fromQuotedText;

  const fromContextInfo = parseTicketId(quotedTextFromContextInfo(ctx), cfg.ticketIdRegex);
  if (fromContextInfo) return fromContextInfo;

  return '';
}

function parseQuick(ctx, cfg, quoteParsed) {
  const body = messageTextFromCtx(ctx);
  if (!body) return null;

  const parts = splitArgs(body);
  if (!parts.length) return null;

  const prefix = commandPrefix(cfg.cmdReply);
  if (!prefix) return null;

  const first = text(parts[0]);
  const quickSendRe = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([123])$`, 'i');
  const quickTeachRe = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([123])=(.*)$`, 'i');

  const teachMatch = first.match(quickTeachRe);
  if (teachMatch) {
    return {
      kind: 'quick_teach',
      slot: text(teachMatch[1]),
      body: text(teachMatch[2]),
    };
  }

  const sendMatch = first.match(quickSendRe);
  if (sendMatch) {
    const explicitTicket = text(parts[1] || '');
    const fromQuote = resolvedQuotedTicketId(ctx, cfg, quoteParsed);
    return {
      kind: 'quick_send',
      slot: text(sendMatch[1]),
      ticketId: explicitTicket || fromQuote,
      source: explicitTicket ? 'command' : 'quote',
    };
  }

  return null;
}

function parseBind(ctx, cfg) {
  const cmdBindTag = text(cfg.cmdBindTag);
  if (!cmdBindTag) return null;

  const body = messageTextFromCtx(ctx);
  if (!body) return null;

  const parts = splitArgs(body);
  if (!parts.length) return null;
  if (keyText(parts[0]) !== keyText(cmdBindTag)) return null;

  return {
    tag: text(parts[1] || ''),
    workgroupKey: text(parts[2] || ''),
  };
}

function parseMove(ctx, cfg, quoteParsed) {
  const cmdMoveTicket = text(cfg.cmdMoveTicket);
  if (!cmdMoveTicket) return null;

  const body = messageTextFromCtx(ctx);
  if (!body) return null;

  const parts = splitArgs(body);
  if (!parts.length) return null;
  if (keyText(parts[0]) !== keyText(cmdMoveTicket)) return null;

  const fromQuote = resolvedQuotedTicketId(ctx, cfg, quoteParsed);
  const a1 = text(parts[1] || '');
  const a2 = text(parts[2] || '');

  if (a2) {
    return {
      ticketId: a1,
      targetKey: a2,
    };
  }

  return {
    ticketId: fromQuote,
    targetKey: a1,
  };
}

function parseCommand(ctx, cfg) {
  const body = messageTextFromCtx(ctx);
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

function mediaKindFromCtx(ctx) {
  const msg = ctx && ctx.message ? ctx.message : null;
  if (!msg) return '';
  if (!msg.hasMedia) return '';
  const type = keyText(msg.type || (msg._data && msg._data.type) || '');
  if (type === 'image' || type === 'document' || type === 'audio' || type === 'video' || type === 'ptt') return type;
  return '';
}

function create(deps) {
  const cfg = deps.cfg;

  async function onGroupMessage(ctx) {
    if (!ctx || !ctx.isGroup) return;

    const quoteParsed = await deps.parseQuote(ctx, cfg);
    const quotedTicketId = resolvedQuotedTicketId(ctx, cfg, quoteParsed);
    const bindParsed = parseBind(ctx, cfg);
    const moveParsed = parseMove(ctx, cfg, quoteParsed);
    const quickParsed = parseQuick(ctx, cfg, quoteParsed);
    const commandParsed = parseCommand(ctx, cfg);

    const hasQuotedContext = !!(quoteParsed && quoteParsed.quotedDetected);
    const hasTicket = !!quotedTicketId;
    const attempted = !!(hasQuotedContext || hasTicket || bindParsed || moveParsed || quickParsed || commandParsed);
    if (!attempted) return;

    if (!(await deps.canReply(ctx))) {
      await deps.sendStaffReply(ctx, cfg.replyNoAccess);
      return;
    }
    if (bindParsed && typeof deps.onBindTag === 'function') {
      const bindResult = await deps.onBindTag({
        tag: bindParsed.tag,
        workgroupKey: bindParsed.workgroupKey,
        ctx,
      });
      if (bindResult && bindResult.code === 'need_text') {
        if (text(cfg.replyNeedText)) await deps.sendStaffReply(ctx, cfg.replyNeedText);
        return;
      }
      if (bindResult && bindResult.ok) {
        if (text(cfg.replyReplySent)) await deps.sendStaffReply(ctx, cfg.replyReplySent);
        if (typeof ctx.stopPropagation === 'function') ctx.stopPropagation();
      }
      return;
    }

    if (moveParsed && typeof deps.onMoveTicket === 'function') {
      const moveResult = await deps.onMoveTicket({
        ticketId: moveParsed.ticketId,
        targetKey: moveParsed.targetKey,
        ctx,
      });
      if (moveResult && moveResult.code === 'need_ticket') {
        if (text(cfg.replyNeedTicket)) await deps.sendStaffReply(ctx, cfg.replyNeedTicket);
        return;
      }
      if (moveResult && moveResult.code === 'need_text') {
        if (text(cfg.replyNeedText)) await deps.sendStaffReply(ctx, cfg.replyNeedText);
        return;
      }
      if (moveResult && moveResult.code === 'ticket_not_found') {
        if (text(cfg.replyTicketNotFound)) await deps.sendStaffReply(ctx, cfg.replyTicketNotFound);
        return;
      }
      if (moveResult && moveResult.code === 'ticket_closed') {
        if (text(cfg.replyTicketClosed)) await deps.sendStaffReply(ctx, cfg.replyTicketClosed);
        return;
      }
      if (moveResult && moveResult.code === 'group_only') {
        if (text(cfg.replyGroupOnly)) await deps.sendStaffReply(ctx, cfg.replyGroupOnly);
        return;
      }
      if (moveResult && moveResult.ok) {
        if (text(cfg.replyReplySent)) await deps.sendStaffReply(ctx, cfg.replyReplySent);
        if (typeof ctx.stopPropagation === 'function') ctx.stopPropagation();
      }
      return;
    }

    if (quickParsed && quickParsed.kind === 'quick_teach' && typeof deps.onQuickTeach === 'function') {
      const teachResult = await deps.onQuickTeach({
        slot: quickParsed.slot,
        body: quickParsed.body,
        ctx,
      });

      if (teachResult && teachResult.code === 'need_text') {
        if (text(cfg.replyNeedText)) await deps.sendStaffReply(ctx, cfg.replyNeedText);
        return;
      }
      if (teachResult && teachResult.code === 'need_ticket') {
        if (text(cfg.replyNeedTicket)) await deps.sendStaffReply(ctx, cfg.replyNeedTicket);
        return;
      }
      if (teachResult && teachResult.code === 'ticket_not_found') {
        if (text(cfg.replyTicketNotFound)) await deps.sendStaffReply(ctx, cfg.replyTicketNotFound);
        return;
      }
      if (teachResult && teachResult.code === 'ticket_closed') {
        if (text(cfg.replyTicketClosed)) await deps.sendStaffReply(ctx, cfg.replyTicketClosed);
        return;
      }
      if (teachResult && teachResult.code === 'group_only') {
        if (text(cfg.replyGroupOnly)) await deps.sendStaffReply(ctx, cfg.replyGroupOnly);
        return;
      }
      if (teachResult && teachResult.ok) {
        if (text(cfg.replyReplySent)) await deps.sendStaffReply(ctx, cfg.replyReplySent);
        if (typeof ctx.stopPropagation === 'function') ctx.stopPropagation();
      }
      return;
    }

    if (quickParsed && quickParsed.kind === 'quick_send' && typeof deps.onQuickSend === 'function') {
      const quickResult = await deps.onQuickSend({
        slot: quickParsed.slot,
        ticketId: quickParsed.ticketId,
        source: quickParsed.source,
        ctx,
      });

      if (quickResult && quickResult.code === 'need_ticket') {
        if (text(cfg.replyNeedTicket)) await deps.sendStaffReply(ctx, cfg.replyNeedTicket);
        return;
      }
      if (quickResult && quickResult.code === 'need_text') {
        if (text(cfg.replyNeedText)) await deps.sendStaffReply(ctx, cfg.replyNeedText);
        return;
      }
      if (quickResult && quickResult.code === 'ticket_not_found') {
        if (text(cfg.replyTicketNotFound)) await deps.sendStaffReply(ctx, cfg.replyTicketNotFound);
        return;
      }
      if (quickResult && quickResult.code === 'ticket_closed') {
        if (text(cfg.replyTicketClosed)) await deps.sendStaffReply(ctx, cfg.replyTicketClosed);
        return;
      }
      if (quickResult && quickResult.code === 'group_only') {
        if (text(cfg.replyGroupOnly)) await deps.sendStaffReply(ctx, cfg.replyGroupOnly);
        return;
      }
      if (quickResult && quickResult.ok) {
        if (text(cfg.replyReplySent)) await deps.sendStaffReply(ctx, cfg.replyReplySent);
        if (typeof ctx.stopPropagation === 'function') ctx.stopPropagation();
      }
      return;
    }

    let payload = null;
    if (quoteParsed && (quoteParsed.quotedDetected || quotedTicketId)) {
      payload = Object.assign({}, quoteParsed, { ticketId: quotedTicketId || text(quoteParsed.ticketId) });
    }
    if (!payload && commandParsed) payload = commandParsed;
    if (!payload) return;

    const ticketId = text(payload.ticketId);
    const fallbackBody = messageTextFromCtx(ctx);
    const body = text(payload.body || fallbackBody);
    const captionText = fallbackBody;
    const mediaKind = mediaKindFromCtx(ctx);

    if (!ticketId) {
      await deps.sendStaffReply(ctx, cfg.replyNeedTicket);
      return;
    }

    if (typeof deps.checkTicketGroup === 'function') {
      const groupCheck = await deps.checkTicketGroup({ ticketId, ctx });
      if (groupCheck && groupCheck.code === 'group_only') {
        if (text(cfg.replyGroupOnly)) await deps.sendStaffReply(ctx, cfg.replyGroupOnly);
        return;
      }
      if (groupCheck && groupCheck.code === 'ticket_not_found') {
        if (text(cfg.replyTicketNotFound)) await deps.sendStaffReply(ctx, cfg.replyTicketNotFound);
        return;
      }
      if (groupCheck && groupCheck.code === 'ticket_closed') {
        if (text(cfg.replyTicketClosed)) await deps.sendStaffReply(ctx, cfg.replyTicketClosed);
        return;
      }
    }

    let result;
    const isMediaReply = !!mediaKind;
    const isAVReply = mediaKind === 'audio' || mediaKind === 'video' || mediaKind === 'ptt';
    if (isMediaReply && isAVReply) {
      result = await deps.sendReplyAV({
        ticketId,
        staffMsg: ctx.message,
        captionText,
        source: payload.source,
        options: { isAuto: 0, manualReply: 1, bypassRateLimit: 1 },
      });
    } else if (isMediaReply) {
      result = await deps.sendReplyMedia({
        ticketId,
        staffMsg: ctx.message,
        captionText,
        source: payload.source,
        options: { isAuto: 0, manualReply: 1, bypassRateLimit: 1 },
      });
    } else {
      if (!body) {
        await deps.sendStaffReply(ctx, cfg.replyNeedText);
        return;
      }
      result = await deps.sendReplyText({
        ticketId,
        body,
        source: payload.source,
      });
    }

    if (!result || !result.ok) {
      if (isMediaReply && result && (result.code === 'media_download_failed' || result.code === 'send_missing' || result.code === 'send_error')) {
        return;
      }
      if (result && result.code === 'group_only') {
        await deps.sendStaffReply(ctx, cfg.replyGroupOnly);
        return;
      }
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