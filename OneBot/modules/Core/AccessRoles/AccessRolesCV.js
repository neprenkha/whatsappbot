'use strict';

function toBool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return d;
}

function toStr(v, d) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s || d;
}

function toList(v) {
  const raw = toStr(v, '');
  if (!raw) return [];
  return raw.split(',').map(function mapOne(x) {
    return String(x || '').trim();
  }).filter(Boolean);
}

function loadGlobalConf(meta, cfg, bugLog) {
  const rel = toStr(cfg.globalConfRel, '');
  if (!rel) {
    if (bugLog) meta.log('AccessRolesCV', 'safe_disabled globalConfRel_missing');
    return { ok: false, conf: {} };
  }
  try {
    const loaded = meta.loadConfRel(rel);
    const conf = loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
    return { ok: true, conf: conf };
  } catch (e) {
    if (bugLog) meta.log('AccessRolesCV', 'safe_disabled global_conf_load_failed err=' + String(e && e.message ? e.message : e));
    return { ok: false, conf: {} };
  }
}

function normalizePrincipal(v) {
  const raw = String(v || '').trim();
  if (!raw) return '';
  if (raw.indexOf('lid:') === 0) return raw;
  if (raw.indexOf('@') > 0) return raw;
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits) return 'lid:' + digits;
  return raw;
}

function roleRank(role) {
  const r = String(role || '').trim().toLowerCase();
  if (r === 'owner') return 5;
  if (r === 'admin') return 4;
  if (r === 'manager') return 3;
  if (r === 'staff') return 2;
  if (r === 'viewer') return 1;
  return 1;
}

function isValidRole(role) {
  const r = String(role || '').trim().toLowerCase();
  return r === 'owner' || r === 'admin' || r === 'manager' || r === 'staff' || r === 'viewer';
}

function normalizeRole(role, fallbackRole) {
  const r = String(role || '').trim().toLowerCase();
  if (isValidRole(r)) return r;
  return fallbackRole;
}

function firstNonEmpty(items) {
  for (let i = 0; i < items.length; i += 1) {
    const s = String(items[i] || '').trim();
    if (s) return s;
  }
  return '';
}

module.exports.init = async function init(meta) {
  const cfg = meta && meta.implConf ? meta.implConf : {};

  const enabled = toBool(cfg.enabled, true);
  const moduleLog = toBool(cfg.moduleLog, true);
  const bugLog = toBool(cfg.bugLog, true);
  const detailLog = toBool(cfg.detailLog, false);
  const traceLog = toBool(cfg.traceLog, false);

  if (!enabled) {
    if (moduleLog) meta.log('AccessRolesCV', 'disabled');
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const globalState = loadGlobalConf(meta, cfg, bugLog);
  const globalConf = globalState.conf;

  const commandServiceName = toStr(cfg.commandServiceName, '');
  const jsonStoreServiceName = toStr(cfg.jsonStoreServiceName, '');
  const storeNamespace = toStr(cfg.storeNamespace, '');
  const storeKey = toStr(cfg.storeKey, '');
  const defaultRole = normalizeRole(cfg.defaultRole, '');
  const bootstrapFirstOwner = toBool(cfg.bootstrapFirstOwner, true);
  const ownerSeedList = toList(cfg.ownerSeedList).map(normalizePrincipal).filter(Boolean);
  const ownerSeedRole = normalizeRole(cfg.ownerSeedRole, '');

  const cmdRole = toStr(cfg.cmdRole, '');
  const actionSet = toStr(cfg.actionSet, '');
  const actionDel = toStr(cfg.actionDel, '');
  const actionList = toStr(cfg.actionList, '');
  const actionMe = toStr(cfg.actionMe, '');
  const cmdHelp = toStr(cfg.cmdHelp, '');

  const msgNoAccess = toStr(cfg.msgNoAccess, '');
  const msgUsage = toStr(cfg.msgUsage, '');
  const msgBadRole = toStr(cfg.msgBadRole, '');
  const msgSetOk = toStr(cfg.msgSetOk, '');
  const msgDelOk = toStr(cfg.msgDelOk, '');
  const msgNotFound = toStr(cfg.msgNotFound, '');
  const msgMe = toStr(cfg.msgMe, '');
  const msgRole = toStr(cfg.msgRole, '');
  const msgListPrefix = toStr(cfg.msgListPrefix, '');

  const controlGroupId = toStr(globalConf.controlGroupId, '');

  const required = [
    commandServiceName,
    jsonStoreServiceName,
    storeNamespace,
    storeKey,
    defaultRole,
    cmdRole,
    actionSet,
    actionDel,
    actionList,
    actionMe,
    cmdHelp,
    msgNoAccess,
    msgUsage,
    msgBadRole,
    msgSetOk,
    msgDelOk,
    msgNotFound,
    msgMe,
    msgRole,
    msgListPrefix
  ];
  if (ownerSeedList.length > 0) required.push(ownerSeedRole);
  for (let i = 0; i < required.length; i += 1) {
    if (!required[i]) {
      if (bugLog) meta.log('AccessRolesCV', 'safe_disabled required_config_missing');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }
  }

  if (!globalState.ok) {
    if (bugLog) meta.log('AccessRolesCV', 'safe_disabled global_conf_unavailable');
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  if (!controlGroupId) {
    if (bugLog) meta.log('AccessRolesCV', 'safe_disabled controlGroupId_missing');
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const jsonstore = meta.getService(jsonStoreServiceName);
  if (!jsonstore || typeof jsonstore.open !== 'function') {
    if (bugLog) meta.log('AccessRolesCV', 'safe_disabled missing_jsonstore_service name=' + jsonStoreServiceName);
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const store = jsonstore.open(storeNamespace);
  const commandService = meta.getService(commandServiceName);

  if (!commandService || typeof commandService.register !== 'function') {
    if (bugLog) meta.log('AccessRolesCV', 'safe_disabled missing_command_service name=' + commandServiceName);
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  let assignments = {};
  try {
    const loaded = await store.get(storeKey, {});
    assignments = loaded && typeof loaded === 'object' ? loaded : {};
  } catch (e) {
    assignments = {};
    if (bugLog) meta.log('AccessRolesCV', 'load_assignments_failed err=' + String(e && e.message ? e.message : e));
  }

  function hasAssignments() {
    return Object.keys(assignments).length > 0;
  }

  async function saveAssignments() {
    await store.set(storeKey, assignments);
  }

  async function bootstrapSeedAssignmentsAtInit() {
    if (!bootstrapFirstOwner) return;
    if (hasAssignments()) {
      if (detailLog || traceLog) meta.log('AccessRolesCV', 'bootstrap_seed_init_skipped existing_assignments=1');
      return;
    }
    if (ownerSeedList.length < 1) {
      if (detailLog || traceLog) meta.log('AccessRolesCV', 'bootstrap_seed_init_skipped ownerSeedList_empty=1');
      return;
    }
    if (!ownerSeedRole) {
      if (bugLog) meta.log('AccessRolesCV', 'bootstrap_seed_init_skipped ownerSeedRole_invalid');
      return;
    }

    let added = 0;
    for (let i = 0; i < ownerSeedList.length; i += 1) {
      const seed = ownerSeedList[i];
      if (!seed) continue;
      if (Object.prototype.hasOwnProperty.call(assignments, seed)) continue;
      assignments[seed] = ownerSeedRole;
      added += 1;
    }

    if (added > 0) {
      await saveAssignments();
      if (moduleLog) meta.log('AccessRolesCV', 'bootstrap_seed_init_added count=' + String(added) + ' role=' + ownerSeedRole);
    }
  }

  await bootstrapSeedAssignmentsAtInit();

  function principalFromCtx(ctx) {
    return normalizePrincipal(firstNonEmpty([
      ctx && ctx.sender && ctx.sender.id,
      ctx && ctx.sender && ctx.sender.phone,
      ctx && ctx.sender && ctx.sender.lid,
      ctx && ctx.author,
      ctx && ctx.from
    ]));
  }

  function principalFromAny(x) {
    if (x && typeof x === 'object') return principalFromCtx(x);
    return normalizePrincipal(x);
  }

  function targetFromQuote(ctx) {
    const q = ctx && ctx.raw && (ctx.raw.quotedMsg || ctx.raw.quotedMessage || ctx.raw.quoted || null);
    return normalizePrincipal(firstNonEmpty([
      q && q.author,
      q && q.from,
      q && q.participant,
      q && q.id && q.id.participant,
      q && q.id && q.id.remote
    ]));
  }

  function targetFromArg(arg) {
    return normalizePrincipal(arg);
  }

  function getRole(any) {
    const k = principalFromAny(any);
    if (!k) return defaultRole;
    return normalizeRole(assignments[k], defaultRole);
  }

  function hasAtLeast(any, minRole) {
    return roleRank(getRole(any)) >= roleRank(normalizeRole(minRole, defaultRole));
  }

  function hasRole(any, reqRole) {
    return hasAtLeast(any, reqRole);
  }

  function isExactRole(any, role) {
    return getRole(any) === normalizeRole(role, defaultRole);
  }

  async function reply(ctx, textValue) {
    if (ctx && typeof ctx.reply === 'function' && textValue) await ctx.reply(textValue);
  }

  async function replyRole(ctx, template, idKey) {
    const target = normalizePrincipal(idKey);
    const message = template
      .replace('{role}', getRole(target))
      .replace('{idKey}', target || '');
    await reply(ctx, message);
  }

  function inControlGroup(ctx) {
    return String(ctx && ctx.chatId || '').trim() === controlGroupId;
  }

  async function tryBootstrapOwner(actor) {
    const actorKey = normalizePrincipal(actor);
    if (!bootstrapFirstOwner) return;
    if (!actorKey) return;
    if (hasAssignments()) return;

    if (ownerSeedList.length < 1) {
      if (bugLog) meta.log('AccessRolesCV', 'safe_disabled bootstrap_owner_seed_missing');
      return;
    }

    const seeded = ownerSeedList.indexOf(actorKey) >= 0;
    if (!seeded) return;

    assignments[actorKey] = ownerSeedRole;
    await saveAssignments();
    if (moduleLog) meta.log('AccessRolesCV', 'bootstrap_owner_assigned actor=' + actorKey);
  }

  async function runRoleCommand(ctx) {
    const actor = principalFromCtx(ctx);

    if (!inControlGroup(ctx)) {
      await reply(ctx, msgNoAccess);
      return;
    }

    const args = ctx && ctx.command && Array.isArray(ctx.command.args) ? ctx.command.args.slice() : [];
    const actionRaw = toStr(args.shift(), '');
    const action = actionRaw.toLowerCase();

    await tryBootstrapOwner(actor);

    if (!action || action === actionMe) {
      await replyRole(ctx, msgMe, actor);
      return;
    }

    if (action !== actionList && action !== actionSet && action !== actionDel) {
      const target = targetFromArg(actionRaw);
      if (target === actor) {
        await replyRole(ctx, msgMe, actor);
        return;
      }
      if (!hasAtLeast(actor, 'admin')) {
        await reply(ctx, msgNoAccess);
        return;
      }
      await replyRole(ctx, msgRole, target);
      return;
    }

    const canManage = hasAtLeast(actor, 'owner');
    if (!canManage) {
      await reply(ctx, msgNoAccess);
      return;
    }

    if (action === actionList) {
      const rows = [];
      const keys = Object.keys(assignments).sort();
      for (let i = 0; i < keys.length; i += 1) {
        rows.push(keys[i] + '=' + getRole(keys[i]));
      }
      await reply(ctx, msgListPrefix + (rows.length ? '\n' + rows.join('\n') : ''));
      return;
    }

    if (action === actionSet) {
      const target = firstNonEmpty([targetFromQuote(ctx), targetFromArg(args[0])]);
      const roleRaw = toStr(args[1], '').toLowerCase();
      if (!target || !roleRaw) {
        await reply(ctx, msgUsage);
        return;
      }
      if (!isValidRole(roleRaw)) {
        await reply(ctx, msgBadRole);
        return;
      }
      assignments[target] = roleRaw;
      await saveAssignments();
      await reply(ctx, msgSetOk);
      return;
    }

    if (action === actionDel) {
      const target = firstNonEmpty([targetFromQuote(ctx), targetFromArg(args[0])]);
      if (!target) {
        await reply(ctx, msgUsage);
        return;
      }
      if (!(target in assignments)) {
        await reply(ctx, msgNotFound);
        return;
      }
      delete assignments[target];
      await saveAssignments();
      await reply(ctx, msgDelOk);
      return;
    }

    await reply(ctx, msgUsage);
  }

  const service = {
    getRole: getRole,
    hasAtLeast: hasAtLeast,
    hasRole: hasRole,
    isExactRole: isExactRole,
    meetsMinRole: function meetsMinRole(ctx, minRole) {
      return hasAtLeast(ctx, minRole);
    },
    isAllowed: function isAllowed(ctx, minRole) {
      return hasAtLeast(ctx, minRole);
    },
    check: function check(ctx, minRole) {
      return hasAtLeast(ctx, minRole);
    },
    list: function list() {
      const out = {};
      const keys = Object.keys(assignments);
      for (let i = 0; i < keys.length; i += 1) out[keys[i]] = getRole(keys[i]);
      return out;
    }
  };

  meta.registerService('access', service);

  commandService.register(cmdRole, runRoleCommand, {
    owner: 'AccessRolesCV',
    help: cmdHelp
  });

  if (moduleLog) {
    meta.log('AccessRolesCV', 'ready defaultRole=' + defaultRole + ' command=' + cmdRole + ' store=' + storeNamespace + '/' + storeKey);
  }

  if (detailLog || traceLog) {
    meta.log('AccessRolesCV', 'bootstrapFirstOwner=' + (bootstrapFirstOwner ? '1' : '0') + ' ownerSeedListCount=' + String(ownerSeedList.length));
  }

  return { onMessage: async () => {}, onEvent: async () => {} };
};