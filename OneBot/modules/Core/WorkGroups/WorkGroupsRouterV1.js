'use strict';

/**
 * WorkGroupsRouterV1
 * - Handles group commands: !group add/list/del.
 * - Interfaces WorkGroupsStore for persistence.
 */

const WorkGroupsStore = require('../Shared/WorkGroupsStoreV1');

async function route(meta, ctx, args) {
  const command = args[0] || '';
  const groupName = args[1] || '';
  const groupChatId = ctx.chatId || '';

  switch (command) {
    case 'list': {
      const groups = await WorkGroupsStore.list();
      const response = groups.length
        ? `Groups:\n${groups.map((g) => `- ${g.name} (${g.chatId})`).join('\n')}`
        : 'No groups available.';
      ctx.reply(response);
      break;
    }
    case 'add': {
      if (!groupName || !groupChatId) {
        ctx.reply('Usage: !group add <name>');
        return { ok: false, reason: 'bad.command' };
      }
      const result = await WorkGroupsStore.add(groupName, groupChatId);
      ctx.reply(result.ok ? `Group added: ${groupName}` : `Failed to add group: ${groupName}`);
      return result;
    }
    case 'del': {
      const result = await WorkGroupsStore.del(groupName);
      ctx.reply(result.ok ? `Group deleted: ${groupName}` : `Failed to delete group: ${groupName}`);
      return result;
    }
    default:
      ctx.reply('Unknown group command. Use !group add/list/del.');
      return { ok: false, reason: 'unknown.command' };
  }
}

module.exports = { route };