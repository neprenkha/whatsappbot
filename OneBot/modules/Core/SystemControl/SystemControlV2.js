'use strict';

/**
 * SystemControlV2
 * - restart, status
 * - RULE: ASCII only
 */

function toBool(v, defVal) {
  const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  if (!s) return !!defVal;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function roleRank(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'controller') return 3;
  if (r === 'admin') return 2;
  if (r === 'staff') return 1;
  return 0;
}

function formatUptime(sec) {
  const s = Math.max(0, Math.floor(Number(sec || 0)));
  const days = Math.floor(s / 86400);
  const rem1 = s % 86400;
  const hrs = Math.floor(rem1 / 3600);
  const rem2 = rem1 % 3600;
  const mins = Math.floor(rem2 / 60);
  const secs = rem2 % 60;
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${days}d ${pad2(hrs)}h ${pad2(mins)}m ${pad2(secs)}s`;
}

async function safeReply(meta, ctx, text) {
  const msg = String(text || '').trim();
  if (!msg) return;

  if (ctx && typeof ctx.reply === 'function') {
    await ctx.reply(msg, { manualReply: 1 });
    return;
  }

  const sendSvc = (typeof meta.getService === 'function') ? meta.getService('send') : null;
  if (typeof sendSvc === 'function' && ctx && ctx.chatId) {
    await sendSvc(ctx.chatId, msg, { manualReply: 1 });
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports.init = async function init(meta) {
  const cfg = meta.implConf || {};

  const controlGroupId = String(cfg.controlGroupId || '').trim();
  const cmdRestart = String(cfg.cmdRestart || 'restart').trim().toLowerCase();
  const cmdStatus = String(cfg.cmdStatus || 'status').trim().toLowerCase();

  const minRoleRestart = String(cfg.minRoleRestart || 'admin').trim().toLowerCase();
  const replyNoAccess = String(cfg.replyNoAccess || '').trim();
  const replyRestarting = String(cfg.replyRestarting || '').trim();
  const statusReplyTemplate = String(cfg.statusReplyTemplate || '').trim();

  const moduleLog = toBool(cfg.moduleLog, true);
  const traceLog = toBool(cfg.traceLog, false);

  const cmdSvc =
    (typeof meta.getService === 'function')
      ? (meta.getService('command') || meta.getService('commands'))
      : null;

  const accessSvc =
    (typeof meta.getService === 'function')
      ? (meta.getService('access') || meta.getService('roles'))
      : null;

  function logExec(cmdName, ctx) {
    if (!moduleLog && !traceLog) return;
    const chatId = String((ctx && ctx.chatId) || '');
    const isGroup = ctx && ctx.isGroup ? 1 : 0;
    meta.log('SystemControlV2', 'exec cmd=' + String(cmdName || '') + ' chatId=' + chatId + ' isGroup=' + isGroup + ' manualReply=1');
  }

  function isControlGroup(chatId) {
    if (!controlGroupId) return false;
    return String(chatId || '') === controlGroupId;
  }

  function senderKey(ctx) {
    const s = (ctx && ctx.sender) || {};
    const lidDigits = String(s.lid || '').replace(/[^0-9]/g, '');
    if (lidDigits) return `lid:${lidDigits}`;

    return String(s.id || s.phone || '').trim();
  }

  function canRun(ctx, minRole) {
    if (!isControlGroup(ctx.chatId)) return false;
    const key = senderKey(ctx);
    if (!key) return false;

    if (accessSvc) {
      if (typeof accessSvc.hasAtLeast === 'function') return !!accessSvc.hasAtLeast(key, minRole);
      if (typeof accessSvc.getRole === 'function') {
        const role = accessSvc.getRole(key);
        return roleRank(role) >= roleRank(minRole);
      }
    }
    return false;
  }

  function formatNow() {
    const tz = (typeof meta.getService === 'function')
      ? meta.getService('timezone')
      : null;

    if (tz) {
      if (typeof tz.formatNow === 'function') return tz.formatNow();
      if (typeof tz.isoNow === 'function') return tz.isoNow();
    }
    return new Date().toISOString();
  }

  function buildStatusReply() {
    if (!statusReplyTemplate) {
      meta.log('SystemControlV2', 'bug missing statusReplyTemplate in implConf');
      return '';
    }

    const bot = String(meta.botName || '').trim() || 'ONEBOT';
    const now = formatNow();
    const uptime = formatUptime(process.uptime());

    return statusReplyTemplate
      .split('{BOT}').join(bot)
      .split('{TIME}').join(now)
      .split('{UPTIME}').join(uptime);
  }

  async function handleRestart(ctx) {
    logExec(cmdRestart, ctx);

    if (!canRun(ctx, minRoleRestart)) {
      await safeReply(meta, ctx, replyNoAccess);
      return { stop: true };
    }

    if (replyRestarting) await safeReply(meta, ctx, replyRestarting);

    await sleep(1200);
    process.exit(100);
  }

  async function handleStatus(ctx) {
    logExec(cmdStatus, ctx);

    if (!isControlGroup(ctx.chatId)) return { stop: true };

    const reply = buildStatusReply();
    if (!reply) return { stop: true };

    await safeReply(meta, ctx, reply);
    return { stop: true };
  }

  function registerCompat(name, fn) {
    if (!cmdSvc || typeof cmdSvc.register !== 'function') return false;
    try {
      cmdSvc.register(name, async (ctx) => fn(ctx));
      return true;
    } catch (_) {
      return false;
    }
  }

  if (!cmdSvc || typeof cmdSvc.register !== 'function') {
    meta.log('SystemControlV2', 'error missing Command service');
  } else {
    registerCompat(cmdRestart, handleRestart);
    registerCompat(cmdStatus, handleStatus);
  }

  meta.log('SystemControlV2', `ready controlGroupId=${controlGroupId} cmdRestart=${cmdRestart} cmdStatus=${cmdStatus}`);
  return { onEvent: async () => {}, onMessage: async () => {} };
};