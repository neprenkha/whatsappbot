'use strict';

// FallbackGroupGateV1
// Purpose: centralize "which groups can run fallback replies" and "where inbound DM should be forwarded".
// This keeps routing logic out of the orchestrator and reply handlers.

function safeStr(v) {
  return String(v || '').trim();
}

function splitIds(v) {
  const s = safeStr(v);
  if (!s) return [];
  return s.split(',').map(x => safeStr(x)).filter(Boolean);
}

function pickWorkGroups(meta, cfg) {
  const name = safeStr(cfg && cfg.workgroupsService) || 'workgroups';
  try {
    if (!meta || typeof meta.getService !== 'function') return null;
    return meta.getService(name) || meta.getService('workgroups') || meta.getService('workGroups') || null;
  } catch (_) {
    return null;
  }
}

function isAllowedReplyGroup(meta, cfg, ctx) {
  if (!ctx || !ctx.isGroup) return false;
  const chatId = safeStr(ctx.chatId);
  if (!chatId) return false;

  const controlGroupId = safeStr(cfg && cfg.controlGroupId);
  if (controlGroupId && chatId === controlGroupId) return true;

  const svc = pickWorkGroups(meta, cfg);
  if (svc && typeof svc.isAllowedGroup === 'function') {
    try {
      return !!svc.isAllowedGroup(chatId);
    } catch (_) {}
  }

  const allowList = splitIds(cfg && cfg.allowedGroupIds);
  if (allowList.length && allowList.includes(chatId)) return true;

  return false;
}

function pickInboxGroupId(meta, cfg, ctx) {
  const svc = pickWorkGroups(meta, cfg);
  if (svc && typeof svc.pickFallbackGroup === 'function') {
    try {
      const gid = safeStr(svc.pickFallbackGroup(ctx));
      if (gid) return gid;
    } catch (_) {}
  }
  return safeStr(cfg && cfg.controlGroupId);
}

module.exports = {
  pickWorkGroups,
  isAllowedReplyGroup,
  pickInboxGroupId,
};
