'use strict';

/**
 * FallbackForwarderV1
 * - Forwards messages from customers to the control group.
 * - Handles deduplication to prevent repeated forwarding.
 * - Logs detailed debugging information.
 */

const SharedLog = require('../Shared/SharedLogV1');
const SharedSafeSend = require('../Shared/SharedSafeSendV1');
const TypeUtil = require('./FallbackTypeUtilV1');

const dedupeCache = new Map();

function isDuplicate(key, ttlMs, log) {
  const now = Date.now();
  for (const [k, t] of dedupeCache.entries()) if ((now - t) > ttlMs) dedupeCache.delete(k);

  if (dedupeCache.has(key)) {
    log.debug('Duplicate detected; message skipped', { key });
    return true;
  }

  dedupeCache.set(key, now);
  return false;
}

async function forwardText(meta, cfg, chatId, text, log) {
  const groupChatId = cfg.controlGroupId;

  if (!groupChatId) {
    log.error('Control group ID missing, cannot forward text.');
    return { ok: false, reason: 'noControlGroup' };
  }

  const sendResult = await SharedSafeSend.send(log, meta, groupChatId, text, {
    tag: 'forward_text'
  });

  if (!sendResult || !sendResult.ok) {
    log.warn('Failed to forward text', { chatId, reason: sendResult.reason || 'unknown' });
    return { ok: false };
  }

  log.info('Text successfully forwarded to control group', { chatId });
  return { ok: true };
}

async function forwardMedia(meta, cfg, chatId, raw, attachmentDetails, log) {
  const groupChatId = cfg.controlGroupId;

  if (!raw || !raw.hasMedia) {
    log.warn('No media to forward for chatId', { chatId });
    return { ok: false, reason: 'noMedia' };
  }

  const dedupeKey = `${chatId}|${raw.id}`;
  const dedupeTtlMs = cfg.dedupeMediaTtlMs || 30000;

  if (isDuplicate(dedupeKey, dedupeTtlMs, log)) {
    return { ok: true, skipped: true, reason: 'deduped' };
  }

  try {
    const media = await raw.downloadMedia();
    const caption = `📎 Attachment from user\nType: ${attachmentDetails.type}`;
    const sendResult = await SharedSafeSend.send(log, meta, groupChatId, media, { caption });

    if (!sendResult || !sendResult.ok) {
      log.error('Failed to forward media attachment', { chatId, reason: sendResult?.reason });
      return { ok: false };
    }

    log.info('Media successfully forwarded to control group', { chatId });
    return { ok: true };
  } catch (err) {
    log.error('Media download or forward failed', { chatId, error: err.message });
    return { ok: false, reason: 'mediaFailed' };
  }
}

async function forwardMessage(meta, cfg, ctx) {
  const log = SharedLog.create(meta, 'FallbackForwarderV1');
  const { chatId, message, raw } = ctx;

  log.info('Processing message from chatId', { chatId });

  const isGroup = ctx.isGroup || false;
  if (isGroup) {
    log.debug('Group message ignored', { chatId });
    return { ok: true, skipped: true, reason: 'groupMessage' };
  }

  // Deduplicate based on messageId
  const dedupeKey = `${chatId}|${message?.id || ''}`;
  const dedupeTtlMs = cfg.dedupeMsgTtlMs || 30000;

  if (isDuplicate(dedupeKey, dedupeTtlMs, log)) {
    return { ok: true, skipped: true, reason: 'deduped' };
  }

  // Forward Text
  const text = message?.text || raw?.body || '';
  if (text) {
    const textResult = await forwardText(meta, cfg, chatId, text, log);
    if (!textResult.ok) return textResult;
  } else {
    log.debug('No text content detected for forwarding', { chatId });
  }

  // Forward Media (if any)
  if (raw && raw.hasMedia) {
    const mediaResult = await forwardMedia(meta, cfg, chatId, raw, { type: raw.type || 'unknown' }, log);
    if (!mediaResult.ok) return mediaResult;
  }

  log.info('Message fully processed and forwarded', { chatId });
  return { ok: true };
}

module.exports = { forwardMessage };