'use strict';

// REWRITTEN: standalone CV command runtime.

function toBool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return d;
}

function toStr(v, d) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s || d;
}

function toList(v) {
  const raw = String(v === undefined || v === null ? '' : v).trim();
  if (!raw) return [];
  return raw.split(',').map(function mapOne(x) {
    return String(x || '').trim();
  }).filter(Boolean);
}

function loadGlobalConf(meta, cfg, bugLog) {
  const rel = toStr(cfg.globalConfRel, '');
  if (!rel) {
    if (bugLog) meta.log('CommandCV', 'global_conf_missing_key globalConfRel');
    return {};
  }
  try {
    const loaded = meta.loadConfRel(rel);
    return loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
  } catch (e) {
    if (bugLog) meta.log('CommandCV', 'global_conf_load_failed err=' + String(e && e.message ? e.message : e));
    return {};
  }
}

function textFromCtx(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  if (typeof ctx.text === 'string') return ctx.text;
  if (ctx.message && typeof ctx.message.body === 'string') return ctx.message.body;
  return '';
}

function parseArgs(s) {
  const clean = String(s || '').trim();
  if (!clean) return [];
  return clean.split(/\s+/g);
}

module.exports.init = async function init(meta) {
  const cfg = meta && meta.implConf ? meta.implConf : {};

  const enabled = toBool(cfg.enabled, true);
  const moduleLog = toBool(cfg.moduleLog, true);
  const bugLog = toBool(cfg.bugLog, true);
  const detailLog = toBool(cfg.detailLog, false);
  const traceLog = toBool(cfg.traceLog, false);

  if (!enabled) {
    if (moduleLog) meta.log('CommandCV', 'disabled');
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const globalConf = loadGlobalConf(meta, cfg, bugLog);

  const prefix = toStr(cfg.prefix, '');
  const allowInDm = toBool(cfg.allowInDm, true);
  const allowInGroups = toBool(cfg.allowInGroups, true);
  const unknownText = toStr(cfg.unknownText, '');
  const unknownControlGroupOnly = toBool(cfg.unknownControlGroupOnly, false);
  const unknownPassthroughDm = toBool(cfg.unknownPassthroughDm, false);
  const unknownIgnoreSet = new Set(toList(cfg.unknownIgnoreNames).map(function mapIgnore(x) {
    return normalizeName(x);
  }).filter(Boolean));
  const controlGroupId = toStr(globalConf.controlGroupId, '');

  const registry = Object.create(null);
  const commandEnabled = !!prefix;

  function normalizeName(name) {
    return String(name || '').trim().toLowerCase();
  }

  function register(name, handler, options) {
    const key = normalizeName(name);
    if (!key) throw new Error('command.register.invalid_name');
    if (typeof handler !== 'function') throw new Error('command.register.invalid_handler');
    registry[key] = {
      name: key,
      handler: handler,
      options: options && typeof options === 'object' ? Object.assign({}, options) : {}
    };
    if (traceLog) meta.log('CommandCV', 'register name=' + key);
  }

  function list() {
    const names = Object.keys(registry);
    names.sort();
    return names.map(function mapName(n) {
      const x = registry[n] || {};
      return {
        name: n,
        help: toStr(x.options && x.options.help, ''),
        owner: toStr(x.options && x.options.owner, '')
      };
    });
  }

  const commandApi = { register, list };
  meta.registerService('command', commandApi);
  meta.registerService('commands', commandApi);

  function isControlGroup(chatId) {
    if (!controlGroupId) return false;
    return String(chatId || '').trim() === controlGroupId;
  }

  function shouldIgnoreUnknown(cmdName) {
    const key = normalizeName(cmdName);
    if (!key) return false;
    return unknownIgnoreSet.has(key);
  }

  async function handleUnknown(ctx, isGroup) {
    if (!unknownText) return;
    if (unknownPassthroughDm && !isGroup) return;
    if (unknownControlGroupOnly && !isControlGroup(ctx && ctx.chatId)) return;
    if (ctx && typeof ctx.reply === 'function') {
      await ctx.reply(unknownText);
    }
  }

  async function onMessage(ctx) {
    try {
      if (!commandEnabled) return;

      const isGroup = !!(ctx && ctx.isGroup);
      if (isGroup && !allowInGroups) return;
      if (!isGroup && !allowInDm) return;

      const rawText = textFromCtx(ctx);
      if (!rawText) return;
      if (rawText.indexOf(prefix) !== 0) return;

      const payload = rawText.slice(prefix.length).trim();
      if (!payload) return;

      const parts = parseArgs(payload);
      const cmdName = normalizeName(parts.shift());
      if (!cmdName) return;

      const item = registry[cmdName];
      if (!item || typeof item.handler !== 'function') {
        if (shouldIgnoreUnknown(cmdName)) return;
        await handleUnknown(ctx, isGroup);
        return;
      }

      const ctx2 = Object.assign({}, ctx, {
        command: {
          prefix: prefix,
          name: cmdName,
          args: parts,
          text: parts.join(' '),
          raw: rawText
        }
      });

      await item.handler(ctx2);

      if (ctx && typeof ctx.stopPropagation === 'function') ctx.stopPropagation();

      if (detailLog || traceLog) {
        meta.log('CommandCV', 'executed name=' + cmdName + ' chatId=' + toStr(ctx && ctx.chatId, ''));
      }
    } catch (e) {
      if (bugLog) meta.log('CommandCV', 'onMessage_error err=' + String(e && e.message ? e.message : e));
    }
  }

  if (!commandEnabled) {
    if (bugLog) meta.log('CommandCV', 'prefix_missing commands_safe_disabled');
  }

  if (moduleLog) {
    meta.log('CommandCV', 'ready prefix=' + (commandEnabled ? prefix : '(disabled)') + ' allowInDm=' + (allowInDm ? '1' : '0') + ' allowInGroups=' + (allowInGroups ? '1' : '0'));
  }

  return {
    onMessage,
    onEvent: async () => {}
  };
};