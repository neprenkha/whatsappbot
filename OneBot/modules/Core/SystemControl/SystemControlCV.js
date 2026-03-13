'use strict';

function text(value) {
  return String(value ?? '').trim();
}

function keyText(value) {
  return text(value).toLowerCase();
}

function toBool(value) {
  const s = keyText(value);
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function fill(template, vars) {
  let out = String(template || '');
  Object.keys(vars).forEach((name) => {
    out = out.split(`{${name}}`).join(String(vars[name] ?? ''));
  });
  return out;
}

function isValidRoleName(value) {
  const role = keyText(value);
  return role === 'owner' || role === 'admin' || role === 'manager' || role === 'sales' || role === 'staff' || role === 'viewer';
}

module.exports = {
  init: async (meta) => {
    const logTag = 'SystemControlCV';
    const cfg = meta.implConf || {};

    const requiredKeys = [
      'globalConfRel',
      'cmdStatus',
      'cmdRestart',
      'cmdInfo',
      'cmdStatusHelp',
      'cmdRestartHelp',
      'cmdInfoHelp',
      'minRoleStatus',
      'minRoleRestart',
      'minRoleInfo',
      'replyNoAccess',
      'replyControlGroupOnly',
      'replyGroupOnly',
      'replyRestarting',
      'replyRestartUnavailable',
      'statusReplyTemplate',
      'infoReplyTemplate',
      'restartExitCode',
    ];

    const missing = requiredKeys.filter((k) => !text(cfg[k]));
    const bugLogEnabled = toBool(cfg.bugLog);
    if (missing.length) {
      if (bugLogEnabled) meta.log(logTag, `config invalid missing=${missing.join(',')}`);
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    if (!isValidRoleName(cfg.minRoleStatus) || !isValidRoleName(cfg.minRoleRestart) || !isValidRoleName(cfg.minRoleInfo)) {
      if (bugLogEnabled) meta.log(logTag, 'config invalid role names');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const loadedGlobal = typeof meta.loadConfRel === 'function'
      ? (meta.loadConfRel(text(cfg.globalConfRel)) || {})
      : {};
    const globalConf = loadedGlobal && loadedGlobal.conf && typeof loadedGlobal.conf === 'object'
      ? loadedGlobal.conf
      : (loadedGlobal && typeof loadedGlobal === 'object' ? loadedGlobal : {});
    const controlGroupId = text(globalConf.controlGroupId);
    if (!controlGroupId) {
      if (bugLogEnabled) meta.log(logTag, 'global config invalid missing=controlGroupId');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const command = meta.getService('command');
    const access = meta.getService('access');
    const send = meta.getService('send');

    if (!command || typeof command.register !== 'function') {
      if (bugLogEnabled) meta.log(logTag, 'missing command service');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }
    if (typeof send !== 'function') {
      if (bugLogEnabled) meta.log(logTag, 'missing send service');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    async function canAccess(ctx, minRole) {
      const requiredRole = text(minRole);
      if (!requiredRole) return false;
      if (!access) return false;

      if (typeof access.hasRole === 'function') return !!(await access.hasRole(ctx, requiredRole));
      if (typeof access.isAllowed === 'function') return !!(await access.isAllowed(ctx, requiredRole));
      if (typeof access.check === 'function') return !!(await access.check(ctx, requiredRole));
      if (typeof access.meetsMinRole === 'function') return !!(await access.meetsMinRole(ctx, requiredRole));
      return false;
    }

    async function sendReply(ctx, message) {
      const payload = text(message);
      if (!payload) return;

      if (ctx && typeof ctx.reply === 'function') {
        await ctx.reply(payload);
        return;
      }

      const chatId = text(ctx && ctx.chatId);
      if (!chatId) return;
      await send(chatId, payload, { isAuto: 0 });
    }

    async function guardScope(ctx, minRole) {
      if (!ctx || !ctx.isGroup) {
        await sendReply(ctx, cfg.replyGroupOnly);
        return false;
      }
      if (text(ctx.chatId) !== controlGroupId) {
        await sendReply(ctx, cfg.replyControlGroupOnly);
        return false;
      }
      if (!(await canAccess(ctx, minRole))) {
        await sendReply(ctx, cfg.replyNoAccess);
        return false;
      }
      return true;
    }

    function nowText() {
      const timezone = meta.getService('timezone');
      if (timezone && typeof timezone.formatNow === 'function') return text(timezone.formatNow());
      if (timezone && typeof timezone.nowText === 'function') return text(timezone.nowText());
      return new Date().toISOString();
    }

    function uptimeText() {
      const total = Math.max(0, Math.floor(process.uptime()));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      return `${h}h ${m}m ${s}s`;
    }

    function botNameText() {
      return text(globalConf.botName) || text(process.env.BOT_NAME);
    }

    const cmdStatus = keyText(cfg.cmdStatus);
    const cmdRestart = keyText(cfg.cmdRestart);
    const cmdInfo = keyText(cfg.cmdInfo);

    command.register(cmdStatus, async (ctx) => {
      if (!(await guardScope(ctx, cfg.minRoleStatus))) return;

      const message = fill(cfg.statusReplyTemplate, {
        BOT: botNameText(),
        TIME: nowText(),
        UPTIME: uptimeText(),
        PID: process.pid,
        NODE: process.version,
      });
      await sendReply(ctx, message);
    }, {
      owner: logTag,
      help: cfg.cmdStatusHelp,
      minRole: text(cfg.minRoleStatus),
    });

    command.register(cmdRestart, async (ctx) => {
      if (!(await guardScope(ctx, cfg.minRoleRestart))) return;

      const exitCode = Number(text(cfg.restartExitCode));
      if (!Number.isInteger(exitCode) || exitCode < 0) {
        await sendReply(ctx, cfg.replyRestartUnavailable);
        return;
      }

      await sendReply(ctx, cfg.replyRestarting);
      setTimeout(() => {
        process.exit(exitCode);
      }, 10);
    }, {
      owner: logTag,
      help: cfg.cmdRestartHelp,
      minRole: text(cfg.minRoleRestart),
    });

    command.register(cmdInfo, async (ctx) => {
      if (!(await guardScope(ctx, cfg.minRoleInfo))) return;

      const message = fill(cfg.infoReplyTemplate, {
        BOT: botNameText(),
        TIME: nowText(),
        UPTIME: uptimeText(),
        PID: process.pid,
        NODE: process.version,
        PLATFORM: process.platform,
      });
      await sendReply(ctx, message);
    }, {
      owner: logTag,
      help: cfg.cmdInfoHelp,
      minRole: text(cfg.minRoleInfo),
    });

    meta.log(logTag, `ready cmdStatus=${cmdStatus} cmdRestart=${cmdRestart} cmdInfo=${cmdInfo}`);
    return { onMessage: async () => {}, onEvent: async () => {} };
  },
};