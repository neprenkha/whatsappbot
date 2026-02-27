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

// Ticket id format spec from SharedTicketCoreV2: YYMMT + 7 digits.
// Example: 2601T0000001
const TICKET_ID_PATTERN = /\b\d{4}T\d{7}\b/;

function parseTicketId(text) {
  const s = String(text || '');
  const m = s.match(TICKET_ID_PATTERN);
  return m ? m[0] : '';
}

function extractQuotedText(raw) {
  if (!raw) return '';
  if (raw.quotedMsg && typeof raw.quotedMsg.body === 'string') return raw.quotedMsg.body;
  if (raw.quotedMsg && typeof raw.quotedMsg.caption === 'string') return raw.quotedMsg.caption;
  if (raw._data && raw._data.quotedMsg) {
    const q = raw._data.quotedMsg;
    if (typeof q.body === 'string') return q.body;
    if (typeof q.caption === 'string') return q.caption;
  }
  return '';
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseReplyCommand(text, cfg) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const prefix = String(cfgStr(cfg, 'replyCommandPrefix', '!') || '!').trim();
  const cmd = String(cfgStr(cfg, 'replyCommandName', 'r') || 'r').trim();
  if (!prefix || !cmd) return null;

  const escPrefix = escapeRegExp(prefix);
  const escCmd = escapeRegExp(cmd);
  const re = new RegExp('^' + escPrefix + escCmd + '\\s+(\\d{4}T\\d{7})(?:\\s+([\\s\\S]*))?$', 'i');
  const m = raw.match(re);
  if (!m) return null;

  return {
    ticketId: String(m[1] || '').trim(),
    body: String(m[2] || '').trim(),
    method: 'command',
  };
}

function resolveReplyTarget(raw, text, cfg) {
  const cmd = parseReplyCommand(text, cfg);
  if (cmd && cmd.ticketId) return cmd;

  const quoted = extractQuotedText(raw);
  const quotedTicket = parseTicketId(quoted);
  if (quotedTicket) {
    return {
      ticketId: quotedTicket,
      body: stripTicket(String(text || ''), quotedTicket),
      method: 'quote',
    };
  }

  const inlineTicket = parseTicketId(text || '');
  if (inlineTicket) {
    return {
      ticketId: inlineTicket,
      body: stripTicket(String(text || ''), inlineTicket),
      method: 'inline',
    };
  }

  return null;
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

async function forwardAvInline(meta, cfg, toGroupId, raw, ticketId) {
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

  const t = rawType(raw);
  const maxInlineMb = cfgInt(cfg, 'forwardAvInlineMaxMb', 15);
  const maxInlineBytes = Math.max(1, maxInlineMb) * 1024 * 1024;
  const sizeBytes = mediaSizeBytes(raw);

  if (sizeBytes > 0 && sizeBytes > maxInlineBytes) {
    meta.log('FallbackCV', 'warn.forwardAv size_exceeds_inline ticketId=' + tId + ' sizeBytes=' + String(sizeBytes) + ' maxInlineBytes=' + String(maxInlineBytes));
    if (typeof raw.forward === 'function') {
      try {
        await raw.forward(toGroupId);
        return { ok: true, mode: 'raw.forward' };
      } catch (e) {
        const detail = errDetail(e);
        meta.log('FallbackCV', 'bug.forwardAv reason=rawForwardFail ticketId=' + tId + ' err=' + detail);
      }
    }
  }

  let media = null;
  try {
    media = await raw.downloadMedia();
  } catch (e) {
    media = null;
    const detail = errDetail(e);
    const msg = 'bug.forwardAv reason=downloadMediaFail ticketId=' + tId + ' err=' + detail;
    meta.log('FallbackCV', msg);
  }

  if (media) {
    const options = {};
    if (t === 'ptt' || t === 'voice' || t === 'audio') options.sendAudioAsVoice = true;
    try {
      await outsend(toGroupId, media, options);
      return { ok: true };
    } catch (e) {
      const detail = errDetail(e);
      meta.log('FallbackCV', 'bug.forwardAv reason=outsendFail ticketId=' + tId + ' err=' + detail);
      return { ok: false, reason: 'outsendFail', detail: detail };
    }
  }

  if (typeof raw.forward === 'function') {
    try {
      await raw.forward(toGroupId);
      return { ok: true, mode: 'raw.forward' };
    } catch (e) {
      const detail = errDetail(e);
      meta.log('FallbackCV', 'bug.forwardAv reason=rawForwardFail ticketId=' + tId + ' err=' + detail);
      return { ok: false, reason: 'rawForwardFail', detail: detail };
    }
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
            meta.log(tag, 'bug.forward.av_failed ticketId=' + ticketRes.ticketId + ' target=' + routeGroupId + ' reason=' + String(rr && rr.reason ? rr.reason : 'unknown'));
          }
          return;
        }

        if (raw && raw.hasMedia) {
          const rr = await FallbackForwardMediaV1.handle(meta, cfg, ticketCtx, {
            raw: raw,
            text: ctx.text || '',
          });
          if (!rr || rr.ok !== true) {
            meta.log(tag, 'bug.forward.media_failed ticketId=' + ticketRes.ticketId + ' target=' + routeGroupId + ' reason=' + String(rr && rr.reason ? rr.reason : 'unknown'));
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
      const route = resolveReplyTarget(raw, ctx.text || '', cfg);
      if (!route || !route.ticketId) return;

      const ticketId = route.ticketId;
      const method = route.method || 'unknown';
      const toCustomerChatId = toChatId(ticketToChat[ticketId]);
      if (!toCustomerChatId) {
        meta.log(tag, 'bug.reply.resolve_failed ticketId=' + ticketId + ' method=' + method + ' reason=missing_target detail=ticket_not_in_memory');
        return;
      }

      const body = String(route.body || '').trim();
      const t = rawType(raw);

      if (isAvType(t) && raw && raw.hasMedia) {
        const rr = await FallbackReplyAVV1.handle(meta, cfg, toCustomerChatId, raw, body);
        if (!rr || rr.ok !== true) {
          meta.log(tag, 'bug.reply.send_failed ticketId=' + ticketId + ' method=' + method + ' target=' + toCustomerChatId + ' reason=' + String(rr && rr.reason ? rr.reason : 'unknown') + ' detail=' + String(rr && rr.detail ? rr.detail : 'no_detail'));
          return;
        }
        meta.log(tag, 'exec.reply.sent ticketId=' + ticketId + ' method=' + method + ' target=' + toCustomerChatId + ' type=av');
        return;
      }

      if (raw && raw.hasMedia) {
        const rr = await FallbackReplyMediaV1.handle(meta, cfg, toCustomerChatId, raw, body);
        if (!rr || rr.ok !== true) {
          meta.log(tag, 'bug.reply.send_failed ticketId=' + ticketId + ' method=' + method + ' target=' + toCustomerChatId + ' reason=' + String(rr && rr.reason ? rr.reason : 'unknown') + ' detail=' + String(rr && rr.detail ? rr.detail : 'no_detail'));
          return;
        }
        meta.log(tag, 'exec.reply.sent ticketId=' + ticketId + ' method=' + method + ' target=' + toCustomerChatId + ' type=media');
        return;
      }

      if (body) {
        const rr = await FallbackReplyTextV1.handle(meta, cfg, toCustomerChatId, body);
        if (!rr || rr.ok !== true) {
          meta.log(tag, 'bug.reply.send_failed ticketId=' + ticketId + ' method=' + method + ' target=' + toCustomerChatId + ' reason=' + String(rr && rr.reason ? rr.reason : 'unknown') + ' detail=' + String(rr && rr.detail ? rr.detail : 'no_detail'));
          return;
        }
        meta.log(tag, 'exec.reply.sent ticketId=' + ticketId + ' method=' + method + ' target=' + toCustomerChatId + ' type=text');
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