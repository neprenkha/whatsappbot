'use strict';

const fs = require('fs');
const path = require('path');

const { toStr, toBool, parseCsv } = require('../Shared/SharedConfV1');
const { normalizeSender, normalizePhone, normalizeLid, maskPhone } = require('../Shared/SharedIdentityV1');
const { readJsonFile, atomicWriteJson } = require('../Shared/SharedFileJsonV1');

function getSvc(meta, name) {
  if (!meta) return null;
  if (typeof meta.getService === 'function') return meta.getService(name);
  if (meta.services && meta.services[name]) return meta.services[name];
  return null;
}

function normId(input) {
  const lid = normalizeLid(input);
  if (lid) return lid;
  const ph = normalizePhone(input);
  if (ph) return ph;
  const s = (input === undefined || input === null) ? '' : String(input).trim();
  return s;
}

function roleRank(role) {
  switch (String(role || '').toLowerCase()) {
    case 'controller': return 30;
    case 'admin': return 20;
    case 'staff': return 10;
    default: return 0; // guest
  }
}

function canonRole(role) {
  const r = String(role || '').toLowerCase().trim();
  if (r === 'controller' || r === 'admin' || r === 'staff') return r;
  return '';
}

function ensureArrayUnique(arr) {
  const seen = new Set();
  const out = [];
  for (const x of (arr || [])) {
    const v = String(x || '').trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function makeEmptyRoles() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    controllers: [],
    admins: [],
    staff: [],
    names: {}
  };
}

function loadRoles(rolesFileAbs) {
  const data = readJsonFile(rolesFileAbs, null);
  if (!data || typeof data !== 'object') return makeEmptyRoles();

  const out = makeEmptyRoles();
  out.version = typeof data.version === 'number' ? data.version : 1;
  out.createdAt = data.createdAt || out.createdAt;

  out.controllers = ensureArrayUnique((data.controllers || []).map(normId));
  out.admins = ensureArrayUnique((data.admins || []).map(normId));
  out.staff = ensureArrayUnique((data.staff || []).map(normId));

  out.names = (data.names && typeof data.names === 'object') ? data.names : {};
  out.updatedAt = new Date().toISOString();

  return out;
}

function saveRoles(rolesFileAbs, roles) {
  roles.updatedAt = new Date().toISOString();
  atomicWriteJson(rolesFileAbs, roles);
}

function removeFromAll(roles, id) {
  roles.controllers = roles.controllers.filter(x => x !== id);
  roles.admins = roles.admins.filter(x => x !== id);
  roles.staff = roles.staff.filter(x => x !== id);
}

function addToRole(roles, role, id) {
  removeFromAll(roles, id);
  if (role === 'controller') roles.controllers.push(id);
  else if (role === 'admin') roles.admins.push(id);
  else if (role === 'staff') roles.staff.push(id);

  roles.controllers = ensureArrayUnique(roles.controllers);
  roles.admins = ensureArrayUnique(roles.admins);
  roles.staff = ensureArrayUnique(roles.staff);
}

function getRoleOf(roles, id) {
  if (!id) return 'guest';
  if (roles.controllers.includes(id)) return 'controller';
  if (roles.admins.includes(id)) return 'admin';
  if (roles.staff.includes(id)) return 'staff';
  return 'guest';
}

function hasAtLeastRole(roles, id, minRole) {
  return roleRank(getRoleOf(roles, id)) >= roleRank(minRole);
}

function formatIdForHuman(id) {
  if (!id) return '';
  if (String(id).startsWith('lid:')) return id;
  return maskPhone(id) || id;
}

async function safeReply(meta, ctx, text) {
  try {
    if (ctx && typeof ctx.reply === 'function') return await ctx.reply(text);
  } catch (_) {}
  const send = getSvc(meta, 'send');
  if (send && typeof send.sendText === 'function' && ctx && ctx.chatId) {
    return await send.sendText(ctx.chatId, text);
  }
  if (send && typeof send.send === 'function' && ctx && ctx.chatId) {
    return await send.send(ctx.chatId, text);
  }
}

function parseAddDelArgs(args) {
  const out = { role: '', id: '', name: '' };
  const a = Array.isArray(args) ? args : [];
  if (a.length < 2) return out;

  out.role = canonRole(a[0]);
  out.id = normId(a[1]);

  if (a.length >= 3) {
    out.name = a.slice(2).join(' ').trim();
  }
  return out;
}

async function init(meta) {
  const conf = meta.implConf || {};

  const rolesFileRel = toStr(conf.rolesFileRel, 'data/SystemControl/roles.json').trim() || 'data/SystemControl/roles.json';
  const rolesFileAbs = path.isAbsolute(rolesFileRel) ? rolesFileRel : path.join(meta.dataRootBot || '', rolesFileRel);

  const controlGroupId = toStr(conf.controlGroupId, '').trim();
  const allowAddInDm = toBool(conf.allowAddInDm, true);

  const bootstrapControllers = parseCsv(conf.controllers || conf.controllersCsv || '');
  const bootstrapAdmins = parseCsv(conf.admins || conf.adminsCsv || '');
  const bootstrapStaff = parseCsv(conf.staff || conf.staffCsv || '');

  let roles = loadRoles(rolesFileAbs);

  // Bootstrap merge (do not wipe existing)
  for (const idRaw of bootstrapControllers) {
    const id = normId(idRaw);
    if (id && !roles.controllers.includes(id)) roles.controllers.push(id);
  }
  for (const idRaw of bootstrapAdmins) {
    const id = normId(idRaw);
    if (!id) continue;
    if (roles.controllers.includes(id)) continue;
    if (!roles.admins.includes(id)) roles.admins.push(id);
  }
  for (const idRaw of bootstrapStaff) {
    const id = normId(idRaw);
    if (!id) continue;
    if (roles.controllers.includes(id) || roles.admins.includes(id)) continue;
    if (!roles.staff.includes(id)) roles.staff.push(id);
  }

  roles.controllers = ensureArrayUnique(roles.controllers);
  roles.admins = ensureArrayUnique(roles.admins);
  roles.staff = ensureArrayUnique(roles.staff);

  // Ensure directory exists early so we fail fast with a clear error.
  try {
    fs.mkdirSync(path.dirname(rolesFileAbs), { recursive: true });
  } catch (_) {}

  saveRoles(rolesFileAbs, roles);

  const accessSvc = {
    rolesFile: rolesFileAbs,
    controlGroupId,

    normalizeSender,

    normId,

    reload() {
      roles = loadRoles(rolesFileAbs);
      return roles;
    },

    snapshot() {
      return JSON.parse(JSON.stringify(roles));
    },

    getRole(senderId) {
      const id = normId(senderId);
      return getRoleOf(roles, id);
    },

    hasRole(senderId, role) {
      const id = normId(senderId);
      return getRoleOf(roles, id) === canonRole(role);
    },

    hasAtLeast(senderId, minRole) {
      const id = normId(senderId);
      return hasAtLeastRole(roles, id, canonRole(minRole) || minRole);
    },

    isControlGroup(chatId) {
      if (!controlGroupId) return false;
      return String(chatId || '').trim() === controlGroupId;
    },

    add(role, idRaw, name) {
      const roleC = canonRole(role);
      const id = normId(idRaw);
      if (!roleC || !id) return false;
      addToRole(roles, roleC, id);
      if (name) roles.names[id] = String(name).trim();
      saveRoles(rolesFileAbs, roles);
      return true;
    },

    del(role, idRaw) {
      const roleC = canonRole(role);
      const id = normId(idRaw);
      if (!roleC || !id) return false;
      // If role is specified, remove only if currently in that role.
      if (getRoleOf(roles, id) === roleC) {
        removeFromAll(roles, id);
        saveRoles(rolesFileAbs, roles);
        return true;
      }
      return false;
    },

    setName(idRaw, name) {
      const id = normId(idRaw);
      if (!id) return false;
      const nm = String(name || '').trim();
      if (!nm) return false;
      roles.names[id] = nm;
      saveRoles(rolesFileAbs, roles);
      return true;
    },

    getName(idRaw) {
      const id = normId(idRaw);
      if (!id) return '';
      return roles.names[id] || '';
    }
  };

  if (typeof meta.registerService === 'function') {
    meta.registerService('access', accessSvc);
  }

  const commands = getSvc(meta, 'commands') || getSvc(meta, 'command');
  if (commands && typeof commands.register === 'function') {
    // !whoami
    commands.register('whoami', async (ctx) => {
      const sender = normId(ctx.senderId);
      const role = getRoleOf(roles, sender);
      const nm = roles.names[sender] || '';
      const lines = [];
      lines.push(`🧩 You`);
      lines.push(`• id: ${sender || '-'}`);
      if (nm) lines.push(`• name: ${nm}`);
      lines.push(`• role: ${role}`);
      await safeReply(meta, ctx, lines.join('\n'));
    }, { owner: 'AccessRoles', help: 'Show your id + role' });

    // !roles
    commands.register('roles', async (ctx) => {
      const lines = [];
      lines.push('👥 Roles');
      lines.push(`• controllers: ${roles.controllers.length}`);
      lines.push(`• admins: ${roles.admins.length}`);
      lines.push(`• staff: ${roles.staff.length}`);
      lines.push('');
      lines.push('Tips: !whoami, !add, !del, !setname');
      await safeReply(meta, ctx, lines.join('\n'));
    }, { owner: 'AccessRoles', help: 'Show roles summary' });

    // !add <role> <id> [name...]
    commands.register('add', async (ctx, args) => {
      const caller = normId(ctx.senderId);
      const callerRole = getRoleOf(roles, caller);

      if (!allowAddInDm && !ctx.isGroup) {
        return await safeReply(meta, ctx, '❌ Not allowed in DM. Use Control Group.');
      }

      const { role, id, name } = parseAddDelArgs(args);
      if (!role || !id) {
        return await safeReply(meta, ctx, 'Usage: !add <controller|admin|staff> <lid:...|phone> [name]');
      }

      // Permission rules:
      // - controller can add anyone to any role
      // - admin can add staff only
      if (callerRole !== 'controller' && !(callerRole === 'admin' && role === 'staff')) {
        return await safeReply(meta, ctx, '🚫 You are not allowed to run this command.');
      }

      accessSvc.add(role, id, name);
      const label = role;
      const nm = name ? ` (${name})` : '';
      await safeReply(meta, ctx, `✅ Added ${id} as ${label}${nm}.`);
    }, { owner: 'AccessRoles', help: 'Add role: !add staff lid:... Name' });

    // !del <role> <id>
    commands.register('del', async (ctx, args) => {
      const caller = normId(ctx.senderId);
      const callerRole = getRoleOf(roles, caller);

      if (!allowAddInDm && !ctx.isGroup) {
        return await safeReply(meta, ctx, '❌ Not allowed in DM. Use Control Group.');
      }

      const { role, id } = parseAddDelArgs(args);
      if (!role || !id) {
        return await safeReply(meta, ctx, 'Usage: !del <controller|admin|staff> <lid:...|phone>');
      }

      if (callerRole !== 'controller' && !(callerRole === 'admin' && role === 'staff')) {
        return await safeReply(meta, ctx, '🚫 You are not allowed to run this command.');
      }

      const ok = accessSvc.del(role, id);
      if (!ok) return await safeReply(meta, ctx, '❓ Not found or role mismatch.');
      await safeReply(meta, ctx, `🗑️ Removed ${id} from ${role}.`);
    }, { owner: 'AccessRoles', help: 'Delete role: !del staff lid:...' });

    // !setname <id> <name...>
    commands.register('setname', async (ctx, args) => {
      const caller = normId(ctx.senderId);
      const callerRole = getRoleOf(roles, caller);

      if (callerRole !== 'controller' && callerRole !== 'admin') {
        return await safeReply(meta, ctx, '🚫 You are not allowed to run this command.');
      }

      const a = Array.isArray(args) ? args : [];
      if (a.length < 2) return await safeReply(meta, ctx, 'Usage: !setname <lid:...|phone> <name...>');
      const id = normId(a[0]);
      const name = a.slice(1).join(' ').trim();
      if (!id || !name) return await safeReply(meta, ctx, 'Usage: !setname <id> <name...>');

      accessSvc.setName(id, name);
      await safeReply(meta, ctx, `✅ Name set for ${formatIdForHuman(id)}: ${name}`);
    }, { owner: 'AccessRoles', help: 'Set friendly name for an id' });
  }

  const controllersCount = roles.controllers.length;
  if (meta.log) meta.log(`[AccessRolesV1] ready controlGroupId=${controlGroupId || '-'} rolesFile=${rolesFileAbs} controllers=${controllersCount}`);

  return {};
}

module.exports = { init };
