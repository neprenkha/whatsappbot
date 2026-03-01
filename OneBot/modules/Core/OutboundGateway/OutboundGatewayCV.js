'use strict';

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

function toInt(v, d) {
  const n = parseInt(String(v === undefined || v === null ? '' : v), 10);
  return Number.isFinite(n) ? n : d;
}

function splitCsv(v) {
  return String(v || '').split(',').map((x) => String(x || '').trim()).filter(Boolean);
}

function loadGlobalConf(meta, cfg, bugLog) {
  const rel = toStr(cfg.globalConfRel, '');
  if (!rel) {
    if (bugLog) meta.log('OutboundGatewayCV', 'global_conf_missing_key globalConfRel');
    return {};
  }
  try {
    const loaded = meta.loadConfRel(rel);
    return loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
  } catch (e) {
    if (bugLog) meta.log('OutboundGatewayCV', 'global_conf_load_failed err=' + String(e && e.message ? e.message : e));
    return {};
  }
}

function resolveSend(meta, name) {
  const svc = meta.getService(name);
  if (!svc) return null;
  if (typeof svc === 'function') return async (chatId, payload, opts) => await svc(chatId, payload, opts || {});
  if (typeof svc.send === 'function') return async (chatId, payload, opts) => await svc.send(chatId, payload, opts || {});
  if (typeof svc.sendText === 'function') return async (chatId, payload, opts) => await svc.sendText(chatId, payload, opts || {});
  if (typeof svc.sendDirect === 'function') return async (chatId, payload, opts) => await svc.sendDirect(chatId, payload, opts || {});
  return null;
}

function normalizeOpts(v) {
  if (!v || typeof v !== 'object') return {};
  return Object.assign({}, v);
}

function makeBlocked(reason, waitMs) {
  const err = new Error('ratelimit.block');
  err.code = 'ratelimit.block';
  err.reason = String(reason || 'blocked');
  err.waitMs = Math.max(0, toInt(waitMs, 0));
  return err;
}

module.exports.init = async function init(meta) {
  const cfg = meta && meta.implConf ? meta.implConf : {};

  const enabled = toBool(cfg.enabled, true);
  const moduleLog = toBool(cfg.moduleLog, true);
  const bugLog = toBool(cfg.bugLog, true);
  const detailLog = toBool(cfg.detailLog, false);
  const traceLog = toBool(cfg.traceLog, false);

  if (!enabled) {
    if (moduleLog) meta.log('OutboundGatewayCV', 'disabled');
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const globalConf = loadGlobalConf(meta, cfg, bugLog);

  const baseSend = toStr(cfg.baseSend, 'transport');
  const ratelimitService = toStr(cfg.ratelimitService, 'ratelimit');
  const exportServices = splitCsv(toStr(cfg.exportServices, toStr(globalConf.sendPrefer, 'sendout,outsend')));
  const bypassChatIds = new Set(splitCsv(toStr(cfg.bypassChatIds, toStr(globalConf.controlGroupId, ''))));
  const rateLimitLogDebounceMs = Math.max(0, toInt(cfg.rateLimitLogDebounceMs, 30000));

  const sendBase = resolveSend(meta, baseSend);
  if (!sendBase) {
    if (bugLog) meta.log('OutboundGatewayCV', 'missing_base_send baseSend=' + baseSend);
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const ratelimit = meta.getService(ratelimitService);
  if (!ratelimit && bugLog) {
    meta.log('OutboundGatewayCV', 'ratelimit_service_missing name=' + ratelimitService);
  }

  const blockLogMap = new Map();

  function shouldLogBlock(chatId) {
    const now = Date.now();
    const prev = Number(blockLogMap.get(chatId) || 0);
    if ((now - prev) < rateLimitLogDebounceMs) return false;
    blockLogMap.set(chatId, now);
    if (blockLogMap.size > 5000) blockLogMap.clear();
    return true;
  }

  async function sendWrapped(chatId, payload, options) {
    const outChatId = String(chatId || '').trim();
    if (!outChatId) throw new Error('outbound.invalid_chatId');

    const opts = normalizeOpts(options);

    const isAuto = toBool(opts.isAuto, false);
    const manualReply = toBool(opts.manualReply, false);
    const explicitBypass = toBool(opts.bypassRateLimit, false);

    if (!isAuto || manualReply || bypassChatIds.has(outChatId)) {
      opts.bypassRateLimit = 1;
    }

    const bypassRateLimit = toBool(opts.bypassRateLimit, false) || explicitBypass;

    if (ratelimit && typeof ratelimit.check === 'function' && !bypassRateLimit) {
      const checked = ratelimit.check({
        chatId: outChatId,
        weight: opts.weight,
        isAuto: opts.isAuto,
        manualReply: opts.manualReply,
        bypassRateLimit: opts.bypassRateLimit,
      }) || { ok: true, reason: 'ok', waitMs: 0 };

      if (!checked.ok) {
        if (moduleLog && shouldLogBlock(outChatId)) {
          meta.log('OutboundGatewayCV', 'ratelimit_block chatId=' + outChatId + ' reason=' + String(checked.reason || 'blocked') + ' waitMs=' + String(toInt(checked.waitMs, 0)));
        }
        throw makeBlocked(checked.reason, checked.waitMs);
      }
    }

    const res = await sendBase(outChatId, payload, opts);

    if (ratelimit && typeof ratelimit.commit === 'function' && !bypassRateLimit) {
      ratelimit.commit({
        chatId: outChatId,
        weight: opts.weight,
        isAuto: opts.isAuto,
        manualReply: opts.manualReply,
        bypassRateLimit: opts.bypassRateLimit,
      });
    }

    if (traceLog || detailLog) {
      meta.log('OutboundGatewayCV', 'send_ok chatId=' + outChatId + ' isAuto=' + (toBool(opts.isAuto, false) ? '1' : '0') + ' bypass=' + (bypassRateLimit ? '1' : '0'));
    }

    return res;
  }

  const published = [];
  for (let i = 0; i < exportServices.length; i += 1) {
    const n = exportServices[i];
    if (!n) continue;
    meta.registerService(n, sendWrapped);
    published.push(n);
  }

  if (moduleLog) {
    meta.log('OutboundGatewayCV', 'ready baseSend=' + baseSend + ' ratelimitService=' + ratelimitService + ' exportServices=' + published.join(','));
  }

  return { onMessage: async () => {}, onEvent: async () => {} };
};