'use strict';

// StatusFeedV1 (Core)
// Routes status@broadcast to a dedicated FEED group (WorkGroups tag: feed)
// and stops propagation so status never pollutes other pipelines.

function toBool(v, d = false) {
  if (v === undefined || v === null || v === '') return d;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return d;
}
function toInt(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function trim(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }

function safeSnippet(text, maxLen = 240) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? (s.slice(0, maxLen) + '…') : s;
}

function isStatus(chatId, raw) {
  const id = trim(chatId);
  const from = trim(raw?.from || raw?._data?.from || '');
  return (id === 'status@broadcast' || from === 'status@broadcast');
}

function pickSendFn(meta, preferList) {
  const names = Array.isArray(preferList) && preferList.length ? preferList : ['outsend', 'sendout', 'send'];
  for (const name of names) {
    const svc = meta.getService ? meta.getService(name) : null;
    if (!svc) continue;

    if (typeof svc === 'function') return { name, fn: svc };

    if (typeof svc === 'object' && svc && typeof svc.sendText === 'function') {
      const fn = async (payload) => {
        if (svc.sendText.length <= 1) return await svc.sendText(payload);
        return await svc.sendText(payload.chatId, payload.text, payload);
      };
      return { name, fn };
    }
  }
  return null;
}

module.exports.init = async function init(meta) {
  const cfg = meta.implConf || {};

  const enabled = toBool(cfg.enabled, true);
  if (!enabled) {
    meta.log('StatusFeedV1', 'disabled by config');
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const feedTag = trim(cfg.feedTag || 'feed').toLowerCase();
  const prefix = trim(cfg.prefix || '📣 STATUS FEED');
  const ignoreEmpty = toBool(cfg.ignoreEmpty, true);
  const dedupeSec = toInt(cfg.dedupeSec, 30);

  const sendPrefer = String(cfg.sendPrefer || 'outsend,sendout,send')
    .split(',').map(s => s.trim()).filter(Boolean);

  // in-memory dedupe
  const lastMap = new Map();
  function seenRecently(key) {
    if (dedupeSec <= 0) return false;
    const now = Date.now();
    const hit = lastMap.get(key);
    if (hit && (now - hit.atMs) <= (dedupeSec * 1000)) return true;
    lastMap.set(key, { atMs: now });
    if (lastMap.size > 2000) lastMap.clear();
    return false;
  }

  meta.log('StatusFeedV1', `ready feedTag=${feedTag} dedupeSec=${dedupeSec} ignoreEmpty=${ignoreEmpty ? 1 : 0}`);

  async function forwardStatus(ctxLike) {
    const workgroups = meta.getService && meta.getService('workgroups');
    const feedGroupId = (workgroups && typeof workgroups.getGroup === 'function')
      ? workgroups.getGroup(feedTag)
      : '';

    // If not bound, just swallow status so it never pollutes other groups
    if (!feedGroupId) return;

    const pick = pickSendFn(meta, sendPrefer);
    if (!pick) return;

    const text = safeSnippet(ctxLike.text || ctxLike.caption || '');
    if (ignoreEmpty && !text) return;

    const senderName = ctxLike.sender?.name || '(unknown)';
    const senderId = ctxLike.sender?.id || '';
    const key = `${senderId}|${text}`;
    if (seenRecently(key)) return;

    const out = [
      prefix,
      `From: ${senderName}`,
      text ? `Text: ${text}` : 'Text: (empty)',
    ].join('\n');

    await pick.fn({ chatId: feedGroupId, text: out });
  }

  return {
    // Primary path: messages come as onMessage (your log shows [msg] status@broadcast)
    onMessage: async (ctx) => {
      try {
        if (!ctx || !isStatus(ctx.chatId, ctx.raw)) return;
        await forwardStatus(ctx);
        // IMPORTANT: stopPropagation here so status never reaches business/fallback pipelines
        if (typeof ctx.stopPropagation === 'function') ctx.stopPropagation();
      } catch (e) {
        meta.log('StatusFeedV1', `error onMessage: ${e && e.message ? e.message : String(e)}`);
      }
    },

    // Fallback path: if connector sends status via onEvent in future, still safe
    onEvent: async (evt) => {
      try {
        if (!evt || !isStatus(evt.chatId, evt.raw)) return;
        await forwardStatus(evt);
      } catch (e) {
        meta.log('StatusFeedV1', `error onEvent: ${e && e.message ? e.message : String(e)}`);
      }
    },
  };
};
