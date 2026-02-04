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

function render(tpl, vars) {
  let out = String(tpl || '');
  for (const [k, v] of Object.entries(vars || {})) {
    out = out.replaceAll(`{${k}}`, String(v ?? ''));
  }
  return out;
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

function isAllowedHere(ctx, role, controlGroupId, allowInControlGroup, allowInOtherGroups, allowInDm) {
  const inGroup = Boolean(ctx?.isGroup);
  if (inGroup) {
    if (controlGroupId && String(ctx?.chatId || '') === controlGroupId) return allowInControlGroup;
    return allowInOtherGroups;
  }
  return allowInDm || (roleRank(role) >= roleRank('admin'));
}

module.exports.init = async function init(meta) {
  const cfg = meta.implConf || {};

  const commandPrefix = String(cfg.commandPrefix || '!').trim() || '!';
  const controlGroupId = String(cfg.controlGroupId || '').trim();

  const allowInDm = String(cfg.allowInDm ?? '1') === '1';
  const allowInControlGroup = String(cfg.allowInControlGroup ?? '1') === '1';
  const allowInOtherGroups = String(cfg.allowInOtherGroups ?? '0') === '1';

  const rolesFileRel = String(cfg.rolesFile || 'data/SystemControl/roles.json').trim();
  const rolesFileAbs = path.isAbsolute(rolesFileRel)
    ? rolesFileRel
    : path.join(meta.dataRoot, 'bots', meta.botName, rolesFileRel);

  let db = safeReadJson(rolesFileAbs, null);
  if (!db || typeof db !== 'object') {
    meta.log('SystemControlV1', `Role database is missing or invalid. Initializing new database.`);
    db = { admins: [], staff: [], names: {} };
    writeJsonAtomic(rolesFileAbs, db);
  }
  if (!Array.isArray(db.admins)) db.admins = [];
  if (!Array.isArray(db.staff)) db.staff = [];
  if (!db.names || typeof db.names !== 'object') db.names = {};

  const admins = new Set(db.admins.map(normalizeKey).filter(Boolean));
  const staff = new Set(db.staff.map(normalizeKey).filter(Boolean));

  function persist() {
    try {
      const out = {
        admins: Array.from(admins),
        staff: Array.from(staff),
        names: db.names || {}
      };
      writeJsonAtomic(rolesFileAbs, out);
    } catch (e) {
      meta.log('SystemControlV1', `Failed to persist roles database: ${e.message}`);
    }
  }

  async function handleCommand(ctx) {
    const text = String(ctx?.text || '').trim();
    if (!text.startsWith(commandPrefix)) return;

    const body = text.slice(commandPrefix.length).trim();
    if (!body) return;

    const [cmd, ...args] = body.split(/\s+/);
    const role = 'guest'; // Placeholder for now

    if (!isAllowedHere(ctx, role, controlGroupId, allowInControlGroup, allowInOtherGroups, allowInDm)) {
      return;
    }

    if (cmd === 'roles') {
      const rolesMsg = `Admins: ${Array.from(admins).join(', ') || 'None'}\nStaff: ${Array.from(staff).join(', ') || 'None'}`;
      await ctx.reply(rolesMsg);
      return;
    }

    // Add/Remove/Other command handling here...
  }

  return {
    onMessage: async (ctx) => handleCommand(ctx),
    onEvent: async () => {}, // No-op for events
  };
};