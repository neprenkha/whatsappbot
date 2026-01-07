"use strict";

const Conf = require("../Shared/SharedConfV1");
const SharedLog = require("../Shared/SharedLogV1");
const TicketCore = require("../Shared/SharedTicketCoreV1");
const TicketCard = require("./FallbackTicketCardV1");
const QuoteReply = require("./FallbackQuoteReplyV1");
const SafeSend = require("../Shared/SharedSafeSendV1");

function safeText(s) {
  return String(s || "").replace(/\r\n/g, "\n").trim();
}

async function forwardMediaToGroup(log, sendFn, groupId, msg) {
  try {
    if (msg && typeof msg.forward === "function") {
      await msg.forward(groupId);
      return true;
    }
  } catch (e) {
    log.warn("[FallbackCV] forward failed. Trying download+send", { error: e.message });
  }
  try {
    const media = msg && msg.downloadMedia ? await msg.downloadMedia() : null;
    if (!media) throw new Error("No media downloaded.");
    const opts = msg.type !== "audio" ? { caption: safeText(msg.body) } : {};
    await sendFn(groupId, media, opts);
    return true;
  } catch (e) {
    log.error("[FallbackCV] Media sending failed.", { error: e.message });
    return false;
  }
}

module.exports.init = async function init(meta) {
  const conf = Conf.load(meta);
  const log = SharedLog.create(meta, "FallbackCV");

  const controlGroupId = conf.getStr("controlGroupId", "");
  if (!controlGroupId) {
    log.error("ControlGroupId is required but missing. Module disabled safely.");
    return { onMessage: async () => {}, onEvent: async () => {} }; // Fail silently
  }

  const sendSel = SafeSend.pickSend(meta, conf.getStr("sendPrefer", "outsend,sendout,send"));
  const sendFn = sendSel?.fn;

  if (!sendFn || typeof sendFn !== "function") {
    log.error(`[FallbackCV] Missing or invalid send function. Available services:`, Object.keys(meta.services || {}));
    return { onMessage: async () => {}, onEvent: async () => {} }; // Fail silently
  }

  async function onMessage(ctx) {
    try {
      if (!ctx || !ctx.chatId) return;

      log.info("[FallbackCV] Handling new message:", ctx.text || ctx.message);

      if (ctx.isGroup && ctx.chatId === controlGroupId) {
        log.debug("[FallbackCV] Ignoring ControlGroup message.");
        return; // Skip messages from the control group
      }

      const msg = ctx.message;
      const isMedia = msg && msg.hasMedia;
      const text = safeText(ctx.text);

      if (!isMedia && !text) {
        log.warn("[FallbackCV] Empty message received. Skipped.");
        return;
      }

      // Attempt ticket processing
      const ticketRes = await TicketCore.touch(meta, conf, conf.getStr("ticketType", "fallback"), ctx.chatId, {
        name: ctx.sender?.name || "",
        phone: ctx.sender?.phone || "",
        text,
      });

      if (ticketRes && ticketRes.ok) {
        log.debug(`[FallbackCV] Ticket processed. ID: ${ticketRes.ticketId}`);
      }

      // Forward the message
      if (isMedia) {
        const forwarded = await forwardMediaToGroup(log, sendFn, controlGroupId, msg);
        if (forwarded) {
          log.debug(`[FallbackCV] Media forwarded successfully.`);
        } else {
          log.warn(`[FallbackCV] Media forwarding failed.`);
        }
      }

    } catch (error) {
      log.error("[FallbackCV] Error in onMessage handler:", { errorMessage: error.message, stack: error.stack });
    }
  }

  async function onEvent(event) {
    log.info("[FallbackCV] Received event:", event);
  }

  return { onMessage, onEvent };
};