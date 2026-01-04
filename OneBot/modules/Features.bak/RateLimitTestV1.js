'use strict';

/**
 * RateLimitTestV1 (Feature)
 * Commands (Control Group only):
 *   !rlsnap              -> show ratelimit snapshot
 *   !rlcheck             -> check allow/block for this chat now
 *   !rlsend <msg...>     -> send 1 msg with rl check+commit
 *   !rlspam <n> [gapMs]  -> attempt to send n msgs; stop when blocked
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
function toInt(v, defVal) {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : defVal;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports.init = async function init(meta) {
  const enabled = toBool(meta.implConf.enabled, true);
  if (!enabled) return { onEvent: async () => {}, onMessage: async () => {} };

  const controlGroupId = toStr(meta.implConf.controlGroupId, '');
  const cmdSnap = toStr(meta.implConf.cmdSnap, 'rlsnap').toLowerCase();
  const cmdCheck = toStr(meta.implConf.cmdCheck, 'rlcheck').toLowerCase();
  const cmdSpam = toStr(meta.implConf.cmdSpam, 'rlspam').toLowerCase();
  const cmdSend = toStr(meta.implConf.cmdSend, 'rlsend').toLowerCase();

  const cmd = meta.getService('command') || meta.getService('commands');
  const rl = meta.getService('ratelimit') || meta.getService('rl');
  const sendSvc = meta.getService('send');

  async function send(chatId, text) {
    if (typeof sendSvc === 'function') {
      return sendSvc(chatId, String(text || '').trim(), {});
    }
  }

  function isControlGroup(ctx) {
    if (!controlGroupId) return true;
    return String(ctx.chatId || '') === controlGroupId;
  }

  if (!rl) {
    meta.log('RateLimitTestV1', 'error missing ratelimit service (load RateLimit core)');
    return { onEvent: async () => {}, onMessage: async () => {} };
  }
  if (!cmd || typeof cmd.register !== 'function') {
    meta.log('RateLimitTestV1', 'error missing command service');
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  cmd.register(cmdSnap, async (ctx) => {
    if (!isControlGroup(ctx)) return;
    const s = rl.snapshot ? rl.snapshot() : null;
    if (!s) return ctx.reply('No snapshot available.');
    const lines = [];
    lines.push(`RateLimit snapshot`);
    lines.push(`enabled: ${s.enabled ? 1 : 0}`);
    lines.push(`dateKey: ${s.dateKey}`);
    lines.push(`minNow: ${s.minNow}`);
    lines.push(`windows: ${Array.isArray(s.windows) ? s.windows.length : 0}`);
    if (Array.isArray(s.windows) && s.windows.length) {
      for (const w of s.windows) lines.push(`- ${w.startMin}-${w.endMin}`);
    }
    lines.push(`globalSent: ${s.globalSent}`);
    lines.push(`chatsTracked: ${s.chats}`);
    return ctx.reply(lines.join('\n'));
  }, { owner: 'RateLimitTestV1', help: 'Show RateLimit snapshot.' });

  cmd.register(cmdCheck, async (ctx) => {
    if (!isControlGroup(ctx)) return;
    const r = rl.check({ chatId: ctx.chatId, weight: 1 });
    const lines = [];
    lines.push(r.ok ? '✅ ALLOW' : '⛔ BLOCK');
    lines.push(`reason: ${r.reason || '-'}`);
    if (!r.ok) lines.push(`waitMs: ${Math.max(0, Number(r.waitMs || 0))}`);
    return ctx.reply(lines.join('\n'));
  }, { owner: 'RateLimitTestV1', help: 'Check allow/block now.' });

  cmd.register(cmdSend, async (ctx) => {
    if (!isControlGroup(ctx)) return;
    const msg = String((ctx.command?.args || []).join(' ') || '').trim();
    if (!msg) return ctx.reply('❗ Usage: !rlsend <message>');
    const r = rl.check({ chatId: ctx.chatId, weight: 1 });
    if (!r.ok) {
      return ctx.reply(`⛔ BLOCK\nreason: ${r.reason}\nwaitMs: ${Math.max(0, Number(r.waitMs || 0))}`);
    }
    await send(ctx.chatId, `🟢 RL SEND\n${msg}`);
    if (typeof rl.commit === 'function') rl.commit({ chatId: ctx.chatId, weight: 1 });
    return ctx.reply('✅ Sent (rl committed).');
  }, { owner: 'RateLimitTestV1', help: 'Send 1 message through RL check+commit.' });

  cmd.register(cmdSpam, async (ctx) => {
    if (!isControlGroup(ctx)) return;

    const n = Math.max(1, toInt(ctx.command?.args?.[0], 10));
    const gapMs = Math.max(0, toInt(ctx.command?.args?.[1], 0));

    let sent = 0;
    let blocked = null;

    for (let i = 1; i <= n; i++) {
      const r = rl.check({ chatId: ctx.chatId, weight: 1 });
      if (!r.ok) { blocked = r; break; }

      await send(ctx.chatId, `🟩 RL SPAM ${i}/${n}`);
      if (typeof rl.commit === 'function') rl.commit({ chatId: ctx.chatId, weight: 1 });
      sent++;

      if (gapMs > 0) await sleep(gapMs);
    }

    if (blocked) {
      return ctx.reply(
        `⛔ Stopped\nsent: ${sent}/${n}\nreason: ${blocked.reason}\nwaitMs: ${Math.max(0, Number(blocked.waitMs || 0))}`
      );
    }

    return ctx.reply(`✅ Done\nsent: ${sent}/${n}`);
  }, { owner: 'RateLimitTestV1', help: 'Spam test: !rlspam <n> [gapMs]' });

  meta.log('RateLimitTestV1', `ready controlGroupId=${controlGroupId}`);
  return { onEvent: async () => {}, onMessage: async () => {} };
};
