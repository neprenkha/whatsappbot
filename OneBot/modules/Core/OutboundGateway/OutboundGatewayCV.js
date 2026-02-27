'use strict';

// CV wrapper for OutboundGateway.
// Adds optional retry bridge without touching V1/V2 implementation files.

const initBase = require('./OutboundGatewayV1');

function toBool(v, dflt) {
  if (v === undefined || v === null || v === '') return !!dflt;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return !!dflt;
}

function toInt(v, dflt) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : dflt;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err) {
  if (err && err.retryable === true) return true;
  const msg = String((err && (err.message || err.code || err.reason)) || '').toLowerCase();
  return (
    msg.indexOf('transport.send_failed') >= 0 ||
    msg.indexOf('promise was collected') >= 0 ||
    msg.indexOf('protocol error') >= 0
  );
}

function wrapWithRetry(meta, baseSend) {
  const cfg = meta.implConf || {};
  const enabled = toBool(cfg.retryBridgeEnabled, true);
  if (!enabled || typeof baseSend !== 'function') return baseSend;

  const attempts = Math.max(1, toInt(cfg.retryBridgeAttempts, 2));
  const queueEnabled = toBool(cfg.retryBridgeQueueEnabled, true);
  const queueSvcName = String(cfg.retryBridgeQueueService || 'outbox').trim() || 'outbox';

  return async function sendWithRetry(chatId, payload, opts) {
    let lastErr = null;
    let attempt = 0;

    while (attempt < attempts) {
      attempt += 1;
      try {
        const res = await baseSend(chatId, payload, opts || {});
        return res;
      } catch (e) {
        lastErr = e;
        const retryable = isRetryableError(e);
        const waitMs = (e && typeof e.waitMs === 'number' && e.waitMs > 0) ? e.waitMs : toInt(cfg.retryBridgeWaitMs, 3000);

        meta.log('OutboundGatewayCV', 'warn retry_bridge attempt=' + attempt + ' retryable=' + (retryable ? '1' : '0') + ' waitMs=' + waitMs + ' reason=' + String(e && (e.code || e.message || e.reason) ? (e.code || e.message || e.reason) : 'send_failed'));

        if (!retryable) throw e;
        if (attempt < attempts) await sleep(waitMs);
      }
    }

    if (queueEnabled) {
      const queueSvc = meta.getService(queueSvcName);
      if (queueSvc && typeof queueSvc.send === 'function') {
        const qOpts = Object.assign({}, opts || {}, {
          retryBridgeQueued: 1,
          retryBridgeAttempts: attempts,
        });
        await queueSvc.send(chatId, payload, qOpts);
        meta.log('OutboundGatewayCV', 'warn retry_bridge queued service=' + queueSvcName + ' chatId=' + String(chatId || ''));
        return { ok: true, queued: true, service: queueSvcName };
      }
    }

    throw lastErr || new Error('send_failed');
  };
}

async function init(meta) {
  const out = await initBase(meta);

  const sendout = meta.getService('sendout');
  const outsend = meta.getService('outsend');

  const wrappedSendout = wrapWithRetry(meta, sendout);
  const wrappedOutsend = wrapWithRetry(meta, outsend);

  if (typeof wrappedSendout === 'function') meta.registerService('sendout', wrappedSendout);
  if (typeof wrappedOutsend === 'function') meta.registerService('outsend', wrappedOutsend);

  return out || {};
}

module.exports = { init };