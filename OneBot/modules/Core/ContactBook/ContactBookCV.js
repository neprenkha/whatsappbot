'use strict';

function text(v) {
  return String(v == null ? '' : v).trim();
}

function lower(v) {
  return text(v).toLowerCase();
}

function toBool(v, d) {
  const s = lower(v);
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
  return lower(v);
}

function quotedChat(ctx) {
  const raw = ctx && ctx.raw && typeof ctx.raw === 'object' ? ctx.raw : {};
  const q = raw.quotedMsg || raw.quotedMessage || raw.quoted || {};
  return text(q.from || q.author || q.participant || raw.quotedAuthor || '');
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

    const store = jsonstore.open(text(cfg.storeNs));
    const storeKey = text(cfg.storeKey);

    async function loadState() {
      const raw = await store.get(storeKey, emptyState());
      const state = raw && typeof raw === 'object' ? raw : emptyState();
      return Object.assign(emptyState(), state);
    }

    async function saveState(state) {
      await store.set(storeKey, state);
    }

    function inboundChat(ctx) {
      return normalizeChat(text(ctx && ctx.chatId) || text(ctx && ctx.author) || text(ctx && ctx.from));
    }

    function inboundPhone(ctx) {
      const sender = ctx && ctx.sender && typeof ctx.sender === 'object' ? ctx.sender : {};
      const raw = ctx && ctx.raw && typeof ctx.raw === 'object' ? ctx.raw : {};
      return normalizePhone(sender.phone || sender.id || raw.author || raw.from || '');
    }

    function resolvePicId(state, chatId, phone) {
      const c = normalizeChat(chatId);
      const p = normalizePhone(phone);
      if (c && state.picIdByChatId[c]) return text(state.picIdByChatId[c]);
      if (p && state.picIdByPhone[p]) return text(state.picIdByPhone[p]);
      return '';
    }

    function nextCode(state, key, prefix) {
      const n = Math.max(0, toInt(state.seq[key], 0)) + 1;
      state.seq[key] = n;
      return text(prefix) + String(n).padStart(Math.max(1, toInt(cfg.codePad, 4)), '0');
    }

    function ensureList(m, k) {
      if (!m[k] || !Array.isArray(m[k])) m[k] = [];
      return m[k];
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

    function inControl(ctx) {
      const control = text(globalConf.controlGroupId);
      if (!control) return true;
      return text(ctx && ctx.chatId) === control;
    }

    async function sendReply(ctx, msg) {
      const body = text(msg);
      if (!body) return;
      if (ctx && typeof ctx.reply === 'function') return ctx.reply(body);
      const sendName = String(globalConf.sendPrefer || '').split(',').map((x) => text(x)).filter(Boolean)[0] || '';
      const send = sendName ? meta.getService(sendName) : null;
      if (send && ctx && ctx.chatId) return send(ctx.chatId, body, { isAuto: 0, manualReply: 1 });
    }

    function renderList(items, lineTemplate) {
      if (!items.length) return text(cfg.replyListEmpty);
      const lines = items.map((x) => fill(lineTemplate, x));
      return fill(cfg.replyListHeader, { ITEMS: lines.join('\n') });
    }

    async function createAccount(state, displayName, type, actor) {
      const code = nextCode(state, 'acc', cfg.accPrefix);
      state.accountsByCode[code] = {
        code,
        displayName: text(displayName),
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

    async function linkPic(state, accountCode, chatId, phone, name, actor) {
      const accCode = text(accountCode);
      if (!state.accountsByCode[accCode]) return { ok: 0 };
      let picId = resolvePicId(state, chatId, phone);
      if (!picId) picId = nextCode(state, 'pic', cfg.picPrefix);
      const rec = state.picsById[picId] || {
        picId,
        displayName: '',
        phone: '',
        chatId: '',
        accountCode: accCode,
        tags: '',
        notes: '',
        createdAt: Date.now(),
        createdBy: text(actor),
      };
      rec.displayName = text(name) || rec.displayName;
      rec.phone = normalizePhone(phone) || rec.phone;
      rec.chatId = normalizeChat(chatId) || rec.chatId;
      rec.accountCode = accCode;
      state.picsById[picId] = rec;
      if (rec.chatId) state.picIdByChatId[rec.chatId] = picId;
      if (rec.phone) state.picIdByPhone[rec.phone] = picId;
      const list = ensureList(state.picIdsByAccountCode, accCode);
      if (!list.includes(picId)) list.push(picId);
      return { ok: 1, rec };
    }

    async function createContext(state, accountCode, label, type, actor) {
      const accCode = text(accountCode);
      if (!state.accountsByCode[accCode]) return { ok: 0 };
      const code = nextCode(state, 'ctx', cfg.ctxPrefix);
      const rec = {
        code,
        accountCode: accCode,
        label: text(label),
        type: text(type),
        tags: '',
        notes: '',
        createdAt: Date.now(),
        createdBy: text(actor),
        status: text(cfg.contextStatusOpen),
      };
      state.contextsByCode[code] = rec;
      const list = ensureList(state.contextCodesByAccountCode, accCode);
      if (!list.includes(code)) list.push(code);
      return { ok: 1, rec };
    }

    if (typeof meta.registerService === 'function') {
      meta.registerService(text(cfg.serviceName), {
        resolveInbound: async (input) => {
          const state = await loadState();
          const picId = resolvePicId(state, input && input.chatId, input && input.phone);
          if (!picId) return { assigned: 0, accountCode: '', picId: '', contextCode: '', status: text(cfg.unassignedLabel) };
          const pic = state.picsById[picId] || {};
          return { assigned: 1, accountCode: text(pic.accountCode), picId, contextCode: '', status: text(cfg.assignedLabel) };
        },
        resolveInboundFromCtx: async (ctx) => {
          const state = await loadState();
          const picId = resolvePicId(state, inboundChat(ctx), inboundPhone(ctx));
          if (!picId) return { assigned: 0, accountCode: '', picId: '', contextCode: '', status: text(cfg.unassignedLabel) };
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
      const action = lower(args.shift());
      if (action === lower(cfg.actionNew)) {
        const name = text(args.shift());
        const type = text(args.shift());
        if (!name) return sendReply(ctx, cfg.replyNeedAccountName);
        const state = await loadState();
        const rec = await createAccount(state, name, type, text(ctx && (ctx.author || ctx.from)));
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyAccCreated, { ACC: rec.code, NAME: rec.displayName }));
      }
      if (action === lower(cfg.actionLink)) {
        const accountCode = text(args.shift());
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccountCode);
        const state = await loadState();
        const linked = await linkPic(state, accountCode, quotedChat(ctx) || inboundChat(ctx), inboundPhone(ctx), text(ctx && (ctx.pushName || ctx.senderName)), text(ctx && (ctx.author || ctx.from)));
        if (!linked.ok) return sendReply(ctx, cfg.replyAccountNotFound);
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyPicLinked, { ACC: accountCode, PIC: linked.rec.picId }));
      }
      if (action === lower(cfg.actionShow)) {
        const accountCode = text(args.shift());
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccountCode);
        const state = await loadState();
        const rec = state.accountsByCode[accountCode];
        if (!rec) return sendReply(ctx, cfg.replyAccountNotFound);
        return sendReply(ctx, fill(cfg.replyShowAccount, { ACC: rec.code, NAME: rec.displayName, TYPE: rec.type }));
      }
      if (action === lower(cfg.actionList)) {
        const state = await loadState();
        const items = Object.keys(state.accountsByCode).sort().map((k) => state.accountsByCode[k]).map((x) => ({ ACC: x.code, NAME: x.displayName, TYPE: x.type }));
        return sendReply(ctx, renderList(items, cfg.replyAccountItem));
      }
      if (action === lower(cfg.actionSetName)) {
        const accountCode = text(args.shift());
        const newName = text(args.join(' '));
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccountCode);
        if (!newName) return sendReply(ctx, cfg.replyNeedAccountName);
        const state = await loadState();
        const rec = state.accountsByCode[accountCode];
        if (!rec) return sendReply(ctx, cfg.replyAccountNotFound);
        rec.displayName = newName;
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyShowAccount, { ACC: rec.code, NAME: rec.displayName, TYPE: rec.type }));
      }
      return sendReply(ctx, cfg.replyUnknown);
    }

    async function runPic(ctx) {
      const args = ctx && ctx.command && Array.isArray(ctx.command.args) ? ctx.command.args.slice() : [];
      const action = lower(args.shift());
      if (action === lower(cfg.actionLink)) {
        const accountCode = text(args.shift());
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccountCode);
        const state = await loadState();
        const linked = await linkPic(state, accountCode, quotedChat(ctx) || inboundChat(ctx), inboundPhone(ctx), text(args.join(' ')), text(ctx && (ctx.author || ctx.from)));
        if (!linked.ok) return sendReply(ctx, cfg.replyAccountNotFound);
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyPicLinked, { ACC: accountCode, PIC: linked.rec.picId }));
      }
      if (action === lower(cfg.actionList)) {
        const accountCode = text(args.shift());
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccountCode);
        const state = await loadState();
        const ids = state.picIdsByAccountCode[accountCode] || [];
        const items = ids.map((id) => state.picsById[id]).filter(Boolean).map((x) => ({ PIC: x.picId, ACC: x.accountCode, NAME: x.displayName }));
        return sendReply(ctx, renderList(items, cfg.replyPicItem));
      }
      if (action === lower(cfg.actionSetName)) {
        const picId = text(args.shift());
        const newName = text(args.join(' '));
        if (!picId) return sendReply(ctx, cfg.replyNeedPicId);
        if (!newName) return sendReply(ctx, cfg.replyNeedPicId);
        const state = await loadState();
        const rec = state.picsById[picId];
        if (!rec) return sendReply(ctx, cfg.replyPicNotFound);
        rec.displayName = newName;
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyShowPic, { PIC: rec.picId, ACC: rec.accountCode, NAME: rec.displayName }));
      }
      return sendReply(ctx, cfg.replyUnknown);
    }

    async function runContext(ctx) {
      const args = ctx && ctx.command && Array.isArray(ctx.command.args) ? ctx.command.args.slice() : [];
      const action = lower(args.shift());
      if (action === lower(cfg.actionNew)) {
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
      if (action === lower(cfg.actionLink)) {
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
      if (action === lower(cfg.actionList)) {
        const accountCode = text(args.shift());
        if (!accountCode) return sendReply(ctx, cfg.replyNeedContextAccount);
        const state = await loadState();
        const ids = state.contextCodesByAccountCode[accountCode] || [];
        const items = ids.map((id) => state.contextsByCode[id]).filter(Boolean).map((x) => ({ CTX: x.code, ACC: x.accountCode, LABEL: x.label, STATUS: x.status }));
        return sendReply(ctx, renderList(items, cfg.replyContextItem));
      }
      if (action === lower(cfg.actionClose)) {
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

    command.register(lower(cfg.cmdAccount), async (ctx) => {
      if (!(await canManage(ctx))) return sendReply(ctx, cfg.replyNoAccess);
      if (!ctx || !ctx.isGroup) return sendReply(ctx, cfg.replyGroupOnly);
      if (!inControl(ctx)) return sendReply(ctx, cfg.replyControlGroupOnly);
      return runAccount(ctx);
    });

    command.register(lower(cfg.cmdPic), async (ctx) => {
      if (!(await canManage(ctx))) return sendReply(ctx, cfg.replyNoAccess);
      if (!ctx || !ctx.isGroup) return sendReply(ctx, cfg.replyGroupOnly);
      if (!inControl(ctx)) return sendReply(ctx, cfg.replyControlGroupOnly);
      return runPic(ctx);
    });

    command.register(lower(cfg.cmdContext), async (ctx) => {
      if (!(await canManage(ctx))) return sendReply(ctx, cfg.replyNoAccess);
      if (!ctx || !ctx.isGroup) return sendReply(ctx, cfg.replyGroupOnly);
      if (!inControl(ctx)) return sendReply(ctx, cfg.replyControlGroupOnly);
      return runContext(ctx);
    });

    if (moduleLog) meta.log('ContactBookCV', 'ready service=' + text(cfg.serviceName));
    if (detailLog) meta.log('ContactBookCV', 'detail store=' + text(cfg.storeNs) + '/' + text(cfg.storeKey));
    if (traceLog) meta.log('ContactBookCV', 'trace active');

    return { onMessage: async () => {}, onEvent: async () => {} };
  },
};