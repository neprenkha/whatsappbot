'use strict';

function text(value) {
  return String(value ?? '').trim();
}

function keyText(value) {
  return text(value).toLowerCase();
}

function toInt(value, fallback) {
  const n = Number.parseInt(text(value), 10);
  return Number.isFinite(n) ? n : fallback;
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
    if (t && !out.includes(t)) out.push(t);
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
    push(pick(quotedMessage, ['ephemeralMessage', 'message', 'imageMessage', 'caption']));
    push(pick(quotedMessage, ['ephemeralMessage', 'message', 'videoMessage', 'caption']));
    push(pick(quotedMessage, ['ephemeralMessage', 'message', 'documentMessage', 'caption']));
    push(pick(quotedMessage, ['viewOnceMessage', 'message', 'extendedTextMessage', 'text']));
    push(pick(quotedMessage, ['viewOnceMessage', 'message', 'conversation']));
    push(pick(quotedMessage, ['viewOnceMessage', 'message', 'imageMessage', 'caption']));
    push(pick(quotedMessage, ['viewOnceMessage', 'message', 'videoMessage', 'caption']));
    push(pick(quotedMessage, ['viewOnceMessage', 'message', 'documentMessage', 'caption']));
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

function mediaMimeTypeFromCtx(ctx) {
  return text(
    (ctx && ctx.message && (ctx.message.mimetype || (ctx.message._data && ctx.message._data.mimetype))) ||
    (ctx && ctx.raw && ctx.raw._data && ctx.raw._data.mimetype) ||
    ''
  );
}

function mediaFileNameFromCtx(ctx) {
  return text(
    (ctx && ctx.message && (ctx.message.filename || (ctx.message._data && ctx.message._data.filename))) ||
    (ctx && ctx.raw && ctx.raw._data && ctx.raw._data.filename) ||
    ''
  );
}

function mediaKindFromCtx(ctx) {
  const msg = ctx && ctx.message ? ctx.message : null;
  const raw = ctx && ctx.raw && typeof ctx.raw === 'object' ? ctx.raw : {};
  const rawData = raw && raw._data && typeof raw._data === 'object' ? raw._data : {};
  if (!msg) return '';

  const direct = keyText(msg.type || (msg._data && msg._data.type) || raw.type || rawData.type || rawData.mediaKeyType || '');
  if (direct === 'image' || direct === 'document' || direct === 'audio' || direct === 'video' || direct === 'ptt') return direct;

  const isPtt = !!(msg.ptt || (msg._data && msg._data.ptt) || rawData.ptt);
  if (isPtt) return 'ptt';

  const mime = keyText(mediaMimeTypeFromCtx(ctx));
  if (mime.indexOf('image/') === 0) return 'image';
  if (mime.indexOf('video/') === 0) return 'video';
  if (mime.indexOf('audio/') === 0) return 'audio';
  if (mime || mediaFileNameFromCtx(ctx)) return 'document';

  return '';
}

function hasMediaCtx(ctx) {
  const msg = ctx && ctx.message ? ctx.message : null;
  const raw = ctx && ctx.raw && typeof ctx.raw === 'object' ? ctx.raw : {};
  const rawData = raw && raw._data && typeof raw._data === 'object' ? raw._data : {};
  return !!(
    mediaKindFromCtx(ctx) ||
    (msg && msg.hasMedia) ||
    (msg && typeof msg.downloadMedia === 'function') ||
    rawData.mediaKey ||
    rawData.directPath ||
    rawData.clientUrl ||
    rawData.isMedia
  );
}

function senderKeyFromCtx(ctx) {
  return text(
    (ctx && (ctx.senderId || ctx.author || ctx.from)) ||
    (ctx && ctx.raw && (ctx.raw.participant || ctx.raw.author || ctx.raw.from)) ||
    ''
  ).toLowerCase();
}

function chatKeyFromCtx(ctx) {
  return text((ctx && ctx.chatId) || (ctx && ctx.raw && ctx.raw.from) || '').toLowerCase();
}

function mediaGroupKeyFromCtx(ctx) {
  const msg = ctx && ctx.message && typeof ctx.message === 'object' ? ctx.message : {};
  const raw = ctx && ctx.raw && typeof ctx.raw === 'object' ? ctx.raw : {};
  const msgData = msg && msg._data && typeof msg._data === 'object' ? msg._data : {};
  const rawData = raw && raw._data && typeof raw._data === 'object' ? raw._data : {};

  return text(
    msg.mediaGroupId ||
    msg.groupId ||
    msgData.mediaGroupId ||
    msgData.groupId ||
    raw.mediaGroupId ||
    raw.groupId ||
    rawData.mediaGroupId ||
    rawData.groupId ||
    ''
  );
}

function sessionKeyFromCtx(ctx) {
  const chatKey = chatKeyFromCtx(ctx);
  const senderKey = senderKeyFromCtx(ctx);
  if (!chatKey || !senderKey) return '';
  return `${chatKey}::${senderKey}`;
}

function create(deps) {
  const cfg = deps.cfg;
  const recentQuoteReplyMap = new Map();
  const bulkWindowMs = Math.max(1000, toInt(cfg.replyMediaDownloadTimeoutMs, 15000));

  function cleanupReplySessions(nowMs) {
    for (const [key, value] of recentQuoteReplyMap.entries()) {
      if (!value || Number(value.expiresAtMs || 0) <= nowMs) {
        recentQuoteReplyMap.delete(key);
      }
    }
  }

  function rememberReplySession(ctx, ticketId) {
    const key = sessionKeyFromCtx(ctx);
    if (!key || !ticketId) return;
    const mediaGroupKey = mediaGroupKeyFromCtx(ctx);
    recentQuoteReplyMap.set(key, {
      ticketId: text(ticketId),
      chatKey: chatKeyFromCtx(ctx),
      senderKey: senderKeyFromCtx(ctx),
      mediaGroupKey: text(mediaGroupKey),
      expiresAtMs: Date.now() + bulkWindowMs,
    });
  }

  function resolveContinuationTicketId(ctx) {
    const key = sessionKeyFromCtx(ctx);
    if (!key) return '';
    const row = recentQuoteReplyMap.get(key);
    if (!row) return '';

    const nowMs = Date.now();
    if (Number(row.expiresAtMs || 0) <= nowMs) {
      recentQuoteReplyMap.delete(key);
      return '';
    }

    const currentMediaGroupKey = mediaGroupKeyFromCtx(ctx);
    if (text(row.mediaGroupKey) && currentMediaGroupKey && text(row.mediaGroupKey) !== text(currentMediaGroupKey)) {
      return '';
    }

    row.expiresAtMs = nowMs + bulkWindowMs;
    recentQuoteReplyMap.set(key, row);
    return text(row.ticketId);
  }

  async function onGroupMessage(ctx) {
    if (!ctx || !ctx.isGroup) return;

    cleanupReplySessions(Date.now());

    const quoteParsedRaw = await deps.parseQuote(ctx, cfg);
    const contextQuotedText = quotedTextFromContextInfo(ctx);
    const quoteParsed = quoteParsedRaw && typeof quoteParsedRaw === 'object'
      ? Object.assign({}, quoteParsedRaw)
      : null;

    if (quoteParsed && !text(quoteParsed.quotedText) && contextQuotedText) {
      quoteParsed.quotedText = contextQuotedText;
    }
    if (quoteParsed && !quoteParsed.quotedDetected && contextQuotedText) {
      quoteParsed.quotedDetected = true;
    }

    const explicitQuotedTicketId = resolvedQuotedTicketId(ctx, cfg, quoteParsed);
    const bindParsed = parseBind(ctx, cfg);
    const moveParsed = parseMove(ctx, cfg, quoteParsed);
    const quickParsed = parseQuick(ctx, cfg, quoteParsed);
    const commandParsed = parseCommand(ctx, cfg);

    const hasQuotedContext = !!(
      (quoteParsed && quoteParsed.quotedDetected) ||
      contextQuotedText
    );
    const explicitTicket = explicitQuotedTicketId || text(commandParsed && commandParsed.ticketId) || text(quickParsed && quickParsed.ticketId);
    const continuationTicketId = !explicitTicket && !hasQuotedContext && !bindParsed && !moveParsed && !quickParsed && !commandParsed && hasMediaCtx(ctx)
      ? resolveContinuationTicketId(ctx)
      : '';
    const hasTicket = !!(explicitTicket || continuationTicketId);
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
    if (quoteParsed && (quoteParsed.quotedDetected || explicitQuotedTicketId)) {
      payload = Object.assign({}, quoteParsed, {
        source: 'quote',
        ticketId: explicitQuotedTicketId || text(quoteParsed.ticketId),
      });
    }
    if (!payload && hasQuotedContext) {
      payload = {
        source: 'quote',
        quotedDetected: true,
        quotedText: contextQuotedText,
        ticketId: explicitQuotedTicketId,
        body: messageTextFromCtx(ctx),
      };
    }
    if (!payload && commandParsed) payload = commandParsed;
    if (!payload && continuationTicketId) {
      payload = {
        source: 'quote_bulk',
        ticketId: continuationTicketId,
        body: messageTextFromCtx(ctx),
      };
    }
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

    if (isMediaReply) {
      rememberReplySession(ctx, ticketId);
    } else {
      cleanupReplySessions(0);
    }

    if (payload.source !== 'quote_bulk') {
      await deps.sendStaffReply(ctx, cfg.replyReplySent);
    }
    if (typeof ctx.stopPropagation === 'function') {
      ctx.stopPropagation();
    }
  }

  return { onGroupMessage };
}

module.exports = {
  create,
};