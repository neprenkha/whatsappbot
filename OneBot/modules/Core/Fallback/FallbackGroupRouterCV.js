'use strict';

function text(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function isExternalCustomerCtx(ctx) {
  if (!ctx || ctx.isGroup) return false;
  if (ctx.fromMe || (ctx.raw && ctx.raw.fromMe)) return false;
  const chatId = lower(ctx.chatId);
  if (!chatId) return false;
  if (chatId === 'status@broadcast') return false;
  return chatId.endsWith('@c.us') || chatId.endsWith('@s.whatsapp.net') || chatId.endsWith('@lid');
}

async function resolveTargetGroup(meta, cfg, globalConf, ctx) {
  const workgroups = meta && typeof meta.getService === 'function'
    ? meta.getService('workgroups')
    : null;

  if (workgroups && typeof workgroups.resolve === 'function') {
    const resolved = await workgroups.resolve(text(cfg.defaultGroupKey), ctx);
    if (resolved && typeof resolved === 'object') {
      const fromObj = text(resolved.groupChatId || resolved.chatId || resolved.id);
      if (fromObj) return fromObj;
    }
    const fromRaw = text(resolved);
    if (fromRaw) return fromRaw;
  }

  if (isExternalCustomerCtx(ctx)) {
    return text(globalConf && globalConf.controlGroupId);
  }
  return '';
}

module.exports = {
  resolveTargetGroup,
};