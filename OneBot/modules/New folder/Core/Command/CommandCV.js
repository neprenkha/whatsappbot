'use strict';

/*
  CommandCV
  - Central command router (prefix based)
  - Exposes service 'command' and alias 'commands'
  - Supports Help module (list(), prefix)
  Version: 2026.01.01
*/

const Conf = require('../Shared/SharedConfV1');

function splitArgs(s) {
  const t = String(s || '').trim();
  if (!t) return [];
  return t.split(/\s+/g).filter(Boolean);
}

module.exports.init = async function init(meta) {
  meta = meta || {};
  const conf = Conf.load(meta);

  const prefixRaw = conf.getStr('prefix', '!');
  const prefixes = Conf.parseCsv(prefixRaw).length ? Conf.parseCsv(prefixRaw) : [prefixRaw];
  const allowInDm = conf.getBool('allowInDm', true);
  const allowInGroups = conf.getBool('allowInGroups', true);

  const unknownText = conf.getStr('unknownText', 'Unknown command. Use !help');
  const unknownControlGroupOnly = conf.getBool('unknownControlGroupOnly', false);
  const unknownPassthroughDm = conf.getBool('unknownPassthroughDm', true);
  const controlGroupId = conf.getStr('controlGroupId', '');

  const registry = new Map(); // cmd -> {fn, meta}
  const order = [];

  function detectPrefix(text) {
    const s = String(text || '');
    for (const p of prefixes) {
      if (!p) continue;
      if (s.startsWith(p)) return p;
    }
    return '';
  }

  function normalizeCmdName(name) {
    return String(name || '').trim().toLowerCase();
  }

  function register(cmdName, fn, opts) {
    const name = normalizeCmdName(cmdName);
    if (!name || typeof fn !== 'function') return false;

    if (registry.has(name)) {
      // Keep the first registrant to avoid clashes (patch modules should use unique commands).
      if (meta && typeof meta.log === 'function') meta.log('command.duplicate', { name });
      return false;
    }

    const info = Object.assign(
      { desc: '', usage: '', hidden: false },
      (opts && typeof opts === 'object') ? opts : {}
    );

    registry.set(name, { fn, info });
    order.push(name);
    return true;
  }

  function list() {
    return order.map((name) => {
      const ent = registry.get(name);
      const info = ent ? ent.info : {};
      return {
        name,
        desc: info.desc || '',
        usage: info.usage || '',
        hidden: !!info.hidden
      };
    });
  }

  async function replyUnknown(ctx) {
    if (!unknownText) return false;
    if (unknownControlGroupOnly && controlGroupId) {
      if (!ctx || String(ctx.chatId || '') !== String(controlGroupId)) return false;
    }
    if (ctx && typeof ctx.reply === 'function') {
      await ctx.reply(String(unknownText));
      return true;
    }
    return false;
  }

  async function onMessage(ctx) {
    const text = ctx ? String(ctx.text || '') : '';
    if (!text) return;

    const usedPrefix = detectPrefix(text);
    if (!usedPrefix) return;

    // Command attempt - respect location rules.
    if (ctx && ctx.isGroup && !allowInGroups) return;
    if (ctx && !ctx.isGroup && !allowInDm) return;

    const trimmed = text.slice(usedPrefix.length).trim();
    if (!trimmed) return;

    const parts = splitArgs(trimmed);
    if (!parts.length) return;

    const cmd = normalizeCmdName(parts.shift());
    const args = parts;

    const ent = registry.get(cmd);
    if (ent && ent.fn) {
      try {
        await ent.fn(ctx, args, { cmd, prefix: usedPrefix, raw: text });
      } catch (e) {
        if (meta && typeof meta.log === 'function') {
          meta.log('command.error', { cmd, err: String(e && e.message ? e.message : e) });
        }
        // Best-effort error message (ASCII only).
        if (ctx && typeof ctx.reply === 'function') await ctx.reply('Command failed.');
      }
      if (ctx && typeof ctx.stopPropagation === 'function') ctx.stopPropagation();
      return;
    }

    // Unknown command: optionally pass through DMs (so Fallback can still open ticket).
    if (unknownPassthroughDm && ctx && !ctx.isGroup) return;

    const replied = await replyUnknown(ctx);
    if (replied && ctx && typeof ctx.stopPropagation === 'function') ctx.stopPropagation();
  }

  const service = {
    register,
    list,
    prefix: prefixes[0] || '!',
    prefixes
  };

  if (meta && typeof meta.registerService === 'function') {
    meta.registerService('command', service);
    meta.registerService('commands', service);
  }

  return { onMessage };
};
