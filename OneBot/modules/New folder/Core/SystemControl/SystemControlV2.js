'use strict';

/**
 * SystemControlV2 (Core)
 * - restart, status
 * Fix: ensure "Restarting..." message is actually sent before process.exit
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
  const controlGroupId = String(meta.implConf.controlGroupId || '').trim();

  const cmdRestart = String(meta.implConf.cmdRestart || 'restart').trim().toLowerCase();
  const cmdStatus  = String(meta.implConf.cmdStatus  || 'status').trim().toLowerCase();

  const minRoleRestart = String(meta.implConf.minRoleRestart || 'admin').trim().toLowerCase();
  const replyNoAccess  = String(meta.implConf.replyNoAccess  || 'You are not allowed to run this command.').trim();

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
    return String(s.id || s.phone || '').trim();
  }

  function canRun(ctx, minRole) {
    if (!isControlGroup(ctx.chatId)) return false;

    const key = senderKey(ctx);

    if (accessSvc) {
      if (typeof accessSvc.hasAtLeast === 'function') return !!accessSvc.hasAtLeast(key, minRole);
      if (typeof accessSvc.isAtLeast === 'function') return !!accessSvc.isAtLeast(key, minRole);

      if (typeof accessSvc.getRole === 'function') {
        const role = accessSvc.getRole(key);
        return roleRank(role) >= roleRank(minRole);
      }
    }
    return false;
  }

  function formatNow() {
    const tz = (typeof meta.getService === 'function')
      ? (meta.getService('tz') || meta.getService('timezone'))
      : null;

    if (tz) {
      if (typeof tz.formatNow === 'function') return tz.formatNow();
      if (typeof tz.nowText === 'function') return tz.nowText();
      if (typeof tz.format === 'function') return tz.format(new Date());
    }
    return new Date().toISOString();
  }

  function countCommands() {
    if (!cmdSvc || typeof cmdSvc.list !== 'function') return 0;
    try { return cmdSvc.list().filter(Boolean).length; } catch { return 0; }
  }

  async function handleRestart(ctx) {
    if (!canRun(ctx, minRoleRestart)) {
      ctx.__noAccess = true;
      await safeReply(meta, ctx, replyNoAccess);
      return { stop: true };
    }

    // Send notify first
    await safeReply(meta, ctx, '🔄 Restarting ONEBOT...');

    // Give SendQueue time to actually send (your delayMs=800)
    // Do NOT hard depend on queue internals (keep SystemControl single-purpose)
    await sleep(1200);

    process.exit(100);
  }

  async function handleStatus(ctx) {
    if (!isControlGroup(ctx.chatId)) return { stop: true };

    const meKey = senderKey(ctx);
    const myRole = (accessSvc && typeof accessSvc.getRole === 'function') ? accessSvc.getRole(meKey) : 'unknown';
    const myName = (accessSvc && typeof accessSvc.getName === 'function') ? accessSvc.getName(meKey) : '';

    let countsLine = '';
    if (accessSvc && typeof accessSvc.listSummary === 'function') {
      const sum = accessSvc.listSummary();
      countsLine = `Controllers: ${sum.controllersCount} | Admins: ${sum.adminsCount} | Staff: ${sum.staffCount}`;
    }

    const mem = process.memoryUsage ? process.memoryUsage() : null;
    const rssMb = mem && mem.rss ? Math.round(mem.rss / 1024 / 1024) : 0;

    const lines = [];
    lines.push(`Bot: ${String(meta.botName || '').trim() || 'ONEBOT'}`);
    lines.push(`Time: ${formatNow()}`);
    lines.push(`Uptime: ${formatUptime(process.uptime())}`);
    lines.push(`You: ${myRole}${myName ? ` (${myName})` : ''}`);
    if (countsLine) lines.push(countsLine);
    lines.push(`Commands: ${countCommands()}`);
    if (rssMb) lines.push(`Memory: ${rssMb} MB (rss)`);
    lines.push('Core: Log / TimeZone / SendQueue / Command / AccessRoles / Help / PingDiag / Scheduler / SystemControl');

    await safeReply(meta, ctx, lines.join('\n'));
    return { stop: true };
  }

  function registerCompat(name, fn, helpText) {
    if (!cmdSvc || typeof cmdSvc.register !== 'function') return false;

    try {
      cmdSvc.register(name, async (ctx) => fn(ctx), { owner: 'SystemControlV2', help: helpText });
      return true;
    } catch {}

    try {
      cmdSvc.register(name, async (ctx, _cmd) => fn(ctx), { desc: helpText, usage: `!${name}` });
      return true;
    } catch {}

    try {
      cmdSvc.register({
        name,
        description: helpText,
        usage: `!${name}`,
        moduleId: 'SystemControlV2',
        handler: async ({ ctx }) => fn(ctx),
      });
      return true;
    } catch {}

    return false;
  }

  if (!cmdSvc || typeof cmdSvc.register !== 'function') {
    meta.log('SystemControlV2', 'error missing Command service (load Command module before SystemControl)');
  } else {
    registerCompat(cmdRestart, handleRestart, 'Restart bot process.');
    registerCompat(cmdStatus,  handleStatus,  'Show bot status (uptime, counts).');
  }

  meta.log('SystemControlV2', `ready controlGroupId=${controlGroupId} cmdRestart=${cmdRestart} cmdStatus=${cmdStatus}`);

  return { onEvent: async () => {}, onMessage: async () => {} };
};
