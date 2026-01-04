/**
 * FallbackV1.js
 * Minimal safe fallback:
 * - Forwards incoming DM messages to the Control Group (WorkGroup/AccessRoles control).
 * - Ignores status@broadcast and ignores messages already inside the control group to prevent loops.
 *
 * NOTE:
 * Group -> customer reply routing is handled by a separate module (Ticket/Inbox) later.
 */
'use strict';

function toBool(v, dflt) {
  if (v === undefined || v === null || v === '') return !!dflt;
  const s = String(v).trim().toLowerCase();
  if (['1','true','yes','y','on'].includes(s)) return true;
  if (['0','false','no','n','off'].includes(s)) return false;
  return !!dflt;
}

function splitCsv(v) {
  return String(v || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function safeStr(v) {
  return (v === undefined || v === null) ? '' : String(v);
}

module.exports.init = async (meta) => {
  const cfg = meta.implConf || {};
  const enabled = toBool(cfg.enabled, true);

  const forwardDm = toBool(cfg.forwardDm, true);
  const forwardGroups = toBool(cfg.forwardGroups, false);

  const ignoreBroadcast = toBool(cfg.ignoreBroadcast, true);
  const ignoreChatIds = new Set(splitCsv(cfg.ignoreChatIds || ''));

  const sendPrefer = splitCsv(cfg.sendPrefer || 'outsend,sendout,send');
  const sendSvcName = safeStr(cfg.send || '').trim();

  let controlGroupId = safeStr(cfg.controlGroupId).trim();
  if (!controlGroupId) {
    const access = meta.getService ? (meta.getService('accessroles') || meta.getService('access') || meta.getService('roles')) : null;
    if (access && access.controlGroupId) controlGroupId = safeStr(access.controlGroupId).trim();
  }

  function pickSend() {
    if (!meta.getService) return null;
    if (sendSvcName) {
      const fixed = meta.getService(sendSvcName);
      if (typeof fixed === 'function') return fixed;
    }
    for (const n of sendPrefer) {
      const fn = meta.getService(n);
      if (typeof fn === 'function') return fn;
    }
    const fallback = meta.getService('send');
    return (typeof fallback === 'function') ? fallback : null;
  }

  if (!enabled) {
    try { meta.log('FallbackV1', 'disabled enabled=0'); } catch (_) {}
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  if (!controlGroupId) {
    try { meta.log('FallbackV1', 'disabled: controlGroupId missing'); } catch (_) {}
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const send = pickSend();
  if (typeof send !== 'function') {
    try { meta.log('FallbackV1', 'disabled: no send service available'); } catch (_) {}
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  try {
    meta.log('FallbackV1', `ready enabled=1 controlGroupId=${controlGroupId} sendPrefer=${sendPrefer.join(',')}`);
  } catch (_) {}

  function buildForwardText(ctx) {
    const fromName = safeStr(ctx?.sender?.name || ctx?.senderName || '');
    const fromPhone = safeStr(ctx?.sender?.phone || '');
    const fromId = safeStr(ctx?.sender?.id || '');
    const chatId = safeStr(ctx?.chatId || '');
    const text = safeStr(ctx?.text || '').trim();

    const who = [fromName, fromPhone].filter(Boolean).join(' ');
    const header = `📥 DM Fallback\nFrom: ${who || fromId || '(unknown)'}\nChatId: ${chatId}`;
    return `${header}\n\n${text || '(no text)'}`;
  }

  async function onMessage(ctx) {
    try {
      const chatId = safeStr(ctx?.chatId || '');
      const isGroup = !!ctx?.isGroup;
      const text = safeStr(ctx?.text || '');

      if (!chatId) return;
      if (ignoreBroadcast && chatId === 'status@broadcast') return;
      if (ignoreChatIds.has(chatId)) return;

      if (chatId === controlGroupId) return;

      if (isGroup && !forwardGroups) return;
      if (!isGroup && !forwardDm) return;

      if (!text || !text.trim()) return;

      const msg = buildForwardText(ctx);

      const res = await send(controlGroupId, msg, { bypass: 1 });

      if (res && res.ok === false) {
        const outbox = meta.getService ? meta.getService('outbox') : null;
        if (outbox && typeof outbox.enqueue === 'function') {
          await outbox.enqueue(controlGroupId, msg, { bypass: 1 });
        }
      }
    } catch (e) {
      try { meta.log('FallbackV1', `err onMessage ${e && e.message ? e.message : String(e)}`); } catch (_) {}
    }
  }

  return { onMessage, onEvent: async () => {} };
};
