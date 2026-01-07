"use strict";

const TICKET_RE = /\b\d{6}T\d{10}\b/g;

function splitCsv(s) {
  if (!s) return [];
  return String(s)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function pickSendFn(meta, preferCsv) {
  const prefer = splitCsv(preferCsv);
  for (const name of prefer) {
    try {
      const fn = meta && meta.getService ? meta.getService(name) : null;
      if (typeof fn === "function") return fn;
    } catch (_e) {}
  }

  const transport = meta && meta.getService ? meta.getService("transport") : null;
  if (transport && typeof transport.sendDirect === "function") {
    return async (chatId, payload, opts) => transport.sendDirect(chatId, payload, opts);
  }

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
  if (!toChatId || !rawMsg) return;

  const type = String(rawMsg.type || "").toLowerCase();
  const prefer = cfg && cfg.sendPrefer ? cfg.sendPrefer : "outsend,sendout,send";
  const sendFn = pickSendFn(meta, prefer);

  let cap = caption == null ? "" : String(caption);
  if (cfg && cfg.stripTicketInCustomerReply) cap = stripTicket(cap);
  if (isAudioLike(type)) cap = "";

  const isAv = isAudioLike(type) || type === "video";

  // for audio/video, forwarding is most reliable
  if (isAv && typeof rawMsg.forward === "function") {
    try {
      await rawMsg.forward(toChatId);
      return;
    } catch (_e) {}
  }

  if (typeof rawMsg.downloadMedia !== "function") {
    if (typeof rawMsg.forward === "function") {
      try {
        await rawMsg.forward(toChatId);
      } catch (_e) {}
    }
    return;
  }

  let media = null;
  try {
    media = await rawMsg.downloadMedia();
  } catch (_e) {
    media = null;
  }

  if (!media) {
    if (typeof rawMsg.forward === "function") {
      try {
        await rawMsg.forward(toChatId);
      } catch (_e) {}
    }
    return;
  }

  const opts = {};
  if (cap.trim() && !isAudioLike(type)) opts.caption = cap.trim();

  await sendFn(toChatId, media, opts);
};
