'use strict';

// CommandCV.js
// - Provides the command runtime: register + dispatch.
// - Other modules register commands via meta.getService('command').register(...)
// - This module parses inbound messages and executes matching handlers.

function toBool(v, defVal) {
  if (v === undefined || v === null) return defVal;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'n' || s === 'off') return false;
  return defVal;
}

function toStr(v, defVal) {
  const s = String(v ?? '').trim();
  return s ? s : defVal;
}

function safeTextFromCtx(ctx) {
  if (!ctx) return '';
  if (typeof ctx.text === 'string') return ctx.text;
  const msg = ctx.message;
  if (msg && typeof msg.body === 'string') return msg.body;
  return '';
}

function splitArgs(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  return s.split(/\s+/g);
}

module.exports = {
  init: async (meta) => {
    const logTag = 'CommandCV';

    const cfg = meta.implConf || {};
    const enabled = toBool(cfg.enabled, true);
    const prefix = toStr(cfg.prefix, '!');
    const allowInDm = toBool(cfg.allowInDm, true);
    const allowInGroups = toBool(cfg.allowInGroups, true);

    const unknownText = toStr(cfg.unknownText, '');
    const unknownControlGroupOnly = toBool(cfg.unknownControlGroupOnly, false);
    const unknownPassthroughDm = toBool(cfg.unknownPassthroughDm, false);
    const controlGroupId = toStr(cfg.controlGroupId, '');

    if (!enabled) {
      meta.log(logTag, 'disabled');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const registry = Object.create(null);

    function normalizeName(name) {
      return String(name || '').trim().toLowerCase();
    }

    function register(name, handler, options) {
      const n = normalizeName(name);
      if (!n) throw new Error('register: missing name');
      if (typeof handler !== 'function') throw new Error('register: handler must be a function');
      registry[n] = { handler, options: options || {} };
    }

    function list() {
      return Object.keys(registry).sort();
    }

    meta.registerService('command', { register, list });
    meta.log(logTag, `ready enabled=1 prefix=${prefix} allowInDm=${allowInDm ? 1 : 0} allowInGroups=${allowInGroups ? 1 : 0}`);

    function isControlGroup(chatId) {
      if (!controlGroupId) return false;
      return String(chatId || '') === controlGroupId;
    }

    async function onMessage(ctx) {
      try {
        const chatId = String((ctx && ctx.chatId) || '').trim();
        if (!chatId) return;
        const isGroup = !!(ctx && ctx.isGroup);
        if (isGroup && !allowInGroups) return;
        if (!isGroup && !allowInDm) return;

        const raw = safeTextFromCtx(ctx);
        const text = String(raw || '');
        if (!text) return;
        if (!text.startsWith(prefix)) return;

        const afterPrefix = text.slice(prefix.length).trim();
        if (!afterPrefix) return;

        const parts = splitArgs(afterPrefix);
        const cmdName = normalizeName(parts.shift() || '');
        if (!cmdName) return;

        const entry = registry[cmdName];
        if (!entry) {
          if (!unknownText) return;
          if (unknownPassthroughDm && !isGroup) return;
          if (unknownControlGroupOnly && !isControlGroup(chatId)) return;

          if (ctx && typeof ctx.reply === 'function') {
            await ctx.reply(unknownText);
          }
          return;
        }

        const ctx2 = {
          ...ctx,
          command: {
            prefix,
            name: cmdName,
            args: parts,
            text: parts.join(' '),
            raw: text,
          },
        };

        await entry.handler(ctx2);

        if (ctx && typeof ctx.stopPropagation === 'function') ctx.stopPropagation();
      } catch (e) {
        meta.log(logTag, `error onMessage err=${String(e && e.message ? e.message : e)}`);
      }
    }

    return { onMessage, onEvent: async () => {} };
  },
};
