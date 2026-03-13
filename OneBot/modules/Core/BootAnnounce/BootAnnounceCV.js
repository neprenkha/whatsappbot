'use strict';

function toBool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return d;
}

function toInt(v, d) {
  const n = parseInt(String(v === undefined || v === null ? '' : v), 10);
  return Number.isFinite(n) ? n : d;
}

function toStr(v, d) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s || d;
}

function loadGlobalConf(meta, cfg, bugLog) {
  const rel = toStr(cfg.globalConfRel, '');
  if (!rel) {
    if (bugLog) meta.log('BootAnnounceCV', 'global_conf_missing_key globalConfRel');
    return {};
  }
  try {
    const loaded = meta.loadConfRel(rel);
    return loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
  } catch (e) {
    if (bugLog) meta.log('BootAnnounceCV', 'global_conf_load_failed err=' + String(e && e.message ? e.message : e));
    return {};
  }
}

function eventType(evt) {
  if (!evt) return '';
  if (typeof evt === 'string') return evt.trim().toLowerCase();
  if (typeof evt.type === 'string') return evt.type.trim().toLowerCase();
  if (typeof evt.name === 'string') return evt.name.trim().toLowerCase();
  if (typeof evt.event === 'string') return evt.event.trim().toLowerCase();
  return '';
}

function isReadyEvent(evt) {
  const t = eventType(evt);
  return t === 'ready' ||
    t === 'connector.ready' ||
    t === 'whatsapp.ready';
}

module.exports = {
  init: async (meta) => {
    const cfg = meta && meta.implConf ? meta.implConf : {};
    const enabled = toBool(cfg.enabled, true);
    const moduleLog = toBool(cfg.moduleLog, true);
    const bugLog = toBool(cfg.bugLog, true);
    const detailLog = toBool(cfg.detailLog, false);
    const traceLog = toBool(cfg.traceLog, false);

    if (!enabled) {
      if (moduleLog) meta.log('BootAnnounceCV', 'disabled');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const globalConf = loadGlobalConf(meta, cfg, bugLog);
    const controlGroupId = toStr(globalConf.controlGroupId, '');
    const delayMs = Math.max(0, toInt(cfg.delayMs, 0));
    const title = toStr(cfg.title, '');
    const tips = toStr(cfg.tips, '');
    const botName = toStr(cfg.botName, meta.botName || '');
    const serviceName = toStr(cfg.serviceName, '') || toStr(String(globalConf.sendPrefer || '').split(',')[0], '');

    if (!controlGroupId) {
      if (bugLog) meta.log('BootAnnounceCV', 'control_group_missing controlGroupId');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const sendSvc = meta.getService(serviceName);
    let sendFn = null;
    if (typeof sendSvc === 'function') {
      sendFn = async (chatId, payload, options) => await sendSvc(chatId, payload, options || {});
    } else if (sendSvc && typeof sendSvc.send === 'function') {
      sendFn = async (chatId, payload, options) => await sendSvc.send(chatId, payload, options || {});
    }
    if (!sendFn) {
      if (bugLog) meta.log('BootAnnounceCV', 'send_service_missing serviceName=' + serviceName);
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const lines = [];
    if (title) lines.push(title);
    if (tips) lines.push(tips);
    if (botName && !title) lines.push(botName);
    const payload = lines.join('\n').trim();
    if (!payload) {
      if (moduleLog) meta.log('BootAnnounceCV', 'ready no_payload');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    let announced = false;

    async function announceOnce() {
      if (announced) return;
      announced = true;
      try {
        await sendFn(controlGroupId, payload, { isAuto: 0, manualReply: 1, bypassRateLimit: 1 });
        if (detailLog || traceLog || moduleLog) meta.log('BootAnnounceCV', 'announce_sent');
      } catch (e) {
        announced = false;
        if (bugLog) meta.log('BootAnnounceCV', 'announce_failed err=' + String(e && e.message ? e.message : e));
      }
    }

    const onEvent = async (evt) => {
      if (!isReadyEvent(evt)) return;
      if (delayMs > 0) {
        setTimeout(() => {
          announceOnce().catch(() => {});
        }, delayMs);
        return;
      }
      await announceOnce();
    };

    if (moduleLog) meta.log('BootAnnounceCV', 'ready');
    return { onMessage: async () => {}, onEvent };
  },
};