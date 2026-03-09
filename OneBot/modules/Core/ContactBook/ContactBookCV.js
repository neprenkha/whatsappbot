'use strict';

function text(v) {
  return String(v == null ? '' : v).trim();
}

function low(v) {
  return text(v).toLowerCase();
}

function toBool(v, d) {
  const s = low(v);
  if (!s) return !!d;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return !!d;
}

function toInt(v, d) {
  const n = parseInt(text(v), 10);
  return Number.isFinite(n) ? n : d;
}

function fill(template, vars) {
  let out = String(template || '');
  Object.keys(vars || {}).forEach((key) => {
    out = out.split(`{${key}}`).join(String(vars[key] == null ? '' : vars[key]));
  });
  return out;
}

function normalizePhone(v) {
  return text(v).replace(/[^0-9]/g, '');
}

function normalizeChatId(v) {
  return low(v);
}

function quotedChatId(ctx) {
  const raw = ctx && ctx.raw && typeof ctx.raw === 'object' ? ctx.raw : {};
  const quoted = raw.quotedMsg || raw.quotedMessage || raw.quoted || {};
  return text(quoted.from || quoted.author || quoted.participant || raw.quotedAuthor || '');
}

function emptyState() {
  return {
    seq: { acc: 0, pic: 0, ctx: 0 },
    accountsByCode: {},
    picsById: {},
    contextsByCode: {},
    picIdByChatId: {},
    picIdByPhone: {},
    picIdsByAccountCode: {},
    contextCodesByAccountCode: {},
    ticketLinksByTicketId: {},
  };
}

module.exports = {
  init: async (meta) => {
    const cfg = meta && meta.implConf ? meta.implConf : {};

    const enabled = toBool(cfg.enabled, true);
    const moduleLog = toBool(cfg.moduleLog, true);
    const bugLog = toBool(cfg.bugLog, true);
    const detailLog = toBool(cfg.detailLog, false);
    const traceLog = toBool(cfg.traceLog, false);

    if (!enabled) return { onMessage: async () => {}, onEvent: async () => {} };

    let globalConf = {};
    try {
      const loaded = meta.loadConfRel(text(cfg.globalConfRel)) || {};
      globalConf = loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
    } catch (e) {
      if (bugLog) meta.log('ContactBookCV', 'global_conf_load_failed err=' + text(e && e.message));
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const command = meta.getService(text(cfg.commandServiceName));
    const jsonstore = meta.getService(text(cfg.jsonStoreServiceName));
    const access = meta.getService(text(cfg.accessServiceName));

    if (!command || typeof command.register !== 'function') return { onMessage: async () => {}, onEvent: async () => {} };
    if (!jsonstore || typeof jsonstore.open !== 'function') return { onMessage: async () => {}, onEvent: async () => {} };

    const storeNs = text(cfg.storeNs);
    const storeKey = text(cfg.storeKey);
    const serviceName = text(cfg.serviceName);

    const store = jsonstore.open(storeNs);

    async function loadState() {
      const raw = await store.get(storeKey, emptyState());
      const state = raw && typeof raw === 'object' ? raw : emptyState();
      return Object.assign(emptyState(), state);
    }

    async function saveState(state) {
      await store.set(storeKey, state);
    }

    function inboundChat(ctx) {
      return normalizeChatId(text(ctx && ctx.chatId) || text(ctx && ctx.author) || text(ctx && ctx.from));
    }

    function inboundPhone(ctx) {
      const sender = ctx && ctx.sender && typeof ctx.sender === 'object' ? ctx.sender : {};
      const raw = ctx && ctx.raw && typeof ctx.raw === 'object' ? ctx.raw : {};
      return normalizePhone(sender.phone || sender.id || raw.author || raw.from || '');
    }

    function nextCode(state, key, prefix) {
      const next = Math.max(0, toInt(state.seq[key], 0)) + 1;
      state.seq[key] = next;
      return text(prefix) + String(next).padStart(Math.max(1, toInt(cfg.codePad, 4)), '0');
    }

    function ensureList(mapObj, key) {
      if (!mapObj[key] || !Array.isArray(mapObj[key])) mapObj[key] = [];
      return mapObj[key];
    }

    function resolvePicId(state, chatId, phone) {
      const chat = normalizeChatId(chatId);
      const ph = normalizePhone(phone);
      if (chat && state.picIdByChatId[chat]) return text(state.picIdByChatId[chat]);
      if (ph && state.picIdByPhone[ph]) return text(state.picIdByPhone[ph]);
      return '';
    }

    async function canManage(ctx) {
      const minRole = text(cfg.minRoleManage);
      if (!minRole) return true;
      if (!access) return false;
      if (typeof access.hasRole === 'function') return !!(await access.hasRole(ctx, minRole));
      if (typeof access.isAllowed === 'function') return !!(await access.isAllowed(ctx, minRole));
      if (typeof access.check === 'function') return !!(await access.check(ctx, minRole));
      if (typeof access.meetsMinRole === 'function') return !!(await access.meetsMinRole(ctx, minRole));
      return false;
    }

    function inControlGroup(ctx) {
      const controlGroupId = text(globalConf.controlGroupId);
      if (!controlGroupId) return true;
      return text(ctx && ctx.chatId) === controlGroupId;
    }

    async function sendReply(ctx, body) {
      const msg = text(body);
      if (!msg) return;
      if (ctx && typeof ctx.reply === 'function') {
        await ctx.reply(msg);
        return;
      }
      const sendName = String(globalConf.sendPrefer || '').split(',').map((x) => text(x)).filter(Boolean)[0] || '';
      const send = sendName ? meta.getService(sendName) : null;
      if (send && ctx && ctx.chatId) await send(ctx.chatId, msg, { isAuto: 0, manualReply: 1 });
    }

    function listMessage(items, lineTemplate) {
      if (!items.length) return text(cfg.replyListEmpty);
      const lines = items.map((x) => fill(lineTemplate, x));
      return fill(cfg.replyListHeader, { ITEMS: lines.join('\n') });
    }

    async function createAccount(state, name, type, actor) {
      const code = nextCode(state, 'acc', cfg.accPrefix);
      state.accountsByCode[code] = {
        code,
        displayName: text(name),
        type: text(type),
        tags: '',
        notes: '',
        defaultWorkgroupKey: '',
        createdAt: Date.now(),
        createdBy: text(actor),
      };
      ensureList(state.picIdsByAccountCode, code);
      ensureList(state.contextCodesByAccountCode, code);
      return state.accountsByCode[code];
    }

    async function linkPic(state, accountCode, chatId, phone, displayName, actor) {
      const account = state.accountsByCode[text(accountCode)];
      if (!account) return { ok: 0, code: 'account_not_found' };

      let picId = resolvePicId(state, chatId, phone);
      if (!picId) picId = nextCode(state, 'pic', cfg.picPrefix);

      const rec = state.picsById[picId] || {
        picId,
        displayName: '',
        phone: '',
        chatId: '',
        accountCode: text(accountCode),
        tags: '',
        notes: '',
        createdAt: Date.now(),
        createdBy: text(actor),
      };

      rec.displayName = text(displayName) || rec.displayName;
      rec.phone = normalizePhone(phone) || rec.phone;
      rec.chatId = normalizeChatId(chatId) || rec.chatId;
      rec.accountCode = text(accountCode);
      state.picsById[picId] = rec;

      if (rec.chatId) state.picIdByChatId[rec.chatId] = picId;
      if (rec.phone) state.picIdByPhone[rec.phone] = picId;

      const list = ensureList(state.picIdsByAccountCode, rec.accountCode);
      if (!list.includes(picId)) list.push(picId);

      return { ok: 1, rec };
    }

    async function createContext(state, accountCode, label, type, actor) {
      const account = state.accountsByCode[text(accountCode)];
      if (!account) return { ok: 0, code: 'account_not_found' };

      const code = nextCode(state, 'ctx', cfg.ctxPrefix);
      const rec = {
        code,
        accountCode: text(accountCode),
        label: text(label),
        type: text(type),
        tags: '',
        notes: '',
        createdAt: Date.now(),
        createdBy: text(actor),
        status: text(cfg.contextStatusOpen),
      };

      state.contextsByCode[code] = rec;
      const list = ensureList(state.contextCodesByAccountCode, rec.accountCode);
      if (!list.includes(code)) list.push(code);
      return { ok: 1, rec };
    }

    if (typeof meta.registerService === 'function') {
      meta.registerService(serviceName, {
        resolveInbound: async (input) => {
          const state = await loadState();
          const picId = resolvePicId(state, input && input.chatId, input && input.phone);
          if (!picId) {
            return { assigned: 0, accountCode: '', picId: '', contextCode: '', status: text(cfg.unassignedLabel) };
          }
          const pic = state.picsById[picId] || {};
          return { assigned: 1, accountCode: text(pic.accountCode), picId, contextCode: '', status: text(cfg.assignedLabel) };
        },
        resolveInboundFromCtx: async (ctx) => {
          const state = await loadState();
          const picId = resolvePicId(state, inboundChat(ctx), inboundPhone(ctx));
          if (!picId) {
            return { assigned: 0, accountCode: '', picId: '', contextCode: '', status: text(cfg.unassignedLabel) };
          }
          const pic = state.picsById[picId] || {};
          return { assigned: 1, accountCode: text(pic.accountCode), picId, contextCode: '', status: text(cfg.assignedLabel) };
        },
        linkTicket: async (payload) => {
          const p = payload && typeof payload === 'object' ? payload : {};
          const ticketId = text(p.ticketId);
          if (!ticketId) return { ok: 0, code: 'need_ticket' };

          const state = await loadState();
          state.ticketLinksByTicketId[ticketId] = {
            ticketId,
            accountCode: text(p.accountCode),
            picId: text(p.picId),
            contextCode: text(p.contextCode),
            workgroupKey: text(p.workgroupKey),
            updatedAt: Date.now(),
          };
          await saveState(state);
          return { ok: 1 };
        },
        getTicketLink: async (ticketId) => {
          const id = text(ticketId);
          const state = await loadState();
          const rec = state.ticketLinksByTicketId[id] || {};
          return {
            ticketId: id,
            accountCode: text(rec.accountCode),
            picId: text(rec.picId),
            contextCode: text(rec.contextCode),
            workgroupKey: text(rec.workgroupKey),
          };
        },
        getFilingPlan: async (payload) => {
          const p = payload && typeof payload === 'object' ? payload : {};
          return {
            accountCode: text(p.accountCode),
            contextCode: text(p.contextCode),
            category: text(p.category),
            folderAccount: fill(cfg.folderAccountTemplate, { ACC: text(p.accountCode) }),
            folderContext: fill(cfg.folderContextTemplate, { CTX: text(p.contextCode), LABEL: text(p.contextLabel) }),
            folderInbox: fill(cfg.folderInboxTemplate, { ACC: text(p.accountCode) }),
          };
        },
      });
    }

    async function runAccount(ctx) {
      const args = ctx && ctx.command && Array.isArray(ctx.command.args) ? ctx.command.args.slice() : [];
      const action = low(args.shift());

      if (action === low(cfg.actionNew)) {
        const name = text(args.shift());
        const type = text(args.shift());
        if (!name) return sendReply(ctx, cfg.replyNeedAccountName);
        const state = await loadState();
        const rec = await createAccount(state, name, type, text(ctx && (ctx.author || ctx.from)));
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyAccCreated, { ACC: rec.code, NAME: rec.displayName }));
      }

      if (action === low(cfg.actionLink)) {
        const accountCode = text(args.shift());
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccountCode);
        const state = await loadState();
        const linked = await linkPic(
          state,
          accountCode,
          quotedChatId(ctx) || inboundChat(ctx),
          inboundPhone(ctx),
          text(ctx && (ctx.pushName || ctx.senderName)),
          text(ctx && (ctx.author || ctx.from))
        );
        if (!linked.ok) return sendReply(ctx, cfg.replyAccountNotFound);
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyPicLinked, { ACC: accountCode, PIC: linked.rec.picId }));
      }

      if (action === low(cfg.actionShow)) {
        const accountCode = text(args.shift());
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccountCode);
        const state = await loadState();
        const rec = state.accountsByCode[accountCode];
        if (!rec) return sendReply(ctx, cfg.replyAccountNotFound);
        return sendReply(ctx, fill(cfg.replyShowAccount, { ACC: rec.code, NAME: rec.displayName, TYPE: rec.type }));
      }

      if (action === low(cfg.actionList)) {
        const state = await loadState();
        const items = Object.keys(state.accountsByCode).sort().map((k) => state.accountsByCode[k]).map((x) => ({ ACC: x.code, NAME: x.displayName, TYPE: x.type }));
        return sendReply(ctx, listMessage(items, cfg.replyAccountItem));
      }

      if (action === low(cfg.actionSetName)) {
        const accountCode = text(args.shift());
        const name = text(args.join(' '));
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccountCode);
        if (!name) return sendReply(ctx, cfg.replyNeedAccountName);
        const state = await loadState();
        const rec = state.accountsByCode[accountCode];
        if (!rec) return sendReply(ctx, cfg.replyAccountNotFound);
        rec.displayName = name;
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyShowAccount, { ACC: rec.code, NAME: rec.displayName, TYPE: rec.type }));
      }

      return sendReply(ctx, cfg.replyUnknown);
    }

    async function runPic(ctx) {
      const args = ctx && ctx.command && Array.isArray(ctx.command.args) ? ctx.command.args.slice() : [];
      const action = low(args.shift());

      if (action === low(cfg.actionLink)) {
        const accountCode = text(args.shift());
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccountCode);
        const state = await loadState();
        const linked = await linkPic(
          state,
          accountCode,
          quotedChatId(ctx) || inboundChat(ctx),
          inboundPhone(ctx),
          text(args.join(' ')),
          text(ctx && (ctx.author || ctx.from))
        );
        if (!linked.ok) return sendReply(ctx, cfg.replyAccountNotFound);
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyPicLinked, { ACC: accountCode, PIC: linked.rec.picId }));
      }

      if (action === low(cfg.actionList)) {
        const accountCode = text(args.shift());
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccountCode);
        const state = await loadState();
        const ids = state.picIdsByAccountCode[accountCode] || [];
        const items = ids.map((id) => state.picsById[id]).filter(Boolean).map((x) => ({ PIC: x.picId, ACC: x.accountCode, NAME: x.displayName }));
        return sendReply(ctx, listMessage(items, cfg.replyPicItem));
      }

      if (action === low(cfg.actionSetName)) {
        const picId = text(args.shift());
        const name = text(args.join(' '));
        if (!picId) return sendReply(ctx, cfg.replyNeedPicId);
        if (!name) return sendReply(ctx, cfg.replyNeedPicId);
        const state = await loadState();
        const rec = state.picsById[picId];
        if (!rec) return sendReply(ctx, cfg.replyPicNotFound);
        rec.displayName = name;
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyShowPic, { PIC: rec.picId, ACC: rec.accountCode, NAME: rec.displayName }));
      }

      return sendReply(ctx, cfg.replyUnknown);
    }

    async function runContext(ctx) {
      const args = ctx && ctx.command && Array.isArray(ctx.command.args) ? ctx.command.args.slice() : [];
      const action = low(args.shift());

      if (action === low(cfg.actionNew)) {
        const accountCode = text(args.shift());
        const label = text(args.join(' '));
        if (!accountCode) return sendReply(ctx, cfg.replyNeedContextAccount);
        if (!label) return sendReply(ctx, cfg.replyNeedContextLabel);
        const state = await loadState();
        const made = await createContext(state, accountCode, label, '', text(ctx && (ctx.author || ctx.from)));
        if (!made.ok) return sendReply(ctx, cfg.replyAccountNotFound);
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyContextCreated, { CTX: made.rec.code, ACC: accountCode, LABEL: made.rec.label }));
      }

      if (action === low(cfg.actionLink)) {
        const ticketId = text(args.shift());
        const contextCode = text(args.shift());
        if (!ticketId) return sendReply(ctx, cfg.replyNeedTicket);
        if (!contextCode) return sendReply(ctx, cfg.replyNeedContextCode);
        const state = await loadState();
        const ctxRec = state.contextsByCode[contextCode];
        if (!ctxRec) return sendReply(ctx, cfg.replyContextNotFound);
        const prev = state.ticketLinksByTicketId[ticketId] || {};
        state.ticketLinksByTicketId[ticketId] = {
          ticketId,
          accountCode: text(prev.accountCode || ctxRec.accountCode),
          picId: text(prev.picId),
          contextCode,
          workgroupKey: text(prev.workgroupKey),
          updatedAt: Date.now(),
        };
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyContextLinked, { TICKET: ticketId, CTX: contextCode }));
      }

      if (action === low(cfg.actionList)) {
        const accountCode = text(args.shift());
        if (!accountCode) return sendReply(ctx, cfg.replyNeedContextAccount);
        const state = await loadState();
        const ids = state.contextCodesByAccountCode[accountCode] || [];
        const items = ids.map((id) => state.contextsByCode[id]).filter(Boolean).map((x) => ({ CTX: x.code, ACC: x.accountCode, LABEL: x.label, STATUS: x.status }));
        return sendReply(ctx, listMessage(items, cfg.replyContextItem));
      }

      if (action === low(cfg.actionClose)) {
        const contextCode = text(args.shift());
        if (!contextCode) return sendReply(ctx, cfg.replyNeedContextCode);
        const state = await loadState();
        const rec = state.contextsByCode[contextCode];
        if (!rec) return sendReply(ctx, cfg.replyContextNotFound);
        rec.status = text(cfg.contextStatusClosed);
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyShowContext, { CTX: rec.code, ACC: rec.accountCode, LABEL: rec.label, STATUS: rec.status }));
      }

      return sendReply(ctx, cfg.replyUnknown);
    }

    command.register(low(cfg.cmdAccount), async (ctx) => {
      if (!(await canManage(ctx))) return sendReply(ctx, cfg.replyNoAccess);
      if (!ctx || !ctx.isGroup) return sendReply(ctx, cfg.replyGroupOnly);
      if (!inControlGroup(ctx)) return sendReply(ctx, cfg.replyControlGroupOnly);
      return runAccount(ctx);
    });

    command.register(low(cfg.cmdPic), async (ctx) => {
      if (!(await canManage(ctx))) return sendReply(ctx, cfg.replyNoAccess);
      if (!ctx || !ctx.isGroup) return sendReply(ctx, cfg.replyGroupOnly);
      if (!inControlGroup(ctx)) return sendReply(ctx, cfg.replyControlGroupOnly);
      return runPic(ctx);
    });

    command.register(low(cfg.cmdContext), async (ctx) => {
      if (!(await canManage(ctx))) return sendReply(ctx, cfg.replyNoAccess);
      if (!ctx || !ctx.isGroup) return sendReply(ctx, cfg.replyGroupOnly);
      if (!inControlGroup(ctx)) return sendReply(ctx, cfg.replyControlGroupOnly);
      return runContext(ctx);
    });

    if (moduleLog) meta.log('ContactBookCV', 'ready service=' + serviceName);
    if (detailLog) meta.log('ContactBookCV', 'detail store=' + storeNs + '/' + storeKey);
    if (traceLog) meta.log('ContactBookCV', 'trace active');

    return { onMessage: async () => {}, onEvent: async () => {} };
  },
};