"use strict";

const SharedLog = require('../Shared/SharedLogV1');

const TICKET_RE = /\b\d{6}T\d{10}\b/g;

function splitCsv(s) {
  if (!s) return [];
  return String(s)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function pickSendFn(meta, preferCsv, log) {
  const prefer = splitCsv(preferCsv);
  if (log && log.debug) log.debug('pickSendFn trying services: ' + prefer.join(', '));
  
  for (const name of prefer) {
    try {
      const fn = meta && meta.getService ? meta.getService(name) : null;
      if (typeof fn === "function") {
        if (log && log.debug) log.debug('pickSendFn selected service: ' + name);
        return fn;
      }
    } catch (_e) {
      if (log && log.warn) log.warn('pickSendFn service ' + name + ' threw error: ' + (_e && _e.message ? _e.message : _e));
    }
  }

  const transport = meta && meta.getService ? meta.getService("transport") : null;
  if (transport && typeof transport.sendDirect === "function") {
    if (log && log.debug) log.debug('pickSendFn using transport.sendDirect');
    return async (chatId, payload, opts) => transport.sendDirect(chatId, payload, opts);
  }

  if (log && log.error) log.error('pickSendFn: No outbound send service available from: ' + prefer.join(', '));
  return async () => {
    throw new Error("No outbound send service");
  };
}

function stripTicket(text) {
  const s = text == null ? "" : String(text);
  return s.replace(TICKET_RE, " ").replace(/\s+/g, " ").trim();
}

function isAudioLike(type) {
  return type === "audio" || type === "ptt";
}

module.exports.sendMedia = async function sendMedia(meta, cfg, toChatId, rawMsg, caption) {
  const log = SharedLog.makeLog(meta, 'FallbackReplyMediaV1', {
    debugEnabled: cfg && cfg.debugLog,
    traceEnabled: cfg && cfg.traceLog
  });

  if (!toChatId || !rawMsg) {
    if (log && log.warn) log.warn('sendMedia: missing toChatId or rawMsg');
    return { ok: false, reason: 'missingParams' };
  }

  const type = String(rawMsg.type || "").toLowerCase();
  if (log && log.debug) log.debug('sendMedia: type=' + type + ' to=' + toChatId);

  const prefer = cfg && cfg.sendPrefer ? cfg.sendPrefer : "outsend,sendout,send";
  const sendFn = pickSendFn(meta, prefer, log);

  let cap = caption == null ? "" : String(caption);
  if (cfg && cfg.stripTicketInCustomerReply) cap = stripTicket(cap);
  if (isAudioLike(type)) cap = "";

  const isAv = isAudioLike(type) || type === "video";

  // for audio/video, forwarding is most reliable
  if (isAv && typeof rawMsg.forward === "function") {
    if (log && log.debug) log.debug('sendMedia: attempting forward for AV type=' + type);
    try {
      await rawMsg.forward(toChatId);
      if (log && log.info) log.info('sendMedia: forward success type=' + type);
      return { ok: true, mode: 'forward', type };
    } catch (e) {
      if (log && log.warn) log.warn('sendMedia: forward failed type=' + type + ' err=' + (e && e.message ? e.message : e));
    }
  }

  if (typeof rawMsg.downloadMedia !== "function") {
    if (log && log.warn) log.warn('sendMedia: downloadMedia not available, attempting forward');
    if (typeof rawMsg.forward === "function") {
      try {
        await rawMsg.forward(toChatId);
        if (log && log.info) log.info('sendMedia: fallback forward success type=' + type);
        return { ok: true, mode: 'fallbackForward', type };
      } catch (e) {
        if (log && log.error) log.error('sendMedia: fallback forward failed type=' + type + ' err=' + (e && e.message ? e.message : e));
        return { ok: false, reason: 'forwardFailed', error: e && e.message ? e.message : String(e) };
      }
    }
    if (log && log.error) log.error('sendMedia: no download or forward available');
    return { ok: false, reason: 'noDownloadOrForward' };
  }

  let media = null;
  if (log && log.debug) log.debug('sendMedia: attempting downloadMedia type=' + type);
  try {
    media = await rawMsg.downloadMedia();
    if (log && log.debug) log.debug('sendMedia: downloadMedia success type=' + type);
  } catch (e) {
    if (log && log.warn) log.warn('sendMedia: downloadMedia failed type=' + type + ' err=' + (e && e.message ? e.message : e));
    media = null;
  }

  if (!media) {
    if (log && log.warn) log.warn('sendMedia: media is null after download, attempting forward');
    if (typeof rawMsg.forward === "function") {
      try {
        await rawMsg.forward(toChatId);
        if (log && log.info) log.info('sendMedia: forward after download fail success type=' + type);
        return { ok: true, mode: 'forwardAfterDownloadFail', type };
      } catch (e) {
        if (log && log.error) log.error('sendMedia: forward after download fail failed type=' + type + ' err=' + (e && e.message ? e.message : e));
        return { ok: false, reason: 'downloadAndForwardFailed', error: e && e.message ? e.message : String(e) };
      }
    }
    if (log && log.error) log.error('sendMedia: download failed and no forward available');
    return { ok: false, reason: 'downloadFailed' };
  }

  const opts = {};
  if (cap.trim() && !isAudioLike(type)) opts.caption = cap.trim();

  if (log && log.debug) log.debug('sendMedia: attempting send with sendFn type=' + type);
  try {
    await sendFn(toChatId, media, opts);
    if (log && log.info) log.info('sendMedia: send success type=' + type);
    return { ok: true, mode: 'send', type };
  } catch (e) {
    if (log && log.error) log.error('sendMedia: send failed type=' + type + ' err=' + (e && e.message ? e.message : e));
    return { ok: false, reason: 'sendFailed', error: e && e.message ? e.message : String(e) };
  }
};
