'use strict';

function text(value) {
  return String(value ?? '').trim();
}

function toBool(value) {
  const s = text(value).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function keyText(value) {
  return text(value).toLowerCase();
}

function fill(template, vars) {
  let out = String(template || '');
  Object.keys(vars).forEach((name) => {
    out = out.split(`{${name}}`).join(String(vars[name] ?? ''));
  });
  return out;
}

module.exports = {
  init: async (meta) => {
    const logTag = 'WorkGroupsCV';
    const cfg = meta.implConf || {};

    const requiredKeys = [
      'globalConfRel',
      'cmdWorkGroup',
      'actionHelp',
      'actionList',
      'actionAdd',
      'actionDel',
      'storeNs',
      'storeKey',
      'minRoleWorkGroup',
      'replyNoAccess',
      'replyGroupOnly',
      'replyControlGroupOnly',
      'replyUsageHelp',
      'replyUsageList',
      'replyUsageAdd',
      'replyUsageDel',
      'replyListEmpty',
      'replyListItemTemplate',
      'replyListTemplate',
      'replyAddNeedName',
      'replyAddNeedChatId',
      'replyAddOk',
      'replyDelNeedName',
      'replyDelNotFound',
      'replyDelOk',
      'replyUnknownAction',
      'cmdWorkGroupHelp',
    ];

    const missing = requiredKeys.filter((key) => !text(cfg[key]));
    const bugLogEnabled = toBool(cfg.bugLog);
    if (missing.length) {
      if (bugLogEnabled) {
        meta.log(logTag, `config invalid missing=${missing.join(',')}`);
      }
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    let loaded = {};
    if (typeof meta.loadConfRel === 'function') {
      loaded = meta.loadConfRel(text(cfg.globalConfRel)) || {};
    }
    const globalConf = loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : (loaded || {});

    const globalControlGroupId = text(globalConf.controlGroupId);
    const globalPrefix = text(globalConf.prefix);
    const serviceName = String(globalConf.sendPrefer || '')
      .split(',')
      .map((x) => text(x))
      .filter(Boolean)[0] || '';
    const send = serviceName ? meta.getService(serviceName) : null;

    if (!globalControlGroupId) {
      if (bugLogEnabled) {
        meta.log(logTag, 'global config invalid missing=controlGroupId');
      }
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const command = meta.getService('command');
    if (!command || typeof command.register !== 'function') {
      if (bugLogEnabled) {
        meta.log(logTag, 'missing command service');
      }
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const access = meta.getService('access');
    const jsonstore = meta.getService('jsonstore');
    if (!jsonstore || typeof jsonstore.open !== 'function') {
      if (bugLogEnabled) {
        meta.log(logTag, 'missing jsonstore service');
      }
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const store = jsonstore.open(text(cfg.storeNs));

    async function sendReply(ctx, payload) {
      const message = text(payload);
      if (!message) return;

      if (ctx && typeof ctx.reply === 'function') {
        await ctx.reply(message);
        return;
      }

      if (typeof send === 'function' && ctx && ctx.chatId) {
        await send(ctx.chatId, message, { isAuto: 0 });
      }
    }

    async function isAllowed(ctx) {
      const minRole = text(cfg.minRoleWorkGroup);
      if (!minRole) return true;
      if (!access) return false;

      if (typeof access.hasRole === 'function') return !!(await access.hasRole(ctx, minRole));
      if (typeof access.isAllowed === 'function') return !!(await access.isAllowed(ctx, minRole));
      if (typeof access.check === 'function') return !!(await access.check(ctx, minRole));
      if (typeof access.meetsMinRole === 'function') return !!(await access.meetsMinRole(ctx, minRole));
      return false;
    }

    function inControlGroup(ctx) {
      return text(ctx && ctx.chatId) === globalControlGroupId;
    }

    async function loadState() {
      const raw = await store.get(text(cfg.storeKey), { groups: [] });
      const groups = raw && Array.isArray(raw.groups) ? raw.groups : [];
      return { groups };
    }

    async function saveState(state) {
      const next = { groups: Array.isArray(state.groups) ? state.groups : [] };
      await store.set(text(cfg.storeKey), next);
    }

    function normalizeRecord(name, chatId) {
      return {
        name: text(name),
        chatId: text(chatId),
      };
    }

    function listLines(groups) {
      return groups.map((item) => fill(cfg.replyListItemTemplate, {
        NAME: text(item.name),
        CHATID: text(item.chatId),
      }));
    }

    async function resolveWorkgroup(key) {
      const probe = keyText(key);
      if (!probe) return '';
      const state = await loadState();
      const found = state.groups.find((item) => keyText(item && item.name) === probe);
      if (!found) return '';
      const chatId = text(found.chatId);
      if (!chatId) return '';
      return { name: text(found.name), chatId, groupChatId: chatId };
    }

    if (typeof meta.registerService === 'function') {
      meta.registerService('workgroups', {
        resolve: async (key) => {
          return await resolveWorkgroup(key);
        },
      });
    }

    const cmdWorkGroup = keyText(cfg.cmdWorkGroup);
    const actionHelp = keyText(cfg.actionHelp);
    const actionList = keyText(cfg.actionList);
    const actionAdd = keyText(cfg.actionAdd);
    const actionDel = keyText(cfg.actionDel);

    command.register(cmdWorkGroup, async (ctx) => {
      if (!(await isAllowed(ctx))) {
        await sendReply(ctx, cfg.replyNoAccess);
        return;
      }

      if (!ctx || !ctx.isGroup) {
        await sendReply(ctx, cfg.replyGroupOnly);
        return;
      }

      if (!inControlGroup(ctx)) {
        await sendReply(ctx, cfg.replyControlGroupOnly);
        return;
      }

      const args = ctx && ctx.command && Array.isArray(ctx.command.args)
        ? ctx.command.args.map((v) => text(v))
        : [];

      const action = keyText(args[0] || actionHelp);

      if (action === actionHelp) {
        const prefix = text((ctx && ctx.command && ctx.command.prefix) || globalPrefix);
        const body = [
          cfg.replyUsageHelp,
          fill(cfg.replyUsageList, { PREFIX: prefix, CMD: cmdWorkGroup, ACTION: actionList }),
          fill(cfg.replyUsageAdd, { PREFIX: prefix, CMD: cmdWorkGroup, ACTION: actionAdd }),
          fill(cfg.replyUsageDel, { PREFIX: prefix, CMD: cmdWorkGroup, ACTION: actionDel }),
        ].join('\n');
        await sendReply(ctx, body);
        return;
      }

      if (action === actionList) {
        const state = await loadState();
        if (!state.groups.length) {
          await sendReply(ctx, cfg.replyListEmpty);
          return;
        }

        const lines = listLines(state.groups);
        await sendReply(ctx, fill(cfg.replyListTemplate, { ITEMS: lines.join('\n') }));
        return;
      }

      if (action === actionAdd) {
        const name = text(args[1]);
        if (!name) {
          await sendReply(ctx, cfg.replyAddNeedName);
          return;
        }

        const chatId = text(args[2]);
        if (!chatId) {
          await sendReply(ctx, cfg.replyAddNeedChatId);
          return;
        }

        const state = await loadState();
        const mapKey = keyText(name);
        const record = normalizeRecord(name, chatId);
        const foundIndex = state.groups.findIndex((item) => keyText(item && item.name) === mapKey);
        if (foundIndex >= 0) {
          state.groups[foundIndex] = record;
        } else {
          state.groups.push(record);
        }

        await saveState(state);
        await sendReply(ctx, fill(cfg.replyAddOk, { NAME: record.name, CHATID: record.chatId }));
        return;
      }

      if (action === actionDel) {
        const name = text(args[1]);
        if (!name) {
          await sendReply(ctx, cfg.replyDelNeedName);
          return;
        }

        const state = await loadState();
        const mapKey = keyText(name);
        const next = state.groups.filter((item) => keyText(item && item.name) !== mapKey);

        if (next.length === state.groups.length) {
          await sendReply(ctx, fill(cfg.replyDelNotFound, { NAME: name }));
          return;
        }

        await saveState({ groups: next });
        await sendReply(ctx, fill(cfg.replyDelOk, { NAME: name }));
        return;
      }

      await sendReply(ctx, cfg.replyUnknownAction);
    }, {
      owner: logTag,
      help: cfg.cmdWorkGroupHelp,
      minRole: text(cfg.minRoleWorkGroup),
    });

    meta.log(logTag, `ready cmdWorkGroup=${cmdWorkGroup}`);
    return { onMessage: async () => {}, onEvent: async () => {} };
  },
};