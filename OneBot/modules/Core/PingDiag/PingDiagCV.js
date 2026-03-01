'use strict';

function text(value) {
  return String(value ?? '').trim();
}

function toBool(value) {
  const s = text(value).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function fill(template, vars) {
  let out = String(template || '');
  Object.keys(vars).forEach((key) => {
    out = out.split(`{${key}}`).join(String(vars[key] ?? ''));
  });
  return out;
}

module.exports = {
  init: async (meta) => {
    const logTag = 'PingDiagCV';
    const cfg = meta.implConf || {};

    const requiredKeys = [
      'cmdPing',
      'cmdDiag',
      'minRolePing',
      'minRoleDiag',
      'replyNoAccess',
      'pingReplyTemplate',
      'diagReplyTemplate',
      'cmdPingHelp',
      'cmdDiagHelp',
    ];

    const missing = requiredKeys.filter((key) => !text(cfg[key]));
    const bugLogEnabled = toBool(cfg.bugLog);

    if (missing.length) {
      if (bugLogEnabled) {
        meta.log(logTag, `config invalid missing=${missing.join(',')}`);
      }
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const cmdPing = text(cfg.cmdPing).toLowerCase();
    const cmdDiag = text(cfg.cmdDiag).toLowerCase();
    const access = meta.getService('access');
    const command = meta.getService('command');

    if (!command || typeof command.register !== 'function') {
      if (bugLogEnabled) {
        meta.log(logTag, 'missing command service');
      }
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    async function sendReply(ctx, payload) {
      const message = text(payload);
      if (!message) return;

      if (ctx && typeof ctx.reply === 'function') {
        await ctx.reply(message);
        return;
      }

      const send = meta.getService('send');
      if (send && ctx && ctx.chatId) {
        await send(ctx.chatId, message, { isAuto: 0 });
      }
    }

    async function isAllowed(ctx, minRole) {
      const need = text(minRole);
      if (!need) return true;
      if (!access) return false;

      if (typeof access.hasRole === 'function') return !!(await access.hasRole(ctx, need));
      if (typeof access.isAllowed === 'function') return !!(await access.isAllowed(ctx, need));
      if (typeof access.check === 'function') return !!(await access.check(ctx, need));
      if (typeof access.meetsMinRole === 'function') return !!(await access.meetsMinRole(ctx, need));
      return false;
    }

    function nowText() {
      const timezone = meta.getService('timezone');
      if (timezone && typeof timezone.formatNow === 'function') {
        return text(timezone.formatNow());
      }
      if (timezone && typeof timezone.nowText === 'function') {
        return text(timezone.nowText());
      }
      return new Date().toISOString();
    }

    function uptimeText() {
      const seconds = Math.max(0, Math.floor(process.uptime()));
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const remain = seconds % 60;
      return `${hours}h ${minutes}m ${remain}s`;
    }

    command.register(cmdPing, async (ctx) => {
      if (!(await isAllowed(ctx, cfg.minRolePing))) {
        await sendReply(ctx, cfg.replyNoAccess);
        return;
      }

      const reply = fill(cfg.pingReplyTemplate, {
        TIME: nowText(),
        UPTIME: uptimeText(),
      });
      await sendReply(ctx, reply);
    }, {
      owner: logTag,
      help: cfg.cmdPingHelp,
      minRole: text(cfg.minRolePing),
    });

    command.register(cmdDiag, async (ctx) => {
      if (!(await isAllowed(ctx, cfg.minRoleDiag))) {
        await sendReply(ctx, cfg.replyNoAccess);
        return;
      }

      const reply = fill(cfg.diagReplyTemplate, {
        TIME: nowText(),
        UPTIME: uptimeText(),
        NODE: process.version,
        PID: process.pid,
      });
      await sendReply(ctx, reply);
    }, {
      owner: logTag,
      help: cfg.cmdDiagHelp,
      minRole: text(cfg.minRoleDiag),
    });

    meta.log(logTag, `ready cmdPing=${cmdPing} cmdDiag=${cmdDiag}`);
    return { onMessage: async () => {}, onEvent: async () => {} };
  },
};