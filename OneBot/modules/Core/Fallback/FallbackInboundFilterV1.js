'use strict';

// FallbackInboundFilterV1
// Purpose: decide whether an inbound event should be handled by Fallback.

function safeStr(v) {
  return String(v || '').trim();
}

function digits(v) {
  return safeStr(v).replace(/\D+/g, '');
}

function hasMedia(ctx) {
  try {
    if (ctx && ctx.attachments && Array.isArray(ctx.attachments) && ctx.attachments.length > 0) return true;
    if (ctx && ctx.media && (Array.isArray(ctx.media) ? ctx.media.length > 0 : true)) return true;
    if (ctx && ctx.raw) {
      const r = ctx.raw;
      if (r.hasMedia) return true;
      if (typeof r.downloadMedia === 'function') return true;
      if (r.mimetype) return true;
    }
  } catch (_) {}
  return false;
}

function shouldCapture(meta, cfg, ctx) {
  const chatId = safeStr(ctx && ctx.chatId);
  const text = safeStr(ctx && ctx.text);

  if (!chatId) return { ok: false, reason: 'nochatid' };

  // ignore status broadcasts
  if (chatId === 'status@broadcast') return { ok: false, reason: 'status' };

  // ignore control group itself (avoid loops)
  const controlGroupId = safeStr(cfg && cfg.controlGroupId);
  if (controlGroupId && chatId === controlGroupId) return { ok: false, reason: 'controlgroup' };

  // ignore explicitly
  const ignoreChatIds = (cfg && cfg.ignoreChatIds) || [];
  if (Array.isArray(ignoreChatIds) && ignoreChatIds.map(safeStr).includes(chatId)) {
    return { ok: false, reason: 'ignored' };
  }

  // groups
  const isGroup = !!(ctx && ctx.isGroup);
  if (isGroup) {
    const forwardGroups = Number(cfg && cfg.forwardGroups) || 0;
    if (!forwardGroups) return { ok: false, reason: 'groupoff' };
    return { ok: true, kind: 'group' };
  }

  // DM only
  const forwardDm = Number(cfg && cfg.forwardDm) || 1;
  if (!forwardDm) return { ok: false, reason: 'dmoff' };

  // ignore empty DM (but allow media-only)
  const ignoreEmpty = Number(cfg && cfg.ignoreEmpty) || 0;
  if (ignoreEmpty && !text && !hasMedia(ctx)) return { ok: false, reason: 'empty' };

  // ignore outbound from me (prevents loops), BUT allow self-chat for testing when enabled.
  if (ctx && (ctx.fromMe || (ctx.raw && ctx.raw.fromMe))) {
    const allowSelfChatFromMe = Number(cfg && cfg.allowSelfChatFromMe) || 0;
    if (allowSelfChatFromMe) {
      const chatId = safeStr(ctx && ctx.chatId);
      const senderId = safeStr(ctx && ctx.sender && (ctx.sender.id || ctx.sender.phone || ctx.sender.lid));
      const c = digits(chatId);
      const s = digits(senderId);
      const isSelfChat = !!c && !!s && c === s;
      if (!isSelfChat) return { ok: false, reason: 'fromme' };
      // self-chat allowed (DM only)
    } else {
      return { ok: false, reason: 'fromme' };
    }
  }

  return { ok: true, kind: 'dm' };
}

module.exports = {
  shouldCapture,
  hasMedia,
};
