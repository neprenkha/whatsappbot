'use strict';

function text(value) {
  return String(value ?? '').trim();
}

function toBool(value) {
  const s = text(value).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function fill(template, vars) {
  let out = String(template || '');
  Object.keys(vars).forEach((key) => {
    out = out.split(`{${key}}`).join(String(vars[key] ?? ''));
  });
  return out;
}

module.exports = {
  init: async (meta) => {
    const logTag = 'HelpCV';
    const cfg = meta.implConf || {};
    const globalConf = meta.globalConf || {};

    const requiredKeys = [
      'cmdHelp',
      'actionSearch',
      'helpCommandDescription',
      'replyConfigError',
      'replyNoCommands',
      'replyTopicNotFound',
      'replySearchNoMatch',
      'titleAllTemplate',
      'titleTopicTemplate',
      'titleSearchTemplate',
      'lineTemplate',
    ];

    const missing = requiredKeys.filter((key) => !text(cfg[key]));
    const bugLogEnabled = toBool(cfg.bugLog);

    if (missing.length) {
      if (bugLogEnabled) {
        meta.log(logTag, `config invalid missing=${missing.join(',')}`);
      }
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const cmdHelp = text(cfg.cmdHelp).toLowerCase();
    const actionSearch = text(cfg.actionSearch).toLowerCase();

    const commandService = meta.getService('command');
    if (!commandService || typeof commandService.register !== 'function') {
      if (bugLogEnabled) {
        meta.log(logTag, 'missing command service');
      }
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const access = meta.getService('access');

    async function canAccess(ctx, minRole) {
      const need = text(minRole);
      if (!need || !access) return true;

      if (typeof access.hasRole === 'function') return !!(await access.hasRole(ctx, need));
      if (typeof access.isAllowed === 'function') return !!(await access.isAllowed(ctx, need));
      if (typeof access.check === 'function') return !!(await access.check(ctx, need));
      if (typeof access.meetsMinRole === 'function') return !!(await access.meetsMinRole(ctx, need));
      return true;
    }

    async function sendReply(ctx, payload) {
      const message = text(payload);
      if (!message) return;

      if (ctx && typeof ctx.reply === 'function') {
        await ctx.reply(message);
        return;
      }

      const send = meta.getService('send');
      if (send && ctx && ctx.chatId) {
        await send(ctx.chatId, message, { isAuto: 0 });
      }
    }

    function normalizeEntry(item) {
      if (typeof item === 'string') {
        return { name: text(item).toLowerCase(), help: '', minRole: '' };
      }

      if (item && typeof item === 'object') {
        return {
          name: text(item.name).toLowerCase(),
          help: text(item.help),
          minRole: text(item.minRole),
        };
      }

      return { name: '', help: '', minRole: '' };
    }

    async function visibleEntries(ctx) {
      const listFn = commandService.list;
      const raw = typeof listFn === 'function' ? listFn() : [];
      const arr = Array.isArray(raw) ? raw : [];
      const out = [];

      for (const item of arr) {
        const entry = normalizeEntry(item);
        if (!entry.name) continue;
        if (!(await canAccess(ctx, entry.minRole))) continue;
        out.push(entry);
      }

      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    }

    function activePrefix(ctx) {
      const fromCtx = text(ctx && ctx.command && ctx.command.prefix);
      if (fromCtx) return fromCtx;
      return text(globalConf.prefix);
    }

    commandService.register(
      cmdHelp,
      async (ctx) => {
        const prefix = activePrefix(ctx);
        if (!prefix) {
          if (bugLogEnabled) {
            meta.log(logTag, 'missing prefix in ctx.command.prefix and globalConf.prefix');
          }
          await sendReply(ctx, cfg.replyConfigError);
          return;
        }

        const entries = await visibleEntries(ctx);
        const args = (ctx && ctx.command && Array.isArray(ctx.command.args))
          ? ctx.command.args.map((v) => text(v).toLowerCase()).filter(Boolean)
          : [];

        if (!entries.length) {
          await sendReply(ctx, cfg.replyNoCommands);
          return;
        }

        if (!args.length) {
          const lines = entries.map((entry) => fill(cfg.lineTemplate, {
            PREFIX: prefix,
            CMD: entry.name,
            HELP: entry.help,
            MINROLE: entry.minRole,
          }));
          const head = fill(cfg.titleAllTemplate, { PREFIX: prefix });
          await sendReply(ctx, `${head}\n${lines.join('\n')}`);
          return;
        }

        if (args[0] === actionSearch) {
          const keyword = text(args.slice(1).join(' ')).toLowerCase();
          if (!keyword) {
            await sendReply(ctx, cfg.replyConfigError);
            return;
          }

          const matched = entries.filter((entry) => {
            return entry.name.includes(keyword) || entry.help.toLowerCase().includes(keyword);
          });

          if (!matched.length) {
            await sendReply(ctx, cfg.replySearchNoMatch);
            return;
          }

          const lines = matched.map((entry) => fill(cfg.lineTemplate, {
            PREFIX: prefix,
            CMD: entry.name,
            HELP: entry.help,
            MINROLE: entry.minRole,
          }));
          const head = fill(cfg.titleSearchTemplate, { PREFIX: prefix, KEYWORD: keyword });
          await sendReply(ctx, `${head}\n${lines.join('\n')}`);
          return;
        }

        const topic = args[0];
        const found = entries.find((entry) => entry.name === topic);
        if (!found) {
          await sendReply(ctx, cfg.replyTopicNotFound);
          return;
        }

        const head = fill(cfg.titleTopicTemplate, { PREFIX: prefix, TOPIC: found.name });
        const line = fill(cfg.lineTemplate, {
          PREFIX: prefix,
          CMD: found.name,
          HELP: found.help,
          MINROLE: found.minRole,
        });
        await sendReply(ctx, `${head}\n${line}`);
      },
      {
        owner: logTag,
        help: cfg.helpCommandDescription,
        minRole: text(cfg.minRoleHelp),
      }
    );

    meta.log(logTag, `ready cmdHelp=${cmdHelp}`);
    return { onMessage: async () => {}, onEvent: async () => {} };
  },
};