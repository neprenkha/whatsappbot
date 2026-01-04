'use strict';

/**
 * PingDiagV1 (Core)
 * - Provides !ping
 */

function toStr(v, def = '') {
  const s = String(v ?? '').trim();
  return s ? s : def;
}

module.exports.init = async function init(meta) {
  const cmdPing = toStr(meta.implConf.cmdPing, 'ping');

  async function reply(ctx, text) {
    const msg = String(text || '').trim();
    if (!msg) return;
    if (ctx && typeof ctx.reply === 'function') return ctx.reply(msg);

    const send = meta.getService('send');
    if (send && ctx && ctx.chatId) return send(ctx.chatId, msg, {});
  }

  const cmd = meta.getService('command') || meta.getService('commands');
  if (!cmd || typeof cmd.register !== 'function') {
    meta.log('PingDiagV1', 'error missing command service (load Command module before PingDiag)');
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  cmd.register(cmdPing, async (ctx) => {
    const tz = meta.getService('tz') || meta.getService('timezone');
    const now = tz && typeof tz.formatNow === 'function' ? tz.formatNow() : new Date().toISOString();
    await reply(ctx, `🏓 pong\n${now}`);
  }, { owner: 'PingDiagV1', help: 'Ping / health check.' });

  meta.log('PingDiagV1', `ready cmdPing=${cmdPing}`);

  return { onEvent: async () => {}, onMessage: async () => {} };
};
