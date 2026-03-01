'use strict';

function text(value) {
  return String(value ?? '').trim();
}

function keyText(value) {
  return text(value).toLowerCase();
}

function toBool(value) {
  const s = keyText(value);
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function fill(template, vars) {
  let out = String(template || '');
  Object.keys(vars).forEach((name) => {
    out = out.split(`{${name}}`).join(String(vars[name] ?? ''));
  });
  return out;
}

module.exports = {
  init: async (meta) => {
    const logTag = 'StatusFeedCV';
    const cfg = meta.implConf || {};

    const requiredKeys = [
      'globalConfRel',
      'cmdStatusFeed',
      'actionPost',
      'actionPreview',
      'actionHelp',
      'argIndexWorkgroup',
      'argIndexMessage',
      'minRoleStatusFeed',
      'replyNoAccess',
      'replyGroupOnly',
      'replyUsage',
      'replyNeedWorkgroup',
      'replyNeedMessage',
      'replyWorkgroupNotFound',
      'replyPostOk',
      'replyPreviewTemplate',
      'feedTemplate',
      'cmdStatusFeedHelp',
    ];

    const missing = requiredKeys.filter((k) => !text(cfg[k]));
    const bugLogEnabled = toBool(cfg.bugLog);
    if (missing.length) {
      if (bugLogEnabled) meta.log(logTag, `config invalid missing=${missing.join(',')}`);
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    let globalConf = {};
    if (typeof meta.loadConfRel === 'function') {
      globalConf = meta.loadConfRel(text(cfg.globalConfRel)) || {};
    }

    const command = meta.getService('command');
    const access = meta.getService('access');
    const send = meta.getService('send');
    const workgroups = meta.getService('workgroups');
    const timezone = meta.getService('timezone');

    if (!command || typeof command.register !== 'function') {
      if (bugLogEnabled) meta.log(logTag, 'missing command service');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }
    if (typeof send !== 'function') {
      if (bugLogEnabled) meta.log(logTag, 'missing send service');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    async function canAccess(ctx) {
      const minRole = text(cfg.minRoleStatusFeed);
      if (!minRole) return false;
      if (!access) return false;

      if (typeof access.hasRole === 'function') return !!(await access.hasRole(ctx, minRole));
      if (typeof access.isAllowed === 'function') return !!(await access.isAllowed(ctx, minRole));
      if (typeof access.check === 'function') return !!(await access.check(ctx, minRole));
      if (typeof access.meetsMinRole === 'function') return !!(await access.meetsMinRole(ctx, minRole));
      return false;
    }

    async function sendReply(ctx, payload) {
      const message = text(payload);
      if (!message) return;

      if (ctx && typeof ctx.reply === 'function') {
        await ctx.reply(message);
        return;
      }

      const chatId = text(ctx && ctx.chatId);
      if (!chatId) return;
      await send(chatId, message, { isAuto: 0 });
    }

    async function resolveWorkgroupChatId(workgroupKey) {
      const key = text(workgroupKey);
      if (!key || !workgroups) return '';

      if (typeof workgroups.resolve === 'function') {
        const r = await workgroups.resolve(key);
        return text((r && r.chatId) || (r && r.groupChatId) || r);
      }
      if (typeof workgroups.getByKey === 'function') {
        const r = await workgroups.getByKey(key);
        return text((r && r.chatId) || (r && r.groupChatId) || r);
      }
      if (typeof workgroups.get === 'function') {
        const r = await workgroups.get(key);
        return text((r && r.chatId) || (r && r.groupChatId) || r);
      }
      if (typeof workgroups.list === 'function') {
        const arr = await workgroups.list();
        if (Array.isArray(arr)) {
          const found = arr.find((x) => keyText(x && x.key) === keyText(key) || keyText(x && x.name) === keyText(key));
          return text(found && (found.chatId || found.groupChatId));
        }
      }
      return '';
    }

    function nowText() {
      if (timezone && typeof timezone.formatNow === 'function') return text(timezone.formatNow());
      if (timezone && typeof timezone.nowText === 'function') return text(timezone.nowText());
      return new Date().toISOString();
    }

    function prefixText(ctx) {
      const fromCtx = text(ctx && ctx.command && ctx.command.prefix);
      if (fromCtx) return fromCtx;
      return text(globalConf.prefix);
    }

    const cmdStatusFeed = keyText(cfg.cmdStatusFeed);
    const actionPost = keyText(cfg.actionPost);
    const actionPreview = keyText(cfg.actionPreview);
    const actionHelp = keyText(cfg.actionHelp);
    const argIndexWorkgroup = Number.parseInt(text(cfg.argIndexWorkgroup), 10);
    const argIndexMessage = Number.parseInt(text(cfg.argIndexMessage), 10);

    command.register(cmdStatusFeed, async (ctx) => {
      if (!ctx || !ctx.isGroup) {
        await sendReply(ctx, cfg.replyGroupOnly);
        return;
      }

      if (!(await canAccess(ctx))) {
        await sendReply(ctx, cfg.replyNoAccess);
        return;
      }

      const args = ctx && ctx.command && Array.isArray(ctx.command.args)
        ? ctx.command.args.map((v) => text(v))
        : [];
      const action = keyText(args[0]);
      const prefix = prefixText(ctx);

      if (!action || action === actionHelp) {
        await sendReply(ctx, fill(cfg.replyUsage, {
          PREFIX: prefix,
          CMD: cmdStatusFeed,
          POST: actionPost,
          PREVIEW: actionPreview,
          HELP: actionHelp,
        }));
        return;
      }

      const workgroupKey = text(args[argIndexWorkgroup]);
      if (!workgroupKey) {
        await sendReply(ctx, cfg.replyNeedWorkgroup);
        return;
      }

      const messageText = text(args.slice(argIndexMessage).join(' '));
      if (!messageText) {
        await sendReply(ctx, cfg.replyNeedMessage);
        return;
      }

      const destinationChatId = await resolveWorkgroupChatId(workgroupKey);
      if (!destinationChatId) {
        await sendReply(ctx, cfg.replyWorkgroupNotFound);
        return;
      }

      const timestamp = nowText();
      const payload = fill(cfg.feedTemplate, {
        TIME: timestamp,
        MESSAGE: messageText,
        WORKGROUP: workgroupKey,
      });

      if (action === actionPreview) {
        await sendReply(ctx, fill(cfg.replyPreviewTemplate, {
          TIME: timestamp,
          MESSAGE: messageText,
          WORKGROUP: workgroupKey,
        }));
        return;
      }

      if (action === actionPost) {
        await send(destinationChatId, payload, { isAuto: 1 });
        await sendReply(ctx, fill(cfg.replyPostOk, {
          WORKGROUP: workgroupKey,
        }));
        return;
      }

      await sendReply(ctx, fill(cfg.replyUsage, {
        PREFIX: prefix,
        CMD: cmdStatusFeed,
        POST: actionPost,
        PREVIEW: actionPreview,
        HELP: actionHelp,
      }));
    }, {
      owner: logTag,
      help: cfg.cmdStatusFeedHelp,
      minRole: text(cfg.minRoleStatusFeed),
    });

    meta.log(logTag, `ready cmdStatusFeed=${cmdStatusFeed}`);
    return { onMessage: async () => {}, onEvent: async () => {} };
  },
};