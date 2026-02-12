'use strict';

const FallbackGroupRouterV1 = require('./FallbackGroupRouterV1');
const FallbackForwardTextV1 = require('./FallbackForwardTextV1');
const FallbackForwardMediaV1 = require('./FallbackForwardMediaV1');
const FallbackReplyTextV1 = require('./FallbackReplyTextV1');
const FallbackReplyMediaV1 = require('./FallbackReplyMediaV1');
const FallbackReplyAVV1 = require('./FallbackReplyAVV1');
const TicketCoreV2 = require('../Shared/SharedTicketCoreV2');

function cfgStr(cfg, key, defVal) {
  if (!cfg || typeof cfg !== 'object') return defVal;
  const v = cfg[key];
  if (v === undefined || v === null) return defVal;
  const s = String(v).trim();
  return s.length ? s : defVal;
}

function cfgInt(cfg, key, defVal) {
  const n = parseInt(cfgStr(cfg, key, ''), 10);
  return Number.isFinite(n) ? n : defVal;
}

function cfgBool(cfg, key, defVal) {
  const s = cfgStr(cfg, key, '');
  if (!s) return !!defVal;
  const t = s.toLowerCase();
  return t === '1' || t === 'true' || t === 'yes' || t === 'on';
}

function toChatId(v) {
  return String(v || '').trim();
}

function rawType(raw) {
  if (!raw) return '';
  if (typeof raw.type === 'string') return raw.type;
  if (raw._data && typeof raw._data.type === 'string') return raw._data.type;
  return '';
}

function isAvType(t) {
  const x = String(t || '').toLowerCase();
  return x === 'audio' || x === 'video' || x === 'ptt' || x === 'voice';
}

// Ticket id format spec from SharedTicketCoreV2: YYMMT + 7 digits.
// Example: 2601T0000001
const TICKET_ID_PATTERN = /\b\d{4}T\d{7}\b/;

function parseTicketId(text) {
  const s = String(text || '');
  const m = s.match(TICKET_ID_PATTERN);
  return m ? m[0] : '';
}

function stripTicket(text, ticketId) {
  const s = String(text || '').trim();
  if (!s || !ticketId) return s;
  const i = s.toUpperCase().indexOf(String(ticketId).toUpperCase());
  if (i === 0) return s.slice(String(ticketId).length).trim();
  return s;
}

async function forwardAvInline(meta, toGroupId, raw, ticketId) {
  const tId = String(ticketId || '');
  if (!toGroupId || !raw) {
    const msg = 'bug.forwardAv reason=bad_input ticketId=' + tId;
    meta.log('FallbackCV', msg);
    return { ok: false, reason: 'bad_input' };
  }

  const outsend = meta.getService('outsend');
  if (typeof outsend !== 'function') {
    const msg = 'bug.forwardAv reason=missingOutsend ticketId=' + tId;
    meta.log('FallbackCV', msg);
    return { ok: false, reason: 'missingOutsend' };
  }

  if (typeof raw.downloadMedia !== 'function') {
    const msg = 'bug.forwardAv reason=noDownloadMedia ticketId=' + tId;
    meta.log('FallbackCV', msg);
    return { ok: false, reason: 'noDownloadMedia' };
  }

  let media = null;
  try {
    media = await raw.downloadMedia();
  } catch (e) {
    media = null;
    const reason = e && e.message ? String(e.message) : String(e);
    const msg = 'bug.forwardAv reason=downloadMediaFail ticketId=' + tId + ' err=' + reason;
    meta.log('FallbackCV', msg);
  }

  if (media) {
    const options = {};
    const t = rawType(raw);
    if (t === 'ptt' || t === 'voice' || t === 'audio') options.sendAudioAsVoice = true;
    await outsend(toGroupId, media, options);
    return { ok: true };
  }

  meta.log('FallbackCV', 'bug.forwardAv reason=downloadMediaEmpty ticketId=' + tId);
  return { ok: false, reason: 'downloadFail' };
}

module.exports = {
  init: async function init(meta) {
    const tag = 'FallbackCV';
    const cfg = meta && meta.implConf ? meta.implConf : {};

    const enabled = cfgBool(cfg, 'enabled', 1);
    if (!enabled) {
      meta.log(tag, 'disabled enabled=0');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const controlGroupId = cfgStr(cfg, 'controlGroupId', '');
    if (!controlGroupId) {
      meta.log(tag, 'disabled missing controlGroupId');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const ticketTtlMs = cfgInt(cfg, 'ticketTtlMs', 300000);
    const sendPrefer = cfgStr(cfg, 'sendPrefer', 'sendout,outsend,send');

    const ticketToChat = Object.create(null);

    meta.log(tag, 'ready enabled=1 controlGroupId=' + controlGroupId + ' sendPrefer=' + sendPrefer);

    async function handleForward(ctx, raw) {
      const fromChatId = toChatId(ctx.chatId);
      const fromAuthorId = toChatId((ctx.sender && ctx.sender.id) || fromChatId);
      if (!fromChatId || !fromAuthorId) return;

      const routeGroupId = FallbackGroupRouterV1.routeGroupId(meta, cfg, ctx);
      if (!routeGroupId) return;

      const ticketRes = await TicketCoreV2.resolve(meta, cfg, fromChatId, fromAuthorId, ticketTtlMs);
      if (!ticketRes || !ticketRes.ok || !ticketRes.ticketId) return;

      ticketToChat[ticketRes.ticketId] = fromChatId;

      const ticketCtx = {
        controlGroupId: routeGroupId,
        ticketId: ticketRes.ticketId,
        seq: 0,
        fromPhone: (ctx.sender && ctx.sender.phone) ? String(ctx.sender.phone) : '',
        fromName: (ctx.sender && ctx.sender.name) ? String(ctx.sender.name) : '',
      };

      const t = rawType(raw);
      if (isAvType(t) && raw && raw.hasMedia) {
        await forwardAvInline(meta, routeGroupId, raw, ticketRes.ticketId);
        return;
      }

      if (raw && raw.hasMedia) {
        await FallbackForwardMediaV1.handle(meta, cfg, ticketCtx, {
          raw: raw,
          text: ctx.text || '',
        });
        return;
      }

      await FallbackForwardTextV1.handle(meta, cfg, ticketCtx, {
        raw: raw,
        text: ctx.text || '',
      });
    }

    async function handleReply(ctx, raw) {
      const ticketId = parseTicketId(ctx.text || '');
      if (!ticketId) return;

      const toCustomerChatId = toChatId(ticketToChat[ticketId]);
      if (!toCustomerChatId) return;

      const body = stripTicket(ctx.text || '', ticketId);
      const t = rawType(raw);

      if (isAvType(t) && raw && raw.hasMedia) {
        await FallbackReplyAVV1.handle(meta, cfg, toCustomerChatId, raw, body);
        return;
      }

      if (raw && raw.hasMedia) {
        await FallbackReplyMediaV1.handle(meta, cfg, toCustomerChatId, raw, body);
        return;
      }

      if (body) {
        await FallbackReplyTextV1.handle(meta, cfg, toCustomerChatId, body);
      }
    }

    async function onMessage(ctx) {
      try {
        const chatId = toChatId(ctx && ctx.chatId);
        if (!chatId) return;

        const raw = ctx && ctx.message ? ctx.message : null;
        const isGroup = !!(ctx && ctx.isGroup);

        if (!isGroup) {
          await handleForward(ctx, raw);
          return;
        }

        if (chatId !== controlGroupId) return;
        await handleReply(ctx, raw);
      } catch (e) {
        meta.log(tag, 'bug.onMessage err=' + String(e && e.message ? e.message : e));
      }
    }

    return { onMessage, onEvent: async () => {} };
  },
};