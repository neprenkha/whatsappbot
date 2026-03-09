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

function fill(tpl, vars) {
  let out = String(tpl || '');
  Object.keys(vars || {}).forEach((k) => {
    out = out.split(`{${k}}`).join(String(vars[k] == null ? '' : vars[k]));
  });
  return out;
}

function normalizePhone(v) {
  return text(v).replace(/[^0-9]/g, '');
}

function normalizeChat(v) {
  return low(v);
}

function getQuoted(ctx) {
  const raw = ctx && ctx.raw && typeof ctx.raw === 'object' ? ctx.raw : {};
  const q = raw.quotedMsg || raw.quotedMessage || raw.quoted || {};
  return text(q.from || q.author || q.participant || raw.quotedAuthor || '');
}

function makeEmptyState() {
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

    let globalCfg = {};
    try {
      const loaded = meta.loadConfRel(text(cfg.globalConfRel)) || {};
      globalCfg = loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
    } catch (e) {
      if (bugLog) meta.log('ContactBookCV', 'global_conf_load_failed err=' + text(e && e.message));
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const commandServiceName = text(cfg.commandServiceName);
    const jsonStoreServiceName = text(cfg.jsonStoreServiceName);
    const accessServiceName = text(cfg.accessServiceName);
    const workGroupsServiceName = text(cfg.workGroupsServiceName);
    const serviceName = text(cfg.serviceName);
    const storeNs = text(cfg.storeNs);
    const storeKey = text(cfg.storeKey);

    const command = meta.getService(commandServiceName);
    const jsonstore = meta.getService(jsonStoreServiceName);
    const access = accessServiceName ? meta.getService(accessServiceName) : null;
    const workgroups = workGroupsServiceName ? meta.getService(workGroupsServiceName) : null;

    if (!command || typeof command.register !== 'function') return { onMessage: async () => {}, onEvent: async () => {} };
    if (!jsonstore || typeof jsonstore.open !== 'function') return { onMessage: async () => {}, onEvent: async () => {} };

    const required = [
      serviceName, storeNs, storeKey,
      cfg.cmdAccount, cfg.cmdPic, cfg.cmdContext,
      cfg.actionNew, cfg.actionLink, cfg.actionShow, cfg.actionList, cfg.actionSetName, cfg.actionClose,
      cfg.accPrefix, cfg.picPrefix, cfg.ctxPrefix,
      cfg.replyNoAccess, cfg.replyGroupOnly, cfg.replyControlGroupOnly, cfg.replyUnknown,
      cfg.replyNeedAccountName, cfg.replyNeedAccountCode, cfg.replyNeedContextAccount, cfg.replyNeedContextLabel,
      cfg.replyNeedTicket, cfg.replyNeedContextCode, cfg.replyNeedPicId,
      cfg.replyAccCreated, cfg.replyPicLinked, cfg.replyContextCreated, cfg.replyContextLinked,
      cfg.replyAccountNotFound, cfg.replyPicNotFound, cfg.replyContextNotFound,
      cfg.replyListEmpty, cfg.replyListHeader,
      cfg.replyAccountItem, cfg.replyPicItem, cfg.replyContextItem,
      cfg.replyShowAccount, cfg.replyShowPic, cfg.replyShowContext,
      cfg.unassignedLabel, cfg.assignedLabel,
      cfg.folderAccountTemplate, cfg.folderContextTemplate, cfg.folderInboxTemplate
    ].map(text);
    for (let i = 0; i < required.length; i += 1) {
      if (!required[i]) return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const store = jsonstore.open(storeNs);

    async function loadState() {
      const raw = await store.get(storeKey, makeEmptyState());
      const s = raw && typeof raw === 'object' ? raw : makeEmptyState();
      return Object.assign(makeEmptyState(), s);
    }

    async function saveState(state) {
      await store.set(storeKey, state);
    }

    function nextCode(state, key, prefix) {
      const n = Math.max(0, toInt(state.seq[key], 0)) + 1;
      state.seq[key] = n;
      return text(prefix) + String(n).padStart(Math.max(1, toInt(cfg.codePad, 4)), '0');
    }

    function ensureList(state, mapKey, itemKey) {
      if (!state[mapKey][itemKey] || !Array.isArray(state[mapKey][itemKey])) state[mapKey][itemKey] = [];
      return state[mapKey][itemKey];
    }

    function inboundChat(ctx) {
      return normalizeChat(text(ctx && ctx.chatId) || text(ctx && ctx.author) || text(ctx && ctx.from));
    }

    function inboundPhone(ctx) {
      const sender = ctx && ctx.sender && typeof ctx.sender === 'object' ? ctx.sender : {};
      const raw = ctx && ctx.raw && typeof ctx.raw === 'object' ? ctx.raw : {};
      return normalizePhone(sender.phone || sender.id || raw.author || raw.from || '');
    }

    function lookupPicId(state, chatId, phone) {
      const c = normalizeChat(chatId);
      const p = normalizePhone(phone);
      if (c && state.picIdByChatId[c]) return text(state.picIdByChatId[c]);
      if (p && state.picIdByPhone[p]) return text(state.picIdByPhone[p]);
      return '';
    }

    async function allowManage(ctx) {
      const minRole = text(cfg.minRoleManage);
      if (!minRole) return true;
      if (!access) return false;
      if (typeof access.hasRole === 'function') return !!(await access.hasRole(ctx, minRole));
      if (typeof access.isAllowed === 'function') return !!(await access.isAllowed(ctx, minRole));
      if (typeof access.check === 'function') return !!(await access.check(ctx, minRole));
      if (typeof access.meetsMinRole === 'function') return !!(await access.meetsMinRole(ctx, minRole));
      return false;
    }

    function inControl(ctx) {
      return text(globalCfg.controlGroupId) ? text(ctx && ctx.chatId) === text(globalCfg.controlGroupId) : true;
    }

    async function reply(ctx, msg) {
      const s = text(msg);
      if (!s) return;
      if (ctx && typeof ctx.reply === 'function') {
        await ctx.reply(s);
        return;
      }
      const sendName = String(globalCfg.sendPrefer || '').split(',').map((x) => text(x)).filter(Boolean)[0] || '';
      const send = sendName ? meta.getService(sendName) : null;
      if (send && ctx && ctx.chatId) await send(ctx.chatId, s, { isAuto: 0, manualReply: 1 });
    }

    function renderList(items, tpl) {
      if (!items.length) return text(cfg.replyListEmpty);
      return fill(cfg.replyListHeader, { ITEMS: items.map((x) => fill(tpl, x)).join('\n') });
    }

    async function createAccount(state, name, type, by) {
      const code = nextCode(state, 'acc', cfg.accPrefix);
      state.accountsByCode[code] = {
        code,
        displayName: text(name),
        type: text(type),
        tags: '',
        notes: '',
        defaultWorkgroupKey: '',
        createdAt: Date.now(),
        createdBy: text(by),
      };
      ensureList(state, 'picIdsByAccountCode', code);
      ensureList(state, 'contextCodesByAccountCode', code);
      return state.accountsByCode[code];
    }

    async function linkPic(state, accountCode, chatId, phone, name, by) {
      const acc = state.accountsByCode[text(accountCode)];
      if (!acc) return { ok: 0, code: 'account_not_found' };
      let picId = lookupPicId(state, chatId, phone);
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
        createdBy: text(by),
      };
      rec.displayName = text(name) || rec.displayName;
      rec.phone = normalizePhone(phone) || rec.phone;
      rec.chatId = normalizeChat(chatId) || rec.chatId;
      rec.accountCode = text(accountCode);
      state.picsById[picId] = rec;
      if (rec.chatId) state.picIdByChatId[rec.chatId] = picId;
      if (rec.phone) state.picIdByPhone[rec.phone] = picId;
      const list = ensureList(state, 'picIdsByAccountCode', rec.accountCode);
      if (!list.includes(picId)) list.push(picId);
      return { ok: 1, rec };
    }

    async function createContext(state, accountCode, label, type, by) {
      const acc = state.accountsByCode[text(accountCode)];
      if (!acc) return { ok: 0, code: 'account_not_found' };
      const code = nextCode(state, 'ctx', cfg.ctxPrefix);
      const rec = {
        code,
        accountCode: text(accountCode),
        label: text(label),
        type: text(type),
        tags: '',
        notes: '',
        createdAt: Date.now(),
        createdBy: text(by),
        status: text(cfg.contextStatusOpen),
      };
      state.contextsByCode[code] = rec;
      const list = ensureList(state, 'contextCodesByAccountCode', rec.accountCode);
      if (!list.includes(code)) list.push(code);
      return { ok: 1, rec };
    }

    if (typeof meta.registerService === 'function') {
      meta.registerService(serviceName, {
        resolveInbound: async (input) => {
          const state = await loadState();
          const picId = lookupPicId(state, input && input.chatId, input && input.phone);
          if (!picId) {
            return {
              assigned: 0,
              accountCode: '',
              picId: '',
              contextCode: '',
              status: text(cfg.unassignedLabel),
            };
          }
          const pic = state.picsById[picId] || {};
          return {
            assigned: 1,
            accountCode: text(pic.accountCode),
            picId,
            contextCode: '',
            status: text(cfg.assignedLabel),
          };
        },
        resolveInboundFromCtx: async (ctx) => {
          const state = await loadState();
          const picId = lookupPicId(state, inboundChat(ctx), inboundPhone(ctx));
          if (!picId) return { assigned: 0, accountCode: '', picId: '', contextCode: '', status: text(cfg.unassignedLabel) };
          const pic = state.picsById[picId] || {};
          return { assigned: 1, accountCode: text(pic.accountCode), picId, contextCode: '', status: text(cfg.assignedLabel) };
        },
        linkTicket: async (payload) => {
          const p = payload && typeof payload === 'object' ? payload : {};
          const ticketId = text(p.ticketId);
          if (!ticketId) return { ok: 0, code: 'need_ticket' };
          const state = await loadState();
          let workgroupKey = text(p.workgroupKey);
          if (!workgroupKey && workgroups && typeof workgroups.resolve === 'function') {
            const found = await workgroups.resolve(text(p.workgroupKey));
            workgroupKey = text(found && found.name);
          }
          state.ticketLinksByTicketId[ticketId] = {
            ticketId,
            accountCode: text(p.accountCode),
            picId: text(p.picId),
            contextCode: text(p.contextCode),
            workgroupKey,
            updatedAt: Date.now(),
          };
          await saveState(state);
          return { ok: 1 };
        },
        getTicketLink: async (ticketId) => {
          const state = await loadState();
          const id = text(ticketId);
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
        if (!name) return reply(ctx, cfg.replyNeedAccountName);
        const state = await loadState();
        const rec = await createAccount(state, name, type, text(ctx && (ctx.author || ctx.from)));
        await saveState(state);
        return reply(ctx, fill(cfg.replyAccCreated, { ACC: rec.code, NAME: rec.displayName }));
      }
      if (action === low(cfg.actionLink)) {
        const accountCode = text(args.shift());
        if (!accountCode) return reply(ctx, cfg.replyNeedAccountCode);
        const state = await loadState();
        const linked = await linkPic(state, accountCode, getQuoted(ctx) || inboundChat(ctx), inboundPhone(ctx), text(ctx && (ctx.pushName || ctx.senderName)), text(ctx && (ctx.author || ctx.from)));
        if (!linked.ok) return reply(ctx, cfg.replyAccountNotFound);
        await saveState(state);
        return reply(ctx, fill(cfg.replyPicLinked, { ACC: accountCode, PIC: linked.rec.picId }));
      }
      if (action === low(cfg.actionShow)) {
        const accountCode = text(args.shift());
        if (!accountCode) return reply(ctx, cfg.replyNeedAccountCode);
        const state = await loadState();
        const rec = state.accountsByCode[accountCode];
        if (!rec) return reply(ctx, cfg.replyAccountNotFound);
        return reply(ctx, fill(cfg.replyShowAccount, { ACC: rec.code, NAME: rec.displayName, TYPE: rec.type }));
      }
      if (action === low(cfg.actionList)) {
        const state = await loadState();
        const items = Object.keys(state.accountsByCode).sort().map((k) => state.accountsByCode[k]).map((x) => ({ ACC: x.code, NAME: x.displayName, TYPE: x.type }));
        return reply(ctx, renderList(items, cfg.replyAccountItem));
      }
      if (action === low(cfg.actionSetName)) {
        const accountCode = text(args.shift());
        const name = text(args.join(' '));
        if (!accountCode) return reply(ctx, cfg.replyNeedAccountCode);
        if (!name) return reply(ctx, cfg.replyNeedAccountName);
        const state = await loadState();
        const rec = state.accountsByCode[accountCode];
        if (!rec) return reply(ctx, cfg.replyAccountNotFound);
        rec.displayName = name;
        await saveState(state);
        return reply(ctx, fill(cfg.replyShowAccount, { ACC: rec.code, NAME: rec.displayName, TYPE: rec.type }));
      }
      return reply(ctx, cfg.replyUnknown);
    }

    async function runPic(ctx) {
      const args = ctx && ctx.command && Array.isArray(ctx.command.args) ? ctx.command.args.slice() : [];
      const action = low(args.shift());
      if (action === low(cfg.actionLink)) {
        const accountCode = text(args.shift());
        if (!accountCode) return reply(ctx, cfg.replyNeedAccountCode);
        const state = await loadState();
        const linked = await linkPic(state, accountCode, getQuoted(ctx) || inboundChat(ctx), inboundPhone(ctx), text(args.join(' ')), text(ctx && (ctx.author || ctx.from)));
        if (!linked.ok) return reply(ctx, cfg.replyAccountNotFound);
        await saveState(state);
        return reply(ctx, fill(cfg.replyPicLinked, { ACC: accountCode, PIC: linked.rec.picId }));
      }
      if (action === low(cfg.actionList)) {
        const accountCode = text(args.shift());
        if (!accountCode) return reply(ctx, cfg.replyNeedAccountCode);
        const state = await loadState();
        const ids = state.picIdsByAccountCode[accountCode] || [];
        const items = ids.map((id) => state.picsById[id]).filter(Boolean).map((x) => ({ PIC: x.picId, ACC: x.accountCode, NAME: x.displayName }));
        return reply(ctx, renderList(items, cfg.replyPicItem));
      }
      if (action === low(cfg.actionSetName)) {
        const picId = text(args.shift());
        const name = text(args.join(' '));
        if (!picId) return reply(ctx, cfg.replyNeedPicId);
        if (!name) return reply(ctx, cfg.replyNeedPicId);
        const state = await loadState();
        const rec = state.picsById[picId];
        if (!rec) return reply(ctx, cfg.replyPicNotFound);
        rec.displayName = name;
        await saveState(state);
        return reply(ctx, fill(cfg.replyShowPic, { PIC: rec.picId, ACC: rec.accountCode, NAME: rec.displayName }));
      }
      return reply(ctx, cfg.replyUnknown);
    }

    async function runContext(ctx) {
      const args = ctx && ctx.command && Array.isArray(ctx.command.args) ? ctx.command.args.slice() : [];
      const action = low(args.shift());
      if (action === low(cfg.actionNew)) {
        const accountCode = text(args.shift());
        const label = text(args.join(' '));
        if (!accountCode) return reply(ctx, cfg.replyNeedContextAccount);
        if (!label) return reply(ctx, cfg.replyNeedContextLabel);
        const state = await loadState();
        const made = await createContext(state, accountCode, label, '', text(ctx && (ctx.author || ctx.from)));
        if (!made.ok) return reply(ctx, cfg.replyAccountNotFound);
        await saveState(state);
        return reply(ctx, fill(cfg.replyContextCreated, { CTX: made.rec.code, ACC: accountCode, LABEL: made.rec.label }));
      }
      if (action === low(cfg.actionLink)) {
        const ticketId = text(args.shift());
        const contextCode = text(args.shift());
        if (!ticketId) return reply(ctx, cfg.replyNeedTicket);
        if (!contextCode) return reply(ctx, cfg.replyNeedContextCode);
        const state = await loadState();
        const ctxRec = state.contextsByCode[contextCode];
        if (!ctxRec) return reply(ctx, cfg.replyContextNotFound);
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
        return reply(ctx, fill(cfg.replyContextLinked, { TICKET: ticketId, CTX: contextCode }));
      }
      if (action === low(cfg.actionList)) {
        const accountCode = text(args.shift());
        if (!accountCode) return reply(ctx, cfg.replyNeedContextAccount);
        const state = await loadState();
        const ids = state.contextCodesByAccountCode[accountCode] || [];
        const items = ids.map((id) => state.contextsByCode[id]).filter(Boolean).map((x) => ({ CTX: x.code, ACC: x.accountCode, LABEL: x.label, STATUS: x.status }));
        return reply(ctx, renderList(items, cfg.replyContextItem));
      }
      if (action === low(cfg.actionClose)) {
        const contextCode = text(args.shift());
        if (!contextCode) return reply(ctx, cfg.replyNeedContextCode);
        const state = await loadState();
        const rec = state.contextsByCode[contextCode];
        if (!rec) return reply(ctx, cfg.replyContextNotFound);
        rec.status = text(cfg.contextStatusClosed);
        await saveState(state);
        return reply(ctx, fill(cfg.replyShowContext, { CTX: rec.code, ACC: rec.accountCode, LABEL: rec.label, STATUS: rec.status }));
      }
      return reply(ctx, cfg.replyUnknown);
    }

    const cmdAccount = low(cfg.cmdAccount);
    const cmdPic = low(cfg.cmdPic);
    const cmdContext = low(cfg.cmdContext);

    command.register(cmdAccount, async (ctx) => {
      if (!(await allowManage(ctx))) return reply(ctx, cfg.replyNoAccess);
      if (!ctx || !ctx.isGroup) return reply(ctx, cfg.replyGroupOnly);
      if (!inControl(ctx)) return reply(ctx, cfg.replyControlGroupOnly);
      return runAccount(ctx);
    });

    command.register(cmdPic, async (ctx) => {
      if (!(await allowManage(ctx))) return reply(ctx, cfg.replyNoAccess);
      if (!ctx || !ctx.isGroup) return reply(ctx, cfg.replyGroupOnly);
      if (!inControl(ctx)) return reply(ctx, cfg.replyControlGroupOnly);
      return runPic(ctx);
    });

    command.register(cmdContext, async (ctx) => {
      if (!(await allowManage(ctx))) return reply(ctx, cfg.replyNoAccess);
      if (!ctx || !ctx.isGroup) return reply(ctx, cfg.replyGroupOnly);
      if (!inControl(ctx)) return reply(ctx, cfg.replyControlGroupOnly);
      return runContext(ctx);
    });

    if (moduleLog) meta.log('ContactBookCV', 'ready service=' + serviceName);
    if (detailLog) meta.log('ContactBookCV', 'detail store=' + storeNs + '/' + storeKey);
    if (traceLog) meta.log('ContactBookCV', 'trace active');

    return { onMessage: async () => {}, onEvent: async () => {} };
  },
};