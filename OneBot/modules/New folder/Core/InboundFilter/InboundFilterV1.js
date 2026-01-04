// InboundFilterV1.js
// Drops/ignores non-user inbound noise so it never triggers downstream modules (e.g., Fallback).
//
// Typical use: stop forwarding status@broadcast / system notifications to Control Group.
//
// HubConf keys (InboundFilter.conf):
// enabled=1
// dropStatusBroadcast=1
// dropEmptySystem=1
// dropFromMe=0
//
// Notes:
// - Uses ctx.stopPropagation() to prevent further module handling.
// - Designed to be safe if any fields are missing.

function toBool(v, defVal = false) {
  if (v === true || v === false) return v;
  if (v === undefined || v === null) return defVal;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on', 'enable', 'enabled'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'disable', 'disabled'].includes(s)) return false;
  return defVal;
}

function safeTag(meta, tag, msg) {
  try {
    if (meta && typeof meta.log === 'function') return meta.log(tag, msg);
  } catch (_) {}
  try { console.log(`[${tag}] ${msg}`); } catch (_) {}
}

module.exports = {
  init: (meta) => {
    const cfg = (meta && meta.hubConf) ? meta.hubConf : {};
    const enabled = toBool(cfg.enabled, false);

    const dropStatusBroadcast = toBool(cfg.dropStatusBroadcast, true);
    const dropEmptySystem = toBool(cfg.dropEmptySystem, true);
    const dropFromMe = toBool(cfg.dropFromMe, false);

    if (!enabled) {
      safeTag(meta, 'InboundFilterV1', 'disabled: enabled=0');
      return {
        onMessage: async () => {},
        onEvent: async () => {},
      };
    }

    safeTag(meta, 'InboundFilterV1', `ready enabled=1 dropStatusBroadcast=${dropStatusBroadcast ? 1 : 0} dropEmptySystem=${dropEmptySystem ? 1 : 0} dropFromMe=${dropFromMe ? 1 : 0}`);

    const shouldDropSystemType = (t) => {
      const type = String(t || '').toLowerCase();
      return ['protocol', 'e2e_notification', 'notification_template', 'notification', 'ciphertext'].includes(type);
    };

    const isEmptyText = (ctx) => {
      const txt = (ctx && typeof ctx.text === 'string') ? ctx.text.trim() : '';
      return !txt;
    };

    return {
      onMessage: async (ctx) => {
        try {
          if (!ctx) return;

          // 1) Status broadcast never forward
          if (dropStatusBroadcast) {
            const chatId = String(ctx.chatId || '');
            const rawFrom = String(ctx.raw?.from || '');
            if (chatId === 'status@broadcast' || rawFrom === 'status@broadcast') {
              ctx.stopPropagation();
              return;
            }
          }

          // 2) Optional: drop messages sent by the bot itself
          if (dropFromMe) {
            if (ctx.raw && ctx.raw.fromMe === true) {
              ctx.stopPropagation();
              return;
            }
          }

          // 3) Drop empty system notifications (group events etc.)
          if (dropEmptySystem) {
            const t = ctx.raw?.type;
            if (shouldDropSystemType(t) && isEmptyText(ctx)) {
              ctx.stopPropagation();
              return;
            }

            // WhatsApp-web.js can mark system-ish events
            const isStatus = ctx.raw?.isStatus === true;
            const isNotification = ctx.raw?._data?.isNotification === true;
            if ((isStatus || isNotification) && isEmptyText(ctx)) {
              ctx.stopPropagation();
              return;
            }
          }
        } catch (e) {
          safeTag(meta, 'InboundFilterV1', `WARN: onMessage error ${e && e.message ? e.message : e}`);
        }
      },

      onEvent: async (ctx) => {
        // Keep minimal; don't block events unless explicitly needed
        try { void ctx; } catch (_) {}
      },
    };
  },
};
