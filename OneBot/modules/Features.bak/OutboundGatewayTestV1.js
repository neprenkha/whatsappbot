'use strict';

/**
 * OutboundGatewayTestV1 (Feature)
 * Commands (Control Group only):
 *   !ogcheck           -> show allow/block via sendout.check()
 *   !ogsend <msg...>   -> attempt send via sendout() (RateLimit enforced)
 */

function toStr(v, defVal) {
  const s = String(v ?? '').trim();
  return s ? s : defVal;
}
function toBool(v, defVal) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return defVal;
  return !(s === '0' || s === 'false' || s === 'no' || s === 'off');
}

module.exports.init = async function init(meta) {
  const enabled = toBool(meta.implConf.enabled, true);
  if (!enabled) return { onEvent: async () => {}, onMessage: async () => {} };

  const controlGroupId = toStr(meta.implConf.controlGroupId, '');
  const cmdCheck = toStr(meta.implConf.cmdCheck, 'ogcheck').toLowerCase();
  const cmdSend = toStr(meta.implConf.cmdSend, 'ogsend').toLowerCase();

  const cmd = meta.getService('command') || meta.getService('commands');
  const sendout = meta.getService('sendout') || meta.getService('outsend');

  function isControlGroup(ctx) {
    if (!controlGroupId) return true;
    return String(ctx.chatId || '') === controlGroupId;
  }

  if (!cmd || typeof cmd.register !== 'function') {
    meta.log('OutboundGatewayTestV1', 'error missing command service');
    return { onEvent: async () => {}, onMessage: async () => {} };
  }
  if (!sendout || typeof sendout !== 'function') {
    meta.log('OutboundGatewayTestV1', 'error missing sendout service (OutboundGateway core not loaded)');
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  cmd.register(cmdCheck, async (ctx) => {
    if (!isControlGroup(ctx)) return;

    const r = (typeof sendout.check === 'function')
      ? sendout.check(ctx.chatId, 1)
      : null;

    if (!r) return ctx.reply('No check() available.');

    const lines = [];
    lines.push(r.ok ? '✅ ALLOW (sendout.check)' : '⛔ BLOCK (sendout.check)');
    lines.push(`reason: ${r.reason || '-'}`);
    if (!r.ok) lines.push(`waitMs: ${Math.max(0, Number(r.waitMs || 0))}`);
    return ctx.reply(lines.join('\n'));
  }, { owner: 'OutboundGatewayTestV1', help: 'Check outbound gateway allow/block.' });

  cmd.register(cmdSend, async (ctx) => {
    if (!isControlGroup(ctx)) return;

    const msg = String((ctx.command?.args || []).join(' ') || '').trim();
    if (!msg) return ctx.reply('❗ Usage: !ogsend <message>');

    const res = await sendout(ctx.chatId, `🟢 OUTBOUND TEST\n${msg}`, { weight: 1 });

    if (res && res.ok) {
      return ctx.reply('✅ Sent via sendout().');
    }
    if (res && res.blocked) {
      return ctx.reply(`⛔ BLOCKED\nreason: ${res.reason}\nwaitMs: ${Math.max(0, Number(res.waitMs || 0))}`);
    }
    return ctx.reply(`❌ ERROR\n${(res && (res.message || res.reason)) || 'unknown'}`);
  }, { owner: 'OutboundGatewayTestV1', help: 'Send via outbound gateway.' });

  meta.log('OutboundGatewayTestV1', `ready controlGroupId=${controlGroupId}`);
  return { onEvent: async () => {}, onMessage: async () => {} };
};
