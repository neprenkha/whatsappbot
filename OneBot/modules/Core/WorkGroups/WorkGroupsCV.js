'use strict';

// X:\OneBot\Modules\Core\WorkGroups\WorkGroupsCV.js
// Version: 2026.01.01
// Minimal Work Groups registry.

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

    if (!conf.getBool('enabled', true)) {
      log.warn('Module is disabled via configuration.');
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

    if (!commands || typeof commands.register !== 'function') {
      log.error(`Missing "command" service or "register" function not available.`);
      return { onMessage: async () => null };
    }

    if (!jsonstore) {
      log.error('Missing "jsonstore" service.');
      return { onMessage: async () => null };
    }

    const store = jsonstore.open(storeNs);

    async function loadGroups() {
      try {
        const rec = await store.get(storeKey, { groups: [] });
        return Array.isArray(rec.groups) ? rec.groups : [];
      } catch (e) {
        log.error(`Failed to load groups: ${e.message}`);
        return [];
      }
    }

    async function saveGroups(groups) {
      try {
        await store.set(storeKey, { groups: Array.isArray(groups) ? groups : [] });
        log.info('Groups saved successfully.');
      } catch (e) {
        log.error(`Failed to save groups: ${e.message}`);
      }
    }

    function isAllowed(ctx) {
      if (!access) return true;
      const senderId = String(ctx?.senderId || '');
      if (!senderId) return false;
      return access.hasAtLeast(senderId, requiredRole);
    }

    async function reply(ctx, text) {
      if (ctx && typeof ctx.reply === 'function') {
        try {
          await ctx.reply(String(text || ''));
        } catch (e) {
          log.error(`Failed to send reply: ${e.message}`);
        }
      }
    }

    async function onGroupCommand(ctx, args) {
      if (!isAllowed(ctx)) {
        await reply(ctx, 'Not allowed.');
        return;
      }

      const sub = String(args[0] || '').trim().toLowerCase();

      if (!sub || sub === 'help') {
        await reply(
          ctx,
          [
            'Work Groups Commands:',
            `- !${cmdGroup} list`,
            `- !${cmdGroup} add <name> [chatId]`,
            `- !${cmdGroup} del <name>`,
            '',
            'Note: If "chatId" is omitted during "add", the current chatId will be used.',
          ].join('\n')
        );
        return;
      }

      if (sub === 'list') {
        const groups = await loadGroups();
        await reply(
          ctx,
          groups.length ? `Groups:\n${groups.map(g => `- ${g.name} = ${g.chatId}`).join('\n')}` : 'No groups are currently saved.'
        );
        return;
      }

      if (sub === 'add') {
        const name = normName(args[1]);
        let chatId = String(args[2] || '').trim();

        if (!name) {
          await reply(ctx, `Usage: !${cmdGroup} add <name> [chatId]`);
          return;
        }

        if (!chatId) {
          if (!ctx?.isGroup) {
            await reply(ctx, 'Please provide a chatId or run this command inside the target group.');
            return;
          }
          chatId = String(ctx?.chatId || ctx?.message?.from || '').trim();
        }

        const groups = await loadGroups();
        const k = keyOf(name);
        const existingIdx = groups.findIndex(group => keyOf(group.name) === k);

        const record = { name, chatId };
        if (existingIdx >= 0) groups[existingIdx] = record;
        else groups.push(record);

        await saveGroups(groups);
        await reply(ctx, `Group "${name}" has been successfully saved with chatId "${chatId}".`);
        return;
      }

      if (sub === 'del') {
        const name = normName(args[1]);
        if (!name) {
          await reply(ctx, `Usage: !${cmdGroup} del <name>`);
          return;
        }

        const groups = await loadGroups();
        const nextGroups = groups.filter(group => keyOf(group.name) !== keyOf(name));

        if (nextGroups.length === groups.length) {
          await reply(ctx, `No group found with the name "${name}".`);
          return;
        }

        await saveGroups(nextGroups);
        await reply(ctx, `Group "${name}" has been deleted.`);
        return;
      }

      await reply(ctx, `Unknown subcommand. Use "!${cmdGroup} help" for a list of supported commands.`);
    }

    commands.register(cmdGroup, onGroupCommand, {
      desc: 'Manage work groups',
      usage: `!${cmdGroup} help`,
    });

    log.info('WorkGroupsCV is ready.');
    return { onMessage: async () => null };
  },
};