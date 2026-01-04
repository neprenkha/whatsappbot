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

  meta.log('BootAnnounceV1', `ready controlGroupId=${controlGroupId} delayMs=${delayMs} sendPrefer=${sendPrefer.join(',')}`);

  let announced = false;

  async function announce(triggerType) {
    if (announced) return;
    announced = true;

    await sleep(delayMs);

    const sender = pickSend(meta, sendPrefer);
    if (!sender) {
      meta.log('BootAnnounceV1', 'error missing send service (sendout/outsend/send)');
      return;
    }

    const time = getNowString(meta);
    const text =
      `${title}\n` +
      `Time: ${time}\n` +
      `Tips:\n${tips}`;

    try {
      await sender.fn(controlGroupId, text, {});
      meta.log('BootAnnounceV1', `sent via ${sender.name} trigger=${triggerType}`);
    } catch (err) {
      meta.log('BootAnnounceV1', `send failed via ${sender.name} msg=${err?.message || err}`);
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
