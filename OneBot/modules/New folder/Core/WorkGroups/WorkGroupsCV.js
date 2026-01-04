'use strict';

// X:\OneBot\Modules\Core\WorkGroups\WorkGroupsCV.js
// Version: 2026.01.01
// Minimal Work Groups registry.
// Commands:
//   !group list
//   !group add <name> [chatId]
//   !group del <name>
// If chatId is omitted for "add", current chatId is used (must run in a group).

const Conf = require('../Shared/SharedConfV1');

function makeLogger(meta, tag) {
  return {
    info: (msg) => meta.log(tag, msg),
    warn: (msg) => meta.log(tag, `WARN ${msg}`),
    error: (msg) => meta.log(tag, `ERROR ${msg}`),
  };
}

function normName(name) {
  return String(name || '').trim();
}

function keyOf(name) {
  return normName(name).toLowerCase();
}

module.exports = {
  init: (meta) => {
    const log = makeLogger(meta, 'WorkGroupsCV');

    const implConfig = meta && meta.hubConf && meta.hubConf.implConfig ? meta.hubConf.implConfig : '';
    const conf = Conf.load(meta, implConfig);

    const enabled = conf.getBool('enabled', true);
    if (!enabled) {
      log.warn('disabled by config');
      return { onMessage: async () => null };
    }

    const commandService = conf.getStr('commandService', 'command');
    const accessService = conf.getStr('accessService', 'access');
    const requiredRole = conf.getStr('requiredRole', 'staff');

    const storeNs = conf.getStr('storeNs', 'core');
    const storeKey = conf.getStr('storeKey', 'WorkGroups/groups');

    const cmdGroup = conf.getStr('cmdGroup', 'group');

    const commands = meta.getService(commandService);
    const access = meta.getService(accessService);
    const jsonstore = meta.getService('jsonstore');

    if (!jsonstore) {
      log.error('missing jsonstore service');
      return { onMessage: async () => null };
    }

    const store = jsonstore.open(storeNs);

    async function loadGroups() {
      const rec = await store.get(storeKey, { groups: [] });
      const groups = Array.isArray(rec && rec.groups) ? rec.groups : [];
      return groups;
    }

    async function saveGroups(groups) {
      await store.set(storeKey, { groups: Array.isArray(groups) ? groups : [] });
    }

    function isAllowed(ctx) {
      if (!access) return true;
      const senderId = String(ctx && ctx.senderId ? ctx.senderId : '');
      if (!senderId) return false;
      return access.hasAtLeast(senderId, requiredRole);
    }

    async function reply(ctx, text) {
      if (ctx && typeof ctx.reply === 'function') {
        await ctx.reply(String(text || ''));
      }
    }

    async function onGroupCommand(ctx, args) {
      if (!isAllowed(ctx)) {
        await reply(ctx, 'Not allowed.');
        return;
      }

      const sub = String(args && args[0] ? args[0] : '').trim().toLowerCase();

      if (!sub || sub === 'help') {
        await reply(
          ctx,
          [
            'Work Groups',
            `- !${cmdGroup} list`,
            `- !${cmdGroup} add <name> [chatId]`,
            `- !${cmdGroup} del <name>`,
            '',
            'Tip: If chatId is omitted for add, current chatId is used (run inside the target group).',
          ].join('\n')
        );
        return;
      }

      if (sub === 'list') {
        const groups = await loadGroups();
        if (!groups.length) {
          await reply(ctx, 'No groups saved.');
          return;
        }
        const lines = ['Saved Groups:'];
        for (const g of groups) {
          lines.push(`- ${g.name} = ${g.chatId}`);
        }
        await reply(ctx, lines.join('\n'));
        return;
      }

      if (sub === 'add' || sub === 'set') {
        const name = normName(args[1]);
        let chatId = String(args[2] || '').trim();

        if (!name) {
          await reply(ctx, `Usage: !${cmdGroup} add <name> [chatId]`);
          return;
        }

        if (!chatId) {
          if (!ctx || !ctx.isGroup) {
            await reply(ctx, 'chatId missing. Run this command inside the target group or provide chatId.');
            return;
          }
          chatId = String((ctx && ctx.chatId) ? ctx.chatId : ((ctx && ctx.message && ctx.message.from) ? ctx.message.from : '')).trim();
        }

        if (!chatId) {
          await reply(ctx, 'Invalid chatId.');
          return;
        }

        const groups = await loadGroups();
        const k = keyOf(name);
        const existingIdx = groups.findIndex((x) => keyOf(x.name) === k);

        const rec = { name, chatId };
        if (existingIdx >= 0) groups[existingIdx] = rec;
        else groups.push(rec);

        await saveGroups(groups);
        await reply(ctx, `Saved: ${name} = ${chatId}`);
        return;
      }

      if (sub === 'del' || sub === 'remove') {
        const name = normName(args[1]);
        if (!name) {
          await reply(ctx, `Usage: !${cmdGroup} del <name>`);
          return;
        }

        const groups = await loadGroups();
        const k = keyOf(name);
        const before = groups.length;
        const next = groups.filter((x) => keyOf(x.name) !== k);

        if (next.length === before) {
          await reply(ctx, 'Not found.');
          return;
        }

        await saveGroups(next);
        await reply(ctx, `Deleted: ${name}`);
        return;
      }

      await reply(ctx, `Unknown subcommand. Use !${cmdGroup} help`);
    }

    if (!commands || typeof commands.register !== 'function') {
      log.error(`missing command service (${commandService}) or register() not available`);
      return { onMessage: async () => null };
    }

    commands.register(cmdGroup, onGroupCommand, {
      desc: 'Manage work group list',
      usage: `!${cmdGroup} help`,
    });

    log.info('ready');
    return { onMessage: async () => null };
  },
};
