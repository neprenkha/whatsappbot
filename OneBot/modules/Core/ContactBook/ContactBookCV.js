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

function fill(template, vars) {
  let out = String(template || '');
  Object.keys(vars || {}).forEach((k) => {
    out = out.split(`{${k}}`).join(String(vars[k] == null ? '' : vars[k]));
  });
  return out;
}

function normalizePhone(v) {
  return text(v).replace(/[^0-9]/g, '');
}

function normalizeChatId(v) {
  return lower(v);
}

function quotedChatId(ctx) {
  const raw = ctx && ctx.raw && typeof ctx.raw === 'object' ? ctx.raw : {};
  const q = raw.quotedMsg || raw.quotedMessage || raw.quoted || {};
  return text(q.from || q.author || q.participant || raw.quotedAuthor || '');
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

    const commandServiceName = text(cfg.commandServiceName);
    const jsonStoreServiceName = text(cfg.jsonStoreServiceName);
    const accessServiceName = text(cfg.accessServiceName);
    const serviceName = text(cfg.serviceName);

    const storeNs = text(cfg.storeNs);
    const storeKey = text(cfg.storeKey);

    const controlGroupId = text(globalConf.controlGroupId);
    const prefix = text(globalConf.prefix);

    const cmdAccount = lower(cfg.cmdAccount);
    const cmdPic = lower(cfg.cmdPic);
    const cmdContext = lower(cfg.cmdContext);

    const actionNew = lower(cfg.actionNew);
    const actionLink = lower(cfg.actionLink);
    const actionShow = lower(cfg.actionShow);
    const actionList = lower(cfg.actionList);
    const actionSetName = lower(cfg.actionSetName);
    const actionClose = lower(cfg.actionClose);

    const accPrefix = text(cfg.accPrefix);
    const picPrefix = text(cfg.picPrefix);
    const ctxPrefix = text(cfg.ctxPrefix);
    const codePad = Math.max(1, toInt(cfg.codePad, 4));

    const required = [
      commandServiceName, jsonStoreServiceName, serviceName,
      storeNs, storeKey, cmdAccount, cmdPic, cmdContext,
      actionNew, actionLink, actionShow, actionList, actionSetName, actionClose,
      accPrefix, picPrefix, ctxPrefix,
      cfg.replyNoAccess, cfg.replyGroupOnly, cfg.replyControlGroupOnly, cfg.replyUnknown,
      cfg.replyNeedAccountName, cfg.replyNeedAccountCode, cfg.replyNeedPicName,
      cfg.replyNeedContextAccount, cfg.replyNeedContextLabel, cfg.replyNeedTicket,
      cfg.replyAccCreated, cfg.replyPicLinked, cfg.replyContextCreated, cfg.replyContextLinked,
      cfg.replyAccountNotFound, cfg.replyPicNotFound, cfg.replyContextNotFound,
      cfg.replyListEmpty, cfg.replyListHeader, cfg.replyListItem,
      cfg.replyShowAccount, cfg.replyShowPic, cfg.replyShowContext,
      cfg.unassignedLabel
    ].map(text);
    for (let i = 0; i < required.length; i += 1) {
      if (!required[i]) {
        if (bugLog) meta.log('ContactBookCV', 'safe_disabled required_config_missing');
        return { onMessage: async () => {}, onEvent: async () => {} };
      }
    }

    const command = meta.getService(commandServiceName);
    const jsonstore = meta.getService(jsonStoreServiceName);
    const access = accessServiceName ? meta.getService(accessServiceName) : null;

    if (!command || typeof command.register !== 'function') {
      if (bugLog) meta.log('ContactBookCV', 'safe_disabled missing_command_service');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }
    if (!jsonstore || typeof jsonstore.open !== 'function') {
      if (bugLog) meta.log('ContactBookCV', 'safe_disabled missing_jsonstore_service');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const store = jsonstore.open(storeNs);

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

    async function hasAccess(ctx) {
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
      return text(ctx && ctx.chatId) === controlGroupId;
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

    async function loadState() {
      const raw = await store.get(storeKey, emptyState());
      const d = raw && typeof raw === 'object' ? raw : emptyState();
      return Object.assign(emptyState(), d);
    }

    async function saveState(state) {
      await store.set(storeKey, state);
    }

    function nextCode(seqObj, key, token) {
      const next = Math.max(0, toInt(seqObj[key], 0)) + 1;
      seqObj[key] = next;
      return token + String(next).padStart(codePad, '0');
    }

    function ensureListMap(mapObj, key) {
      if (!mapObj[key] || !Array.isArray(mapObj[key])) mapObj[key] = [];
      return mapObj[key];
    }

    function accountFromCode(state, code) {
      return state.accountsByCode[text(code)] || null;
    }

    function picFromId(state, picId) {
      return state.picsById[text(picId)] || null;
    }

    function contextFromCode(state, code) {
      return state.contextsByCode[text(code)] || null;
    }

    function resolvePicId(state, chatId, phone) {
      const c = normalizeChatId(chatId);
      const p = normalizePhone(phone);
      if (c && state.picIdByChatId[c]) return text(state.picIdByChatId[c]);
      if (p && state.picIdByPhone[p]) return text(state.picIdByPhone[p]);
      return '';
    }

    function inboundPhone(ctx) {
      const sender = ctx && ctx.sender && typeof ctx.sender === 'object' ? ctx.sender : {};
      const raw = ctx && ctx.raw && typeof ctx.raw === 'object' ? ctx.raw : {};
      return normalizePhone(sender.phone || sender.id || raw.author || raw.from || '');
    }

    function inboundChatId(ctx) {
      return normalizeChatId(text(ctx && ctx.chatId) || text(ctx && ctx.author) || text(ctx && ctx.from));
    }

    async function createAccount(state, displayName, type, actor) {
      const code = nextCode(state.seq, 'acc', accPrefix);
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
      ensureListMap(state.picIdsByAccountCode, code);
      ensureListMap(state.contextCodesByAccountCode, code);
      return state.accountsByCode[code];
    }

    async function createContext(state, accountCode, label, type, actor) {
      const code = nextCode(state.seq, 'ctx', ctxPrefix);
      state.contextsByCode[code] = {
        code,
        accountCode,
        label: text(label),
        type: text(type),
        tags: '',
        notes: '',
        createdAt: Date.now(),
        createdBy: text(actor),
        status: text(cfg.contextStatusOpen),
      };
      const list = ensureListMap(state.contextCodesByAccountCode, accountCode);
      if (!list.includes(code)) list.push(code);
      return state.contextsByCode[code];
    }

    async function linkPic(state, input) {
      const accountCode = text(input.accountCode);
      const account = accountFromCode(state, accountCode);
      if (!account) return { ok: 0, code: 'account_not_found' };

      const chatId = normalizeChatId(input.chatId);
      const phone = normalizePhone(input.phone);
      const displayName = text(input.displayName);

      let picId = resolvePicId(state, chatId, phone);
      if (!picId) {
        picId = nextCode(state.seq, 'pic', picPrefix);
      }

      const current = state.picsById[picId] || {
        picId,
        displayName: '',
        phone: '',
        chatId: '',
        accountCode,
        tags: '',
        notes: '',
        createdAt: Date.now(),
        createdBy: text(input.actor),
      };

      current.displayName = displayName || current.displayName;
      current.phone = phone || current.phone;
      current.chatId = chatId || current.chatId;
      current.accountCode = accountCode;
      state.picsById[picId] = current;

      if (current.chatId) state.picIdByChatId[current.chatId] = picId;
      if (current.phone) state.picIdByPhone[current.phone] = picId;

      const list = ensureListMap(state.picIdsByAccountCode, accountCode);
      if (!list.includes(picId)) list.push(picId);

      return { ok: 1, pic: current };
    }

    async function resolveInbound(state, ctx) {
      const chatId = inboundChatId(ctx);
      const phone = inboundPhone(ctx);
      const picId = resolvePicId(state, chatId, phone);
      if (!picId) {
        return {
          assigned: 0,
          accountCode: '',
          picId: '',
          contextCode: '',
          status: text(cfg.unassignedLabel),
          chatId,
          phone,
        };
      }
      const pic = picFromId(state, picId);
      if (!pic) {
        return {
          assigned: 0,
          accountCode: '',
          picId: '',
          contextCode: '',
          status: text(cfg.unassignedLabel),
          chatId,
          phone,
        };
      }
      return {
        assigned: 1,
        accountCode: text(pic.accountCode),
        picId,
        contextCode: '',
        status: 'assigned',
        chatId,
        phone,
      };
    }

    function listRecords(items, mapLine) {
      if (!items.length) return text(cfg.replyListEmpty);
      const lines = items.map(mapLine).map((line) => text(line)).filter(Boolean);
      return fill(cfg.replyListHeader, { ITEMS: lines.join('\n') });
    }

    async function runAccountCommand(ctx) {
      const args = ctx && ctx.command && Array.isArray(ctx.command.args) ? ctx.command.args.slice() : [];
      const action = lower(args.shift());

      if (action === actionNew) {
        const displayName = text(args.shift());
        const type = text(args.shift());
        if (!displayName) return sendReply(ctx, cfg.replyNeedAccountName);
        const state = await loadState();
        const rec = await createAccount(state, displayName, type, text(ctx && ctx.author));
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyAccCreated, { ACC: rec.code, NAME: rec.displayName }));
      }

      if (action === actionLink) {
        const accountCode = text(args.shift());
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccountCode);
        const state = await loadState();
        const chatId = normalizeChatId(quotedChatId(ctx) || inboundChatId(ctx));
        const linked = await linkPic(state, {
          accountCode,
          chatId,
          phone: inboundPhone(ctx),
          displayName: text(ctx && (ctx.pushName || ctx.senderName || '')),
          actor: text(ctx && ctx.author),
        });
        if (!linked.ok) return sendReply(ctx, cfg.replyAccountNotFound);
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyPicLinked, { ACC: accountCode, PIC: linked.pic.picId }));
      }

      if (action === actionShow) {
        const accountCode = text(args.shift());
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccountCode);
        const state = await loadState();
        const rec = accountFromCode(state, accountCode);
        if (!rec) return sendReply(ctx, cfg.replyAccountNotFound);
        return sendReply(ctx, fill(cfg.replyShowAccount, { ACC: rec.code, NAME: rec.displayName, TYPE: rec.type }));
      }

      if (action === actionList) {
        const state = await loadState();
        const items = Object.keys(state.accountsByCode).sort().map((k) => state.accountsByCode[k]);
        return sendReply(ctx, listRecords(items, (r) => fill(cfg.replyListItem, { CODE: r.code, NAME: r.displayName, TYPE: r.type })));
      }

      if (action === actionSetName) {
        const accountCode = text(args.shift());
        const newName = text(args.join(' '));
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccountCode);
        if (!newName) return sendReply(ctx, cfg.replyNeedAccountName);
        const state = await loadState();
        const rec = accountFromCode(state, accountCode);
        if (!rec) return sendReply(ctx, cfg.replyAccountNotFound);
        rec.displayName = newName;
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyShowAccount, { ACC: rec.code, NAME: rec.displayName, TYPE: rec.type }));
      }

      return sendReply(ctx, cfg.replyUnknown);
    }

    async function runPicCommand(ctx) {
      const args = ctx && ctx.command && Array.isArray(ctx.command.args) ? ctx.command.args.slice() : [];
      const action = lower(args.shift());

      if (action === actionLink) {
        const accountCode = text(args.shift());
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccountCode);
        const displayName = text(args.join(' '));
        const state = await loadState();
        const linked = await linkPic(state, {
          accountCode,
          chatId: normalizeChatId(quotedChatId(ctx) || inboundChatId(ctx)),
          phone: inboundPhone(ctx),
          displayName,
          actor: text(ctx && ctx.author),
        });
        if (!linked.ok) return sendReply(ctx, cfg.replyAccountNotFound);
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyPicLinked, { ACC: accountCode, PIC: linked.pic.picId }));
      }

      if (action === actionList) {
        const accountCode = text(args.shift());
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccountCode);
        const state = await loadState();
        const picIds = state.picIdsByAccountCode[accountCode] || [];
        const items = picIds.map((id) => state.picsById[id]).filter(Boolean);
        return sendReply(ctx, listRecords(items, (r) => fill(cfg.replyShowPic, { PIC: r.picId, ACC: r.accountCode, NAME: r.displayName })));
      }

      if (action === actionSetName) {
        const picId = text(args.shift());
        const newName = text(args.join(' '));
        if (!picId) return sendReply(ctx, cfg.replyNeedPicName);
        if (!newName) return sendReply(ctx, cfg.replyNeedPicName);
        const state = await loadState();
        const pic = picFromId(state, picId);
        if (!pic) return sendReply(ctx, cfg.replyPicNotFound);
        pic.displayName = newName;
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyShowPic, { PIC: pic.picId, ACC: pic.accountCode, NAME: pic.displayName }));
      }

      return sendReply(ctx, cfg.replyUnknown);
    }

    async function runContextCommand(ctx) {
      const args = ctx && ctx.command && Array.isArray(ctx.command.args) ? ctx.command.args.slice() : [];
      const action = lower(args.shift());

      if (action === actionNew) {
        const accountCode = text(args.shift());
        const label = text(args.join(' '));
        if (!accountCode) return sendReply(ctx, cfg.replyNeedContextAccount);
        if (!label) return sendReply(ctx, cfg.replyNeedContextLabel);
        const state = await loadState();
        if (!accountFromCode(state, accountCode)) return sendReply(ctx, cfg.replyAccountNotFound);
        const rec = await createContext(state, accountCode, label, '', text(ctx && ctx.author));
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyContextCreated, { CTX: rec.code, ACC: accountCode, LABEL: rec.label }));
      }

      if (action === actionLink) {
        const ticketId = text(args.shift());
        const contextCode = text(args.shift());
        if (!ticketId) return sendReply(ctx, cfg.replyNeedTicket);
        if (!contextCode) return sendReply(ctx, cfg.replyContextNotFound);
        const state = await loadState();
        const ctxRec = contextFromCode(state, contextCode);
        if (!ctxRec) return sendReply(ctx, cfg.replyContextNotFound);
        const prev = state.ticketLinksByTicketId[ticketId] || {};
        state.ticketLinksByTicketId[ticketId] = {
          ticketId,
          accountCode: text(prev.accountCode || ctxRec.accountCode),
          picId: text(prev.picId || ''),
          contextCode,
          workgroupKey: text(prev.workgroupKey || ''),
          updatedAt: Date.now(),
        };
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyContextLinked, { CTX: contextCode, TICKET: ticketId }));
      }

      if (action === actionList) {
        const accountCode = text(args.shift());
        if (!accountCode) return sendReply(ctx, cfg.replyNeedContextAccount);
        const state = await loadState();
        const ctxCodes = state.contextCodesByAccountCode[accountCode] || [];
        const items = ctxCodes.map((code) => state.contextsByCode[code]).filter(Boolean);
        return sendReply(ctx, listRecords(items, (r) => fill(cfg.replyShowContext, { CTX: r.code, ACC: r.accountCode, LABEL: r.label, STATUS: r.status })));
      }

      if (action === actionClose) {
        const contextCode = text(args.shift());
        const state = await loadState();
        const rec = contextFromCode(state, contextCode);
        if (!rec) return sendReply(ctx, cfg.replyContextNotFound);
        rec.status = text(cfg.contextStatusClosed);
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyShowContext, { CTX: rec.code, ACC: rec.accountCode, LABEL: rec.label, STATUS: rec.status }));
      }

      return sendReply(ctx, cfg.replyUnknown);
    }

    if (typeof meta.registerService === 'function') {
      meta.registerService(serviceName, {
        resolveInbound: async (input) => {
          const state = await loadState();
          const chatId = normalizeChatId(input && input.chatId);
          const phone = normalizePhone(input && input.phone);
          const picId = resolvePicId(state, chatId, phone);
          if (!picId) {
            return {
              assigned: 0,
              accountCode: '',
              picId: '',
              contextCode: '',
              status: text(cfg.unassignedLabel),
            };
          }
          const pic = picFromId(state, picId);
          return {
            assigned: 1,
            accountCode: text(pic && pic.accountCode),
            picId,
            contextCode: '',
            status: 'assigned',
          };
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
          if (!id) return { ticketId: '', accountCode: '', picId: '', contextCode: '', workgroupKey: '' };
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
        resolveInboundFromCtx: async (ctx) => {
          const state = await loadState();
          return resolveInbound(state, ctx);
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

    command.register(cmdAccount, async (ctx) => {
      if (!(await hasAccess(ctx))) return sendReply(ctx, cfg.replyNoAccess);
      if (!ctx || !ctx.isGroup) return sendReply(ctx, cfg.replyGroupOnly);
      if (controlGroupId && !inControlGroup(ctx)) return sendReply(ctx, cfg.replyControlGroupOnly);
      return runAccountCommand(ctx);
    });

    command.register(cmdPic, async (ctx) => {
      if (!(await hasAccess(ctx))) return sendReply(ctx, cfg.replyNoAccess);
      if (!ctx || !ctx.isGroup) return sendReply(ctx, cfg.replyGroupOnly);
      if (controlGroupId && !inControlGroup(ctx)) return sendReply(ctx, cfg.replyControlGroupOnly);
      return runPicCommand(ctx);
    });

    command.register(cmdContext, async (ctx) => {
      if (!(await hasAccess(ctx))) return sendReply(ctx, cfg.replyNoAccess);
      if (!ctx || !ctx.isGroup) return sendReply(ctx, cfg.replyGroupOnly);
      if (controlGroupId && !inControlGroup(ctx)) return sendReply(ctx, cfg.replyControlGroupOnly);
      return runContextCommand(ctx);
    });

    if (moduleLog) meta.log('ContactBookCV', 'ready service=' + serviceName + ' prefix=' + prefix);
    if (detailLog) meta.log('ContactBookCV', 'detail store=' + storeNs + '/' + storeKey);
    if (traceLog) meta.log('ContactBookCV', 'trace active');

    return { onMessage: async () => {}, onEvent: async () => {} };
  },
};