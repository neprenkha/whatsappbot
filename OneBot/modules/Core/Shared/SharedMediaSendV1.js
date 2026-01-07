'use strict';

/*
SharedMediaSendV1

Purpose:
- Send media with resilient fallback behavior.
- Logs all failures to ensure traceability.
*/

function _isFn(fn) {
  return typeof fn === 'function';
}

async function sendDirectWithFallback(log, transport, chatId, payload, options, rawMsg, sendService, forwardFn) {
  log.info('[SharedMediaSendV1] Attempting to send media.');

  const primary = _isFn(sendService) ? sendService : null;
  if (!primary) {
    log.error('[SharedMediaSendV1] No send service available.');
    return { ok: false, reason: 'No available send service' };
  }

  try {
    await primary(chatId, payload, options);
    log.info(`[SharedMediaSendV1] Media sent successfully to ${chatId}.`);
    return { ok: true };
  } catch (error) {
    log.error('[SharedMediaSendV1] Failed to send media on primary. Attempting fallback.', {
      errorMessage: error.message,
    });

    // Attempt fallback with raw msg forward if provided
    if (forwardFn && _isFn(forwardFn)) {
      log.info('[SharedMediaSendV1] Fallback: Attempting to forward raw message.');
      try {
        await forwardFn(chatId);
        return { ok: true, reason: 'Fallback forward success' };
      } catch (fallbackError) {
        log.error('[SharedMediaSendV1] Fallback raw forward failed.', { fallbackError });
      }
    }
  }

  log.error('[SharedMediaSendV1] All attempts to send media failed.');
  return { ok: false, reason: 'All forward attempts failed' };
}

module.exports = { sendDirectWithFallback };