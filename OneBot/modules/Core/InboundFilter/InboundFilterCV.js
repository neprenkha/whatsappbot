'use strict';

// REWRITTEN: standalone CV implementation with config-driven filters.

function toBool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return d;
}

function toStr(v, d) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s || d;
}

function toList(v, d) {
  const raw = toStr(v, '');
  if (!raw) return Array.isArray(d) ? d.slice() : [];
  const out = [];
  const parts = raw.split(',');
  for (let i = 0; i < parts.length; i += 1) {
    const item = String(parts[i] || '').trim();
    if (item) out.push(item);
  }
  return out;
}

function loadGlobalConf(meta, cfg, bugLog) {
  const rel = toStr(cfg.globalConfRel, '');
  if (!rel) {
    if (bugLog) meta.log('InboundFilterCV', 'global_conf_missing_key globalConfRel');
    return {};
  }
  try {
    const loaded = meta.loadConfRel(rel);
    return loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
  } catch (e) {
    if (bugLog) meta.log('InboundFilterCV', 'global_conf_load_failed err=' + String(e && e.message ? e.message : e));
    return {};
  }
}

function safeStop(ctx) {
  if (ctx && typeof ctx.stopPropagation === 'function') ctx.stopPropagation();
}

module.exports.init = async function init(meta) {
  const cfg = meta && meta.implConf ? meta.implConf : {};

  const enabled = toBool(cfg.enabled, true);
  const moduleLog = toBool(cfg.moduleLog, true);
  const bugLog = toBool(cfg.bugLog, true);
  const detailLog = toBool(cfg.detailLog, false);
  const traceLog = toBool(cfg.traceLog, false);

  if (!enabled) {
    if (moduleLog) meta.log('InboundFilterCV', 'disabled');
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const globalConf = loadGlobalConf(meta, cfg, bugLog);
  void globalConf;

  const dropStatusBroadcast = toBool(cfg.dropStatusBroadcast, true);
  const statusBroadcastIds = toList(cfg.statusBroadcastIds, ['status@broadcast']);
  const dropFromMe = toBool(cfg.dropFromMe, false);
  const dropEmptySystem = toBool(cfg.dropEmptySystem, true);
  const dropSystemTypes = toList(cfg.dropSystemTypes, [
    'protocol',
    'e2e_notification',
    'notification_template',
    'notification',
    'ciphertext'
  ]);
  const dropNotificationWhenEmpty = toBool(cfg.dropNotificationWhenEmpty, true);
  const dropStatusWhenEmpty = toBool(cfg.dropStatusWhenEmpty, true);

  const statusIdMap = new Map();
  for (let i = 0; i < statusBroadcastIds.length; i += 1) {
    const id = String(statusBroadcastIds[i] || '').trim();
    if (id) statusIdMap.set(id, 1);
  }

  const systemTypeMap = new Map();
  for (let j = 0; j < dropSystemTypes.length; j += 1) {
    const t = String(dropSystemTypes[j] || '').trim().toLowerCase();
    if (t) systemTypeMap.set(t, 1);
  }

  function isEmptyText(ctx) {
    const txt = ctx && typeof ctx.text === 'string' ? ctx.text.trim() : '';
    return txt.length === 0;
  }

  function dropWithLog(reason, chatId, extra) {
    if (detailLog || traceLog) {
      meta.log('InboundFilterCV', 'drop reason=' + reason + ' chatId=' + chatId + (extra ? ' ' + extra : ''));
    }
  }

  if (moduleLog) {
    meta.log(
      'InboundFilterCV',
      'ready dropStatusBroadcast=' + (dropStatusBroadcast ? '1' : '0') +
        ' dropFromMe=' + (dropFromMe ? '1' : '0') +
        ' dropEmptySystem=' + (dropEmptySystem ? '1' : '0')
    );
  }

  async function onMessage(ctx) {
    try {
      if (!ctx) return;

      const chatId = toStr(ctx.chatId, '');
      const rawFrom = toStr(ctx && ctx.raw ? ctx.raw.from : '', '');

      if (dropStatusBroadcast && (statusIdMap.has(chatId) || statusIdMap.has(rawFrom))) {
        dropWithLog('status_broadcast', chatId || rawFrom, 'rawFrom=' + rawFrom);
        safeStop(ctx);
        return;
      }

      if (dropFromMe && ctx.raw && ctx.raw.fromMe === true) {
        dropWithLog('from_me', chatId, '');
        safeStop(ctx);
        return;
      }

      if (dropEmptySystem && isEmptyText(ctx)) {
        const rawType = toStr(ctx.raw && ctx.raw.type, '').toLowerCase();
        if (systemTypeMap.has(rawType)) {
          dropWithLog('system_type', chatId, 'type=' + rawType);
          safeStop(ctx);
          return;
        }

        const isNotification = !!(ctx.raw && ctx.raw._data && ctx.raw._data.isNotification === true);
        const isStatus = !!(ctx.raw && ctx.raw.isStatus === true);

        if (dropNotificationWhenEmpty && isNotification) {
          dropWithLog('notification_empty', chatId, '');
          safeStop(ctx);
          return;
        }

        if (dropStatusWhenEmpty && isStatus) {
          dropWithLog('status_empty', chatId, '');
          safeStop(ctx);
        }
      }
    } catch (e) {
      if (bugLog) meta.log('InboundFilterCV', 'onMessage_error err=' + String(e && e.message ? e.message : e));
    }
  }

  return {
    onMessage,
    onEvent: async () => {}
  };
};