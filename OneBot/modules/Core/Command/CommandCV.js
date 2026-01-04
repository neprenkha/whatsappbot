'use strict';

/**
 * CommandCV (Router for registered commands)
 * Purpose: Route commands based on registered commands under prefixes.
 */

const Conf = require('../Shared/SharedConfV1');

module.exports.init = async function init(meta) {
  const config = Conf.load(meta);
  const controlGroupId = config.getStr('controlGroupId', '');

  const commands = new Map();

  // Registers a command
  function register(command, handler, opts) {
    const normalized = String(command).toLowerCase().trim();
    commands.set(normalized, handler);
  }

  async function onMessage(context) {
    const text = context.text || '';
    const matched = text.startsWith('!') ? text.slice(1).split(/\s+/) : null;
    if (matched && commands.has(matched[0].toLowerCase())) {
      return commands.get(matched[0].toLowerCase())(context, matched.slice(1));
    }
    if (controlGroupId === context.chatId) {
      await context.reply('Unknown command. Use !help.');
    }
  }

  meta.registerService('command', { register });
  return { onMessage };
};