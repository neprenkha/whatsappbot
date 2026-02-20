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

function toBool(v, defVal) {
  const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  if (!s) return !!defVal;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

module.exports.init = async function init(meta) {
  const cfg = (meta && meta.implConf) || {};
  const cmdPing = toStr(cfg.cmdPing, 'ping');
  const cmdPingHelp = toStr(cfg.cmdPingHelp, '');
  const pingReplyTemplate = toStr(cfg.pingReplyTemplate, '');
  const moduleLog = toBool(cfg.moduleLog, true);
  const traceLog = toBool(cfg.traceLog, false);

  function logExec(ctx) {
    if (!moduleLog && !traceLog) return;
    const chatId = String((ctx && ctx.chatId) || '');
    const isGroup = ctx && ctx.isGroup ? 1 : 0;
    meta.log('PingDiagV1', 'exec cmd=' + cmdPing + ' chatId=' + chatId + ' isGroup=' + isGroup + ' manualReply=1');
  }

  function formatNow() {
    const tz = meta && meta.getService ? meta.getService('timezone') : null;
    if (tz) {
      if (typeof tz.formatNow === 'function') return tz.formatNow();
      if (typeof tz.isoNow === 'function') return tz.isoNow();
    }
    return new Date().toISOString();
  }

  function buildPingReply(now) {
    if (!pingReplyTemplate) {
      try { meta.log('PingDiagV1', 'bug missing pingReplyTemplate in implConf'); } catch (_) {}
      return '';
    }
    return pingReplyTemplate.split('{TIME}').join(String(now || ''));
  }

  async function reply(ctx, text) {
    const msg = String(text || '').trim();
    if (!msg) return;

    try {
      if (ctx && typeof ctx.reply === 'function') {
        await ctx.reply(msg, { manualReply: 1 });
        return;
      }
    } catch (_) {}

    try {
      const send = meta && meta.getService ? meta.getService('send') : null;
      if (typeof send === 'function' && ctx && ctx.chatId) {
        await send(ctx.chatId, msg, { manualReply: 1 });
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
      logExec(ctx);
      const now = formatNow();
      const msg = buildPingReply(now);
      if (!msg) return;
      await reply(ctx, msg);
    },
    { owner: 'PingDiagV1', help: cmdPingHelp }
  );

  try { meta.log('PingDiagV1', 'ready cmdPing=' + cmdPing); } catch (_) {}

  return { onEvent: async () => {}, onMessage: async () => {} };
};