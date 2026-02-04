'use strict';

const SharedLogV1 = require('../Shared/SharedLogV1');

function cfgStr(cfg, key, defVal) {
  if (!cfg) return defVal;
  const v = cfg[key];
  if (v === undefined || v === null) return defVal;
  const s = String(v).trim();
  return s.length ? s : defVal;
}

function cfgBool(cfg, key, defVal) {
  const s = cfgStr(cfg, key, '');
  if (!s) return !!defVal;
  return s === '1' || s.toLowerCase() === 'true' || s.toLowerCase() === 'yes';
}

module.exports = {
  init: async function init(meta, cfg, opt) {
    const tag = '[FallbackForwardAvV1]';
    const log = SharedLogV1.wrap(meta, cfg, opt, tag);

    const enabled = cfgBool(cfg, 'enabled', 1);
    if (!enabled) {
      log.info('disabled', { enabled: 0 });
      return { enabled: false };
    }

    const sendPreferKey = (opt && opt.sendPreferKey) ? opt.sendPreferKey : 'sendPrefer';
    const sendPrefer = cfgStr(cfg, sendPreferKey, 'sendout,outsend,send');
    const controlGroupId = (opt && opt.controlGroupId) ? opt.controlGroupId : cfgStr(cfg, 'controlGroupId', '');
    const mediaQueue = opt && opt.mediaQueue;

    async function send(envelope, ticketId) {
      if (!controlGroupId) return { ok: false, reason: 'missing.controlGroupId' };
      if (!mediaQueue || !mediaQueue.pushAv) return { ok: false, reason: 'missing.mediaQueue' };

      const env = envelope || {};
      const files = Array.isArray(env.files) ? env.files : [];
      const picked = [];

      for (let i = 0; i < files.length; i++) {
        const f = files[i] || {};
        const kind = String(f.kind || '');
        if (kind === 'audio' || kind === 'video' || kind === 'ptt') {
          picked.push(f);
        }
      }

      if (picked.length <= 0) {
        return { ok: true, sent: 0 };
      }

      for (let i = 0; i < picked.length; i++) {
        await mediaQueue.pushAv({
          ticketId: ticketId,
          toChatId: controlGroupId,
          file: picked[i],
          sendPrefer: sendPrefer
        });
      }

      log.detail('queued', { ticketId: ticketId, av: picked.length });
      return { ok: true, sent: picked.length };
    }

    log.info('ready', { enabled: 1, controlGroupId: controlGroupId, sendPrefer: sendPrefer });
    return { enabled: true, send: send };
  }
};
