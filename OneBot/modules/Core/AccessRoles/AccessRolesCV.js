'use strict';

function toBool(v, d) {
  if (v === undefined || v === null || v === '') return !!d;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return !!d;
}

function toStr(v, d) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s || d;
}

function toList(v) {
  return String(v || '')
    .split(',')
    .map((x) => String(x || '').trim().toLowerCase())
    .filter(Boolean);
}

function normalizePrincipal(v) {
  const raw = String(v || '').trim();
  if (!raw) return '';
  if (raw.indexOf('lid:') === 0) return raw;
  if (raw.indexOf('@') > 0) return raw;
  const digits = raw.replace(/[^0-9]/g, '');
  return digits ? ('lid:' + digits) : raw;
}

function firstNonEmpty(items) {
  for (let i = 0; i < items.length; i += 1) {
    const s = String(items[i] || '').trim();
    if (s) return s;
  }
  return '';
}

function parseStoreSpec(spec, fallbackKey) {
  const raw = String(spec || '').trim();
  if (!raw.toLowerCase().startsWith('jsonstore:')) return null;
  const tail = raw.slice('jsonstore:'.length);
  const parts = tail.split('/').map((x) => String(x || '').trim()).filter(Boolean);
  if (parts.length < 1) return null;
  const namespace = parts[0];
  let key = String(fallbackKey || '').trim();
  if (!key && parts.length > 1) key = parts.slice(1).join('/').replace(/\.json$/i, '');
  if (!namespace || !key) return null;
  return { namespace, key };
}

module.exports = {
  init: async (meta) => {
    const cfg = meta && meta.implConf ? meta.implConf : {};
    const log = meta && typeof meta.log === 'function' ? meta.log : () => {};
    const tag = 'AccessRolesCV';

    const enabled = toBool(cfg.enabled, true);
    const moduleLog = toBool(cfg.moduleLog, true);
    const bugLog = toBool(cfg.bugLog, true);
    const detailLog = toBool(cfg.detailLog, false);
    const traceLog = toBool(cfg.traceLog, false);

    if (!enabled) {
      if (moduleLog) log(tag, 'disabled enabled=0');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const serviceName = toStr(cfg.serviceName, '');
    const commandService = toStr(cfg.commandService, '');
    const storeSpec = toStr(cfg.storeSpec, '');
    const storeKey = toStr(cfg.storeKey, '');

    const controllers = toList(cfg.controllers);
    const requiredRole = toStr(cfg.requiredRole, '').toLowerCase();
    const ownerSeedList = toList(cfg.ownerSeedList).map(normalizePrincipal).filter(Boolean);
    const bootstrapFirstOwner = toBool(cfg.bootstrapFirstOwner, true);

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
    const msgListPrefix = toStr(cfg.msgListPrefix, '');

    const storeRef = parseStoreSpec(storeSpec, storeKey);

    const required = [
      serviceName,
      commandService,
      storeSpec,
      storeKey,
      requiredRole,
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
      msgListPrefix,
    ];

    for (let i = 0; i < required.length; i += 1) {
      if (!required[i]) {
        if (bugLog) log(tag, 'required_config_missing safe_disabled');
        return { onMessage: async () => {}, onEvent: async () => {} };
      }
    }

    if (serviceName !== 'access') {
      if (bugLog) log(tag, 'service_name_invalid expected=access got=' + serviceName);
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    if (!storeRef) {
      if (bugLog) log(tag, 'store_invalid expected=jsonstore:Namespace/file storeSpec=' + storeSpec + ' storeKey=' + storeKey);
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    if (!controllers.length || controllers.indexOf(requiredRole) < 0) {
      if (bugLog) log(tag, 'controllers_or_requiredRole_invalid safe_disabled');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    function normalizeRole(role, fallbackRole) {
      const r = String(role || '').trim().toLowerCase();
      return controllers.indexOf(r) >= 0 ? r : fallbackRole;
    }

    function roleRank(role) {
      const r = normalizeRole(role, requiredRole);
      const i = controllers.indexOf(r);
      return (controllers.length - i);
    }

    const manageRole = controllers[0];

    const jsonstore = meta.getService('jsonstore');
    if (!jsonstore || typeof jsonstore.open !== 'function') {
      if (bugLog) log(tag, 'missing_jsonstore_service name=jsonstore');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const store = jsonstore.open(storeRef.namespace);
    const command = meta.getService(commandService);
    if (!command || typeof command.register !== 'function') {
      if (bugLog) log(tag, 'missing_command_service name=' + commandService);
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    let assignments = {};
    try {
      const loaded = await store.get(storeRef.key, {});
      assignments = loaded && typeof loaded === 'object' ? loaded : {};
    } catch (err) {
      assignments = {};
      if (bugLog) log(tag, 'load_assignments_failed err=' + String(err && err.message ? err.message : err));
    }

    async function saveAssignments() {
      try {
        await store.set(storeRef.key, assignments);
      } catch (err) {
        if (bugLog) log(tag, 'save_assignments_failed err=' + String(err && err.message ? err.message : err));
      }
    }

    function hasPrivilegedRole() {
      const keys = Object.keys(assignments);
      for (let i = 0; i < keys.length; i += 1) {
        const role = normalizeRole(assignments[keys[i]], requiredRole);
        if (roleRank(role) >= roleRank(manageRole)) return true;
      }
      return false;
    }

    function principalFromCtx(ctx) {
      return normalizePrincipal(firstNonEmpty([
        ctx && ctx.sender && ctx.sender.id,
        ctx && ctx.sender && ctx.sender.phone,
        ctx && ctx.sender && ctx.sender.lid,
        ctx && ctx.author,
        ctx && ctx.from,
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
        q && q.id && q.id.remote,
      ]));
    }

    function getRole(any) {
      const k = principalFromAny(any);
      if (!k) return requiredRole;
      return normalizeRole(assignments[k], requiredRole);
    }

    function hasAtLeast(any, minRole) {
      return roleRank(getRole(any)) >= roleRank(normalizeRole(minRole, requiredRole));
    }

    function hasRole(any, reqRole) {
      return hasAtLeast(any, reqRole);
    }

    function isExactRole(any, role) {
      return getRole(any) === normalizeRole(role, requiredRole);
    }

    async function reply(ctx, textValue) {
      if (ctx && typeof ctx.reply === 'function' && textValue) await ctx.reply(textValue);
    }

    async function tryBootstrapOwner(actor) {
      const actorKey = normalizePrincipal(actor);
      if (!bootstrapFirstOwner) return;
      if (!actorKey) return;
      if (hasPrivilegedRole()) return;
      if (ownerSeedList.length > 0 && ownerSeedList.indexOf(actorKey) < 0) return;
      assignments[actorKey] = manageRole;
      await saveAssignments();
    }

    async function runRoleCommand(ctx) {
      const actor = principalFromCtx(ctx);
      const args = ctx && ctx.command && Array.isArray(ctx.command.args) ? ctx.command.args.slice() : [];
      const action = toStr(args.shift(), actionMe).toLowerCase();

      if (action === actionMe) {
        await tryBootstrapOwner(actor);
        const actorRole = getRole(actor);
        const message = msgMe.replace('{role}', actorRole).replace('{idKey}', actor || '');
        await reply(ctx, message);
        return;
      }

      await tryBootstrapOwner(actor);
      if (!hasAtLeast(actor, manageRole)) {
        await reply(ctx, msgNoAccess);
        return;
      }

      if (action === actionList) {
        const keys = Object.keys(assignments).sort();
        const rows = [];
        for (let i = 0; i < keys.length; i += 1) rows.push(keys[i] + '=' + getRole(keys[i]));
        await reply(ctx, msgListPrefix + (rows.length ? ('\n' + rows.join('\n')) : ''));
        return;
      }

      if (action === actionSet) {
        const target = firstNonEmpty([targetFromQuote(ctx), principalFromAny(args[0])]);
        const roleArg = normalizeRole(args[1], '');
        if (!target || !roleArg) {
          await reply(ctx, msgUsage);
          return;
        }
        if (controllers.indexOf(roleArg) < 0) {
          await reply(ctx, msgBadRole);
          return;
        }
        assignments[target] = roleArg;
        await saveAssignments();
        await reply(ctx, msgSetOk);
        return;
      }

      if (action === actionDel) {
        const target = firstNonEmpty([targetFromQuote(ctx), principalFromAny(args[0])]);
        if (!target) {
          await reply(ctx, msgUsage);
          return;
        }
        if (!Object.prototype.hasOwnProperty.call(assignments, target)) {
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
      getRole,
      hasAtLeast,
      hasRole,
      isExactRole,
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
      },
    };

    meta.registerService('access', service);
    command.register(cmdRole, runRoleCommand, { owner: 'AccessRolesCV', help: cmdHelp });

    if (moduleLog) {
      log(tag, 'ready command=' + cmdRole + ' serviceName=' + serviceName + ' store=' + storeRef.namespace + '/' + storeRef.key);
    }
    if (detailLog || traceLog) {
      log(tag, 'bootstrapFirstOwner=' + (bootstrapFirstOwner ? '1' : '0') + ' roles=' + controllers.join(','));
    }

    return { onMessage: async () => {}, onEvent: async () => {} };
  },
};