'use strict';

const SharedLog = require('../Shared/SharedLogV1');
const SharedSafeSend = require('../Shared/SharedSafeSendV1');
const TypeUtil = require('./FallbackTypeUtilV1');

function createLogger(meta, cfg) {
  const make = SharedLog.createLogger || SharedLog.create;
  return make('FallbackForwardAvV1', meta, {
    debug: !!cfg.debug,
    trace: !!cfg.trace,
  });
}

function makeHeader(ticketCtx, raw) {
  const t = TypeUtil.getRawType(raw);
  const prefix = TypeUtil.formatInboundPrefix(ticketCtx.ticketId, ticketCtx.fromPhone, ticketCtx.fromName, ticketCtx.seq);
  const lines = [prefix];
  if (t) lines.push(`Type: ${t}`);
  lines.push('Note: Media forwarded without caption.');
  return TypeUtil.cleanText(lines.join('\n'), 1000);
}

const _lastHeaderAtByTicket = new Map();

function shouldSendHeader(ticketId, windowMs) {
  const now = TypeUtil.nowMs();
  const last = _lastHeaderAtByTicket.get(ticketId) || 0;
  if (now - last >= windowMs) {
    _lastHeaderAtByTicket.set(ticketId, now);
    return true;
  }
  return false;
}

async function tryForwardRaw(raw, toChatId, log) {
  if (!raw || typeof raw.forward !== 'function') return { ok: false, reason: 'noForward' };
  try {
    await raw.forward(toChatId);
    return { ok: true };
  } catch (e) {
    log.warn(`raw.forward failed ${e && e.message ? e.message : e}`);
    return { ok: false, reason: 'forwardFail' };
  }
}

async function handle(meta, cfg, ticketCtx, ctx) {
  const log = createLogger(meta, cfg);

  const outsend = meta.getService('outsend');
  if (typeof outsend !== 'function') {
    log.error('missing outsend service');
    return { ok: false, reason: 'missingOutsend' };
  }

  const raw = ctx.raw;
  if (!raw || !raw.hasMedia) return { ok: true, skipped: true, reason: 'noMedia' };

  const headerWindowMs = cfg.forwardAvHeaderWindowMs || 2500;

  // Send header (throttled) so staff can quote it for reply
  if (shouldSendHeader(ticketCtx.ticketId, headerWindowMs)) {
    const header = makeHeader(ticketCtx, raw);
    const h = await SharedSafeSend.send(log, outsend, ticketCtx.controlGroupId, header, {
      tag: 'fallback.in.av.header',
    });
    if (!h.ok) log.error(`send header failed reason=${h.reason || ''}`);
  } else {
    log.trace(`header suppressed ticket=${ticketCtx.ticketId} windowMs=${headerWindowMs}`);
  }

  // Prefer raw.forward for audio/video reliability
  const fwd = await tryForwardRaw(raw, ticketCtx.controlGroupId, log);
  if (!fwd.ok) {
    log.error(`av forward failed reason=${fwd.reason || ''}`);
  }
  return fwd;
}

module.exports = { handle };
