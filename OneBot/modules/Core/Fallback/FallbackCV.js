// FallbackCV.js
// Customer DM -> Control Group with ticket card + media
// Control Group quote-reply -> Customer DM (ticket hidden)
//
// Patch 2026-01-10:
// - Video/audio are sent via msg.forward first (more reliable than base64 downloadMedia for AV)
// - Dedupe inbound duplicate events by message id to avoid double ticket / double media
// - Retry send when RateLimit returns reason=window (wait + retry instead of hard block)

const SharedConf = require('../Shared/SharedConfV1');
const SharedTicketCore = require('../Shared/SharedTicketCoreV1');
const SharedSafeSend = require('../Shared/SharedSafeSendV1');
const SharedMessageTicketMap = require('../Shared/SharedMessageTicketMapV1');

const FallbackTicketCard = require('./FallbackTicketCardV1');

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  let t = null;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`timeout:${label || 'op'}`)), ms);
  });
  return Promise.race([
    promise.finally(() => {
      if (t) clearTimeout(t);
    }),
    timeout,
  ]);
}

function safeStr(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function asInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function isTruthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

function pickFirstText(msg) {
  const body = safeStr(msg && msg.body);
  const caption = safeStr(msg && msg.caption);
  if (body && caption && body !== caption) return `${body}\n${caption}`.trim();
  return (body || caption || '').trim();
}

function getMsgKey(msg) {
  try {
    const id =
      (msg && msg.id && msg.id._serialized) ||
      (msg && msg._data && msg._data.id && msg._data.id._serialized) ||
      '';
    if (id) return id;
    const from = safeStr(msg && msg.from);
    const t = safeStr((msg && msg.timestamp) || (msg && msg._data && msg._data.t) || '');
    const type = safeStr(msg && msg.type);
    const body = safeStr(msg && msg.body).slice(0, 32);
    return `${from}|${type}|${t}|${body}`;
  } catch {
    return '';
  }
}

function isAvType(type) {
  return type === 'video' || type === 'audio' || type === 'ptt' || type === 'voice' || type === 'ptv';
}

module.exports = function init(meta, hubConf, implConf) {
  const { cfg, raw } = SharedConf.wrap(meta, hubConf, implConf, {
    defaults: {
      enabled: 1,
      controlGroupId: '',
      sendPrefer: 'outsend,sendout,send',
      burstMs: 2500,
      msgBufferMax: 20,
      mediaTimeoutMs: 45000,
      mediaRetryMs: 1200,
      sendSpacingMs: 1200,
      avWarmupMs: 8000,
      forwardTimeoutMs: 90000,
      quotedTimeoutMs: 12000,
      moduleLog: 1,
      bugLog: 1,
      detailLog: 0,
      traceLog: 1,
    },
  });

  const enabled = isTruthy(cfg.enabled);
  const controlGroupId = safeStr(cfg.controlGroupId);

  const moduleTag = 'FallbackCV';
  const logEnabled = {
    info: isTruthy(cfg.moduleLog),
    warn: isTruthy(cfg.bugLog),
    error: isTruthy(cfg.bugLog),
    detail: isTruthy(cfg.detailLog),
    trace: isTruthy(cfg.traceLog),
  };

  function log(level, msg, obj) {
    try {
      if (level === 'detail' && !logEnabled.detail) return;
      if (level === 'trace' && !logEnabled.trace) return;
      if (level === 'info' && !logEnabled.info) return;
      if (level === 'warn' && !logEnabled.warn) return;
      if (level === 'error' && !logEnabled.error) return;

      const line = obj ? `${msg} ${JSON.stringify(obj)}` : msg;
      if (meta && typeof meta.log === 'function') {
        meta.log(moduleTag, `${level} ${line}`);
      } else {
        console.log(`[${moduleTag}] ${level} ${line}`);
      }
      if ((level === 'warn' || level === 'error') && meta && typeof meta.log === 'function') {
        console.log(`[${moduleTag}] ${level} ${line}`);
      }
    } catch (e) {
      console.log(`[${moduleTag}] log.error ${e && e.message ? e.message : e}`);
    }
  }

  if (!enabled) {
    log('info', 'disabled via conf enabled=0');
    return { id: 'Fallback', onMessage: async () => {}, onEvent: async () => {} };
  }

  if (!controlGroupId) {
    log('error', 'Disabled: controlGroupId not configured or empty. Please set controlGroupId in config to enable Fallback.');
    return { id: 'Fallback', onMessage: async () => {}, onEvent: async () => {} };
  }

  const pick = SharedSafeSend.pickSend(meta, cfg.sendPrefer);
  const sendFn = pick.fn;

  const burstMs = Math.max(200, asInt(cfg.burstMs, 2500));
  const msgBufferMax = Math.max(1, asInt(cfg.msgBufferMax, 20));
  const mediaTimeoutMs = Math.max(5000, asInt(cfg.mediaTimeoutMs, 45000));
  const mediaRetryMs = Math.max(200, asInt(cfg.mediaRetryMs, 1200));
  const sendSpacingMs = Math.max(0, asInt(cfg.sendSpacingMs, 1200));
  const avWarmupMs = Math.max(0, asInt(cfg.avWarmupMs, 8000));
  const forwardTimeoutMs = Math.max(5000, asInt(cfg.forwardTimeoutMs, 90000));
  const quotedTimeoutMs = Math.max(2000, asInt(cfg.quotedTimeoutMs, 12000));

  const buf = new Map(); // chatId -> entry
  const flushing = new Set(); // chatId

  async function sendWithRetry(chatId, payload, opts, label) {
    const maxTries = 8;
    let last = null;
    for (let i = 1; i <= maxTries; i++) {
      try {
        last = await sendFn(chatId, payload, opts || {});
      } catch (e) {
        last = { ok: 0, reason: `exception:${e && e.message ? e.message : e}` };
      }

      const ok = !!(last && (last.ok === 1 || last.ok === true));
      if (ok) return last;

      const reason = safeStr(last && last.reason);
      if (reason && reason !== 'window') return last;

      const wait = Math.min(5000, 400 + i * Math.max(200, sendSpacingMs));
      log('detail', `${label || 'send'} retry window`, { attempt: i, waitMs: wait });
      await sleepMs(wait);
    }
    return last;
  }

  async function tryDownloadMediaReliable(msg, timeoutMs, retryMs) {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < timeoutMs) {
      attempt += 1;
      try {
        const media = await withTimeout(msg.downloadMedia(), Math.min(45000, timeoutMs), 'downloadMedia');
        if (media && typeof media.data === 'string' && media.data.length > 0) {
          return { ok: 1, media, attempt };
        }
        log('warn', 'downloadMedia empty', { attempt });
      } catch (e) {
        log('warn', 'downloadMedia exception', { attempt, err: safeStr(e && e.message ? e.message : e) });
      }
      await sleepMs(retryMs);
    }
    return { ok: 0, media: null, attempt };
  }

  function mediaOptsFor(type) {
    if (type === 'ptt' || type === 'voice') return { sendAudioAsVoice: true };
    return {};
  }

  async function tryForwardMessage(msg, chatId) {
    if (!msg || typeof msg.forward !== 'function') {
      return { ok: 0, reason: 'no_forward' };
    }
    try {
      const res = await withTimeout(msg.forward(chatId), forwardTimeoutMs, 'forward');
      const msgId = res && res.id && res.id._serialized ? res.id._serialized : '';
      return { ok: 1, msgId };
    } catch (e) {
      return { ok: 0, reason: safeStr(e && e.message ? e.message : e) };
    }
  }

  async function sendAttachmentToControlGroup(ticketId, idx, item) {
    const msg = item.msg;
    const type = item.type;

    if (sendSpacingMs > 0) await sleepMs(sendSpacingMs);

    if (isAvType(type)) {
      if (avWarmupMs > 0) {
        log('detail', 'av warmup', { ticketId, idx, waitMs: avWarmupMs, type });
        await sleepMs(avWarmupMs);
      }
      log('trace', 'av forward start', { ticketId, idx, type });
      const fwd = await tryForwardMessage(msg, controlGroupId);
      if (fwd.ok) {
        log('trace', 'sent attachment', { ticketId, idx, type, mode: 'msg.forward', msgId: fwd.msgId });
        return { ok: 1, mode: 'forward', msgId: fwd.msgId };
      }
      log('warn', 'av forward failed, fallback to downloadMedia', { ticketId, idx, type, reason: fwd.reason });
      const dl = await tryDownloadMediaReliable(msg, Math.min(mediaTimeoutMs, 30000), mediaRetryMs);
      if (!dl.ok) {
        log('warn', 'av downloadMedia failed', { ticketId, idx, type, attempts: dl.attempt });
        return { ok: 0, reason: 'av_download_failed' };
      }
      const r = await sendWithRetry(controlGroupId, dl.media, mediaOptsFor(type), 'sendMedia(av)');
      log('trace', 'sent attachment', {
        ticketId,
        idx,
        type,
        mode: 'downloadMedia',
        ok: r && r.ok ? 1 : 0,
        reason: safeStr(r && r.reason),
      });
      return r;
    }

    log('trace', 'media send start', { ticketId, idx, type });
    const dl = await tryDownloadMediaReliable(msg, mediaTimeoutMs, mediaRetryMs);
    if (dl.ok) {
      const r = await sendWithRetry(controlGroupId, dl.media, mediaOptsFor(type), 'sendMedia');
      log('trace', 'sent attachment', {
        ticketId,
        idx,
        type,
        mode: 'downloadMedia',
        ok: r && r.ok ? 1 : 0,
        reason: safeStr(r && r.reason),
      });
      return r;
    }

    log('warn', 'media download failed, fallback to forward', { ticketId, idx, type, attempts: dl.attempt });
    const fwd = await tryForwardMessage(msg, controlGroupId);
    log('trace', 'sent attachment', {
      ticketId,
      idx,
      type,
      mode: 'msg.forward',
      ok: fwd.ok ? 1 : 0,
      reason: safeStr(fwd.reason),
      msgId: fwd.msgId || '',
    });
    return fwd;
  }

  function bufferPush(ctx) {
    const msg = ctx.message;
    const chatId = safeStr(msg && msg.from);
    const key = getMsgKey(msg);
    const type = safeStr(msg && msg.type);

    if (!chatId) return;

    let entry = buf.get(chatId);
    if (!entry) {
      entry = {
        timer: null,
        items: [],
        seen: new Set(),
        fromName: safeStr(ctx.fromName || ''),
        fromChatId: chatId,
        createdAt: Date.now(),
      };
      buf.set(chatId, entry);
    }

    if (key) {
      if (entry.seen.has(key)) {
        log('detail', 'inbound dm duplicate ignored', { chatId, type, key });
        return;
      }
      entry.seen.add(key);
    }

    while (entry.items.length >= msgBufferMax) entry.items.shift();

    entry.items.push({
      msg,
      type: type || 'chat',
      hasMedia: !!(msg && msg.hasMedia),
      text: pickFirstText(msg),
      key,
    });

    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      flushBuffer(chatId).catch((e) => {
        log('error', 'flushBuffer exception', { chatId, err: safeStr(e && e.message ? e.message : e) });
      });
    }, burstMs);
  }

  async function flushBuffer(chatId) {
    if (flushing.has(chatId)) return;
    const entry = buf.get(chatId);
    if (!entry) return;

    flushing.add(chatId);

    try {
      if (entry.timer) clearTimeout(entry.timer);
      buf.delete(chatId);

      const items = entry.items || [];
      if (items.length === 0) return;

      const fromChatId = chatId;
      const fromName = entry.fromName || '';

      const mediaCount = items.filter((x) => x.hasMedia).length;
      const textParts = items.map((x) => safeStr(x.text)).filter(Boolean);
      const mergedText = Array.from(new Set(textParts)).join('\n').trim();

      const ticket = await SharedTicketCore.touch(meta, raw, 'fallback', {
        fromChatId,
        fromName,
      });

      const ticketId = ticket && ticket.ticketId ? ticket.ticketId : safeStr(ticket && ticket.id);
      if (!ticketId) {
        log('error', 'ticket create failed', { chatId });
        return;
      }

      const cardText = FallbackTicketCard.render(meta, raw, {
        ticketId,
        fromChatId,
        fromName,
        text: mergedText,
        mediaCount,
        items,
      });

      const cardRes = await sendWithRetry(controlGroupId, cardText, {}, 'sendCard');
      log('detail', 'sent ticket card', { ticketId, ok: cardRes && cardRes.ok ? 1 : 0, reason: safeStr(cardRes && cardRes.reason) });

      try {
        SharedMessageTicketMap.setFromResult(meta, raw, { ticketId, result: cardRes });
      } catch (e) {
        log('warn', 'SharedMessageTicketMap.setFromResult failed', { ticketId, err: safeStr(e && e.message ? e.message : e) });
      }

      let idx = 0;
      for (const it of items) {
        if (!it.hasMedia) continue;
        await sendAttachmentToControlGroup(ticketId, idx, it);
        idx += 1;
      }
    } finally {
      flushing.delete(chatId);
    }
  }

  async function handleGroupQuoteReply(ctx) {
    const msg = ctx.message;
    if (!msg) return;

    const chatId = safeStr(msg && msg.from);
    if (chatId !== controlGroupId) return;

    if (!msg.hasQuotedMsg) return;

    let quoted = null;
    try {
      quoted = await withTimeout(msg.getQuotedMessage(), quotedTimeoutMs, 'getQuotedMessage');
    } catch (e) {
      log('warn', 'getQuotedMessage failed', { err: safeStr(e && e.message ? e.message : e) });
      return;
    }
    if (!quoted) return;

    let ticketId = '';
    try {
      ticketId = safeStr(SharedMessageTicketMap.getTicketIdFromQuotedMessage(meta, raw, quoted));
    } catch (e) {
      log('warn', 'getTicketIdFromQuotedMessage failed', { err: safeStr(e && e.message ? e.message : e) });
      return;
    }
    if (!ticketId) {
      log('detail', 'group quote reply has no ticketId match');
      return;
    }

    let ticket = null;
    try {
      ticket = await SharedTicketCore.get(meta, raw, 'fallback', ticketId);
    } catch (e) {
      log('warn', 'ticket get failed', { ticketId, err: safeStr(e && e.message ? e.message : e) });
      return;
    }
    const toChatId = safeStr(ticket && ticket.fromChatId);
    if (!toChatId) {
      log('warn', 'ticket missing fromChatId', { ticketId });
      return;
    }

    const replyText = pickFirstText(msg);

    if (replyText) {
      const r = await sendWithRetry(toChatId, replyText, {}, 'replyText');
      log('trace', 'sent reply text', { ticketId, ok: r && r.ok ? 1 : 0, reason: safeStr(r && r.reason) });
      if (sendSpacingMs > 0) await sleepMs(sendSpacingMs);
    }

    if (msg.hasMedia) {
      const type = safeStr(msg.type);

      if (isAvType(type)) {
        if (sendSpacingMs > 0) await sleepMs(sendSpacingMs);
        log('trace', 'reply av forward start', { ticketId, type });
        const fwd = await tryForwardMessage(msg, toChatId);
        if (fwd.ok) {
          log('trace', 'sent reply media', { ticketId, type, mode: 'msg.forward', ok: 1, msgId: fwd.msgId });
          return;
        }
        log('warn', 'reply av forward failed, fallback downloadMedia', { ticketId, type, reason: fwd.reason });
        const dl = await tryDownloadMediaReliable(msg, Math.min(mediaTimeoutMs, 30000), mediaRetryMs);
        if (!dl.ok) {
          log('warn', 'reply av downloadMedia failed', { ticketId, type, attempts: dl.attempt });
          return;
        }
        const r = await sendWithRetry(toChatId, dl.media, mediaOptsFor(type), 'replyMedia(av)');
        log('trace', 'sent reply media', {
          ticketId,
          type,
          mode: 'downloadMedia',
          ok: r && r.ok ? 1 : 0,
          reason: safeStr(r && r.reason),
        });
        return;
      }

      const dl = await tryDownloadMediaReliable(msg, mediaTimeoutMs, mediaRetryMs);
      if (dl.ok) {
        const r = await sendWithRetry(toChatId, dl.media, mediaOptsFor(type), 'replyMedia');
        log('trace', 'sent reply media', { ticketId, type, mode: 'downloadMedia', ok: r && r.ok ? 1 : 0, reason: safeStr(r && r.reason) });
        return;
      }

      log('warn', 'reply media download failed, fallback forward', { ticketId, type, attempts: dl.attempt });
      const fwd = await tryForwardMessage(msg, toChatId);
      log('trace', 'sent reply media', {
        ticketId,
        type,
        mode: 'msg.forward',
        ok: fwd.ok ? 1 : 0,
        reason: safeStr(fwd.reason),
        msgId: fwd.msgId || '',
      });
    }
  }

  log('info', 'ready', {
    enabled: 1,
    controlGroupId,
    sendPrefer: safeStr(cfg.sendPrefer),
    burstMs,
    msgBufferMax,
    mediaTimeoutMs,
    mediaRetryMs,
    sendSpacingMs,
    avWarmupMs,
    forwardTimeoutMs,
    quotedTimeoutMs,
    moduleLog: logEnabled.info ? 1 : 0,
    bugLog: logEnabled.warn ? 1 : 0,
    detailLog: logEnabled.detail ? 1 : 0,
    traceLog: logEnabled.trace ? 1 : 0,
  });

  return {
    id: 'Fallback',
    onMessage: async (ctx) => {
      try {
        if (!ctx || !ctx.message) return;

        if (ctx.isGroup) {
          await handleGroupQuoteReply(ctx);
          return;
        }

        if (ctx.isDM) {
          const msg = ctx.message;
          log('trace', 'inbound dm', { chatId: safeStr(msg.from), hasMedia: msg.hasMedia ? 1 : 0, type: safeStr(msg.type) });
          bufferPush(ctx);
        }
      } catch (e) {
        log('error', 'onMessage exception', { err: safeStr(e && e.message ? e.message : e) });
      }
    },
    onEvent: async () => {},
  };
};
