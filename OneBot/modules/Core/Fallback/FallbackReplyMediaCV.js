'use strict';

function text(value) {
  return String(value ?? '').trim();
}

function toInt(value, fallback) {
  const n = Number.parseInt(text(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value) {
  const s = text(value).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function parseTicketId(raw, ticketIdRegex) {
  const source = text(raw);
  if (!source) return '';
  const re = new RegExp(text(ticketIdRegex), 'i');
  const m = source.match(re);
  return m && m[0] ? text(m[0]) : '';
}

function stripTicketId(sourceText, ticketIdRegex) {
  const re = new RegExp(text(ticketIdRegex), 'ig');
  return text(sourceText).replace(re, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeKind(value) {
  const v = text(value).toLowerCase();
  if (v === 'image' || v === 'document' || v === 'audio' || v === 'video' || v === 'ptt') return v;
  return '';
}

function mediaFileNameOf(staffMsg) {
  return text(staffMsg && (staffMsg.filename || (staffMsg._data && staffMsg._data.filename) || ''));
}

function mediaMimeTypeOf(staffMsg) {
  return text(staffMsg && (staffMsg.mimetype || (staffMsg._data && staffMsg._data.mimetype) || ''));
}

function inferKindFromMimeAndName(mimeType, fileName, isPtt) {
  const mime = text(mimeType).toLowerCase();
  const name = text(fileName);
  if (isPtt) return 'ptt';
  if (mime.indexOf('image/') === 0) return 'image';
  if (mime.indexOf('video/') === 0) return 'video';
  if (mime.indexOf('audio/') === 0) return 'audio';
  if (mime || name) return 'document';
  return '';
}

function mediaTypeOf(staffMsg) {
  if (!staffMsg || typeof staffMsg !== 'object') return '';
  const direct = normalizeKind(staffMsg.type || (staffMsg._data && staffMsg._data.type) || '');
  if (direct) return direct;

  const isPtt = !!(staffMsg.ptt || (staffMsg._data && staffMsg._data.ptt));
  return inferKindFromMimeAndName(mediaMimeTypeOf(staffMsg), mediaFileNameOf(staffMsg), isPtt);
}

function hasDownloadableMedia(staffMsg) {
  if (!staffMsg || typeof staffMsg.downloadMedia !== 'function') return false;
  if (staffMsg.hasMedia === true) return true;
  return !!mediaTypeOf(staffMsg);
}

function normalizeSendKind(initialKind, mediaObj, staffMsg) {
  const preferred = normalizeKind(initialKind);
  if (preferred === 'image' || preferred === 'document') return preferred;

  const inferred = inferKindFromMimeAndName(
    text(mediaObj && mediaObj.mimetype) || mediaMimeTypeOf(staffMsg),
    text(mediaObj && mediaObj.filename) || mediaFileNameOf(staffMsg),
    false
  );
  if (inferred === 'image' || inferred === 'document') return inferred;
  return '';
}

function resolveSendService(meta, cfg) {
  const preferred = text(cfg.replyMediaSendPrefer)
    .split(',')
    .map((x) => text(x))
    .filter(Boolean);

  let names = preferred.slice();
  if (!names.length && typeof meta.loadConfRel === 'function' && text(cfg.globalConfRel)) {
    try {
      const loaded = meta.loadConfRel(text(cfg.globalConfRel)) || {};
      const globalConf = loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
      names = String(globalConf.sendPrefer || '')
        .split(',')
        .map((x) => text(x))
        .filter(Boolean);
    } catch (_) {}
  }

  for (const name of names) {
    const svc = meta.getService(name);
    if (typeof svc === 'function') return svc;
    if (svc && typeof svc.send === 'function') {
      return async (chatId, payload, options) => await svc.send(chatId, payload, options || {});
    }
  }

  return null;
}

function bugEnabled(value) {
  return toBool(value);
}

function looksLikeBase64Blob(value) {
  const compact = text(value).replace(/\s+/g, '');
  if (compact.length < 512) return false;
  if (compact.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=]+$/.test(compact);
}

function sanitizeCaption(captionText, ticketIdRegex) {
  const stripped = stripTicketId(captionText, ticketIdRegex);
  if (looksLikeBase64Blob(stripped)) return '';
  return stripped;
}

async function withTimeout(promise, timeoutMs) {
  const ms = Math.max(1, toInt(timeoutMs, 1));
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('media_download_timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function markTicketReplied(store, ticketStoreKey, ticketId) {
  const state = await store.get(ticketStoreKey, { tickets: [] });
  const tickets = Array.isArray(state.tickets) ? state.tickets : [];
  const ticket = tickets.find((x) => text(x.ticketId) === text(ticketId));
  if (!ticket) return false;
  ticket.lastStaffReplyAt = Date.now();
  ticket.awaitingStaff = 0;
  await store.set(ticketStoreKey, { tickets });
  return true;
}

async function sendToCustomer(input) {
  const cfg = input.cfg;
  const meta = input.meta;
  const store = input.store;
  const ticketStoreKey = input.ticketStoreKey;
  const ticketIdRaw = input.ticketId;
  const staffMsg = input.staffMsg;
  const captionText = text(input.captionText);
  const baseOptions = input.options && typeof input.options === 'object' ? Object.assign({}, input.options) : {};

  const ticketId = parseTicketId(ticketIdRaw, cfg.ticketIdRegex);
  if (!ticketId) return { ok: 0, code: 'need_ticket' };

  if (!hasDownloadableMedia(staffMsg)) {
    return { ok: 0, code: 'media_download_failed' };
  }

  const state = await store.get(ticketStoreKey, { tickets: [] });
  const tickets = Array.isArray(state.tickets) ? state.tickets : [];
  const ticket = tickets.find((x) => text(x.ticketId) === ticketId);

  if (!ticket) return { ok: 0, code: 'ticket_not_found' };
  if (text(ticket.status) === text(cfg.ticketStatusClosed)) return { ok: 0, code: 'ticket_closed' };

  const customerChatId = text(ticket.customerChatId);
  if (!customerChatId) return { ok: 0, code: 'ticket_not_found' };

  const send = resolveSendService(meta, cfg);
  if (typeof send !== 'function') return { ok: 0, code: 'send_missing' };

  let mediaObj;
  try {
    mediaObj = await withTimeout(staffMsg.downloadMedia(), toInt(cfg.replyMediaDownloadTimeoutMs, 1));
  } catch (e) {
    return { ok: 0, code: 'media_download_failed', error: text(e && e.message ? e.message : e) };
  }

  if (!mediaObj) return { ok: 0, code: 'media_download_failed' };
  if (!text(mediaObj.filename)) mediaObj.filename = mediaFileNameOf(staffMsg);
  if (!text(mediaObj.mimetype)) mediaObj.mimetype = mediaMimeTypeOf(staffMsg);

  const kind = normalizeSendKind(mediaTypeOf(staffMsg), mediaObj, staffMsg);
  if (kind !== 'image' && kind !== 'document') {
    return { ok: 0, code: 'media_download_failed' };
  }

  const caption = sanitizeCaption(captionText, cfg.ticketIdRegex);

  const outOptions = Object.assign({}, baseOptions, {
    isAuto: 0,
    manualReply: 1,
    bypassRateLimit: 1,
  });
  if (kind === 'document') outOptions.sendMediaAsDocument = true;
  if (caption) outOptions.caption = caption;

  const maxTries = Math.max(1, toInt(cfg.replyMediaMaxTries, 1));
  const retryBaseMs = Math.max(0, toInt(cfg.replyMediaRetryBaseMs, 0));
  const retryJitterMs = Math.max(0, toInt(cfg.replyMediaRetryJitterMs, 0));
  const gapMs = Math.max(0, toInt(cfg.replyMediaGapMs, 0));

  for (let attempt = 1; attempt <= maxTries; attempt += 1) {
    try {
      const enqueueId = await send(customerChatId, mediaObj, outOptions);
      if (gapMs > 0) await sleep(gapMs);
      try {
        await markTicketReplied(store, ticketStoreKey, ticketId);
      } catch (e) {
        if (bugEnabled(cfg.bugLog) && meta && typeof meta.log === 'function') {
          meta.log('FallbackReplyMediaCV', 'bug ticket_update_failed err=' + text(e && e.message ? e.message : e));
        }
      }
      return { ok: 1, code: 'sent', targetChatId: customerChatId, enqueueId };
    } catch (e) {
      if (attempt >= maxTries) {
        return { ok: 0, code: 'send_error', error: text(e && e.message ? e.message : e) };
      }
      const jitter = retryJitterMs > 0 ? Math.floor(Math.random() * (retryJitterMs + 1)) : 0;
      await sleep(retryBaseMs + jitter);
    }
  }

  return { ok: 0, code: 'send_error' };
}

module.exports = {
  sendToCustomer,
};