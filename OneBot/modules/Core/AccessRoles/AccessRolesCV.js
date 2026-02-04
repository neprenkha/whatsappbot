'use strict';

// AccessRolesCV.js
// - Loads roles from a JSON file and registers the 'access' service.
// - Roles are used by modules like SystemControl to gate commands.

const fs = require('fs');
const path = require('path');

function toBool(v, defVal) {
  if (v === undefined || v === null) return defVal;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'n' || s === 'off') return false;
  return defVal;
}

function toStr(v, defVal) {
  const s = String(v ?? '').trim();
  return s ? s : defVal;
}

function safeReadJson(absPath) {
  try {
    const txt = fs.readFileSync(absPath, 'utf8');
    return JSON.parse(txt);
  } catch (_) {
    return null;
  }
}

function roleRank(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'controller') return 3;
  if (r === 'admin') return 2;
  if (r === 'staff') return 1;
  return 0;
}

function normalizeKey(userId) {
  const raw = String(userId || '').trim();
  if (!raw) return '';
  if (raw.startsWith('lid:')) return raw;

  // Extract digits where possible.
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits) return `lid:${digits}`;

  return raw;
}

module.exports = {
  init: async (meta) => {
    const logTag = 'AccessRolesCV';
    const cfg = meta.implConf || {};

    const enabled = toBool(cfg.enabled, true);
    const rolesFileRel = toStr(cfg.rolesFileRel, 'SystemControl/roles.json');

    if (!enabled) {
      meta.log(logTag, 'disabled');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const dataRootBot = String(meta.dataRootBot || '').trim();
    const absRoles = path.isAbsolute(rolesFileRel)
      ? rolesFileRel
      : path.join(dataRootBot, rolesFileRel);

    const rolesDoc = safeReadJson(absRoles) || { controllers: [], admins: [], staff: [] };

    const roleByKey = Object.create(null);

    function setRole(list, role) {
      const arr = Array.isArray(list) ? list : [];
      for (const item of arr) {
        const k = normalizeKey(item);
        if (!k) continue;
        const prev = roleByKey[k] || 'guest';
        if (roleRank(role) > roleRank(prev)) roleByKey[k] = role;
      }
    }

    setRole(rolesDoc.staff, 'staff');
    setRole(rolesDoc.admins, 'admin');
    setRole(rolesDoc.controllers, 'controller');

    const access = {
      getRole(userId) {
        const key = normalizeKey(userId);
        return roleByKey[key] || 'guest';
      },
      hasAtLeast(userId, minRole) {
        const role = this.getRole(userId);
        return roleRank(role) >= roleRank(minRole);
      },
    };

    meta.registerService('access', access);

    const counts = {
      controllers: Array.isArray(rolesDoc.controllers) ? rolesDoc.controllers.length : 0,
      admins: Array.isArray(rolesDoc.admins) ? rolesDoc.admins.length : 0,
      staff: Array.isArray(rolesDoc.staff) ? rolesDoc.staff.length : 0,
    };

    meta.log(logTag, `ready enabled=1 rolesFile=${absRoles} controllers=${counts.controllers} admins=${counts.admins} staff=${counts.staff}`);
    return { onMessage: async () => {}, onEvent: async () => {} };
  },
};
