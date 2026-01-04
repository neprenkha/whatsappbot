'use strict';

/**
 * HelpV1 (Core)
 * - Provides !help
 * - Uses Command service
 */

function toStr(v, def = '') {
  const s = String(v ?? '').trim();
  return s ? s : def;
}

module.exports.init = async function init(meta) {
  const cmdHelp = toStr(meta.implConf.cmdHelp, 'help');

  async function reply(ctx, text) {
    const msg = String(text || '').trim();
    if (!msg) return;
    if (ctx && typeof ctx.reply === 'function') return ctx.reply(msg);

    const send = meta.getService('send');
    if (send && ctx && ctx.chatId) return send(ctx.chatId, msg, {});
  }

  const cmd = meta.getService('command') || meta.getService('commands');
  if (!cmd || typeof cmd.register !== 'function') {
    meta.log('HelpV1', 'error missing command service (load Command module before Help)');
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  cmd.register(cmdHelp, async (ctx) => {
    const list = (typeof cmd.list === 'function') ? cmd.list() : [];
    const prefix = String(cmd.prefix || '!');

    const rows = list
      .filter(x => x && !x.hidden)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
      .map(x => {
        const name = String(x.name || '').trim();
        const help = String(x.help || '').trim();
        return help ? `${prefix}${name} — ${help}` : `${prefix}${name}`;
      });

    const text = rows.length ? `Commands:\n${rows.join('\n')}` : 'No commands registered.';
    await reply(ctx, text);
  }, { owner: 'HelpV1', help: 'Show available commands.' });

  meta.log('HelpV1', `ready cmdHelp=${cmdHelp}`);

  return { onEvent: async () => {}, onMessage: async () => {} };
};
