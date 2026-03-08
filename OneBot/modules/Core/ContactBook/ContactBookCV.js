'use strict';

function text(value) {
  return String(value == null ? '' : value).trim();
}

function keyText(value) {
  return text(value).toLowerCase();
}

function toBool(value, fallbackValue) {
  const raw = keyText(value);
  if (!raw) return !!fallbackValue;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return !!fallbackValue;
}

function toInt(value, fallbackValue) {
  const n = Number.parseInt(text(value), 10);
  return Number.isFinite(n) ? n : fallbackValue;
}

function fill(template, vars) {
  let out = String(template || '');
  Object.keys(vars).forEach((name) => {
    out = out.split('{' + name + '}').join(String(vars[name] == null ? '' : vars[name]));
  });
  return out;
}

function normalizePrincipal(value) {
  const raw = text(value);
  if (!raw) return '';
  if (raw.indexOf('lid:') === 0) return raw;
  if (raw.indexOf('@') > 0) return raw;
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits) return 'lid:' + digits;
  return raw;
}

function normalizePhone(value) {
  return text(value).replace(/[^0-9]/g, '');
}

function actorFromCtx(ctx) {
  const sender = ctx && ctx.sender ? ctx.sender : {};
  return normalizePrincipal(
    text(sender.id) ||
    text(sender.phone) ||
    text(sender.lid) ||
    text(ctx && ctx.author) ||
    text(ctx && ctx.from)
  );
}

function toList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function ensureListMap(map, key) {
  const normalized = text(key);
  if (!normalized) return [];
  if (!Array.isArray(map[normalized])) map[normalized] = [];
  return map[normalized];
}

function ensureStateShape(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const next = {
    accountsByCode: base.accountsByCode && typeof base.accountsByCode === 'object' ? base.accountsByCode : {},
    picsById: base.picsById && typeof base.picsById === 'object' ? base.picsById : {},
    contextsByCode: base.contextsByCode && typeof base.contextsByCode === 'object' ? base.contextsByCode : {},
    picIdByChatId: base.picIdByChatId && typeof base.picIdByChatId === 'object' ? base.picIdByChatId : {},
    picIdByPhone: base.picIdByPhone && typeof base.picIdByPhone === 'object' ? base.picIdByPhone : {},
    picIdsByAccountCode: base.picIdsByAccountCode && typeof base.picIdsByAccountCode === 'object' ? base.picIdsByAccountCode : {},
    contextCodesByAccountCode: base.contextCodesByAccountCode && typeof base.contextCodesByAccountCode === 'object' ? base.contextCodesByAccountCode : {},
    ticketContextByTicketId: base.ticketContextByTicketId && typeof base.ticketContextByTicketId === 'object' ? base.ticketContextByTicketId : {},
    seqAcc: Number(base.seqAcc || 0),
    seqPic: Number(base.seqPic || 0),
    seqCtx: Number(base.seqCtx || 0),
  };
  if (!Number.isFinite(next.seqAcc) || next.seqAcc < 0) next.seqAcc = 0;
  if (!Number.isFinite(next.seqPic) || next.seqPic < 0) next.seqPic = 0;
  if (!Number.isFinite(next.seqCtx) || next.seqCtx < 0) next.seqCtx = 0;
  return next;
}

function getQuotedMessage(ctx) {
  const raw = ctx && ctx.raw ? ctx.raw : {};
  if (raw.quotedMsg && typeof raw.quotedMsg === 'object') return raw.quotedMsg;
  if (raw.quotedMessage && typeof raw.quotedMessage === 'object') return raw.quotedMessage;
  if (raw.quoted && typeof raw.quoted === 'object') return raw.quoted;
  const data = raw && raw._data ? raw._data : {};
  if (data.quotedMsg && typeof data.quotedMsg === 'object') return data.quotedMsg;
  return {};
}

function getQuotedText(ctx) {
  const direct = text(ctx && ctx.quotedText);
  if (direct) return direct;
  const quoted = getQuotedMessage(ctx);
  return text(quoted.body) || text(quoted.caption);
}

function getQuotedPrincipal(ctx) {
  const quoted = getQuotedMessage(ctx);
  return normalizePrincipal(
    text(quoted.author) ||
    text(quoted.from) ||
    text(quoted.participant) ||
    text(quoted.id && quoted.id.participant) ||
    text(quoted.id && quoted.id.remote)
  );
}

function getQuotedPhone(ctx) {
  const quoted = getQuotedMessage(ctx);
  return normalizePhone(text(quoted.phone) || text(quoted.author) || text(quoted.from));
}

function extractTicketId(sourceText, ticketIdRegex) {
  const body = text(sourceText);
  if (!body || !text(ticketIdRegex)) return '';
  try {
    const re = new RegExp(text(ticketIdRegex), 'i');
    const match = body.match(re);
    return match && match[0] ? text(match[0]) : '';
  } catch (_) {
    return '';
  }
}

module.exports = {
  init: async (meta) => {
    const tag = 'ContactBookCV';
    const cfg = meta && meta.implConf ? meta.implConf : {};

    if (!toBool(cfg.enabled, true)) {
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const moduleLog = toBool(cfg.moduleLog, true);
    const bugLog = toBool(cfg.bugLog, true);
    const detailLog = toBool(cfg.detailLog, false);
    const traceLog = toBool(cfg.traceLog, false);

    const required = [
      'globalConfRel',
      'storeKey',
      'accountCodePrefix',
      'picCodePrefix',
      'contextCodePrefix',
      'codeDigits',
      'cmdAccount',
      'cmdPic',
      'cmdContext',
      'actionNew',
      'actionLink',
      'actionShow',
      'actionList',
      'minRoleManage',
      'replyNoAccess',
      'replyGroupOnly',
      'replyControlGroupOnly',
      'replyNeedAction',
      'replyUnknownAction',
      'replyNeedAccount',
      'replyNeedContext',
      'replyNeedDisplayName',
      'replyNeedLabel',
      'replyNeedQuote',
      'replyNeedTicket',
      'replyAccountCreated',
      'replyAccountLinked',
      'replyAccountNotFound',
      'replyAccountShow',
      'replyAccountListHeader',
      'replyAccountListItem',
      'replyPicLinked',
      'replyPicListHeader',
      'replyPicListItem',
      'replyContextCreated',
      'replyContextLinked',
      'replyContextListHeader',
      'replyContextListItem',
      'replyListEmpty',
    ];

    const missing = required.filter((key) => !text(cfg[key]));
    if (missing.length) {
      if (bugLog) meta.log(tag, 'disabled missing=' + missing.join(','));
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const command = meta.getService('command');
    const access = meta.getService('access');
    const jsonstore = meta.getService('jsonstore');

    if (!command || typeof command.register !== 'function') {
      if (bugLog) meta.log(tag, 'disabled missing_command_service');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }
    if (!jsonstore || typeof jsonstore.open !== 'function') {
      if (bugLog) meta.log(tag, 'disabled missing_jsonstore_service');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    let globalLoaded = {};
    if (typeof meta.loadConfRel === 'function') {
      globalLoaded = meta.loadConfRel(text(cfg.globalConfRel)) || {};
    }
    const globalConf = globalLoaded && globalLoaded.conf && typeof globalLoaded.conf === 'object'
      ? globalConf
      : (globalLoaded && typeof globalLoaded === 'object' ? globalLoaded : {});

    const controlGroupId = text(globalConf.controlGroupId);
    if (!controlGroupId) {
      if (bugLog) meta.log(tag, 'disabled missing_controlGroupId');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const ticketIdRegex = text(cfg.ticketIdRegex);

    const store = jsonstore.open(text(cfg.storeNs));
    const codeDigits = Math.max(1, toInt(cfg.codeDigits, 4));

    async function sendReply(ctx, message) {
      const out = text(message);
      if (!out) return;
      if (ctx && typeof ctx.reply === 'function') {
        await ctx.reply(out);
        return;
      }
      const chatId = text(ctx && ctx.chatId);
      if (!chatId) return;
      const preferred = text(globalConf.sendPrefer).split(',').map((x) => text(x)).filter(Boolean)[0] || '';
      const send = preferred ? meta.getService(preferred) : meta.getService('send');
      if (typeof send === 'function') {
        await send(chatId, out, { isAuto: 0, manualReply: 1, bypassRateLimit: 1 });
      } else if (send && typeof send.send === 'function') {
        await send.send(chatId, out, { isAuto: 0, manualReply: 1, bypassRateLimit: 1 });
      }
    }

    async function canManage(ctx) {
      const minRole = text(cfg.minRoleManage);
      if (!minRole) return true;
      if (!access) return false;
      if (typeof access.hasAtLeast === 'function') return !!(await access.hasAtLeast(ctx, minRole));
      if (typeof access.hasRole === 'function') return !!(await access.hasRole(ctx, minRole));
      if (typeof access.isAllowed === 'function') return !!(await access.isAllowed(ctx, minRole));
      if (typeof access.check === 'function') return !!(await access.check(ctx, minRole));
      if (typeof access.meetsMinRole === 'function') return !!(await access.meetsMinRole(ctx, minRole));
      return false;
    }

    async function loadState() {
      const raw = await store.get(text(cfg.storeKey), {});
      return ensureStateShape(raw);
    }

    async function saveState(state) {
      await store.set(text(cfg.storeKey), state);
    }

    function nextAccountCode(state) {
      state.seqAcc += 1;
      return text(cfg.accountCodePrefix) + String(state.seqAcc).padStart(codeDigits, '0');
    }

    function nextPicCode(state) {
      state.seqPic += 1;
      return text(cfg.picCodePrefix) + String(state.seqPic).padStart(codeDigits, '0');
    }

    function nextContextCode(state) {
      state.seqCtx += 1;
      return text(cfg.contextCodePrefix) + String(state.seqCtx).padStart(codeDigits, '0');
    }

    async function onAccount(ctx) {
      if (!ctx || !ctx.isGroup) return sendReply(ctx, cfg.replyGroupOnly);
      if (text(ctx.chatId) !== controlGroupId) return sendReply(ctx, cfg.replyControlGroupOnly);
      if (!(await canManage(ctx))) return sendReply(ctx, cfg.replyNoAccess);

      const args = ctx && ctx.command && Array.isArray(ctx.command.args) ? ctx.command.args.map((x) => text(x)) : [];
      const action = keyText(args[0]);
      if (!action) return sendReply(ctx, cfg.replyNeedAction);

      if (action === keyText(cfg.actionNew)) {
        const displayName = text(args[1]);
        const accountType = text(args[2]);
        if (!displayName) return sendReply(ctx, cfg.replyNeedDisplayName);

        const state = await loadState();
        const accountCode = nextAccountCode(state);
        state.accountsByCode[accountCode] = {
          code: accountCode,
          displayName: displayName,
          type: accountType,
          createdAt: new Date().toISOString(),
          createdBy: actorFromCtx(ctx),
        };
        ensureListMap(state.picIdsByAccountCode, accountCode);
        ensureListMap(state.contextCodesByAccountCode, accountCode);
        await saveState(state);

        return sendReply(ctx, fill(cfg.replyAccountCreated, { ACCOUNT_CODE: accountCode }));
      }

      if (action === keyText(cfg.actionLink)) {
        const accountCode = text(args[1]);
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccount);

        const quotedPrincipal = getQuotedPrincipal(ctx);
        if (!quotedPrincipal) return sendReply(ctx, cfg.replyNeedQuote);

        const state = await loadState();
        if (!state.accountsByCode[accountCode]) return sendReply(ctx, cfg.replyAccountNotFound);

        let picCode = '';
        const picCodes = Object.keys(state.picsById);
        for (let i = 0; i < picCodes.length; i += 1) {
          const p = state.picsById[picCodes[i]];
          if (text(p.chatId) === quotedPrincipal) {
            picCode = picCodes[i];
            break;
          }
        }

        if (!picCode) {
          picCode = nextPicCode(state);
          state.picsById[picCode] = {
            picId: picCode,
            displayName: text(getQuotedMessage(ctx).name),
            phone: getQuotedPhone(ctx),
            chatId: quotedPrincipal,
            accountCode: accountCode,
            createdAt: new Date().toISOString(),
            createdBy: actorFromCtx(ctx),
          };
        } else {
          state.picsById[picCode].accountCode = accountCode;
        }

        state.picIdByChatId[quotedPrincipal] = picCode;
        const phone = normalizePhone(state.picsById[picCode].phone);
        if (phone) state.picIdByPhone[phone] = picCode;
        const picList = ensureListMap(state.picIdsByAccountCode, accountCode);
        if (picList.indexOf(picCode) < 0) picList.push(picCode);

        await saveState(state);
        return sendReply(ctx, fill(cfg.replyAccountLinked, { ACCOUNT_CODE: accountCode }));
      }

      if (action === keyText(cfg.actionShow)) {
        const accountCode = text(args[1]);
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccount);

        const state = await loadState();
        const account = state.accountsByCode[accountCode];
        if (!account) return sendReply(ctx, cfg.replyAccountNotFound);

        const picCount = toList(state.picIdsByAccountCode[accountCode]).length;
        const contextCount = toList(state.contextCodesByAccountCode[accountCode]).length;
        return sendReply(ctx, fill(cfg.replyAccountShow, {
          ACCOUNT_CODE: accountCode,
          DISPLAY_NAME: text(account.displayName),
          ACCOUNT_TYPE: text(account.type),
          PIC_COUNT: String(picCount),
          CONTEXT_COUNT: String(contextCount),
        }));
      }

      if (action === keyText(cfg.actionList)) {
        const state = await loadState();
        const accountCodes = Object.keys(state.accountsByCode).sort();
        if (!accountCodes.length) return sendReply(ctx, cfg.replyListEmpty);

        const lines = accountCodes.map((accountCode) => {
          const account = state.accountsByCode[accountCode] || {};
          return fill(cfg.replyAccountListItem, {
            ACCOUNT_CODE: accountCode,
            DISPLAY_NAME: text(account.displayName),
            ACCOUNT_TYPE: text(account.type),
          });
        });

        return sendReply(ctx, text(cfg.replyAccountListHeader) + '\n' + lines.join('\n'));
      }

      return sendReply(ctx, cfg.replyUnknownAction);
    }

    async function onPic(ctx) {
      if (!ctx || !ctx.isGroup) return sendReply(ctx, cfg.replyGroupOnly);
      if (text(ctx.chatId) !== controlGroupId) return sendReply(ctx, cfg.replyControlGroupOnly);
      if (!(await canManage(ctx))) return sendReply(ctx, cfg.replyNoAccess);

      const args = ctx && ctx.command && Array.isArray(ctx.command.args) ? ctx.command.args.map((x) => text(x)) : [];
      const action = keyText(args[0]);
      if (!action) return sendReply(ctx, cfg.replyNeedAction);

      if (action === keyText(cfg.actionLink)) {
        const accountCode = text(args[1]);
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccount);

        const quotedPrincipal = getQuotedPrincipal(ctx);
        if (!quotedPrincipal) return sendReply(ctx, cfg.replyNeedQuote);

        const state = await loadState();
        if (!state.accountsByCode[accountCode]) return sendReply(ctx, cfg.replyAccountNotFound);

        let picCode = state.picIdByChatId[quotedPrincipal] || '';
        if (!picCode) {
          picCode = nextPicCode(state);
          state.picsById[picCode] = {
            picId: picCode,
            displayName: text(getQuotedMessage(ctx).name),
            phone: getQuotedPhone(ctx),
            chatId: quotedPrincipal,
            accountCode: accountCode,
            createdAt: new Date().toISOString(),
            createdBy: actorFromCtx(ctx),
          };
        } else {
          state.picsById[picCode].accountCode = accountCode;
        }

        state.picIdByChatId[quotedPrincipal] = picCode;
        const phone = normalizePhone(state.picsById[picCode].phone);
        if (phone) state.picIdByPhone[phone] = picCode;
        const picList = ensureListMap(state.picIdsByAccountCode, accountCode);
        if (picList.indexOf(picCode) < 0) picList.push(picCode);

        await saveState(state);
        return sendReply(ctx, fill(cfg.replyPicLinked, { PIC_CODE: picCode, ACCOUNT_CODE: accountCode }));
      }

      if (action === keyText(cfg.actionList)) {
        const accountCode = text(args[1]);
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccount);

        const state = await loadState();
        if (!state.accountsByCode[accountCode]) return sendReply(ctx, cfg.replyAccountNotFound);
        const picCodes = toList(state.picIdsByAccountCode[accountCode]);
        if (!picCodes.length) return sendReply(ctx, cfg.replyListEmpty);

        const lines = picCodes.map((picCode) => {
          const pic = state.picsById[picCode] || {};
          return fill(cfg.replyPicListItem, {
            PIC_CODE: picCode,
            DISPLAY_NAME: text(pic.displayName),
            PHONE: text(pic.phone),
            CHAT_ID: text(pic.chatId),
          });
        });

        return sendReply(ctx, fill(cfg.replyPicListHeader, { ACCOUNT_CODE: accountCode }) + '\n' + lines.join('\n'));
      }

      return sendReply(ctx, cfg.replyUnknownAction);
    }

    async function onContext(ctx) {
      if (!ctx || !ctx.isGroup) return sendReply(ctx, cfg.replyGroupOnly);
      if (text(ctx.chatId) !== controlGroupId) return sendReply(ctx, cfg.replyControlGroupOnly);
      if (!(await canManage(ctx))) return sendReply(ctx, cfg.replyNoAccess);

      const args = ctx && ctx.command && Array.isArray(ctx.command.args) ? ctx.command.args.map((x) => text(x)) : [];
      const action = keyText(args[0]);
      if (!action) return sendReply(ctx, cfg.replyNeedAction);

      if (action === keyText(cfg.actionNew)) {
        const accountCode = text(args[1]);
        const label = text(args.slice(2).join(' '));
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccount);
        if (!label) return sendReply(ctx, cfg.replyNeedLabel);

        const state = await loadState();
        if (!state.accountsByCode[accountCode]) return sendReply(ctx, cfg.replyAccountNotFound);

        const contextCode = nextContextCode(state);
        state.contextsByCode[contextCode] = {
          code: contextCode,
          accountCode: accountCode,
          label: label,
          status: 'open',
          createdAt: new Date().toISOString(),
          createdBy: actorFromCtx(ctx),
        };
        const contextList = ensureListMap(state.contextCodesByAccountCode, accountCode);
        if (contextList.indexOf(contextCode) < 0) contextList.push(contextCode);
        await saveState(state);

        return sendReply(ctx, fill(cfg.replyContextCreated, { CONTEXT_CODE: contextCode, ACCOUNT_CODE: accountCode }));
      }

      if (action === keyText(cfg.actionLink)) {
        const contextCode = text(args[1]);
        if (!contextCode) return sendReply(ctx, cfg.replyNeedContext);

        const quotedTicket = extractTicketId(getQuotedText(ctx), ticketIdRegex);
        const directTicket = extractTicketId(args[2], ticketIdRegex);
        const ticketId = quotedTicket || directTicket;
        if (!ticketId) return sendReply(ctx, cfg.replyNeedTicket);

        const state = await loadState();
        if (!state.contextsByCode[contextCode]) return sendReply(ctx, cfg.replyNeedContext);

        state.ticketContextByTicketId[ticketId] = contextCode;
        await saveState(state);

        return sendReply(ctx, fill(cfg.replyContextLinked, { CONTEXT_CODE: contextCode, TICKET_ID: ticketId }));
      }

      if (action === keyText(cfg.actionList)) {
        const accountCode = text(args[1]);
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccount);

        const state = await loadState();
        if (!state.accountsByCode[accountCode]) return sendReply(ctx, cfg.replyAccountNotFound);
        const contextCodes = toList(state.contextCodesByAccountCode[accountCode]);
        if (!contextCodes.length) return sendReply(ctx, cfg.replyListEmpty);

        const lines = contextCodes.map((contextCode) => {
          const row = state.contextsByCode[contextCode] || {};
          return fill(cfg.replyContextListItem, {
            CONTEXT_CODE: contextCode,
            CONTEXT_LABEL: text(row.label),
          });
        });

        return sendReply(ctx, fill(cfg.replyContextListHeader, { ACCOUNT_CODE: accountCode }) + '\n' + lines.join('\n'));
      }

      return sendReply(ctx, cfg.replyUnknownAction);
    }

    command.register(text(cfg.cmdAccount), onAccount, {
      owner: 'ContactBookCV',
      help: text(cfg.cmdAccountHelp),
      minRole: text(cfg.minRoleManage),
      prefix: text(globalConf.prefix),
    });

    command.register(text(cfg.cmdPic), onPic, {
      owner: 'ContactBookCV',
      help: text(cfg.cmdPicHelp),
      minRole: text(cfg.minRoleManage),
      prefix: text(globalConf.prefix),
    });

    command.register(text(cfg.cmdContext), onContext, {
      owner: 'ContactBookCV',
      help: text(cfg.cmdContextHelp),
      minRole: text(cfg.minRoleManage),
      prefix: text(globalConf.prefix),
    });

    if (moduleLog) {
      meta.log(tag, 'ready cmdAccount=' + text(cfg.cmdAccount) + ' cmdPic=' + text(cfg.cmdPic) + ' cmdContext=' + text(cfg.cmdContext));
    }
    if (detailLog || traceLog) {
      meta.log(tag, 'ready storeNs=' + text(cfg.storeNs) + ' storeKey=' + text(cfg.storeKey));
    }

    return { onMessage: async () => {}, onEvent: async () => {} };
  },
};