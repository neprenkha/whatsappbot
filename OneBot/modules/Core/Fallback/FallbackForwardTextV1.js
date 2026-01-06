'use strict';

const SharedLog = require('../Shared/SharedLogV1');
const SharedSafeSend = require('../Shared/SharedSafeSendV1');
const TypeUtil = require('./FallbackTypeUtilV1');

function createLogger(meta, cfg) {
  const make = SharedLog.createLogger || SharedLog.create;
  return make('FallbackForwardTextV1', meta, {
    debug: !!cfg.debug,
    trace: !!cfg.trace,
  });
}

async function handle(meta, cfg, ticketCtx, ctx) {
  const log = createLogger(meta, cfg);

  const outsend = meta.getService('outsend');
  if (typeof outsend !== 'function') {
    log.error('missing outsend service');
    return { ok: false, reason: 'missingOutsend' };
  }

  const raw = ctx.raw;
  const text = TypeUtil.cleanText(ctx.text || (raw && raw.body) || '', cfg.forwardTextMaxLen || 3500);

  if (!text) return { ok: true, skipped: true, reason: 'emptyText' };

  const prefix = TypeUtil.formatInboundPrefix(ticketCtx.ticketId, ticketCtx.fromPhone, ticketCtx.fromName, ticketCtx.seq);
  const msg = `${prefix}\n${text}`;

  const r = await SharedSafeSend.send(log, outsend, ticketCtx.controlGroupId, msg, {
    tag: 'fallback.in.text',
  });

  if (!r.ok) {
    log.error(`send failed reason=${r.reason || ''}`);
  }

  return r;
}

module.exports = { handle };
