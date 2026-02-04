'use strict';

const FallbackGroupRouterV1 = require('./FallbackGroupRouterV1');
const FallbackForwardTextV1 = require('./FallbackForwardTextV1');
const FallbackForwardMediaV1 = require('./FallbackForwardMediaV1');
const FallbackForwardAvV1 = require('./FallbackForwardAvV1');
const FallbackReplyTextV1 = require('./FallbackReplyTextV1');
const FallbackReplyMediaV1 = require('./FallbackReplyMediaV1');
const FallbackReplyAvV1 = require('./FallbackReplyAvV1');
const FallbackCommandReplyV1 = require('./FallbackCommandReplyV1');
const FallbackTicketCardV1 = require('./FallbackTicketCardV1');
const FallbackMediaForwardQueueV1 = require('./FallbackMediaForwardQueueV1');
const TicketCoreV2 = require('../Shared/SharedTicketCoreV2');

function cfgStr(cfg, key, defVal) {
  if (!cfg) return defVal;
  const v = cfg[key];
  if (v === undefined || v === null) return defVal;
  const s = String(v).trim();
  return s.length ? s : defVal;
}

function cfgInt(cfg, key, defVal) {
  const s = cfgStr(cfg, key, '');
  if (!s) return defVal;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : defVal;
}

function cfgBool(cfg, key, defVal) {
  const s = cfgStr(cfg, key, '');
  if (!s) return !!defVal;
  return s === '1' || s.toLowerCase() === 'true' || s.toLowerCase() === 'yes';
}

function safeObj(o) {
  return (o && typeof o === 'object') ? o : {};
}

function countKinds(envelope) {
  const env = safeObj(envelope);
  let pic = 0;
  let doc = 0;
  let av = 0;

  const files = Array.isArray(env.files) ? env.files : [];
  for (let i = 0; i < files.length; i++) {
    const f = safeObj(files[i]);
    const kind = String(f.kind || '');
    if (kind === 'pic') pic++;
    else if (kind === 'doc') doc++;
    else if (kind === 'audio' || kind === 'video' || kind === 'ptt') av++;
  }

  return { pic, doc, av };
}

module.exports = {
  init: async function init(meta) {
    const tag = '[FallbackCV]';
    const log = meta && meta.log ? meta.log : function noop() {};

    const hubConf = safeObj(meta && meta.hubConf);
    const cfg = safeObj(meta && meta.implConf);

    const enabled = cfgBool(cfg, 'enabled', 1);
    if (!enabled) {
      log(tag, 'disabled', { enabled: 0 });
      return { enabled: false };
    }

    // Canonical key only (per CONF STANDARD).
    const controlGroupId = cfgStr(cfg, 'controlGroupId', '');

    if (!controlGroupId) {
      log(tag, 'config.missing', { key: 'controlGroupId', enabled: 1 });
      return { enabled: false };
    }

    const burstMs = cfgInt(cfg, 'burstMs', 1200);
    const msgBufferMax = cfgInt(cfg, 'msgBufferMax', 20);
    const sendPreferKey = 'sendPrefer';

    const moduleLog = cfgBool(cfg, 'moduleLog', 1);
    const bugLog = cfgBool(cfg, 'bugLog', 1);
    const detailLog = cfgBool(cfg, 'detailLog', 0);
    const traceLog = cfgBool(cfg, 'traceLog', 0);

    const router = await FallbackGroupRouterV1.init(meta, cfg, {
      moduleLog, bugLog, detailLog, traceLog,
      controlGroupId,
      sendPreferKey,
    });

    const ticketCard = await FallbackTicketCardV1.init(meta, cfg, {
      moduleLog, bugLog, detailLog, traceLog,
      controlGroupId,
      sendPreferKey,
    });

    const mediaQueue = await FallbackMediaForwardQueueV1.init(meta, cfg, {
      moduleLog, bugLog, detailLog, traceLog,
      burstMs,
      sendPreferKey,
    });

    const forwardText = await FallbackForwardTextV1.init(meta, cfg, {
      moduleLog, bugLog, detailLog, traceLog,
      controlGroupId,
      sendPreferKey,
    });

    const forwardMedia = await FallbackForwardMediaV1.init(meta, cfg, {
      moduleLog, bugLog, detailLog, traceLog,
      controlGroupId,
      sendPreferKey,
      mediaQueue,
    });

    const forwardAv = await FallbackForwardAvV1.init(meta, cfg, {
      moduleLog, bugLog, detailLog, traceLog,
      controlGroupId,
      sendPreferKey,
      mediaQueue,
    });

    const replyText = await FallbackReplyTextV1.init(meta, cfg, {
      moduleLog, bugLog, detailLog, traceLog,
      sendPreferKey,
    });

    const replyMedia = await FallbackReplyMediaV1.init(meta, cfg, {
      moduleLog, bugLog, detailLog, traceLog,
      sendPreferKey,
    });

    const replyAv = await FallbackReplyAvV1.init(meta, cfg, {
      moduleLog, bugLog, detailLog, traceLog,
      sendPreferKey,
    });

    const cmdReply = await FallbackCommandReplyV1.init(meta, cfg, {
      moduleLog, bugLog, detailLog, traceLog,
      sendPreferKey,
    });

    log(tag, 'ready', {
      enabled: 1,
      controlGroupId: controlGroupId,
      msgBufferMax: msgBufferMax,
      burstMs: burstMs,
      moduleLog: moduleLog ? 1 : 0,
      bugLog: bugLog ? 1 : 0,
      detailLog: detailLog ? 1 : 0,
      traceLog: traceLog ? 1 : 0,
      implFile: cfgStr(hubConf, 'implFile', ''),
      implConfig: cfgStr(hubConf, 'implConfig', ''),
    });

    async function onMessage(ev) {
      try {
        const e = safeObj(ev);
        const env = safeObj(e.data && e.data.envelope);

        const chatId = String(env.chatId || '');
        const authorId = String(env.authorId || '');

        if (!chatId || !authorId) return;

        const route = await router.route(env);
        if (!route || !route.ok) return;

        if (route.kind === 'forward') {
          const k = countKinds(env);
          const r = await TicketCoreV2.resolve(meta, cfg, chatId, authorId, cfgInt(cfg, 'ticketTtlMs', 300000));
          if (!r || !r.ok || !r.ticketId) return;

          await TicketCoreV2.touch(meta, cfg, chatId, authorId, r.ticketId);

          const ticketText = await ticketCard.render(env, r.ticketId, k);
          await forwardText.send(env, r.ticketId, ticketText);

          await forwardMedia.send(env, r.ticketId);
          await forwardAv.send(env, r.ticketId);

          return;
        }

        if (route.kind === 'reply') {
          const rr = await cmdReply.tryReply(env);
          if (rr && rr.ok && rr.handled) return;

          const rt = await replyText.tryReply(env);
          if (rt && rt.ok && rt.handled) return;

          const rm = await replyMedia.tryReply(env);
          if (rm && rm.ok && rm.handled) return;

          const ra = await replyAv.tryReply(env);
          if (ra && ra.ok && ra.handled) return;

          return;
        }
      } catch (err) {
        const msg = err && err.stack ? String(err.stack) : String(err);
        log('[FallbackCV]', 'bug.onMessage', { err: msg });
      }
    }

    return { enabled: true, onMessage };
  }
};
