'use strict';

/**
 * BootAnnounceV1
 * Sends one "bot online" announce message to Control Group when connector is ready.
 * Uses timezone service if available.
 */

function toInt(v, defVal) {
  const n = Number(v);
  return Number.isFinite(n) ? n : defVal;
}

function parseCsv(s) {
  return String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pickSend(meta, preferList) {
  const prefer = Array.isArray(preferList) && preferList.length
    ? preferList
    : ['sendout', 'outsend', 'send'];

  for (const name of prefer) {
    const fn = meta.getService?.(name);
    if (typeof fn === 'function') return { name, fn };
  }
  return null;
}

function getNowString(meta) {
  const tzSvc = meta.getService?.('timezone') || meta.getService?.('tz');

  try {
    if (typeof tzSvc === 'function') {
      const out = tzSvc();
      if (typeof out === 'string' && out.trim()) return out.trim();
    }
    if (tzSvc && typeof tzSvc.now === 'function') return String(tzSvc.now()).trim();
    if (tzSvc && typeof tzSvc.formatNow === 'function') return String(tzSvc.formatNow()).trim();
    if (tzSvc && typeof tzSvc.nowStr === 'function') return String(tzSvc.nowStr()).trim();
  } catch (_) {
    // ignore
  }

  // fallback (last resort)
  return new Date().toLocaleString('en-MY', { hour12: false });
}

module.exports.init = async function init(meta) {
  const conf = meta.implConf || {};

  const enabled = toInt(conf.enabled, 1) === 1;
  const controlGroupId = String(conf.controlGroupId || '').trim();

  const botName = String(conf.botName || meta.botName || 'ONEBOT').trim() || 'ONEBOT';
  const delayMs = toInt(conf.delayMs, 2000);
  const maxRetries = toInt(conf.maxRetries, 3);
  const retryDelayMs = toInt(conf.retryDelayMs, 5000);

  const title = String(conf.title || `✅ ${botName} Online`).trim();
  const tips = String(conf.tips || '!status  |  !help').trim();
  const sendPrefer = parseCsv(conf.sendPrefer || 'outsend,sendout,send');

  if (!enabled) {
    meta.log('BootAnnounceV1', 'disabled');
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  if (!controlGroupId) {
    meta.log('BootAnnounceV1', 'error missing controlGroupId');
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  meta.log('BootAnnounceV1', `ready controlGroupId=${controlGroupId} delayMs=${delayMs} maxRetries=${maxRetries} retryDelayMs=${retryDelayMs} sendPrefer=${sendPrefer.join(',')}`);

  let announced = false;
  let sendFailureLogged = false;

  async function announce(triggerType) {
    if (announced) return;
    announced = true;

    await sleep(delayMs);

    const sender = pickSend(meta, sendPrefer);
    if (!sender) {
      if (!sendFailureLogged) {
        meta.log('BootAnnounceV1', 'error missing send service (sendout/outsend/send)');
        sendFailureLogged = true;
      }
      return;
    }

    const time = getNowString(meta);
    const text =
      `${title}\n` +
      `Time: ${time}\n` +
      `Tips:\n${tips}`;

    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await sender.fn(controlGroupId, text, {});
        meta.log('BootAnnounceV1', `sent via ${sender.name} trigger=${triggerType} attempt=${attempt}`);
        sendFailureLogged = false; // Reset flag on success
        return; // Success, exit
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          // Retry with exponential backoff
          const waitMs = retryDelayMs * attempt;
          meta.log('BootAnnounceV1', `retry ${attempt}/${maxRetries} after ${waitMs}ms via ${sender.name}`);
          await sleep(waitMs);
        }
      }
    }

    // Log failure only once after all retries exhausted
    if (!sendFailureLogged) {
      meta.log('BootAnnounceV1', `send failed after ${maxRetries} attempts via ${sender.name} msg=${lastError?.message || lastError}`);
      sendFailureLogged = true;
    }
  }

  async function onEvent(evt) {
    const t = String(evt?.type || '').toLowerCase();

    // Trigger points (be tolerant with event naming)
    if (
      t === 'ready' ||
      t === 'connector.ready' ||
      t === 'whatsapp.ready' ||
      t === 'authenticated' ||
      t === 'connector.authenticated'
    ) {
      await announce(t);
    }
  }

  return { onEvent, onMessage: async () => {} };
};
