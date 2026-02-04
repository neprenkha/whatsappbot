'use strict';

/**
 * SystemControlV2
 * - restart, status
 * - FIX: cfg was undefined (caused crash)
 * - RULE: ASCII only
 */

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
    await ctx.reply(msg);
    return;
  }

  const sendSvc = (typeof meta.getService === 'function') ? meta.getService('send') : null;
  if (typeof sendSvc === 'function' && ctx && ctx.chatId) {
    await sendSvc(ctx.chatId, msg, {});
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports.init = async function init(meta) {
  const cfg = meta.implConf || {}; // FIX: define cfg

  const controlGroupId = String(cfg.controlGroupId || '').trim();
  const cmdRestart = String(cfg.cmdRestart || 'restart').trim().toLowerCase();
  const cmdStatus = String(cfg.cmdStatus || 'status').trim().toLowerCase();

  const minRoleRestart = String(cfg.minRoleRestart || 'admin').trim().toLowerCase();
  const replyNoAccess = String(cfg.replyNoAccess || '').trim();
  const replyRestarting = String(cfg.replyRestarting || '').trim();

  const cmdSvc =
    (typeof meta.getService === 'function')
      ? (meta.getService('command') || meta.getService('commands'))
      : null;

  const accessSvc =
    (typeof meta.getService === 'function')
      ? (meta.getService('access') || meta.getService('roles'))
      : null;

  function isControlGroup(chatId) {
    if (!controlGroupId) return false;
    return String(chatId || '') === controlGroupId;
  }

  function senderKey(ctx) {
    const s = (ctx && ctx.sender) || {};
    const lidDigits = String(s.lid || '').replace(/[^0-9]/g, '');
    if (lidDigits) return `lid:${lidDigits}`;

    // Backward compatible: fall back to id/phone as-is.
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

  async function handleRestart(ctx) {
    if (!canRun(ctx, minRoleRestart)) {
      await safeReply(meta, ctx, replyNoAccess);
      return { stop: true };
    }

    if (replyRestarting) await safeReply(meta, ctx, replyRestarting);

    // allow queue time
    await sleep(1200);
    process.exit(100);
  }

  async function handleStatus(ctx) {
    if (!isControlGroup(ctx.chatId)) return { stop: true };

    const lines = [];
    lines.push(`Bot: ${String(meta.botName || '').trim() || 'ONEBOT'}`);
    lines.push(`Time: ${formatNow()}`);
    lines.push(`Uptime: ${formatUptime(process.uptime())}`);

    await safeReply(meta, ctx, lines.join('\n'));
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
