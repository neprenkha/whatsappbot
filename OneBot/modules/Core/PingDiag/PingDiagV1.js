'use strict';

/*
PingDiagV1 (Core)
- Provides !ping
- ASCII-only
*/

function toStr(v, defVal) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s ? s : (defVal || '');
}

module.exports.init = async function init(meta) {
  const cfg = (meta && meta.implConf) || {};
  const cmdPing = toStr(cfg.cmdPing, 'ping');

  async function reply(ctx, text) {
    const msg = String(text || '').trim();
    if (!msg) return;

    try {
      if (ctx && typeof ctx.reply === 'function') {
        await ctx.reply(msg);
        return;
      }
    } catch (_) {}

    try {
      const send = meta && meta.getService ? meta.getService('send') : null;
      if (typeof send === 'function' && ctx && ctx.chatId) {
        await send(ctx.chatId, msg, {});
      }
    } catch (_) {}
  }

  const cmd = meta && meta.getService ? (meta.getService('command') || meta.getService('commands')) : null;
  if (!cmd || typeof cmd.register !== 'function') {
    try { meta.log('PingDiagV1', 'error missing command service (load Command module before PingDiag)'); } catch (_) {}
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  cmd.register(
    cmdPing,
    async (ctx) => {
      const tz = meta && meta.getService ? meta.getService('timezone') : null;
      const now = tz && typeof tz.formatNow === 'function' ? tz.formatNow() : new Date().toISOString();
      await reply(ctx, `pong\n${now}`);
    },
    { owner: 'PingDiagV1', help: 'Ping / health check.' }
  );

  try { meta.log('PingDiagV1', `ready cmdPing=${cmdPing}`); } catch (_) {}

  return { onEvent: async () => {}, onMessage: async () => {} };
};
