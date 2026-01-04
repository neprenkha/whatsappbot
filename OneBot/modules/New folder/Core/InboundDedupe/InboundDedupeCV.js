/**
 * InboundDedupeCV.js
 * Dedupe inbound message events (protects against duplicate WhatsApp Web events).
 *
 * Behavior:
 * - Prefer stable message id if available.
 * - If id is missing/unstable, dedupe by (senderId + chatId + normalized text + media signature)
 *   within dedupeSec window.
 *
 * This file is compatible with two module styles:
 * - meta.on("message", ...) event-style (newer)
 * - return { onMessage, onEvent } (older Kernel style)
 */

"use strict";

const crypto = require("crypto");

function safeStr(v) {
  if (v === null || v === undefined) return "";
  try { return String(v); } catch (e) { return ""; }
}

function safeInt(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

function hash1(s) {
  return crypto.createHash("sha1").update(s, "utf8").digest("hex");
}

function getMsgId(ctx) {
  const m = (ctx && ctx.message) ? ctx.message : null;

  // Common shapes
  const direct =
    (m && m.id) ||
    (m && m.msgId) ||
    (m && m.messageId) ||
    (ctx && ctx.msgId) ||
    (ctx && ctx.messageId);

  // If it's an object, try common WA shapes
  if (direct && typeof direct === "object") {
    const s1 = safeStr(direct._serialized);
    if (s1) return s1;

    const s2 = safeStr(direct.id);
    if (s2) return s2;

    const s3 = safeStr(direct._id);
    if (s3) return s3;
  }

  const s = safeStr(direct);
  if (s) return s;

  // Some drivers store id nested
  if (m && m._data && m._data.id) {
    const s4 = safeStr(m._data.id._serialized || m._data.id.id || m._data.id);
    if (s4) return s4;
  }

  return "";
}

function getSenderId(ctx) {
  const s = (ctx && ctx.sender) ? ctx.sender : null;
  return safeStr(
    (ctx && ctx.senderId) ||
    (s && (s.id || s._id || s.user || s.phone)) ||
    (ctx && ctx.from) ||
    ""
  );
}

function getChatId(ctx) {
  return safeStr((ctx && ctx.chatId) || (ctx && ctx.to) || (ctx && ctx.chat) || "");
}

function getText(ctx) {
  if (!ctx) return "";
  if (typeof ctx.text === "string") return ctx.text;
  const m = ctx.message || {};
  if (typeof m.text === "string") return m.text;
  if (typeof m.body === "string") return m.body;
  if (typeof m.caption === "string") return m.caption;
  return "";
}

function normalizeText(t) {
  let s = safeStr(t);
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  s = s.trim();
  // Keep whitespace mostly as-is, but collapse extreme runs to avoid driver differences
  s = s.replace(/[ \t]{3,}/g, "  ");
  return s;
}

function getMediaSig(ctx) {
  const m = (ctx && ctx.message) ? ctx.message : null;
  if (!m) return "";
  // A light signature that helps distinguish text vs media messages
  const hasMedia = !!(m.hasMedia || m.media || m.mimetype || m.mimeType);
  const mt = safeStr(m.mimetype || m.mimeType);
  const fn = safeStr(m.filename || m.fileName || (m.media && m.media.filename) || "");
  const sz = safeStr(m.size || (m.media && m.media.size) || "");
  if (!hasMedia && !mt && !fn && !sz) return "";
  return [hasMedia ? "1" : "0", mt, fn, sz].join(":");
}

function makeDedupeModule(meta, cfg) {
  // cfg can be passed or read from meta.implConf
  cfg = cfg || (meta && meta.implConf) || {};

  const enabled = safeInt(cfg && cfg.enabled, 1) === 1;
  const dedupeSec = Math.max(1, safeInt(cfg && cfg.dedupeSec, 4));
  const maxKeys = Math.max(100, safeInt(cfg && cfg.maxKeys, 8000));
  const logDrops = safeInt(cfg && cfg.logDrops, 0) === 1;

  // Keep same knobs (if you ever want to allow self-messages or commands through)
  const hashForFromMe = safeInt(cfg && cfg.hashForFromMe, 1) === 1;
  const hashForCommands = safeInt(cfg && cfg.hashForCommands, 1) === 1;

  const map = new Map(); // key -> expireAtMs

  function cleanup(now) {
    // Remove expired
    for (const [k, exp] of map.entries()) {
      if (exp <= now) map.delete(k);
    }
    // Trim oldest if too large
    if (map.size <= maxKeys) return;
    const extra = map.size - maxKeys;
    let i = 0;
    for (const k of map.keys()) {
      map.delete(k);
      i += 1;
      if (i >= extra) break;
    }
  }

  function shouldDedupe(ctx, textNorm) {
    const isFromMe = !!(ctx && (ctx.isFromMe || (ctx.message && ctx.message.fromMe) || ctx.fromMe || ctx.message && ctx.message.fromMe));
    const isCommand = (textNorm || "").startsWith("!");
    if (isFromMe && !hashForFromMe) return false;
    if (isCommand && !hashForCommands) return false;
    return true;
  }

  function checkAndMark(ctx) {
    if (!enabled) return { dropped: false };

    const now = Date.now();
    cleanup(now);

    const id = getMsgId(ctx);
    const senderId = getSenderId(ctx);
    const chatId = getChatId(ctx);
    const textNorm = normalizeText(getText(ctx));
    const mediaSig = getMediaSig(ctx);

    const keyId = id ? "id:" + id : "";
    const doHash = shouldDedupe(ctx, textNorm);
    const rawForHash = [senderId, chatId, textNorm, mediaSig].join("|");
    const keyHash = doHash ? ("h:" + hash1(rawForHash)) : "";

    if (keyId || keyHash) {
      const expId = keyId ? map.get(keyId) : null;
      const expHash = keyHash ? map.get(keyHash) : null;
      if ((expId && expId > now) || (expHash && expHash > now)) {
        if (logDrops) {
          try {
            meta && meta.log && meta.log("InboundDedupeV1", "drop duplicate id=" + (keyId ? keyId.slice(0, 24) : "") + " hash=" + (keyHash ? keyHash.slice(0, 16) : ""));
          } catch (_) {}
        }
        // mark ctx for older-style frameworks
        if (ctx) {
          try {
            ctx.drop = true;
            ctx.stop = true;
            if (typeof ctx.stopPropagation === "function") ctx.stopPropagation();
          } catch (_) {}
        }
        return { dropped: true };
      }

      const exp = now + (dedupeSec * 1000);
      if (keyHash) map.set(keyHash, exp);
      if (keyId) map.set(keyId, exp);
    }

    return { dropped: false };
  }

  // Return the handlers for older-style Kernel (onMessage/onEvent) or allow caller to attach event
  return {
    checkAndMark,
    metaInfo() {
      try {
        meta && meta.log && meta.log(
          "InboundDedupeV1",
          "ready enabled=" + (enabled ? 1 : 0) +
            " dedupeSec=" + dedupeSec +
            " maxKeys=" + maxKeys +
            " logDrops=" + (logDrops ? 1 : 0) +
            " hashForFromMe=" + (hashForFromMe ? 1 : 0) +
            " hashForCommands=" + (hashForCommands ? 1 : 0)
        );
      } catch (_) {}
    },
    onMessageHandler: async function (ctx, next) {
      // This is used when meta.on("message", ...) exists
      if (!enabled) {
        if (typeof next === "function") return next();
        return;
      }
      try {
        const res = checkAndMark(ctx);
        if (res.dropped) return; // drop and do not call next()
      } catch (e) {
        try { meta && meta.log && meta.log("InboundDedupeV1", "error " + (e && e.message ? e.message : String(e))); } catch (_) {}
      }
      if (typeof next === "function") return next();
    },
    onMessageLegacy: async function (ctx) {
      // Older Kernel-style: mark ctx.drop/stop and return
      if (!enabled) return;
      try {
        const res = checkAndMark(ctx);
        if (res.dropped) return;
      } catch (e) {
        try { meta && meta.log && meta.log("InboundDedupeV1", "error " + (e && e.message ? e.message : String(e))); } catch (_) {}
      }
    },
  };
}

async function init(meta, cfg) {
  const mod = makeDedupeModule(meta, cfg);
  mod.metaInfo();

  // If meta.on exists (newer event API), register listener and use next()
  if (meta && typeof meta.on === "function") {
    meta.on("message", async (ctx, next) => {
      // delegate to handler that calls next()
      await mod.onMessageHandler(ctx, next);
    });
    // return nothing (or undefined) for event-style
    return;
  }

  // Otherwise, return legacy handlers expected by older Kernel
  return {
    onMessage: mod.onMessageLegacy,
    onEvent: async () => {},
  };
}

module.exports = { init };