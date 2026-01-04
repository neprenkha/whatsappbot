'use strict';

/*
  SystemControlV1 (CORE)
  - Roles + basic system commands
  - Roles stored in roles.json (admins/staff/names)
  - Controllers come from .conf (not written to roles.json)
  - Prefer LID in groups (phone may be hidden)
*/

const fs = require('fs');
const path = require('path');

function safeReadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function normDigits(s) {
  return String(s || '').replace(/[^\d]/g, '');
}

function normalizeKey(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  const lower = raw.toLowerCase();

  if (lower.startsWith('lid:')) {
    const d = normDigits(raw.slice(4));
    return d ? `lid:${d}` : '';
  }
  if (lower.startsWith('phone:')) {
    const d = normDigits(raw.slice(6));
    return d ? `phone:${d}` : '';
  }

  // Accept whatsapp ids
  if (raw.endsWith('@lid')) {
    const d = normDigits(raw.slice(0, -4));
    return d ? `lid:${d}` : '';
  }
  if (raw.endsWith('@c.us')) {
    const d = normDigits(raw.slice(0, -5));
    return d ? `phone:${d}` : '';
  }

  // If numeric: decide phone vs lid
  const d = normDigits(raw);
  if (!d) return '';

  // If starts with 60 (Malaysia) treat as phone
  if (d.startsWith('60')) return `phone:${d}`;

  // Otherwise default to lid (matches how your group sender id appears)
  return `lid:${d}`;
}

function parseList(v) {
  const t = String(v || '').trim();
  if (!t) return [];
  return t.split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
}

function decodeTemplate(s) {
  return String(s || '').replace(/\\n/g, '\n');
}

function roleRank(role) {
  switch (String(role || '').toLowerCase()) {
    case 'controller': return 3;
    case 'admin': return 2;
    case 'staff': return 1;
    default: return 0;
  }
}

function pickBestLidFromCtx(ctx) {
  const sid = String(ctx?.sender?.id || '');
  if (sid.endsWith('@lid')) return normDigits(sid.slice(0, -4));

  const lidField = normDigits(ctx?.sender?.lid || '');
  if (lidField) return lidField;

  return '';
}

function buildSenderKeys(ctx) {
  const keys = [];

  const sid = String(ctx?.sender?.id || '').trim();
  if (sid.endsWith('@lid')) {
    const d = normDigits(sid.slice(0, -4));
    if (d) keys.push(`lid:${d}`);
  } else if (sid.endsWith('@c.us')) {
    const d = normDigits(sid.slice(0, -5));
    if (d) keys.push(`phone:${d}`);
  }

  const lidField = normDigits(ctx?.sender?.lid || '');
  if (lidField) keys.push(`lid:${lidField}`);

  const phoneField = normDigits(ctx?.sender?.phone || '');
  if (phoneField) keys.push(`phone:${phoneField}`);

  return Array.from(new Set(keys));
}

function formatUptime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

async function smartReply(meta, ctx, text) {
  if (!text) return;

  if (ctx && typeof ctx.reply === 'function') {
    return ctx.reply(text);
  }

  const chatId = String(ctx?.chatId || ctx?.sender?.chatId || '');
  if (!chatId) return;

  const sendSvc = (typeof meta.getService === 'function') ? meta.getService('send') : null;
  if (sendSvc) {
    if (typeof sendSvc.sendText === 'function') return sendSvc.sendText(chatId, text, {});
    if (typeof sendSvc.send === 'function') return sendSvc.send(chatId, text, {});
  }

  const client = (typeof meta.getService === 'function') ? meta.getService('client') : null;
  if (client && typeof client.sendMessage === 'function') {
    return client.sendMessage(chatId, text);
  }
}

async function tryGracefulClose(meta) {
  try {
    const client = (typeof meta.getService === 'function') ? meta.getService('client') : null;
    if (!client) return;

    if (typeof client.destroy === 'function') {
      await Promise.race([
        client.destroy(),
        new Promise(resolve => setTimeout(resolve, 700))
      ]);
      return;
    }

    if (typeof client.logout === 'function') {
      await Promise.race([
        client.logout(),
        new Promise(resolve => setTimeout(resolve, 700))
      ]);
      return;
    }
  } catch {}
}

module.exports.init = async function init(meta) {
  const cfg = meta.implConf || {};

  const commandPrefix = String(cfg.commandPrefix || '!').trim() || '!';
  const controlGroupId = String(cfg.controlGroupId || '').trim();

  const allowInDm = String(cfg.allowInDm ?? '1') === '1';
  const allowInControlGroup = String(cfg.allowInControlGroup ?? '1') === '1';
  const allowInOtherGroups = String(cfg.allowInOtherGroups ?? '0') === '1';

  const cmdWhoami = String(cfg.cmdWhoami || 'whoami').trim();
  const cmdRoles = String(cfg.cmdRoles || 'roles').trim();
  const cmdStatus = String(cfg.cmdStatus || 'status').trim();
  const cmdAdd = String(cfg.cmdAdd || 'add').trim();
  const cmdRemove = String(cfg.cmdRemove || 'remove').trim();
  const cmdDel = String(cfg.cmdDel || '').trim();
  const cmdSetName = String(cfg.cmdSetName || 'setname').trim();
  const cmdHelp = String(cfg.cmdHelp || 'help').trim();
  const cmdRestart = String(cfg.cmdRestart || 'restart').trim();
  const cmdShutdown = String(cfg.cmdShutdown || 'shutdown').trim();

  const removeCmds = new Set([cmdRemove, cmdDel].map(s => String(s || '').trim()).filter(Boolean));

  const minRoleWhoami = String(cfg.minRoleWhoami || 'guest').trim();
  const minRoleRoles = String(cfg.minRoleRoles || 'staff').trim();
  const minRoleStatus = String(cfg.minRoleStatus || 'staff').trim();
  const minRoleAdd = String(cfg.minRoleAdd || 'admin').trim();
  const minRoleRemove = String(cfg.minRoleRemove || 'admin').trim();
  const minRoleSetName = String(cfg.minRoleSetName || 'admin').trim();
  const minRoleRestart = String(cfg.minRoleRestart || 'admin').trim();
  const minRoleShutdown = String(cfg.minRoleShutdown || 'controller').trim();

  const restartExitCode = parseInt(String(cfg.restartExitCode || '100'), 10) || 100;

  const rolesFileRel = String(cfg.rolesFile || 'data/SystemControl/roles.json').trim();
  const rolesFileAbs = path.isAbsolute(rolesFileRel)
    ? rolesFileRel
    : path.join(meta.dataRoot, 'bots', meta.botName, rolesFileRel);

  const hubConf = (meta && (meta.hubConf || meta.conf)) || {};

  const controllers = new Set(
    [...parseList(cfg.controllers), ...parseList(hubConf.controllers)]
      .map(normalizeKey)
      .filter(Boolean)
  );

  const replyNoAccess = decodeTemplate(cfg.replyNoAccess || '❌ No access.');
  const replyUnknownCommand = decodeTemplate(cfg.replyUnknownCommand || '❓ Unknown command.');
  const replyAdded = decodeTemplate(cfg.replyAdded || '✅ Added {target} as {role}.');
  const replyRemoved = decodeTemplate(cfg.replyRemoved || '✅ Removed {target} from {role}.');
  const replyNameSet = decodeTemplate(cfg.replyNameSet || '✅ Name set for {target}: {name}');
  const replyRestarting = decodeTemplate(cfg.replyRestarting || '♻️ Restarting...');
  const replyShuttingDown = decodeTemplate(cfg.replyShuttingDown || '🛑 Shutting down...');

  const whoamiTemplate = decodeTemplate(cfg.whoamiTemplate || 'WHOAMI\\nRole: {role}\\nName: {name}\\nPhone: hidden\\nLID: {lid}\\n\\nTip: {whoamiTip}');
  const whoamiTip = decodeTemplate(cfg.whoamiTip || 'Preferred: use LID for roles (phone may be hidden in groups).\\nExample: !add staff LID:{lid}');
  const rolesTemplate = decodeTemplate(cfg.rolesTemplate || 'ROLES\\nControllers (from conf): {controllersCount}\\nAdmins: {adminsCount}\\nStaff: {staffCount}\\nGuest: (default)\\n\\nTip:\\n!add admin 60XXXXXXXXXX\\n!add admin LID:XXXXXXXXXX');
  const statusTemplate = decodeTemplate(cfg.statusTemplate || 'STATUS\\nBot: {botName}\\nPID: {pid}\\nUptime: {uptime}\\nControlGroup: {controlGroupId}\\n\\nControllers: {controllersCount}\\nAdmins: {adminsCount}\\nStaff: {staffCount}\\n\\nRolesFile: {rolesFile}\\nMemory(RSS): {memRssMb} MB\\n\\nSendQueue: {sendQueueInfo}');
  const helpTemplate = decodeTemplate(cfg.helpTemplate || (
    'COMMANDS\\n' +
    '!whoami\\n' +
    '!roles\\n' +
    '!status\\n' +
    '!add admin|staff <LID:xxx|60xxxx> [Name]\\n' +
    '!remove admin|staff <LID:xxx|60xxxx>\\n' +
    '!setname <LID:xxx|60xxxx> <Name>\\n' +
    '!restart\\n' +
    '!shutdown'
  ));

  // roles.json structure
  let db = safeReadJson(rolesFileAbs, null);
  if (!db || typeof db !== 'object') {
    db = { admins: [], staff: [], names: {} };
    writeJsonAtomic(rolesFileAbs, db);
  }
  if (!Array.isArray(db.admins)) db.admins = [];
  if (!Array.isArray(db.staff)) db.staff = [];
  if (!db.names || typeof db.names !== 'object') db.names = {};

  const admins = new Set(db.admins.map(normalizeKey).filter(Boolean));
  const staff = new Set(db.staff.map(normalizeKey).filter(Boolean));

  function persist() {
    const out = {
      admins: Array.from(admins),
      staff: Array.from(staff),
      names: db.names || {}
    };
    writeJsonAtomic(rolesFileAbs, out);
  }

  function getRoleForCtx(ctx) {
    const keys = buildSenderKeys(ctx);
    for (const k of keys) if (controllers.has(k)) return 'controller';
    for (const k of keys) if (admins.has(k)) return 'admin';
    for (const k of keys) if (staff.has(k)) return 'staff';
    return 'guest';
  }

  function getNameForCtx(ctx) {
    const keys = buildSenderKeys(ctx);
    for (const k of keys) {
      const n = db.names?.[k];
      if (n) return String(n);
    }
    return String(ctx?.sender?.name || '');
  }

  function render(tpl, vars) {
    let out = String(tpl || '');
    for (const [k, v] of Object.entries(vars || {})) {
      out = out.replaceAll(`{${k}}`, String(v ?? ''));
    }
    return out;
  }

  function isControlChat(ctx) {
    if (!controlGroupId) return false;
    return String(ctx?.chatId || '') === controlGroupId;
  }

  function isAllowedHere(ctx, role) {
    const inGroup = Boolean(ctx?.isGroup);
    if (inGroup) {
      if (isControlChat(ctx)) return allowInControlGroup;
      return allowInOtherGroups;
    }
    if (!allowInDm) return false;
    if (!controlGroupId) return roleRank(role) >= roleRank('admin');
    return roleRank(role) >= roleRank('admin');
  }

  function meetsMinRole(role, minRole) {
    return roleRank(role) >= roleRank(minRole);
  }

  meta.log('SystemControlV1', `ready controlGroupId=${controlGroupId || '(empty)'} rolesFile=${rolesFileAbs} controllers=${controllers.size} removeCmds=${Array.from(removeCmds).join(',') || '(none)'}`);

  async function handleCommand(ctx) {
    const text = String(ctx?.text || '').trim();
    if (!text.startsWith(commandPrefix)) return;

    const body = text.slice(commandPrefix.length).trim();
    if (!body) return;

    const parts = body.split(/\s+/);
    const name = String(parts.shift() || '').trim();

    const role = getRoleForCtx(ctx);

    if (!isAllowedHere(ctx, role)) {
      await smartReply(meta, ctx, replyNoAccess);
      return { stop: true };
    }

    if (name === cmdWhoami) {
      if (!meetsMinRole(role, minRoleWhoami)) {
        await smartReply(meta, ctx, replyNoAccess);
        return { stop: true };
      }
      const lid = pickBestLidFromCtx(ctx) || '';
      const nm = getNameForCtx(ctx) || '(unknown)';
      const msg = render(whoamiTemplate, {
        role,
        name: nm,
        lid: lid || '-',
        whoamiTip: render(whoamiTip, { lid: lid || 'XXXXXXXXXX' })
      });
      await smartReply(meta, ctx, msg);
      return { stop: true };
    }

    if (name === cmdRoles) {
      if (!meetsMinRole(role, minRoleRoles)) {
        await smartReply(meta, ctx, replyNoAccess);
        return { stop: true };
      }
      const msg = render(rolesTemplate, {
        controllersCount: controllers.size,
        adminsCount: admins.size,
        staffCount: staff.size
      });
      await smartReply(meta, ctx, msg);
      return { stop: true };
    }

    if (name === cmdStatus) {
      if (!meetsMinRole(role, minRoleStatus)) {
        await smartReply(meta, ctx, replyNoAccess);
        return { stop: true };
      }

      const mu = process.memoryUsage();
      const memRssMb = Math.round((mu.rss || 0) / 1024 / 1024);

      // Best-effort send queue info (safe)
      let sendQueueInfo = 'n/a';
      try {
        const sendSvc = (typeof meta.getService === 'function') ? meta.getService('send') : null;
        if (sendSvc) {
          if (typeof sendSvc.getStats === 'function') {
            const st = sendSvc.getStats();
            sendQueueInfo = JSON.stringify(st);
          } else if (sendSvc.stats && typeof sendSvc.stats === 'object') {
            sendQueueInfo = JSON.stringify(sendSvc.stats);
          } else {
            sendQueueInfo = 'ready';
          }
        }
      } catch {
        sendQueueInfo = 'n/a';
      }

      const msg = render(statusTemplate, {
        botName: String(meta.botName || ''),
        pid: String(process.pid),
        uptime: formatUptime(process.uptime()),
        controlGroupId: controlGroupId || '-',
        controllersCount: controllers.size,
        adminsCount: admins.size,
        staffCount: staff.size,
        rolesFile: rolesFileAbs,
        memRssMb: String(memRssMb),
        sendQueueInfo: sendQueueInfo || 'n/a'
      });

      await smartReply(meta, ctx, msg);
      return { stop: true };
    }

    if (name === cmdHelp) {
      await smartReply(meta, ctx, helpTemplate);
      return { stop: true };
    }

    if (name === cmdAdd) {
      if (!meetsMinRole(role, minRoleAdd)) {
        await smartReply(meta, ctx, replyNoAccess);
        return { stop: true };
      }

      const targetRole = String(parts.shift() || '').toLowerCase();
      const targetIdRaw = String(parts.shift() || '');
      const targetKey = normalizeKey(targetIdRaw);
      const displayTarget = targetKey || targetIdRaw;

      const newName = parts.join(' ').trim();

      if (!targetKey || (targetRole !== 'admin' && targetRole !== 'staff')) {
        await smartReply(meta, ctx, replyUnknownCommand);
        return { stop: true };
      }

      if (targetRole === 'admin') admins.add(targetKey);
      if (targetRole === 'staff') staff.add(targetKey);

      if (newName) db.names[targetKey] = newName;

      persist();

      await smartReply(meta, ctx, render(replyAdded, { target: displayTarget, role: targetRole }));
      return { stop: true };
    }

    if (removeCmds.has(name)) {
      if (!meetsMinRole(role, minRoleRemove)) {
        await smartReply(meta, ctx, replyNoAccess);
        return { stop: true };
      }

      const targetRole = String(parts.shift() || '').toLowerCase();
      const targetIdRaw = String(parts.shift() || '');
      const targetKey = normalizeKey(targetIdRaw);
      const displayTarget = targetKey || targetIdRaw;

      if (!targetKey || (targetRole !== 'admin' && targetRole !== 'staff')) {
        await smartReply(meta, ctx, replyUnknownCommand);
        return { stop: true };
      }

      if (targetRole === 'admin') admins.delete(targetKey);
      if (targetRole === 'staff') staff.delete(targetKey);

      persist();

      await smartReply(meta, ctx, render(replyRemoved, { target: displayTarget, role: targetRole }));
      return { stop: true };
    }

    if (name === cmdSetName) {
      if (!meetsMinRole(role, minRoleSetName)) {
        await smartReply(meta, ctx, replyNoAccess);
        return { stop: true };
      }

      const targetIdRaw = String(parts.shift() || '');
      const targetKey = normalizeKey(targetIdRaw);
      const newName = parts.join(' ').trim();

      if (!targetKey || !newName) {
        await smartReply(meta, ctx, replyUnknownCommand);
        return { stop: true };
      }

      db.names[targetKey] = newName;
      persist();

      await smartReply(meta, ctx, render(replyNameSet, { target: targetKey, name: newName }));
      return { stop: true };
    }

    if (name === cmdRestart) {
      if (!meetsMinRole(role, minRoleRestart)) {
        await smartReply(meta, ctx, replyNoAccess);
        return { stop: true };
      }
      await smartReply(meta, ctx, replyRestarting);
      setTimeout(async () => {
        await tryGracefulClose(meta);
        process.exit(restartExitCode);
      }, 250);
      return { stop: true };
    }

    if (name === cmdShutdown) {
      if (!meetsMinRole(role, minRoleShutdown)) {
        await smartReply(meta, ctx, replyNoAccess);
        return { stop: true };
      }
      await smartReply(meta, ctx, replyShuttingDown);
      setTimeout(async () => {
        await tryGracefulClose(meta);
        process.exit(0);
      }, 250);
      return { stop: true };
    }

    await smartReply(meta, ctx, replyUnknownCommand);
    return { stop: true };
  }

  return {
    onMessage: async (ctx) => handleCommand(ctx),
    onEvent: async () => {},
    handleMessage: async (ctx) => handleCommand(ctx),
    handleEvent: async () => {},
  };
};
