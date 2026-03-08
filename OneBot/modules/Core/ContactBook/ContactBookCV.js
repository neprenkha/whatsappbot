'use strict';

function text(v) { return String(v == null ? '' : v).trim(); }
function keyText(v) { return text(v).toLowerCase(); }
function toBool(v, d) {
  const s = keyText(v);
  if (!s) return !!d;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return !!d;
}
function toInt(v, d) { const n = Number.parseInt(text(v), 10); return Number.isFinite(n) ? n : d; }
function fill(tpl, vars) {
  let out = String(tpl || '');
  Object.keys(vars || {}).forEach((k) => { out = out.split('{' + k + '}').join(String(vars[k] == null ? '' : vars[k])); });
  return out;
}
function normalizePrincipal(v) {
  const raw = text(v);
  if (!raw) return '';
  if (raw.indexOf('lid:') === 0) return raw;
  if (raw.indexOf('@') > 0) return raw;
  const digits = raw.replace(/[^0-9]/g, '');
  return digits ? ('lid:' + digits) : raw;
}
function normalizePhone(v) { return text(v).replace(/[^0-9]/g, ''); }
function actorIdFromCtx(ctx) {
  const s = ctx && ctx.sender ? ctx.sender : {};
  return normalizePrincipal(text(s.id) || text(s.phone) || text(s.lid) || text(ctx && ctx.author) || text(ctx && ctx.from));
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
  const q = getQuotedMessage(ctx);
  return text(q.body) || text(q.caption);
}
function getQuotedPrincipal(ctx) {
  const q = getQuotedMessage(ctx);
  return normalizePrincipal(text(q.author) || text(q.from) || text(q.participant) || text(q.id && q.id.participant) || text(q.id && q.id.remote));
}
function getQuotedPhone(ctx) {
  const q = getQuotedMessage(ctx);
  return normalizePhone(text(q.phone) || text(q.author) || text(q.from));
}
function extractTicketId(sourceText, ticketIdRegex) {
  const body = text(sourceText);
  if (!body || !text(ticketIdRegex)) return '';
  try {
    const m = body.match(new RegExp(text(ticketIdRegex), 'i'));
    return m && m[0] ? text(m[0]) : '';
  } catch (_) { return ''; }
}
function roleRank(role) {
  const r = keyText(role);
  if (r === 'owner') return 6;
  if (r === 'admin') return 5;
  if (r === 'manager') return 4;
  if (r === 'sales') return 3;
  if (r === 'staff') return 2;
  if (r === 'viewer') return 1;
  return 0;
}
async function hasRoleAtLeast(access, ctx, minRole) {
  const required = keyText(minRole);
  if (!required) return true;
  if (!access) return false;
  const actorId = actorIdFromCtx(ctx);
  if (!actorId) return false;
  if (typeof access.hasAtLeast === 'function') return !!(await access.hasAtLeast(actorId, required));
  if (typeof access.getRole === 'function') return roleRank(await access.getRole(actorId)) >= roleRank(required);
  if (typeof access.hasRole === 'function') return !!(await access.hasRole(actorId, required));
  if (typeof access.meetsMinRole === 'function') return !!(await access.meetsMinRole(actorId, required));
  return false;
}
function ensureListMap(map, key) { const k = text(key); if (!k) return []; if (!Array.isArray(map[k])) map[k] = []; return map[k]; }
function ensureStateShape(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const s = {
    accountsByCode: b.accountsByCode && typeof b.accountsByCode === 'object' ? b.accountsByCode : {},
    picsById: b.picsById && typeof b.picsById === 'object' ? b.picsById : {},
    contextsByCode: b.contextsByCode && typeof b.contextsByCode === 'object' ? b.contextsByCode : {},
    picIdByChatId: b.picIdByChatId && typeof b.picIdByChatId === 'object' ? b.picIdByChatId : {},
    picIdByPhone: b.picIdByPhone && typeof b.picIdByPhone === 'object' ? b.picIdByPhone : {},
    picIdsByAccountCode: b.picIdsByAccountCode && typeof b.picIdsByAccountCode === 'object' ? b.picIdsByAccountCode : {},
    contextCodesByAccountCode: b.contextCodesByAccountCode && typeof b.contextCodesByAccountCode === 'object' ? b.contextCodesByAccountCode : {},
    ticketContextByTicketId: b.ticketContextByTicketId && typeof b.ticketContextByTicketId === 'object' ? b.ticketContextByTicketId : {},
    seqAcc: Number(b.seqAcc || 0), seqPic: Number(b.seqPic || 0), seqCtx: Number(b.seqCtx || 0),
  };
  if (!Number.isFinite(s.seqAcc) || s.seqAcc < 0) s.seqAcc = 0;
  if (!Number.isFinite(s.seqPic) || s.seqPic < 0) s.seqPic = 0;
  if (!Number.isFinite(s.seqCtx) || s.seqCtx < 0) s.seqCtx = 0;
  return s;
}

module.exports = {
  init: async (meta) => {
    const cfg = meta && meta.implConf ? meta.implConf : {};
    if (!toBool(cfg.enabled, true)) return { onMessage: async () => {}, onEvent: async () => {} };

    const moduleLog = toBool(cfg.moduleLog, true);
    const bugLog = toBool(cfg.bugLog, true);

    const required = [
      'globalConfRel', 'storeNs', 'storeKey', 'ticketIdRegex',
      'accountCodePrefix', 'picCodePrefix', 'contextCodePrefix', 'codeDigits',
      'cmdAccount', 'cmdPic', 'cmdContext',
      'actionNew', 'actionLink', 'actionShow', 'actionList', 'minRoleManage',
      'replyNoAccess', 'replyGroupOnly', 'replyNeedAction', 'replyUnknownAction',
      'replyNeedAccount', 'replyNeedContext', 'replyNeedDisplayName', 'replyNeedLabel', 'replyNeedQuote', 'replyNeedTicket',
      'replyAccountCreated', 'replyAccountLinked', 'replyAccountNotFound', 'replyAccountShow', 'replyAccountListHeader', 'replyAccountListItem',
      'replyPicLinked', 'replyPicListHeader', 'replyPicListItem',
      'replyContextCreated', 'replyContextLinked', 'replyContextListHeader', 'replyContextListItem', 'replyListEmpty',
    ];
    const missing = required.filter((k) => !text(cfg[k]));
    if (missing.length) {
      if (bugLog && meta && typeof meta.log === 'function') meta.log('ContactBookCV', 'safe_disabled missing=' + missing.join(','));
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const command = meta.getService('command');
    const access = meta.getService('access');
    const jsonstore = meta.getService('jsonstore');
    if (!command || typeof command.register !== 'function') return { onMessage: async () => {}, onEvent: async () => {} };
    if (!jsonstore || typeof jsonstore.open !== 'function') return { onMessage: async () => {}, onEvent: async () => {} };

    const loaded = typeof meta.loadConfRel === 'function' ? (meta.loadConfRel(text(cfg.globalConfRel)) || {}) : {};
    const globalConf = loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
    const controlGroupId = text(globalConf.controlGroupId);
    if (!controlGroupId) return { onMessage: async () => {}, onEvent: async () => {} };

    const store = jsonstore.open(text(cfg.storeNs));
    const digits = Math.max(1, toInt(cfg.codeDigits, 4));

    async function sendReply(ctx, message) {
      const out = text(message);
      if (!out) return;
      if (ctx && typeof ctx.reply === 'function') await ctx.reply(out);
    }

    async function loadState() { return ensureStateShape(await store.get(text(cfg.storeKey), {})); }
    async function saveState(state) { await store.set(text(cfg.storeKey), ensureStateShape(state)); }
    function nextCode(prefix, seq) { return text(prefix) + String(seq).padStart(digits, '0'); }
    function extractArgs(ctx) { return ctx && ctx.command && Array.isArray(ctx.command.args) ? ctx.command.args.map((v) => text(v)) : []; }

    async function ensureAllowed(ctx) {
      if (!ctx || !ctx.isGroup) { await sendReply(ctx, cfg.replyGroupOnly); return false; }
      if (text(ctx.chatId) !== controlGroupId) { await sendReply(ctx, cfg.replyGroupOnly); return false; }
      if (!(await hasRoleAtLeast(access, ctx, cfg.minRoleManage))) { await sendReply(ctx, cfg.replyNoAccess); return false; }
      return true;
    }

    function upsertPic(state, accountCode, ctx) {
      const principal = getQuotedPrincipal(ctx);
      const phone = getQuotedPhone(ctx);
      const chatId = text(ctx && ctx.quotedFrom) || text(ctx && ctx.quotedChatId) || principal;
      if (!principal && !phone && !chatId) return { ok: false };

      const byChat = chatId ? text(state.picIdByChatId[chatId]) : '';
      const byPhone = phone ? text(state.picIdByPhone[phone]) : '';
      let picId = byChat || byPhone;
      if (!picId) { state.seqPic += 1; picId = nextCode(cfg.picCodePrefix, state.seqPic); }

      const prev = state.picsById[picId] && typeof state.picsById[picId] === 'object' ? state.picsById[picId] : {};
      const row = {
        picId,
        accountCode: text(accountCode),
        displayName: text(prev.displayName || (ctx && ctx.sender && ctx.sender.name) || ''),
        principal: principal || text(prev.principal),
        phone: phone || text(prev.phone),
        chatId: chatId || text(prev.chatId),
        updatedAt: new Date().toISOString(),
      };
      state.picsById[picId] = row;
      if (row.chatId) state.picIdByChatId[row.chatId] = picId;
      if (row.phone) state.picIdByPhone[row.phone] = picId;
      const ids = ensureListMap(state.picIdsByAccountCode, accountCode);
      if (!ids.includes(picId)) ids.push(picId);
      return { ok: true, picId, row };
    }

    async function onAccount(ctx) {
      if (!(await ensureAllowed(ctx))) return;
      const args = extractArgs(ctx);
      const action = keyText(args[0]);
      if (!action) return sendReply(ctx, cfg.replyNeedAction);

      if (action === keyText(cfg.actionNew)) {
        const displayName = text(args[1]);
        const accountType = text(args[2]);
        if (!displayName) return sendReply(ctx, cfg.replyNeedDisplayName);
        const state = await loadState();
        state.seqAcc += 1;
        const accountCode = nextCode(cfg.accountCodePrefix, state.seqAcc);
        state.accountsByCode[accountCode] = {
          accountCode,
          displayName,
          accountType,
          createdBy: actorIdFromCtx(ctx),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        ensureListMap(state.picIdsByAccountCode, accountCode);
        ensureListMap(state.contextCodesByAccountCode, accountCode);
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyAccountCreated, { ACCOUNT_CODE: accountCode }));
      }

      if (action === keyText(cfg.actionLink)) {
        const accountCode = text(args[1]);
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccount);
        const state = await loadState();
        if (!state.accountsByCode[accountCode]) return sendReply(ctx, cfg.replyAccountNotFound);
        const linked = upsertPic(state, accountCode, ctx);
        if (!linked.ok) return sendReply(ctx, cfg.replyNeedQuote);
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyAccountLinked, { ACCOUNT_CODE: accountCode, PIC_CODE: linked.picId }));
      }

      if (action === keyText(cfg.actionShow)) {
        const accountCode = text(args[1]);
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccount);
        const state = await loadState();
        const account = state.accountsByCode[accountCode];
        if (!account) return sendReply(ctx, cfg.replyAccountNotFound);
        return sendReply(ctx, fill(cfg.replyAccountShow, {
          ACCOUNT_CODE: accountCode,
          DISPLAY_NAME: text(account.displayName),
          ACCOUNT_TYPE: text(account.accountType),
          PIC_COUNT: ensureListMap(state.picIdsByAccountCode, accountCode).length,
          CONTEXT_COUNT: ensureListMap(state.contextCodesByAccountCode, accountCode).length,
        }));
      }

      if (action === keyText(cfg.actionList)) {
        const state = await loadState();
        const codes = Object.keys(state.accountsByCode).sort();
        if (!codes.length) return sendReply(ctx, cfg.replyListEmpty);
        const rows = codes.map((code) => {
          const row = state.accountsByCode[code] || {};
          return fill(cfg.replyAccountListItem, {
            ACCOUNT_CODE: code,
            DISPLAY_NAME: text(row.displayName),
            ACCOUNT_TYPE: text(row.accountType),
          });
        });
        return sendReply(ctx, cfg.replyAccountListHeader + '\n' + rows.join('\n'));
      }

      return sendReply(ctx, cfg.replyUnknownAction);
    }

    async function onPic(ctx) {
      if (!(await ensureAllowed(ctx))) return;
      const args = extractArgs(ctx);
      const action = keyText(args[0]);
      if (!action) return sendReply(ctx, cfg.replyNeedAction);

      if (action === keyText(cfg.actionLink)) {
        const accountCode = text(args[1]);
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccount);
        const state = await loadState();
        if (!state.accountsByCode[accountCode]) return sendReply(ctx, cfg.replyAccountNotFound);
        const linked = upsertPic(state, accountCode, ctx);
        if (!linked.ok) return sendReply(ctx, cfg.replyNeedQuote);
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyPicLinked, {
          ACCOUNT_CODE: accountCode,
          PIC_CODE: linked.picId,
          DISPLAY_NAME: text(linked.row.displayName),
          PHONE: text(linked.row.phone),
          CHAT_ID: text(linked.row.chatId),
        }));
      }

      if (action === keyText(cfg.actionList)) {
        const accountCode = text(args[1]);
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccount);
        const state = await loadState();
        if (!state.accountsByCode[accountCode]) return sendReply(ctx, cfg.replyAccountNotFound);
        const picIds = ensureListMap(state.picIdsByAccountCode, accountCode);
        if (!picIds.length) return sendReply(ctx, cfg.replyListEmpty);
        const rows = picIds.map((id) => {
          const row = state.picsById[id] || {};
          return fill(cfg.replyPicListItem, { PIC_CODE: id, DISPLAY_NAME: text(row.displayName), PHONE: text(row.phone), CHAT_ID: text(row.chatId) });
        });
        return sendReply(ctx, fill(cfg.replyPicListHeader, { ACCOUNT_CODE: accountCode }) + '\n' + rows.join('\n'));
      }

      return sendReply(ctx, cfg.replyUnknownAction);
    }

    async function onContext(ctx) {
      if (!(await ensureAllowed(ctx))) return;
      const args = extractArgs(ctx);
      const action = keyText(args[0]);
      if (!action) return sendReply(ctx, cfg.replyNeedAction);

      if (action === keyText(cfg.actionNew)) {
        const accountCode = text(args[1]);
        const label = text(args.slice(2).join(' '));
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccount);
        if (!label) return sendReply(ctx, cfg.replyNeedLabel);
        const state = await loadState();
        if (!state.accountsByCode[accountCode]) return sendReply(ctx, cfg.replyAccountNotFound);
        state.seqCtx += 1;
        const contextCode = nextCode(cfg.contextCodePrefix, state.seqCtx);
        state.contextsByCode[contextCode] = {
          contextCode,
          accountCode,
          contextLabel: label,
          createdBy: actorIdFromCtx(ctx),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const list = ensureListMap(state.contextCodesByAccountCode, accountCode);
        if (!list.includes(contextCode)) list.push(contextCode);
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyContextCreated, { CONTEXT_CODE: contextCode, ACCOUNT_CODE: accountCode }));
      }

      if (action === keyText(cfg.actionLink)) {
        const contextCode = text(args[1]);
        if (!contextCode) return sendReply(ctx, cfg.replyNeedContext);
        const state = await loadState();
        if (!state.contextsByCode[contextCode]) return sendReply(ctx, cfg.replyNeedContext);
        const ticketId = extractTicketId(getQuotedText(ctx), cfg.ticketIdRegex);
        if (!ticketId) return sendReply(ctx, cfg.replyNeedTicket);
        state.ticketContextByTicketId[ticketId] = contextCode;
        await saveState(state);
        return sendReply(ctx, fill(cfg.replyContextLinked, { CONTEXT_CODE: contextCode }));
      }

      if (action === keyText(cfg.actionList)) {
        const accountCode = text(args[1]);
        if (!accountCode) return sendReply(ctx, cfg.replyNeedAccount);
        const state = await loadState();
        if (!state.accountsByCode[accountCode]) return sendReply(ctx, cfg.replyAccountNotFound);
        const codes = ensureListMap(state.contextCodesByAccountCode, accountCode);
        if (!codes.length) return sendReply(ctx, cfg.replyListEmpty);
        const rows = codes.map((code) => {
          const row = state.contextsByCode[code] || {};
          return fill(cfg.replyContextListItem, { CONTEXT_CODE: code, CONTEXT_LABEL: text(row.contextLabel) });
        });
        return sendReply(ctx, fill(cfg.replyContextListHeader, { ACCOUNT_CODE: accountCode }) + '\n' + rows.join('\n'));
      }

      return sendReply(ctx, cfg.replyUnknownAction);
    }

    command.register(text(cfg.cmdAccount), onAccount);
    command.register(text(cfg.cmdPic), onPic);
    command.register(text(cfg.cmdContext), onContext);

    if (moduleLog && meta && typeof meta.log === 'function') meta.log('ContactBookCV', 'ready phase1');
    return { onMessage: async () => {}, onEvent: async () => {} };
  },
};