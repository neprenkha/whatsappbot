'use strict';

/*
FallbackMediaForwardQueueV1
- DM -> Control Group media forward helper (queue + retry)
- Uses rawMsg.downloadMedia() (not transport.downloadMedia)
*/

const SharedLog = require('../Shared/SharedLogV1');

function splitCsv(s) {
  if (!s) return [];
  return String(s).split(',').map(x => x.trim()).filter(Boolean);
}

function pickSendFn(meta, preferCsv) {
  const prefer = splitCsv(preferCsv || 'outsend,sendout,send');

  for (const name of prefer) {
    try {
      const svc = meta.getService(name);
      if (typeof svc === 'function') return { name, fn: svc };
      if (svc && typeof svc.sendDirect === 'function') {
        return { name, fn: async (chatId, payload, opts) => svc.sendDirect(chatId, payload, opts || {}) };
      }
    } catch (_e) {}
  }

  try {
    const t = meta.getService('transport');
    if (t && typeof t.sendDirect === 'function') {
      return { name: 'transport', fn: async (chatId, payload, opts) => t.sendDirect(chatId, payload, opts || {}) };
    }
  } catch (_e) {}

  return { name: '', fn: null };
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function _asString(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err && err.message) return String(err.message);
  try { return JSON.stringify(err); } catch (_e) { return String(err); }
}

const state = { queue: [], busy: false };

function _enqueue(it) {
  state.queue.push(it);
}

async function _run(meta) {
  if (state.busy) return;
  state.busy = true;

  const log = SharedLog.create(meta, 'FallbackMediaForwardQueueV1');

  try {
    while (state.queue.length > 0) {
      const it = state.queue.shift();
      const { groupChatId, rawMsg, caption, maxRetry, retryDelayMs, sendPrefer } = it;

      const sendSel = pickSendFn(meta, sendPrefer);
      if (!sendSel.fn) {
        log.error('no send function for media forward');
        continue;
      }

      if (!rawMsg || typeof rawMsg.downloadMedia !== 'function') {
        log.error('rawMsg.downloadMedia not available');
        continue;
      }

      let media = null;
      try {
        media = await rawMsg.downloadMedia();
      } catch (e) {
        log.error('downloadMedia failed err=' + _asString(e));
        continue;
      }

      if (!media) {
        log.error('downloadMedia returned empty');
        continue;
      }

      const type = rawMsg && rawMsg.type ? String(rawMsg.type).toLowerCase() : '';
      const isAudio = (type.indexOf('audio') >= 0 || type.indexOf('ptt') >= 0 || type.indexOf('voice') >= 0);

      const opt = {};
      if (!isAudio && caption) opt.caption = String(caption);

      let tries = 0;
      const lim = Math.max(1, maxRetry || 3);
      let ok = false;

      while (!ok && tries < lim) {
        tries += 1;
        try {
          await sendSel.fn(groupChatId, media, opt);
          ok = true;
        } catch (e) {
          const msg = _asString(e);
          log.warn('forward media failed tries=' + tries + ' err=' + msg);
          if (msg.toLowerCase().indexOf('window') >= 0 && tries < lim) {
            await _sleep(Math.max(800, retryDelayMs || 1200));
            continue;
          }
          break;
        }
      }

      await _sleep(250);
    }
  } finally {
    state.busy = false;
  }
}

async function forward(meta, cfgRaw, groupChatId, ctx, caption) {
  const log = SharedLog.create(meta, 'FallbackMediaForwardQueueV1');
  const raw = ctx && ctx.raw ? ctx.raw : null;
  if (!raw) return { ok: false, reason: 'noraw' };

  _enqueue({
    groupChatId,
    rawMsg: raw,
    caption: caption || '',
    maxRetry: (cfgRaw && cfgRaw.mediaForwardRetry) ? Number(cfgRaw.mediaForwardRetry) : 3,
    retryDelayMs: (cfgRaw && cfgRaw.mediaForwardRetryDelayMs) ? Number(cfgRaw.mediaForwardRetryDelayMs) : 1200,
    sendPrefer: (cfgRaw && cfgRaw.sendPrefer) ? cfgRaw.sendPrefer : 'outsend,sendout,send'
  });

  log.trace('queued media forward type=' + (raw.type || ''));
  _run(meta);
  return { ok: true, queued: true };
}

module.exports = { forward };
