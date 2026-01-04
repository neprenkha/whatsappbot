'use strict';

const { createCommandHandlerV1 } = require('./WorkGroupsCommandHandlerV1');

function createRouterV1(meta, cfg, service, store) {
  const handler = createCommandHandlerV1(meta, cfg, service);

  function onMessage(msg) {
    if (!msg || !msg.text) return;
    const text = String(msg.text || '').trim();
    if (!text.startsWith('!')) return;

    const cmdText = text.slice(1).trim();

    // only in groups (usually control group)
    if (!msg.isGroup) return;

    // handle only group commands
    if (
      cmdText === cfg.cmdGroup ||
      cmdText === cfg.cmdGroupList ||
      cmdText === cfg.cmdGroupWho ||
      cmdText.startsWith(cfg.cmdGroupAdd + ' ') ||
      cmdText.startsWith(cfg.cmdGroupSet + ' ') ||
      cmdText.startsWith(cfg.cmdGroupDel + ' ')
    ) {
      handler.handle(msg, cmdText);
    }
  }

  return { onMessage };
}

module.exports = { createRouterV1 };
