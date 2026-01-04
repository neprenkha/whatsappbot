'use strict';

/**
 * LogV1 (Core)
 * - Simple console logging for debugging
 */

function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

module.exports.init = async function init(meta) {
  const logEvents = String(meta.implConf.logEvents || '1').trim() !== '0';
  const logMessages = String(meta.implConf.logMessages || '1').trim() !== '0';

  return {
    onEvent: async (ctx) => {
      if (!logEvents) return;
      meta.log('event', `keys=${Object.keys(ctx.data || {}).join(',')}`);
    },
    onMessage: async (ctx) => {
      if (!logMessages) return;
      const info = pick(ctx, ['chatId', 'isGroup', 'text']);
      const sender = pick(ctx.sender || {}, ['id', 'phone', 'lid', 'name']);
      meta.log('msg', `chatId=${info.chatId} isGroup=${info.isGroup} sender=${JSON.stringify(sender)} text=${JSON.stringify(info.text)}`);
    },
  };
};
