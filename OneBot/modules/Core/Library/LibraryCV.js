'use strict';

function text(value) {
  return String(value ?? '').trim();
}

function keyText(value) {
  return text(value).toLowerCase();
}

function toInt(value, fallback) {
  const n = Number.parseInt(text(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function splitCsv(value) {
  return text(value).split(',').map((x) => text(x)).filter(Boolean);
}

function rankItem(item, tokens) {
  const blob = `${keyText(item.name)} ${keyText((item.tags || []).join(' '))}`;
  let score = 0;
  tokens.forEach((t) => {
    if (blob.includes(t)) score += 1;
  });
  return score;
}

function extractTicketId(sourceText, ticketIdRegex) {
  const s = text(sourceText);
  if (!s) return '';
  const m = s.match(new RegExp(text(ticketIdRegex), 'i'));
  return m && m[0] ? text(m[0]) : '';
}

function getQuotedText(ctx) {
  const fromCtx = text(ctx && ctx.quotedText);
  if (fromCtx) return fromCtx;
  const raw = ctx && ctx.raw ? ctx.raw : {};
  const data = raw && raw._data ? raw._data : {};
  const q = data && data.quotedMsg ? data.quotedMsg : {};
  return text(q.body) || text(q.caption);
}

function actorIdFromCtx(ctx) {
  const sender = ctx && ctx.sender ? ctx.sender : {};
  return text(sender.id) || text(sender.phone) || text(sender.lid) || text(ctx && ctx.author) || text(ctx && ctx.from);
}

async function canAccess(access, ctx, roleName) {
  const role = keyText(roleName);
  const actorId = actorIdFromCtx(ctx);
  if (!role || !actorId || !access) return false;

  if (typeof access.hasAtLeast === 'function') {
    return !!(await access.hasAtLeast(actorId, role));
  }

  if (typeof access.getRole === 'function') {
    const roleRank = { viewer: 1, staff: 2, sales: 3, manager: 4, admin: 5, owner: 6 };
    const actorRole = keyText(await access.getRole(actorId));
    return (roleRank[actorRole] || 0) >= (roleRank[role] || 0);
  }

  if (typeof access.hasRole === 'function') {
    return !!(await access.hasRole(actorId, role));
  }

  return false;
}

module.exports = {
  init: async (meta) => {
    const cfg = meta.implConf || {};

    const loaded = typeof meta.loadConfRel === 'function'
      ? (meta.loadConfRel(text(cfg.globalConfRel)) || {})
      : {};
    const globalConf = loaded.conf || {};

    const command = meta.getService('command');
    const access = meta.getService('access');
    const jsonstore = meta.getService('jsonstore');

    if (!command || typeof command.register !== 'function') {
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    if (!jsonstore || typeof jsonstore.open !== 'function') {
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const store = jsonstore.open(text(cfg.storeNs));
    const searchLimit = Math.max(1, toInt(cfg.searchLimit, 5));

    async function staffReply(ctx, message) {
      const out = text(message);
      if (!out) return;
      if (ctx && typeof ctx.reply === 'function') {
        await ctx.reply(out);
        return;
      }
      const send = meta.getService('send');
      const chatId = text(ctx && ctx.chatId);
      if (typeof send === 'function' && chatId) {
        await send(chatId, out, { isAuto: 0, manualReply: 1, bypassRateLimit: 1 });
      }
    }

    async function loadItems() {
      const raw = await store.get(text(cfg.storeKey), { items: [] });
      return Array.isArray(raw.items) ? raw.items : [];
    }

    async function saveItems(items) {
      await store.set(text(cfg.storeKey), { items });
    }

    function render(template, vars) {
      let out = String(template || '');
      Object.keys(vars).forEach((k) => {
        out = out.split(`{${k}}`).join(String(vars[k] ?? ''));
      });
      return out;
    }

    async function onLib(ctx) {
      if (!ctx || !ctx.isGroup) {
        await staffReply(ctx, cfg.replyGroupOnly);
        return;
      }

      const args = (ctx.command && Array.isArray(ctx.command.args)) ? ctx.command.args.map((x) => text(x)) : [];
      const action = keyText(args[0]);
      if (!action) {
        await staffReply(ctx, cfg.replyNeedArgs);
        return;
      }

      if (action === keyText(cfg.actionAdd)) {
        if (!(await canAccess(access, ctx, cfg.minRoleManage))) return staffReply(ctx, cfg.replyNoAccess);
        const id = text(args[1]);
        const name = text(args[2]);
        const tags = splitCsv(args[3]);
        const body = text(args.slice(4).join(' '));
        if (!id) return staffReply(ctx, cfg.replyNeedId);
        if (!name) return staffReply(ctx, cfg.replyNeedName);
        if (!body) return staffReply(ctx, cfg.replyNeedBody);
        const items = await loadItems();
        const index = items.findIndex((x) => keyText(x.id) === keyText(id));
        const next = { id, name, tags, body, updatedAt: new Date().toISOString() };
        if (index >= 0) items[index] = next; else items.push(next);
        await saveItems(items);
        return staffReply(ctx, cfg.replySaved);
      }

      if (action === keyText(cfg.actionDel)) {
        if (!(await canAccess(access, ctx, cfg.minRoleManage))) return staffReply(ctx, cfg.replyNoAccess);
        const id = text(args[1]);
        if (!id) return staffReply(ctx, cfg.replyNeedId);
        const items = await loadItems();
        const next = items.filter((x) => keyText(x.id) !== keyText(id));
        if (next.length === items.length) return staffReply(ctx, cfg.replyNotFound);
        await saveItems(next);
        return staffReply(ctx, cfg.replyDeleted);
      }

      if (action === keyText(cfg.actionSearch)) {
        if (!(await canAccess(access, ctx, cfg.minRoleSearch))) return staffReply(ctx, cfg.replyNoAccess);
        const tokens = keyText(args.slice(1).join(' ')).split(/\s+/).filter(Boolean);
        if (!tokens.length) return staffReply(ctx, cfg.replyNeedArgs);
        const items = await loadItems();
        const ranked = items.map((item) => ({ item, score: rankItem(item, tokens) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score || keyText(a.item.name).localeCompare(keyText(b.item.name)))
          .slice(0, searchLimit);
        if (!ranked.length) return staffReply(ctx, cfg.replySearchEmpty);
        const lines = ranked.map((x) => render(cfg.replySearchLineTemplate, {
          ID: text(x.item.id), NAME: text(x.item.name), TAGS: text((x.item.tags || []).join(',')), SCORE: String(x.score),
        }));
        return staffReply(ctx, `${text(cfg.replySearchHeader)}\n${lines.join('\n')}`);
      }

      if (action === keyText(cfg.actionList)) {
        if (!(await canAccess(access, ctx, cfg.minRoleSearch))) return staffReply(ctx, cfg.replyNoAccess);
        const items = await loadItems();
        if (!items.length) return staffReply(ctx, cfg.replySearchEmpty);
        const lines = items.map((x) => render(cfg.replyListLineTemplate, {
          ID: text(x.id), NAME: text(x.name), TAGS: text((x.tags || []).join(',')),
        }));
        return staffReply(ctx, `${text(cfg.replyListHeader)}\n${lines.join('\n')}`);
      }

      if (action === keyText(cfg.actionShow)) {
        if (!(await canAccess(access, ctx, cfg.minRoleSearch))) return staffReply(ctx, cfg.replyNoAccess);
        const id = text(args[1]);
        if (!id) return staffReply(ctx, cfg.replyNeedId);
        const items = await loadItems();
        const item = items.find((x) => keyText(x.id) === keyText(id));
        if (!item) return staffReply(ctx, cfg.replyNotFound);
        return staffReply(ctx, render(cfg.replyShowTemplate, {
          ID: text(item.id), NAME: text(item.name), TAGS: text((item.tags || []).join(',')), BODY: text(item.body),
        }));
      }

      if (action === keyText(cfg.actionSend)) {
        if (!(await canAccess(access, ctx, cfg.minRoleSend))) return staffReply(ctx, cfg.replyNoAccess);
        const id = text(args[1]);
        if (!id) return staffReply(ctx, cfg.replyNeedId);
        const items = await loadItems();
        const item = items.find((x) => keyText(x.id) === keyText(id));
        if (!item) return staffReply(ctx, cfg.replyNotFound);
        const ticketId = extractTicketId(getQuotedText(ctx), cfg.ticketIdRegex) || extractTicketId(args[2], cfg.ticketIdRegex);
        if (!ticketId) return staffReply(ctx, cfg.replyNeedTicket);
        const fallback = meta.getService('fallback');
        if (!fallback || typeof fallback.sendTicketReplyFromStaff !== 'function') return staffReply(ctx, cfg.replyNeedFallback);
        const result = await fallback.sendTicketReplyFromStaff(ticketId, text(item.body), 'library');
        if (!result || !result.ok) return staffReply(ctx, cfg.replyNotFound);
        return staffReply(ctx, cfg.replySent);
      }

      return staffReply(ctx, cfg.replyUnknownAction);
    }

    command.register(text(cfg.cmdLib), onLib, {
      owner: 'LibraryCV',
      help: cfg.cmdLibHelp,
      minRole: text(cfg.minRoleSearch),
      prefix: text((globalConf && globalConf.prefix) || ''),
    });

    return { onMessage: async () => {}, onEvent: async () => {} };
  },
};