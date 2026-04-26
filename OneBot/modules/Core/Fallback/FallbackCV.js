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

function messageObjFromCtx(ctx) {
  return ctx && ctx.message ? ctx.message : null;
}

function rawDataFromCtx(ctx) {
  const raw = ctx && ctx.raw ? ctx.raw : null;
  const rawData = raw && raw._data && typeof raw._data === 'object' ? raw._data : {};
  return rawData;
}

function buildCustomerLabel(ctx) {
  return text(
    (ctx && (ctx.pushName || ctx.senderName || ctx.authorName)) ||
    (ctx && ctx.chatId) ||
    ''
  );
}

function bodyTextFromCtx(ctx) {
  return text(
    (ctx && ctx.text) ||
    (ctx && ctx.message && ctx.message.body) ||
    rawDataFromCtx(ctx).body ||
    ''
  );
}

function captionTextFromCtx(ctx) {
  return text(
    (ctx && ctx.message && ctx.message.caption) ||
    rawDataFromCtx(ctx).caption ||
    ''
  );
}

function mediaFileNameFromCtx(ctx) {
  const msg = messageObjFromCtx(ctx);
  const rawData = rawDataFromCtx(ctx);
  return text(
    (msg && (msg.filename || (msg._data && msg._data.filename))) ||
    rawData.filename ||
    ''
  );
}

function mediaMimeTypeFromCtx(ctx) {
  const msg = messageObjFromCtx(ctx);
  const rawData = rawDataFromCtx(ctx);
  return text(
    (msg && (msg.mimetype || (msg._data && msg._data.mimetype))) ||
    rawData.mimetype ||
    ''
  );
}

function normalizeMediaKind(kind) {
  const v = text(kind).toLowerCase();
  if (v === 'image' || v === 'document' || v === 'audio' || v === 'video' || v === 'ptt') return v;
  return '';
}

function inferMediaKindFromMimeAndName(mimeType, fileName, isPtt) {
  const mime = text(mimeType).toLowerCase();
  const name = text(fileName);
  if (isPtt) return 'ptt';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime || name) return 'document';
  return '';
}

function hasMediaMarkersFromCtx(ctx) {
  const msg = messageObjFromCtx(ctx);
  const rawData = rawDataFromCtx(ctx);
  const directKind = normalizeMediaKind(
    (msg && (msg.type || (msg._data && msg._data.type))) ||
    rawData.type ||
    rawData.mediaKeyType
  );
  if (directKind) return true;
  if (msg && msg.hasMedia) return true;
  if (msg && (msg.ptt || (msg._data && msg._data.ptt))) return true;
  if (rawData.ptt) return true;
  if (mediaMimeTypeFromCtx(ctx)) return true;
  if (mediaFileNameFromCtx(ctx)) return true;
  if (rawData.mediaKey || rawData.directPath || rawData.clientUrl || rawData.isMedia) return true;
  return false;
}

function inferMediaKindFromCtx(ctx) {
  const msg = messageObjFromCtx(ctx);
  const rawData = rawDataFromCtx(ctx);
  const directKind = normalizeMediaKind(
    (msg && (msg.type || (msg._data && msg._data.type))) ||
    rawData.type ||
    rawData.mediaKeyType
  );
  if (directKind) return directKind;

  const isPtt = !!(
    (msg && (msg.ptt || (msg._data && msg._data.ptt))) ||
    rawData.ptt
  );

  return inferMediaKindFromMimeAndName(mediaMimeTypeFromCtx(ctx), mediaFileNameFromCtx(ctx), isPtt);
}

function inferMediaKindFromDownloadedMedia(ctx, mediaObj, fallbackKind) {
  const preferred = normalizeMediaKind(fallbackKind);
  if (preferred) return preferred;
  const msg = messageObjFromCtx(ctx);
  const rawData = rawDataFromCtx(ctx);
  const isPtt = !!(
    (msg && (msg.ptt || (msg._data && msg._data.ptt))) ||
    rawData.ptt
  );
  const inferred = inferMediaKindFromMimeAndName(
    text(mediaObj && mediaObj.mimetype) || mediaMimeTypeFromCtx(ctx),
    text(mediaObj && mediaObj.filename) || mediaFileNameFromCtx(ctx),
    isPtt
  );
  if (inferred) return inferred;
  return mediaObj ? 'document' : '';
}

function canDownloadMedia(ctx) {
  const msg = messageObjFromCtx(ctx);
  return !!(msg && typeof msg.downloadMedia === 'function' && hasMediaMarkersFromCtx(ctx));
}

function idFromCtx(ctx) {
  return text(
    (ctx && (ctx.senderId || ctx.author || ctx.from)) ||
    (ctx && ctx.raw && (ctx.raw.participant || ctx.raw.author || ctx.raw.from)) ||
    ''
  );
}

function isStatusBroadcastCtx(ctx) {
  const chatId = text(ctx && ctx.chatId).toLowerCase();
  const senderId = idFromCtx(ctx).toLowerCase();
  return chatId === 'status@broadcast' || senderId === 'status@broadcast';
}

function isInternalIdentityCtx(ctx) {
  const chatId = text(ctx && ctx.chatId).toLowerCase();
  const senderId = idFromCtx(ctx).toLowerCase();
  if (chatId.endsWith('@lid')) return true;
  if (senderId.endsWith('@lid')) return true;
  return false;
}

function isFromMeCtx(ctx) {
  const msg = messageObjFromCtx(ctx);
  const raw = ctx && ctx.raw ? ctx.raw : null;
  const rawData = rawDataFromCtx(ctx);
  return !!(
    (msg && (msg.fromMe || (msg.id && msg.id.fromMe))) ||
    (raw && (raw.fromMe || (raw.id && raw.id.fromMe))) ||
    rawData.fromMe
  );
}

function isInternalOpsCtx(ctx, globalConf) {
  const controlGroupId = text(globalConf && globalConf.controlGroupId).toLowerCase();
  if (!controlGroupId) return false;
  const chatId = text(ctx && ctx.chatId).toLowerCase();
  const senderId = idFromCtx(ctx).toLowerCase();
  return chatId === controlGroupId || senderId === controlGroupId;
}

function isCustomerDmCtx(ctx, globalConf) {
  if (!ctx || ctx.isGroup) return false;
  if (isFromMeCtx(ctx)) return false;
  if (isStatusBroadcastCtx(ctx)) return false;
  if (isInternalIdentityCtx(ctx)) return false;
  if (isInternalOpsCtx(ctx, globalConf)) return false;
  const chatId = text(ctx.chatId).toLowerCase();
  return chatId.endsWith('@c.us') || chatId.endsWith('@s.whatsapp.net');
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

function buildInboundMediaOptions(cfg, kind, captionText, lastInboundAtMs) {
  const mediaKind = text(kind).toLowerCase();
  const caption = text(captionText);
  const options = {
    isAuto: 1,
    manualReply: 0,
    lastInboundAtMs: Number(lastInboundAtMs || 0),
  };

  if (mediaKind === 'document') options.sendMediaAsDocument = true;
  if (mediaKind === 'ptt') options.sendAudioAsVoice = true;
  if (mediaKind === 'audio' && toBool(cfg && cfg.replyAudioAsVoice)) options.sendAudioAsVoice = true;
  if (mediaKind === 'video' && toBool(cfg && cfg.replyVideoAsDocument)) options.sendMediaAsDocument = true;
  if (caption && mediaKind !== 'ptt') options.caption = caption;

  return options;
}

function buildInboundDisplayText(kind, captionText, fileName, bodyText) {
  const mediaKind = text(kind).toLowerCase();
  const caption = text(captionText);
  const name = text(fileName);
  const body = text(bodyText);
  if (caption) return caption;
  if (name) return name;
  if (body) return body;
  if (mediaKind === 'document') return '[document]';
  if (mediaKind === 'image') return '[image]';
  if (mediaKind === 'video') return '[video]';
  if (mediaKind === 'audio') return '[audio]';
  if (mediaKind === 'ptt') return '[voice]';
  return '[media]';
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

    const missing = required.filter((k) => {
      const v = cfg[k];
      if (v === undefined || v === null) return true;
      if (typeof v === 'string' && v.trim() === '') return true;
      return false;
    });
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
    const preferredSendService = String(globalConf.sendPrefer || '')
      .split(',')
      .map((x) => text(x))
      .filter(Boolean)[0] || '';
    const sendSvc = meta.getService('send') || (preferredSendService ? meta.getService(preferredSendService) : null);
    const access = meta.getService('access');

    if (!jsonstore || typeof jsonstore.open !== 'function') {
      if (bugLog) meta.log(tag, 'disabled missing_jsonstore_service');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    let sendFn = null;
    if (typeof sendSvc === 'function') {
      sendFn = async (chatId, payload, options) => await sendSvc(chatId, payload, options || {});
    } else if (sendSvc && typeof sendSvc.send === 'function') {
      sendFn = async (chatId, payload, options) => await sendSvc.send(chatId, payload, options || {});
    }

    if (!sendFn) {
      if (bugLog) meta.log(tag, 'disabled missing_send_service');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const store = jsonstore.open('core');
    const ticketCard = await FallbackTicketCardCV.init(meta, cfg);

    const burstMs = Math.max(1, toInt(cfg.burstMs, 1200));
    const msgBufferMax = Math.max(1, toInt(cfg.msgBufferMax, 20));
    const tickMs = Math.max(1000, toInt(cfg.tickMs, 60000));
    const batchMax = Math.max(1, toInt(cfg.batchMax, 5));
    const maxAttempts = Math.max(1, toInt(cfg.maxAttempts, 3));
    const retryDelayMs = Math.max(1000, toInt(cfg.retryDelayMs, 300000));
    const reminderAfterMs = Math.max(1000, toInt(cfg.reminderAfterMs, 600000));
    const escalationAfterMs = Math.max(reminderAfterMs, toInt(cfg.escalationAfterMs, 1800000));
    const reminderTemplate = text(cfg.reminderTemplate);
    const escalationTemplate = text(cfg.escalationTemplate);

    const burstState = new Map();
    let antiMissRunning = false;

    function fill(tpl, vars) {
      let out = String(tpl || '');
      Object.keys(vars || {}).forEach((k) => {
        out = out.split(`{${k}}`).join(String(vars[k] == null ? '' : vars[k]));
      });
      return out;
    }

    function asMs(v) {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }

    function isOpenAwaitingTicket(ticket) {
      if (!ticket || typeof ticket !== 'object') return false;
      const status = text(ticket.status).toLowerCase();
      const openStatus = text(cfg.ticketStatusOpen).toLowerCase();
      const closedStatus = text(cfg.ticketStatusClosed).toLowerCase();
      if (!status) return false;
      if (closedStatus && status === closedStatus) return false;
      if (openStatus && status !== openStatus) return false;
      if (!text(ticket.customerChatId)) return false;
      if (!toBool(ticket.awaitingStaff)) return false;
      return true;
    }

    function detectStage(ticket, nowMs) {
      const lastInboundAt = asMs(ticket && ticket.lastInboundAt);
      if (!lastInboundAt) return '';
      const ageMs = nowMs - lastInboundAt;
      if (ageMs < reminderAfterMs) return '';
      if (ageMs >= escalationAfterMs) return 'escalation';
      return 'reminder';
    }

    function canSendStage(ticket, stage, nowMs) {
      const sentAtKey = stage === 'escalation' ? 'escalationSentAt' : 'reminderSentAt';
      const countKey = stage === 'escalation' ? 'escalationCount' : 'reminderCount';
      const nextAtKey = stage === 'escalation' ? 'escalationNextAt' : 'reminderNextAt';

      const sentAt = asMs(ticket && ticket[sentAtKey]);
      const nextAt = asMs(ticket && ticket[nextAtKey]);
      const count = Math.max(0, toInt(ticket && ticket[countKey], 0));

      if (count >= maxAttempts) return false;
      if (nextAt > 0 && nowMs < nextAt) return false;
      if (sentAt > 0 && nowMs - sentAt < retryDelayMs) return false;
      return true;
    }

    async function runAntiMissTick() {
      if (antiMissRunning) return;
      antiMissRunning = true;
      try {
        const tickets = await loadTicketState();
        if (!Array.isArray(tickets) || !tickets.length) return;

        const nowMs = Date.now();
        let changed = false;
        let sentCount = 0;

        for (const ticket of tickets) {
          if (sentCount >= batchMax) break;
          if (!isOpenAwaitingTicket(ticket)) continue;

          const stage = detectStage(ticket, nowMs);
          if (!stage) continue;
          if (!canSendStage(ticket, stage, nowMs)) continue;

          const targetChatId = await resolveTargetGroup(
            text(ticket.groupKey || cfg.defaultGroupKey),
            { isGroup: 0, chatId: text(ticket.customerChatId) }
          );
          if (!targetChatId) continue;

          const tpl = stage === 'escalation' ? escalationTemplate : reminderTemplate;
          if (!tpl) continue;

          const payload = fill(tpl, {
            TICKETID: text(ticket.ticketId),
            CHATID: text(ticket.customerChatId),
            STATUS: text(ticket.status),
            LASTINBOUNDAT: String(asMs(ticket.lastInboundAt)),
            LASTSTAFFREPLYAT: String(asMs(ticket.lastStaffReplyAt)),
          });
          if (!payload) continue;

          await sendFn(targetChatId, payload, {
            isAuto: 1,
            manualReply: 0,
            lastInboundAtMs: asMs(ticket.lastInboundAt),
          });

          const sentAtKey = stage === 'escalation' ? 'escalationSentAt' : 'reminderSentAt';
          const countKey = stage === 'escalation' ? 'escalationCount' : 'reminderCount';
          const nextAtKey = stage === 'escalation' ? 'escalationNextAt' : 'reminderNextAt';
          ticket[sentAtKey] = nowMs;
          ticket[countKey] = Math.max(0, toInt(ticket[countKey], 0)) + 1;
          ticket[nextAtKey] = nowMs + retryDelayMs;
          ticket.updatedAt = new Date(nowMs).toISOString();

          changed = true;
          sentCount += 1;
        }

        if (changed) await saveTicketState(tickets);
      } catch (e) {
        if (bugLog) meta.log(tag, `bug anti_miss_tick err=${text(e && e.message ? e.message : e)}`);
      } finally {
        antiMissRunning = false;
      }
    }

    async function loadTicketState() {
      const raw = await store.get(ticketRef.key, { tickets: [] });
      return Array.isArray(raw.tickets) ? raw.tickets : [];
    }

    async function saveTicketState(tickets) {
      await store.set(ticketRef.key, { tickets });
    }

    async function loadBindMap() {
      const key = text(cfg.bindMapStoreKey);
      if (!key) return {};
      const raw = await store.get(key, {});
      return raw && typeof raw === 'object' ? raw : {};
    }

    async function saveBindMap(map) {
      const key = text(cfg.bindMapStoreKey);
      if (!key) return;
      await store.set(key, map && typeof map === 'object' ? map : {});
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

    async function resolveWorkgroupChatId(workgroupKey, ctx) {
      const key = text(workgroupKey);
      if (!key) return '';
      const workgroups = meta.getService('workgroups');
      if (workgroups && typeof workgroups.resolve === 'function') {
        const r = await workgroups.resolve(key, ctx);
        return text((r && (r.groupChatId || r.chatId || r.id)) || r);
      }
      return '';
    }

    async function resolveTargetGroup(workgroupKey, ctx) {
      const fromWorkgroups = await resolveWorkgroupChatId(workgroupKey, ctx);
      if (fromWorkgroups) return fromWorkgroups;
      const fallback = await FallbackGroupRouterCV.resolveTargetGroup(meta, cfg, globalConf, ctx);
      return text(fallback);
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

          const ticketRows = await loadTicketState();
          const ticketRow = ticketRows.find((x) => text(x.ticketId) === text(entry.ticketId));
          const intendedKey = text(entry.groupKey) || text(ticketRow && ticketRow.groupKey) || text(cfg.defaultGroupKey);
          const targetChat = await resolveTargetGroup(intendedKey, entry.ctx);
          if (!targetChat) {
            if (bugLog) meta.log(tag, `bug burst_no_group ticketId=${entry.ticketId} chatId=${entry.chatId}`);
            return;
          }
          const quickReplies = ticketRow && ticketRow.quickReplies && typeof ticketRow.quickReplies === 'object'
            ? ticketRow.quickReplies
            : {};

          let cardText = '';
          try {
            cardText = await ticketCard.render({
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
          } catch (e) {
            if (bugLog) meta.log(tag, `bug ticket_card_render_failed ticketId=${entry.ticketId} err=${text(e && e.message ? e.message : e)}`);
          }

          const consolidated = FallbackForwardTextCV.renderBatch(meta, cfg, {
            ticketId: entry.ticketId,
            customerName: entry.customerName,
            customerChatId: entry.chatId,
            messages: entry.messages,
          });

          const lastInboundAtMs = Number(entry.lastAt || (ticketRow && ticketRow.lastInboundAt) || 0);
          if (cardText) {
            await sendFn(targetChat, cardText, { isAuto: 1, manualReply: 0, lastInboundAtMs });
          }
          if (consolidated) {
            await sendFn(targetChat, consolidated, { isAuto: 1, manualReply: 0, lastInboundAtMs });
          }
        } catch (e) {
          if (bugLog) meta.log(tag, `bug burst_flush err=${text(e && e.message ? e.message : e)}`);
        }
      }, burstMs);

      burstState.set(key, current);
    }

    async function onDmMessage(ctx) {
      if (!ctx || ctx.isGroup) return;

      if (!isCustomerDmCtx(ctx, globalConf)) {
        if (bugLog && (isFromMeCtx(ctx) || isStatusBroadcastCtx(ctx) || isInternalIdentityCtx(ctx) || isInternalOpsCtx(ctx, globalConf))) {
          meta.log(tag, `drop inbound_non_customer chatId=${text(ctx.chatId)} senderId=${idFromCtx(ctx)}`);
        }
        return;
      }

      const chatId = text(ctx.chatId);
      if (!chatId) return;

      const bodyText = bodyTextFromCtx(ctx);
      const captionText = captionTextFromCtx(ctx);
      let mediaObj = null;
      let inboundMediaKind = inferMediaKindFromCtx(ctx);
      const shouldTryDownload = canDownloadMedia(ctx);
      if (shouldTryDownload) {
        try {
          mediaObj = await ctx.message.downloadMedia();
        } catch (e) {
          mediaObj = null;
          if (bugLog) meta.log(tag, `bug inbound_media_download_failed chatId=${chatId} err=${text(e && e.message ? e.message : e)}`);
        }
      }

      if (mediaObj) {
        inboundMediaKind = inferMediaKindFromDownloadedMedia(ctx, mediaObj, inboundMediaKind);
      }

      const hasInboundMedia = !!mediaObj;
      if (hasInboundMedia && !inboundMediaKind) inboundMediaKind = 'document';
      if (!bodyText && !captionText && !hasInboundMedia) return;

      const tickets = await loadTicketState();

      let ticket = tickets.find((x) => text(x.customerChatId) === chatId && text(x.status) !== text(cfg.ticketStatusClosed));
      let groupKey = '';
      if (!ticket) {
        const inboundAt = Date.now();
        const ticketId = await nextTicketId();
        ticket = {
          ticketId,
          customerChatId: chatId,
          status: text(cfg.ticketStatusOpen),
          groupKey: text(cfg.defaultGroupKey),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastInboundAt: inboundAt,
          awaitingStaff: 1,
        };
        tickets.push(ticket);
        groupKey = text(ticket.groupKey || cfg.defaultGroupKey);
      } else {
        const inboundAt = Date.now();
        ticket.updatedAt = new Date().toISOString();
        ticket.lastInboundAt = inboundAt;
        ticket.awaitingStaff = 1;
        groupKey = text(ticket.groupKey || cfg.defaultGroupKey);
        if (!text(ticket.groupKey)) {
          ticket.groupKey = groupKey;
        }
      }

      if (!groupKey) {
        groupKey = text(cfg.defaultGroupKey);
        if (ticket) ticket.groupKey = groupKey;
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
        groupKey,
        timer: null,
      };

      current.customerName = buildCustomerLabel(ctx);
      current.status = text(ticket.status);
      current.lastAt = Date.now();
      current.ctx = ctx;
      current.groupKey = groupKey;

      const resolvedFileName = text(mediaObj && mediaObj.filename) || mediaFileNameFromCtx(ctx);
      const resolvedMimeType = text(mediaObj && mediaObj.mimetype) || mediaMimeTypeFromCtx(ctx);
      const displayText = hasInboundMedia
        ? buildInboundDisplayText(inboundMediaKind, captionText, resolvedFileName, bodyText)
        : bodyText;
      if (displayText) current.messages.push(displayText);
      if (current.messages.length > msgBufferMax) {
        current.messages = current.messages.slice(current.messages.length - msgBufferMax);
      }

      burstState.set(burstKey, current);
      scheduleBurstFlush(chatId, ticket.ticketId);

      if (hasInboundMedia) {
        try {
          const targetChat = await resolveTargetGroup(groupKey, ctx);
          if (targetChat) {
            if (!text(mediaObj.filename) && resolvedFileName) mediaObj.filename = resolvedFileName;
            if (!text(mediaObj.mimetype) && resolvedMimeType) mediaObj.mimetype = resolvedMimeType;
            await sendFn(
              targetChat,
              mediaObj,
              buildInboundMediaOptions(cfg, inboundMediaKind, captionText, Number(current.lastAt || 0))
            );
          } else if (bugLog) {
            meta.log(tag, `bug inbound_media_forward_skipped ticketId=${ticket.ticketId} hasMedia=1 hasTarget=0`);
          }
        } catch (e) {
          if (bugLog) meta.log(tag, `bug inbound_media_forward_failed ticketId=${ticket.ticketId} kind=${inboundMediaKind} err=${text(e && e.message ? e.message : e)}`);
        }
      }

      await sendFn(chatId, text(cfg.inboundAckTemplate), { isAuto: 1, manualReply: 0 });
      if (typeof ctx.stopPropagation === 'function') ctx.stopPropagation();
    }

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
      onBindTag: async ({ tag: bindTag, workgroupKey }) => {
        const normalizedTag = text(bindTag);
        const normalizedGroupKey = text(workgroupKey);
        if (!normalizedTag || !normalizedGroupKey) return { ok: 0, code: 'need_text' };
        if (!text(cfg.bindMapStoreKey)) {
          if (bugLog) meta.log(tag, 'bug bind_tag_missing_bindMapStoreKey');
          return { ok: 0, code: 'need_text' };
        }
        try {
          const bindMap = await loadBindMap();
          bindMap[normalizedTag] = normalizedGroupKey;
          await saveBindMap(bindMap);
          return { ok: 1 };
        } catch (e) {
          if (bugLog) meta.log(tag, `bug bind_tag_failed err=${text(e && e.message ? e.message : e)}`);
          return { ok: 0, code: 'need_text' };
        }
      },
      onMoveTicket: async ({ ticketId, targetKey, workgroupKey, ctx }) => {
        const resolvedTicketId = text(ticketId);
        const resolvedGroupKey = text(workgroupKey || targetKey);

        if (!ctx || !ctx.isGroup) return { ok: 0, code: 'group_only' };
        if (!resolvedTicketId) return { ok: 0, code: 'need_ticket' };
        if (!resolvedGroupKey) return { ok: 0, code: 'need_text' };

        try {
          const workgroups = meta.getService('workgroups');
          if (workgroups && typeof workgroups.resolve === 'function') {
            const check = await workgroups.resolve(resolvedGroupKey, ctx);
            if (!check) {
              if (bugLog) meta.log(tag, `bug move_ticket_group_not_resolved key=${resolvedGroupKey}`);
              return { ok: 0, code: 'need_text' };
            }
          } else if (bugLog) {
            meta.log(tag, 'bug move_ticket_missing_workgroups_service');
          }

          const tickets = await loadTicketState();
          const ticket = tickets.find((x) => text(x.ticketId) === resolvedTicketId);
          if (!ticket) return { ok: 0, code: 'ticket_not_found' };
          if (text(ticket.status) === text(cfg.ticketStatusClosed)) return { ok: 0, code: 'ticket_closed' };

          ticket.groupKey = resolvedGroupKey;
          ticket.updatedAt = new Date(Date.now()).toISOString();
          await saveTicketState(tickets);
          return { ok: 1 };
        } catch (e) {
          if (bugLog) meta.log(tag, `bug move_ticket_failed err=${text(e && e.message ? e.message : e)}`);
          return { ok: 0, code: 'need_text' };
        }
      },
      canReply: async (ctx) => canAccess(access, ctx, cfg.minRoleTicketReply),
      sendStaffReply: async (ctx, message) => {
        const chatId = text(ctx && ctx.chatId);
        if (!chatId) return;
        const payload = text(message);
        const options = { isAuto: 0, manualReply: 1, bypassRateLimit: 1 };
        if (ctx && typeof ctx.reply === 'function') {
          try {
            await ctx.reply(payload, options);
            return;
          } catch (e) {
            if (bugLog) meta.log(tag, `bug staff_reply_ctx_reply_failed err=${text(e && e.message ? e.message : e)}`);
          }
        }
        await sendFn(chatId, payload, options);
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

    setInterval(() => {
      runAntiMissTick().catch((e) => {
        if (bugLog) meta.log(tag, `bug anti_miss_loop err=${text(e && e.message ? e.message : e)}`);
      });
    }, tickMs);

    return {
      onMessage: async (ctx) => {
        await onDmMessage(ctx);
        await replyRouter.onGroupMessage(ctx);
      },
      onEvent: async () => {},
    };
  },
};