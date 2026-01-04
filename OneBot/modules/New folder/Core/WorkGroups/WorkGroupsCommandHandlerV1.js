'use strict';

function createCommandHandlerV1(meta, cfg, service) {
  async function send(chatId, text) {
    if (!meta || typeof meta.sendText !== 'function') return;
    try {
      const r = await meta.sendText(chatId, text);
      if (r && r.ok === false) {
        meta.log('WorkGroupsCmd', `send failed chatId=${chatId} err=${r.err || 'unknown'}`);
      }
    } catch (e) {
      meta.log('WorkGroupsCmd', `send exception chatId=${chatId} err=${e && e.message ? e.message : e}`);
    }
  }

  function fmtGroupList(groups) {
    if (!groups || groups.length === 0) return 'WorkGroups: (empty)';
    const lines = ['WorkGroups:'];
    for (const g of groups) {
      lines.push(`- ${g.name} => ${g.chatId}`);
    }
    return lines.join('\n');
  }

  function handle(msg, cmdText) {
    const t = String(cmdText || '').trim();

    if (t === cfg.cmdGroup || t === cfg.cmdGroupList) {
      const groups = service.listGroups();
      send(msg.chatId, fmtGroupList(groups));
      return true;
    }

    if (t.startsWith(cfg.cmdGroupAdd + ' ')) {
      const name = t.slice((cfg.cmdGroupAdd + ' ').length).trim();
      const r = service.setGroup(name, msg.chatId);
      send(msg.chatId, r.ok ? `OK added/updated: ${name}` : `ERR: ${r.err}`);
      return true;
    }

    if (t.startsWith(cfg.cmdGroupSet + ' ')) {
      const name = t.slice((cfg.cmdGroupSet + ' ').length).trim();
      const r = service.setGroup(name, msg.chatId);
      send(msg.chatId, r.ok ? `OK set: ${name}` : `ERR: ${r.err}`);
      return true;
    }

    if (t.startsWith(cfg.cmdGroupDel + ' ')) {
      const name = t.slice((cfg.cmdGroupDel + ' ').length).trim();
      const r = service.delGroup(name);
      send(msg.chatId, r.ok ? `OK deleted: ${name}` : `ERR: ${r.err}`);
      return true;
    }

    if (t === cfg.cmdGroupWho) {
      const g = service.getGroupForChatId(msg.chatId);
      send(msg.chatId, g ? `This chat is: ${g.name}` : 'This chat is not mapped.');
      return true;
    }

    // Unknown subcommand under "!group" => show quick hint (so tak senyap)
    send(msg.chatId, 'Usage: !group | !group list | !group add <name> | !group del <name> | !group who');
    return true;
  }

  return { handle };
}

module.exports = { createCommandHandlerV1 };
