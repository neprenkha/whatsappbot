'use strict';

const FallbackGroupRouterCV = require('./FallbackGroupRouterCV');
const FallbackForwardTextCV = require('./FallbackForwardTextCV');
const FallbackTicketCardCV = require('./FallbackTicketCardCV');
const FallbackQuoteParseCV = require('./FallbackQuoteParseCV');
const FallbackReplyRouterCV = require('./FallbackReplyRouterCV');
const FallbackReplyTextCV = require('./FallbackReplyTextCV');
const FallbackReplyMediaCV = require('./FallbackReplyMediaCV');
const FallbackReplyAVCV = require('./FallbackReplyAVCV');


function text(value) {
  return String(value ?? '').trim();
}

function toBool(value) {
  const s = text(value).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function toInt(value, fallback) {
  const n = Number.parseInt(text(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseTicketRef(spec) {
  const raw = text(spec);
  const parts = raw.split(':');
  if (parts.length < 2) return null;
  const kind = text(parts[0]).toLowerCase();
  const key = text(parts.slice(1).join(':'));
  if (!kind || !key) return null;
  return { kind, key };
}

function nowPeriodUTC() {
  const d = new Date();
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${yy}${mm}`;
}

function parseEpochMs(value, fallbackMs) {
  const raw = text(value);
  if (!raw) return fallbackMs;
  const n = Date.parse(raw);
  return Number.isFinite(n) ? n : fallbackMs;
}

function buildCustomerLabel(ctx) {
  return text(
    (ctx && (ctx.pushName || ctx.senderName || ctx.authorName)) ||
    (ctx && ctx.chatId) ||
    ''
  );
}

function messageTextFromCtx(ctx) {
  return text(
    (ctx && ctx.text) ||
    (ctx && ctx.message && (ctx.message.body || ctx.message.caption)) ||
    (ctx && ctx.raw && ctx.raw._data && (ctx.raw._data.body || ctx.raw._data.caption)) ||
    ''
  );
}

async function canAccess(access, ctx, roleName) {
  const role = text(roleName);
  if (!role || !access) return false;
  if (typeof access.hasRole === 'function') return !!(await access.hasRole(ctx, role));
  if (typeof access.isAllowed === 'function') return !!(await access.isAllowed(ctx, role));
  if (typeof access.check === 'function') return !!(await access.check(ctx, role));
  if (typeof access.meetsMinRole === 'function') return !!(await access.meetsMinRole(ctx, role));
  return false;
}

module.exports = {
  init: async (meta) => {
    const tag = 'FallbackCV';
    const cfg = meta && meta.implConf ? meta.implConf : {};

    const required = [
      'enabled',
      'globalConfRel',
      'ticketStoreSpec',
      'ticketSeqKey',
      'msgBufferMax',
      'burstMs',
      'ticketStatusOpen',
      'ticketStatusClosed',
      'ticketIdRegex',
      'defaultGroupKey',
      'forwardTextPrefixTemplate',
      'forwardTextMaxLen',
      'inboundAckTemplate',
      'ticketCardTemplate',
      'cmdReply',
      'minRoleTicketReply',
      'replyNoAccess',
      'replyGroupOnly',
      'replyNeedTicket',
      'replyNeedText',
      'replyTicketNotFound',
      'replyTicketClosed',
      'replyReplySent',
      'replyMediaSendPrefer',
      'replyMediaMaxTries',
      'replyMediaRetryBaseMs',
      'replyMediaRetryJitterMs',
      'replyMediaGapMs',
      'replyMediaDownloadTimeoutMs',
      'replyAudioAsVoice',
      'replyVideoAsDocument',
      'moduleLog',
      'bugLog',
      'detailLog',
      'traceLog',
    ];

    const missing = required.filter((k) => !text(cfg[k]));
    const bugLog = toBool(cfg.bugLog);

    if (missing.length) {
      if (bugLog) meta.log(tag, `disabled missing_keys=${missing.join(',')}`);
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    if (!toBool(cfg.enabled)) {
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    if (text(cfg.inboundAckTemplate).includes('{TICKETID}')) {
      if (bugLog) meta.log(tag, 'disabled inboundAckTemplate_must_not_include_ticketid');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const loadedGlobal = typeof meta.loadConfRel === 'function'
      ? (meta.loadConfRel(text(cfg.globalConfRel)) || {})
      : {};
    const globalConf = loadedGlobal && loadedGlobal.conf && typeof loadedGlobal.conf === 'object'
      ? loadedGlobal.conf
      : (loadedGlobal && typeof loadedGlobal === 'object' ? loadedGlobal : {});

    const ticketRef = parseTicketRef(cfg.ticketStoreSpec);
    if (!ticketRef || ticketRef.kind !== 'jsonstore') {
      if (bugLog) meta.log(tag, 'disabled invalid_ticketStoreSpec');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const jsonstore = meta.getService('jsonstore');
    const serviceName = String(globalConf.sendPrefer || '')
      .split(',')
      .map((x) => text(x))
      .filter(Boolean)[0] || '';
    const send = serviceName ? meta.getService(serviceName) : null;
    const access = meta.getService('access');

    if (!jsonstore || typeof jsonstore.open !== 'function') {
      if (bugLog) meta.log(tag, 'disabled missing_jsonstore_service');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    if (!serviceName || typeof send !== 'function') {
      if (bugLog) meta.log(tag, 'disabled missing_send_service');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const store = jsonstore.open('core');
    const ticketCard = await FallbackTicketCardCV.init(meta, cfg);

    const burstMs = Math.max(1, toInt(cfg.burstMs, 1200));
    const msgBufferMax = Math.max(1, toInt(cfg.msgBufferMax, 20));
    const tickMs = Math.max(1000, toInt(cfg.tickMs, burstMs));
    const batchMax = Math.max(1, toInt(cfg.batchMax, msgBufferMax));
    const maxAttempts = Math.max(1, toInt(cfg.maxAttempts, 1));
    const retryDelayMs = Math.max(0, toInt(cfg.retryDelayMs, tickMs));

    const burstState = new Map();
    const reminderState = new Map();

    async function loadTicketState() {
      const raw = await store.get(ticketRef.key, { tickets: [] });
      return Array.isArray(raw.tickets) ? raw.tickets : [];
    }

    async function saveTicketState(tickets) {
      await store.set(ticketRef.key, { tickets });
    }

    async function nextTicketId() {
      const period = nowPeriodUTC();
      const seqRaw = await store.get(text(cfg.ticketSeqKey), { period: '', value: 0 });
      const current = text(seqRaw.period) === period ? Number(seqRaw.value || 0) : 0;
      const next = current + 1;
      await store.set(text(cfg.ticketSeqKey), { period, value: next });
      const seqDigits = 7;
      return `${period}T${String(next).padStart(seqDigits, '0')}`;
    }

    function resolveTargetGroup(ctx) {
      return FallbackGroupRouterCV.resolveTargetGroup(meta, cfg, globalConf, ctx);
    }

    function scheduleBurstFlush(chatId, ticketId) {
      const key = `${chatId}::${ticketId}`;
      const current = burstState.get(key);
      if (!current) return;

      if (current.timer) clearTimeout(current.timer);

      current.timer = setTimeout(async () => {
        try {
          const entry = burstState.get(key);
          if (!entry) return;
          burstState.delete(key);

          const targetChat = resolveTargetGroup(entry.ctx);
          if (!targetChat) {
            if (bugLog) meta.log(tag, `bug burst_no_group ticketId=${entry.ticketId} chatId=${entry.chatId}`);
            return;
          }

          const ticketRows = await loadTicketState();
          const ticketRow = ticketRows.find((x) => text(x.ticketId) === text(entry.ticketId));
          const quickReplies = ticketRow && ticketRow.quickReplies && typeof ticketRow.quickReplies === 'object'
            ? ticketRow.quickReplies
            : {};

          const cardText = await ticketCard.render({
            ticketId: entry.ticketId,
            customerChatId: entry.chatId,
            customerName: entry.customerName,
            status: entry.status,
            time: new Date(entry.lastAt).toISOString(),
            messageCount: entry.messages.length,
            lastText: entry.messages[entry.messages.length - 1] || '',
            qr1: text(quickReplies['1']),
            qr2: text(quickReplies['2']),
            qr3: text(quickReplies['3']),
          });

          const consolidated = FallbackForwardTextCV.renderBatch(meta, cfg, {
            ticketId: entry.ticketId,
            customerName: entry.customerName,
            customerChatId: entry.chatId,
            messages: entry.messages,
          });

          await send(targetChat, cardText, { isAuto: 0 });
          if (consolidated) {
            await send(targetChat, consolidated, { isAuto: 0 });
          }
        } catch (e) {
          if (bugLog) meta.log(tag, `bug burst_flush err=${text(e && e.message ? e.message : e)}`);
        }
      }, burstMs);

      burstState.set(key, current);
    }

    async function onDmMessage(ctx) {
      if (!ctx || ctx.isGroup) return;

      const chatId = text(ctx.chatId);
      if (!chatId) return;

      const body = messageTextFromCtx(ctx);
      if (!body) return;

      const tickets = await loadTicketState();

      let ticket = tickets.find((x) => text(x.customerChatId) === chatId && text(x.status) !== text(cfg.ticketStatusClosed));
      if (!ticket) {
        const ticketId = await nextTicketId();
        ticket = {
          ticketId,
          customerChatId: chatId,
          status: text(cfg.ticketStatusOpen),
          groupKey: text(cfg.defaultGroupKey),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        tickets.push(ticket);
      } else {
        ticket.updatedAt = new Date().toISOString();
      }

      await saveTicketState(tickets);

      const burstKey = `${chatId}::${ticket.ticketId}`;
      const current = burstState.get(burstKey) || {
        ticketId: ticket.ticketId,
        chatId,
        customerName: buildCustomerLabel(ctx),
        status: text(ticket.status),
        messages: [],
        lastAt: Date.now(),
        ctx,
        timer: null,
      };

      current.customerName = buildCustomerLabel(ctx);
      current.status = text(ticket.status);
      current.lastAt = Date.now();
      current.ctx = ctx;
      current.messages.push(body);
      if (current.messages.length > msgBufferMax) {
        current.messages = current.messages.slice(current.messages.length - msgBufferMax);
      }

      burstState.set(burstKey, current);
      scheduleBurstFlush(chatId, ticket.ticketId);

      await send(chatId, text(cfg.inboundAckTemplate), { isAuto: 0 });
      if (typeof ctx.stopPropagation === 'function') ctx.stopPropagation();
    }


    async function runReminderCycle() {
      try {
        const tickets = await loadTicketState();
        const openDmTickets = tickets.filter((x) => {
          const statusOpen = text(x && x.status) === text(cfg.ticketStatusOpen);
          const chatId = text(x && x.customerChatId);
          const isDm = !!chatId && chatId.indexOf('@g.us') < 0;
          return statusOpen && isDm;
        });

        openDmTickets.sort((a, b) => {
          const ta = parseEpochMs(a && (a.updatedAt || a.createdAt), 0);
          const tb = parseEpochMs(b && (b.updatedAt || b.createdAt), 0);
          return ta - tb;
        });

        const cycleSent = new Set();
        let sentCount = 0;

        for (let i = 0; i < openDmTickets.length; i += 1) {
          if (sentCount >= batchMax) break;

          const ticket = openDmTickets[i] || {};
          const ticketId = text(ticket.ticketId);
          if (!ticketId || cycleSent.has(ticketId)) continue;

          const lastInboundAtMs = parseEpochMs(ticket.updatedAt || ticket.createdAt, 0);
          const current = reminderState.get(ticketId) || {
            attempt: 0,
            nextAtMs: lastInboundAtMs + tickMs,
            lastInboundAtMs,
          };

          if (lastInboundAtMs > Number(current.lastInboundAtMs || 0)) {
            current.attempt = 0;
            current.nextAtMs = lastInboundAtMs + tickMs;
            current.lastInboundAtMs = lastInboundAtMs;
          }

          if (Date.now() < Number(current.nextAtMs || 0)) {
            reminderState.set(ticketId, current);
            continue;
          }

          const targetChat = resolveTargetGroup({
            chatId: text(ticket.customerChatId),
            isGroup: false,
          });
          if (!targetChat) {
            if (bugLog) meta.log(tag, `bug remind_no_group ticketId=${ticketId}`);
            continue;
          }

          const quickReplies = ticket && ticket.quickReplies && typeof ticket.quickReplies === 'object'
            ? ticket.quickReplies
            : {};

          const cardText = await ticketCard.render({
            ticketId: ticketId,
            customerChatId: text(ticket.customerChatId),
            customerName: text(ticket.customerName || ticket.customerChatId),
            status: text(ticket.status),
            time: new Date(lastInboundAtMs || Date.now()).toISOString(),
            messageCount: 0,
            lastText: '',
            qr1: text(quickReplies['1']),
            qr2: text(quickReplies['2']),
            qr3: text(quickReplies['3']),
          });

          await send(targetChat, cardText, {
            isAuto: 1,
            manualReply: 0,
            lastInboundAtMs,
          });

          cycleSent.add(ticketId);
          sentCount += 1;

          if (current.attempt + 1 >= maxAttempts) {
            current.attempt = maxAttempts;
            current.nextAtMs = Number.MAX_SAFE_INTEGER;
          } else {
            current.attempt += 1;
            current.nextAtMs = Date.now() + retryDelayMs;
          }

          current.lastInboundAtMs = lastInboundAtMs;
          reminderState.set(ticketId, current);
        }
      } catch (e) {
        if (bugLog) meta.log(tag, `bug reminder_cycle err=${text(e && e.message ? e.message : e)}`);
      }
    }

    const reminderTimer = setInterval(() => {
      runReminderCycle().catch(() => {});
    }, tickMs);

    const replyRouter = FallbackReplyRouterCV.create({
      cfg,
      parseQuote: FallbackQuoteParseCV.parse,
      sendReplyText: async ({ ticketId, body, source }) => {
        return FallbackReplyTextCV.sendToCustomer({
          cfg,
          meta,
          store,
          ticketStoreKey: ticketRef.key,
          ticketId,
          body,
          source,
        });
      },
      sendReplyMedia: async ({ ticketId, staffMsg, captionText, source, options }) => {
        return FallbackReplyMediaCV.sendToCustomer({
          cfg,
          meta,
          store,
          ticketStoreKey: ticketRef.key,
          ticketId,
          staffMsg,
          captionText,
          source,
          options,
        });
      },
      sendReplyAV: async ({ ticketId, staffMsg, captionText, source, options }) => {
        return FallbackReplyAVCV.sendToCustomer({
          cfg,
          meta,
          store,
          ticketStoreKey: ticketRef.key,
          ticketId,
          staffMsg,
          captionText,
          source,
          options,
        });
      },
      canReply: async (ctx) => canAccess(access, ctx, cfg.minRoleTicketReply),
      sendStaffReply: async (ctx, message) => {
        if (ctx && typeof ctx.reply === 'function') {
          await ctx.reply(text(message));
          return;
        }
        const chatId = text(ctx && ctx.chatId);
        if (!chatId) return;
        await send(chatId, text(message), { isAuto: 0, manualReply: 1, bypassRateLimit: 1 });
      },
      bugLog: bugLog,
      log: (line) => meta.log(tag, line),
    });

    if (typeof meta.registerService === 'function') {
      meta.registerService('fallback', {
        sendTicketReplyFromStaff: async (ticketId, body, source) => {
          return FallbackReplyTextCV.sendToCustomer({
            cfg,
            meta,
            store,
            ticketStoreKey: ticketRef.key,
            ticketId,
            body,
            source,
          });
        },
      });
    }

    return {
      onMessage: async (ctx) => {
        await onDmMessage(ctx);
        await replyRouter.onGroupMessage(ctx);
      },
      onEvent: async () => {},
      shutdown: async () => {
        clearInterval(reminderTimer);
      },
    };
  },
};