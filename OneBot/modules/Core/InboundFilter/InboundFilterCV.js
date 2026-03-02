'use strict';

function toBool(v, dflt) {
  if (v === undefined || v === null || v === '') return !!dflt;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on' || s === 'enabled' || s === 'enable') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off' || s === 'disabled' || s === 'disable') return false;
  return !!dflt;
}

function toText(v) {
  return String(v === undefined || v === null ? '' : v);
}

function isEmptyText(ctx) {
  return toText(ctx && ctx.text).trim() === '';
}

function isSystemType(t) {
  const type = toText(t).toLowerCase();
  return type === 'protocol' ||
    type === 'e2e_notification' ||
    type === 'notification_template' ||
    type === 'notification' ||
    type === 'ciphertext';
}

function getChatId(ctx) {
  return toText(ctx && ctx.chatId);
}

function getRawFrom(ctx) {
  return toText(ctx && ctx.raw && ctx.raw.from);
}

function shouldStop(ctx) {
  return !!(ctx && typeof ctx.stopPropagation === 'function');
}

module.exports = {
  init: async (meta) => {
    const cfg = meta.implConf || {};
    const log = typeof meta.log === 'function' ? meta.log : () => {};
    const tag = 'InboundFilterCV';

    const enabled = toBool(cfg.enabled, true);
    const dropStatusBroadcast = toBool(cfg.dropStatusBroadcast, false);
    const dropEmptySystem = toBool(cfg.dropEmptySystem, true);
    const dropFromMe = toBool(cfg.dropFromMe, false);

    if (!enabled) {
      log(tag, 'disabled enabled=0');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    log(
      tag,
      'ready enabled=1 dropStatusBroadcast=' + (dropStatusBroadcast ? '1' : '0') +
      ' dropEmptySystem=' + (dropEmptySystem ? '1' : '0') +
      ' dropFromMe=' + (dropFromMe ? '1' : '0')
    );

    async function onMessage(ctx) {
      if (!ctx) return;

      const chatId = getChatId(ctx);
      const rawFrom = getRawFrom(ctx);

      if (dropStatusBroadcast) {
        if (chatId === 'status@broadcast' || rawFrom === 'status@broadcast') {
          if (shouldStop(ctx)) ctx.stopPropagation();
          return;
        }
      }

      if (dropFromMe) {
        if (ctx.raw && ctx.raw.fromMe === true) {
          if (shouldStop(ctx)) ctx.stopPropagation();
          return;
        }
      }

      if (dropEmptySystem) {
        const rawType = ctx.raw && ctx.raw.type;
        if (isSystemType(rawType) && isEmptyText(ctx)) {
          if (shouldStop(ctx)) ctx.stopPropagation();
          return;
        }

        const isStatus = !!(ctx.raw && ctx.raw.isStatus === true);
        const isNotification = !!(ctx.raw && ctx.raw._data && ctx.raw._data.isNotification === true);
        if ((isStatus || isNotification) && isEmptyText(ctx)) {
          if (shouldStop(ctx)) ctx.stopPropagation();
        }
      }
    }

    return {
      onMessage,
      onEvent: async () => {},
    };
  },
};