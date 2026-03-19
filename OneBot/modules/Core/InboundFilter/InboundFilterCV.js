'use strict';

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return !!fallback;
  const text = String(value).trim().toLowerCase();
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true;
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false;
  return !!fallback;
}

function toText(value) {
  return String(value === undefined || value === null ? '' : value);
}

function getRaw(ctx) {
  return ctx && ctx.raw && typeof ctx.raw === 'object' ? ctx.raw : {};
}

function getType(ctx) {
  return toText(getRaw(ctx).type).trim().toLowerCase();
}

function getChatId(ctx) {
  return toText(ctx && ctx.chatId).trim();
}

function getFromMe(ctx) {
  return !!getRaw(ctx).fromMe;
}

function getSenderId(ctx) {
  const raw = getRaw(ctx);
  return toText(
    (ctx && (ctx.senderId || ctx.author || ctx.from)) ||
    raw.participant ||
    raw.author ||
    raw.from ||
    ''
  ).trim();
}

function getText(ctx) {
  return toText(ctx && ctx.text).trim();
}

function isStatusBroadcast(ctx) {
  const chatId = getChatId(ctx);
  const from = toText(getRaw(ctx).from).trim();
  return chatId === 'status@broadcast' || from === 'status@broadcast';
}

function isEmptySystem(ctx) {
  const type = getType(ctx);
  const empty = getText(ctx) === '';
  return empty && (
    type === 'protocol' ||
    type === 'e2e_notification' ||
    type === 'notification_template' ||
    type === 'notification' ||
    type === 'ciphertext'
  );
}

function isLidIdentity(value) {
  return toText(value).trim().toLowerCase().endsWith('@lid');
}

function toLowerSet(csv) {
  return new Set(
    toText(csv)
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
  );
}

function stopIfPossible(ctx) {
  if (ctx && typeof ctx.stopPropagation === 'function') {
    ctx.stopPropagation();
    return true;
  }
  return false;
}

module.exports = {
  init: async (meta) => {
    const cfg = meta && meta.implConf ? meta.implConf : {};
    const log = meta && typeof meta.log === 'function' ? meta.log : () => {};
    const tag = 'InboundFilterCV';

    const enabled = toBool(cfg.enabled, true);
    const moduleLog = toBool(cfg.moduleLog, true);
    const bugLog = toBool(cfg.bugLog, true);
    const detailLog = toBool(cfg.detailLog, false);
    const traceLog = toBool(cfg.traceLog, false);

    const dropStatusBroadcast = toBool(cfg.dropStatusBroadcast, false);
    const dropEmptySystem = toBool(cfg.dropEmptySystem, true);
    const dropFromMe = toBool(cfg.dropFromMe, false);
    const dropLid = toBool(cfg.dropLid, true);
    const dropChatIdCsv = toLowerSet(cfg.dropChatIds);

    if (!enabled) {
      if (moduleLog) log(tag, 'disabled enabled=0');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    if (moduleLog) {
      log(tag, 'ready enabled=1 dropStatusBroadcast=' + (dropStatusBroadcast ? '1' : '0') + ' dropEmptySystem=' + (dropEmptySystem ? '1' : '0') + ' dropFromMe=' + (dropFromMe ? '1' : '0'));
    }

    async function onMessage(ctx) {
      if (!ctx) return;

      const chatId = getChatId(ctx);
      const fromMe = getFromMe(ctx) ? '1' : '0';
      const type = getType(ctx);

      if (dropStatusBroadcast && isStatusBroadcast(ctx)) {
        stopIfPossible(ctx);
        if (moduleLog || detailLog || traceLog) log(tag, 'drop reason=status_broadcast chatId=' + chatId + ' fromMe=' + fromMe + ' type=' + type);
        return;
      }

      const senderId = getSenderId(ctx);
      const chatLower = chatId.toLowerCase();
      const senderLower = senderId.toLowerCase();

      if (dropFromMe && getFromMe(ctx)) {
        stopIfPossible(ctx);
        if (moduleLog || detailLog || traceLog) log(tag, 'drop reason=from_me chatId=' + chatId + ' fromMe=' + fromMe + ' type=' + type);
        return;
      }

      if (dropLid && (isLidIdentity(chatId) || isLidIdentity(senderId))) {
        stopIfPossible(ctx);
        if (moduleLog || detailLog || traceLog) log(tag, 'drop reason=lid_identity chatId=' + chatId + ' senderId=' + senderId + ' fromMe=' + fromMe + ' type=' + type);
        return;
      }

      if (dropChatIdCsv.size && (dropChatIdCsv.has(chatLower) || dropChatIdCsv.has(senderLower))) {
        stopIfPossible(ctx);
        if (moduleLog || detailLog || traceLog) log(tag, 'drop reason=chatid_blocklist chatId=' + chatId + ' senderId=' + senderId + ' fromMe=' + fromMe + ' type=' + type);
        return;
      }

      if (dropEmptySystem && isEmptySystem(ctx)) {
        stopIfPossible(ctx);
        if (moduleLog || detailLog || traceLog) log(tag, 'drop reason=empty_system chatId=' + chatId + ' fromMe=' + fromMe + ' type=' + type);
        return;
      }

      if (detailLog || traceLog) {
        log(tag, 'pass chatId=' + chatId + ' fromMe=' + fromMe + ' type=' + type);
      }
    }

    async function onEvent() {}

    return { onMessage, onEvent };
  },
};