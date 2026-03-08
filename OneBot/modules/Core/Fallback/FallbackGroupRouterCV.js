'use strict';

function text(value) {
  return String(value ?? '').trim();
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

  return text(globalConf && globalConf.controlGroupId);
}

module.exports = {
  resolveTargetGroup,
};