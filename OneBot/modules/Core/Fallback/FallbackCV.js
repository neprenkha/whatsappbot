'use strict';

const util = require('util');

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

function splitCsv(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function toChatId(v) {
  return String(v || '').trim();
}

function asGroupId(v) {
  const id = toChatId(v);
  return id && id.endsWith('@g.us') ? id : '';
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

const TICKET_ID_PATTERN = /\b\d{4}T\d{7}\b/;

function parseTicketId(text) {
  const s = String(text || '');
  const m = s.match(TICKET_ID_PATTERN);
  return m ? m[0] : '';
}

function stripTicket(text, ticketId) {
  const s = String(text || '').trim();
  if (!s) return s;
  const escaped = String(ticketId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const p = escaped ? new RegExp(escaped, 'ig') : TICKET_ID_PATTERN;
  return s.replace(p, ' ').replace(/\s+/g, ' ').trim();
}

function errCode(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err.code) return String(err.code);
  if (err.reason) return String(err.reason);
  return '';
}

function messageOf(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return String(err.message || err.code || err.reason || '');
}

function errDetail(err) {
  try {
    if (!err) return '';
    if (typeof err === 'string') return err;
    const msg = err.message ? String(err.message) : '';
    const stack = err.stack ? String(err.stack).split('\n')[0] : '';
    const obj = util.inspect(err, { depth: 3, breakLength: 140, maxArrayLength: 20 });
    return [msg, stack, obj].filter(Boolean).join(' | ');
  } catch (_) {
    return String(err || '');
  }
}

function mediaSizeBytes(raw) {
  const d = raw && raw._data ? raw._data : {};
  const n = Number(d.size || d.fileSize || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isRetryableSendError(err) {
  if (err && err.retryable === true) return true;
  const m = messageOf(err).toLowerCase();
  if (!m) return false;
  return (
    m.indexOf('promise was collected') >= 0 ||
    m.indexOf('execution context was destroyed') >= 0 ||
    m.indexOf('target closed') >= 0 ||
    m.indexOf('session closed') >= 0 ||
    m.indexOf('protocol error') >= 0 ||
    m.indexOf('transport.send_failed') >= 0 ||
    m.indexOf('timeout') >= 0 ||
    m.indexOf('network') >= 0
  );
}

function waitMsFrom(err, dflt) {
  if (err && typeof err.waitMs === 'number' && err.waitMs > 0) return err.waitMs;
  return dflt;
}

function pickSender(meta, preferCsv) {
  const names = splitCsv(preferCsv || 'outsend,sendout,transport,send');
  for (const name of names) {
    const svc = meta.getService(name);
    if (typeof svc === 'function') return { name, fn: svc };
    if (svc && typeof svc.sendDirect === 'function') {
      return { name, fn: async (chatId, payload, opts) => await svc.sendDirect(chatId, payload, opts || {}) };
    }
    if (svc && typeof svc.send === 'function') {
      return { name, fn: async (chatId, payload, opts) => await svc.send(chatId, payload, opts || {}) };
    }
  }
  return { name: '', fn: null };
}

async function forwardAvInline(meta, cfg, toGroupId, raw, ticketId) {
  const tId = String(ticketId || '');
  if (!toGroupId || !raw) {
    const msg = 'bug.forwardAv reason=bad_input ticketId=' + tId;
    meta.log('FallbackCV', msg);
    return { ok: false, reason: 'bad_input', detail: 'toGroupId/raw missing' };
  }

  if (typeof raw.downloadMedia !== 'function') {
    const msg = 'bug.forwardAv reason=noDownloadMedia ticketId=' + tId;
    meta.log('FallbackCV', msg);
    return { ok: false, reason: 'noDownloadMedia', detail: 'raw.downloadMedia missing' };
  }

  const sender = pickSender(meta, cfgStr(cfg, 'sendPrefer', 'outsend,sendout,transport,send'));
  if (typeof sender.fn !== 'function') {
    const msg = 'bug.forwardAv reason=missingSender ticketId=' + tId;
    meta.log('FallbackCV', msg);
    return { ok: false, reason: 'missingSender', detail: 'no sender from sendPrefer' };
  }

  const t = rawType(raw);
  const maxInlineMb = cfgInt(cfg, 'forwardAvInlineMaxMb', 15);
  const maxInlineBytes = Math.max(1, maxInlineMb) * 1024 * 1024;
  const sizeBytes = mediaSizeBytes(raw);

  if (sizeBytes > 0 && sizeBytes > maxInlineBytes) {
    meta.log('FallbackCV', 'warn.forwardAv size_exceeds_inline ticketId=' + tId + ' sizeBytes=' + String(sizeBytes) + ' maxInlineBytes=' + String(maxInlineBytes));
    if (typeof raw.forward === 'function') {
      try {
        await raw.forward(toGroupId);
        return { ok: true, mode: 'raw.forward', svc: 'raw.forward' };
      } catch (e) {
        const detail = errDetail(e);
        meta.log('FallbackCV', 'bug.forwardAv reason=rawForwardFail ticketId=' + tId + ' target=' + toGroupId + ' svc=raw.forward retryable=' + (isRetryableSendError(e) ? '1' : '0') + ' waitMs=' + String(waitMsFrom(e, 0)) + ' err=' + detail);
      }
    }
  }

  let media = null;
  try {
    media = await raw.downloadMedia();
  } catch (e) {
    media = null;
    const detail = errDetail(e);
    const msg = 'bug.forwardAv reason=downloadMediaFail ticketId=' + tId + ' target=' + toGroupId + ' svc=' + sender.name + ' retryable=' + (isRetryableSendError(e) ? '1' : '0') + ' waitMs=' + String(waitMsFrom(e, 0)) + ' err=' + detail;
    meta.log('FallbackCV', msg);
  }

  if (media) {
    const options = {
      manualReply: cfgBool(cfg, 'forwardAvManualReply', true) ? 1 : 0,
      allowOutsideWindow: cfgBool(cfg, 'forwardAvAllowOutsideWindow', true) ? 1 : 0,
      bypassRateLimit: cfgBool(cfg, 'forwardAvBypassRateLimit', false) ? 1 : 0,
    };
    if (t === 'ptt' || t === 'voice' || t === 'audio') options.sendAudioAsVoice = true;

    const retryMax = Math.max(1, cfgInt(cfg, 'forwardAvRetryMax', 3));
    const retryBaseMs = Math.max(200, cfgInt(cfg, 'forwardAvRetryBaseMs', 1200));
    const retryMaxMs = Math.max(retryBaseMs, cfgInt(cfg, 'forwardAvRetryMaxMs', 6000));

    for (let attempt = 1; attempt <= retryMax; attempt++) {
      try {
        const sendRes = await sender.fn(toGroupId, media, options);
        if (sendRes && sendRes.ok === false) {
          const reason = String(sendRes.reason || sendRes.code || 'send_failed');
          const detail = String(sendRes.detail || sendRes.message || 'sender returned ok=false');
          const retryable = sendRes.retryable === true ? 1 : 0;
          const waitMs = typeof sendRes.waitMs === 'number' && sendRes.waitMs > 0 ? sendRes.waitMs : 0;
          meta.log('FallbackCV', 'bug.forwardAv reason=' + reason + ' ticketId=' + tId + ' target=' + toGroupId + ' svc=' + sender.name + ' retryable=' + String(retryable) + ' waitMs=' + String(waitMs) + ' detail=' + detail + ' attempt=' + String(attempt));
          if (!retryable || attempt >= retryMax) {
            return { ok: false, reason, detail, svc: sender.name, retryable, waitMs };
          }
          const sleepMs = Math.min(retryMaxMs, waitMs > 0 ? waitMs : (retryBaseMs * Math.pow(2, attempt - 1)));
          await new Promise((resolve) => setTimeout(resolve, sleepMs));
          continue;
        }
        return { ok: true, svc: sender.name, attempt: attempt };
      } catch (e) {
        const retryable = isRetryableSendError(e);
        const detail = errDetail(e);
        const waitMs = waitMsFrom(e, Math.min(retryMaxMs, retryBaseMs * Math.pow(2, attempt - 1)));
        const reason = errCode(e) || messageOf(e) || 'outsendFail';
        meta.log('FallbackCV', 'bug.forwardAv reason=' + reason + ' ticketId=' + tId + ' target=' + toGroupId + ' svc=' + sender.name + ' retryable=' + (retryable ? '1' : '0') + ' waitMs=' + String(waitMs) + ' detail=' + detail + ' attempt=' + String(attempt));
        if (!retryable || attempt >= retryMax) {
          return { ok: false, reason, detail, svc: sender.name, retryable: retryable ? 1 : 0, waitMs };
        }
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }

  if (typeof raw.forward === 'function') {
    try {
      await raw.forward(toGroupId);
      return { ok: true, mode: 'raw.forward', svc: 'raw.forward' };
    } catch (e) {
      const detail = errDetail(e);
      const retryable = isRetryableSendError(e);
      const waitMs = waitMsFrom(e, 0);
      meta.log('FallbackCV', 'bug.forwardAv reason=rawForwardFail ticketId=' + tId + ' target=' + toGroupId + ' svc=raw.forward retryable=' + (retryable ? '1' : '0') + ' waitMs=' + String(waitMs) + ' detail=' + detail);
      return { ok: false, reason: 'rawForwardFail', detail: detail, svc: 'raw.forward', retryable: retryable ? 1 : 0, waitMs };
    }
  }

  meta.log('FallbackCV', 'bug.forwardAv reason=downloadMediaEmpty ticketId=' + tId + ' target=' + toGroupId + ' svc=' + sender.name + ' retryable=0 waitMs=0 detail=downloadMedia returned empty');
  return { ok: false, reason: 'downloadFail', detail: 'downloadMedia returned empty', svc: sender.name, retryable: 0, waitMs: 0 };
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

    const controlGroupId = asGroupId(cfgStr(cfg, 'controlGroupId', ''));
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
      const senderPhone = (ctx && ctx.sender && ctx.sender.phone) ? String(ctx.sender.phone) : '';
      meta.log(tag, 'exec forward chatId=' + fromChatId + ' isGroup=' + (ctx && ctx.isGroup ? '1' : '0') + ' senderId=' + fromAuthorId + ' senderPhone=' + senderPhone);
      if (!fromChatId || !fromAuthorId) return;

      const routeCandidate = FallbackGroupRouterV1.routeGroupId(meta, cfg, ctx);
      const routed = asGroupId(routeCandidate);
      const routeGroupId = routed || controlGroupId;
      if (!routeGroupId) return;
      if (!routed) {
        meta.log(tag, 'warn.route.invalid target=' + String(routeCandidate || '') + ' fallback=' + controlGroupId);
      }

      const ticketRes = await TicketCoreV2.resolve(meta, cfg, fromChatId, fromAuthorId, ticketTtlMs);
      if (!ticketRes || !ticketRes.ok || !ticketRes.ticketId) {
        meta.log(tag, 'bug.ticket.resolve_failed chatId=' + fromChatId + ' senderId=' + fromAuthorId + ' reason=' + String(ticketRes && ticketRes.reason ? ticketRes.reason : 'unknown'));
        return;
      }

      ticketToChat[ticketRes.ticketId] = fromChatId;
      meta.log(tag, 'exec ticket chatId=' + fromChatId + ' ticketId=' + ticketRes.ticketId + ' target=' + routeGroupId + ' service=' + sendPrefer);

      const ticketCtx = {
        controlGroupId: routeGroupId,
        ticketId: ticketRes.ticketId,
        seq: 0,
        fromPhone: (ctx.sender && ctx.sender.phone) ? String(ctx.sender.phone) : '',
        fromName: (ctx.sender && ctx.sender.name) ? String(ctx.sender.name) : '',
      };

      const t = rawType(raw);
      try {
        if (isAvType(t) && raw && raw.hasMedia) {
          const rr = await forwardAvInline(meta, cfg, routeGroupId, raw, ticketRes.ticketId);
          if (!rr || rr.ok !== true) {
            meta.log(tag, 'bug.forward.av_failed ticketId=' + ticketRes.ticketId + ' target=' + routeGroupId + ' svc=' + String(rr && rr.svc ? rr.svc : '') + ' retryable=' + String(rr && rr.retryable ? rr.retryable : 0) + ' waitMs=' + String(rr && rr.waitMs ? rr.waitMs : 0) + ' reason=' + String(rr && rr.reason ? rr.reason : 'unknown') + ' detail=' + String(rr && rr.detail ? rr.detail : ''));
          }
          return;
        }

        if (raw && raw.hasMedia) {
          const rr = await FallbackForwardMediaV1.handle(meta, cfg, ticketCtx, {
            raw: raw,
            text: ctx.text || '',
          });
          if (!rr || rr.ok !== true) {
            meta.log(tag, 'bug.forward.media_failed ticketId=' + ticketRes.ticketId + ' target=' + routeGroupId + ' svc=' + String(rr && rr.svc ? rr.svc : '') + ' retryable=' + String(rr && rr.retryable ? rr.retryable : 0) + ' waitMs=' + String(rr && rr.waitMs ? rr.waitMs : 0) + ' reason=' + String(rr && rr.reason ? rr.reason : 'unknown') + ' detail=' + String(rr && rr.detail ? rr.detail : ''));
          }
          return;
        }

        const rr = await FallbackForwardTextV1.handle(meta, cfg, ticketCtx, {
          raw: raw,
          text: ctx.text || '',
        });
        if (!rr || rr.ok !== true) {
          meta.log(tag, 'bug.forward.text_failed ticketId=' + ticketRes.ticketId + ' target=' + routeGroupId + ' reason=' + String(rr && rr.reason ? rr.reason : 'unknown'));
        }
      } catch (e) {
        meta.log(tag, 'bug.forward.send_failed ticketId=' + ticketRes.ticketId + ' target=' + routeGroupId + ' code=' + errCode(e) + ' reason=' + String(e && e.message ? e.message : e));
      }
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
        if (raw && raw.fromMe === true) return;

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