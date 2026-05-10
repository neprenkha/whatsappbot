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

function isPromiseLike(v) {
  return !!v && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
}

async function resolveChatId(chatId) {
  const resolved = isPromiseLike(chatId) ? await chatId : chatId;
  return String(resolved || '').trim();
}

function makeBlocked(reason, waitMs) {
  const err = new Error('ratelimit.block');
  err.code = 'ratelimit.block';
  err.reason = String(reason || 'blocked');
  err.waitMs = Math.max(0, toInt(waitMs, 0));
  return err;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function errText(err) {
  return String((err && (err.code || err.reason || err.message)) || err || '');
}

function isRetryableTransportError(err) {
  const msg = errText(err).toLowerCase();
  return msg.includes('runtime.callfunctionon') || msg.includes('promise was collected') || msg.includes('timed out') || msg.includes('target closed') || msg.includes('session closed');
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
  const services = splitCsv(toStr(cfg.services, toStr(globalConf.sendPrefer, 'sendout,outsend')));
  const bypassChatIds = new Set(splitCsv(toStr(cfg.bypassChatIds, toStr(globalConf.controlGroupId, ''))));
  const rateLimitLogDebounceMs = Math.max(0, toInt(cfg.rateLimitLogDebounceMs, 30000));
  const transportRetryMax = Math.max(1, toInt(cfg.transportRetryMax, 1));
  const transportRetryDelayMs = Math.max(0, toInt(cfg.transportRetryDelayMs, 0));
  const transportGapMs = Math.max(0, toInt(cfg.transportGapMs, 0));

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

  let sendChain = Promise.resolve();

  async function runSerializedSend(chatId, payload, opts) {
    const previous = sendChain.catch(() => {});
    const current = previous.then(async () => {
      let lastErr = null;
      for (let attempt = 1; attempt <= transportRetryMax; attempt += 1) {
        try {
          const res = await sendBase(chatId, payload, opts);
          if (transportGapMs > 0) await sleep(transportGapMs);
          return res;
        } catch (err) {
          lastErr = err;
          if (attempt >= transportRetryMax || !isRetryableTransportError(err)) throw err;
          if (detailLog || traceLog) {
            meta.log('OutboundGatewayCV', 'transport_retry chatId=' + chatId + ' attempt=' + String(attempt + 1) + ' err=' + errText(err));
          }
          if (transportRetryDelayMs > 0) await sleep(transportRetryDelayMs);
        }
      }
      throw lastErr || new Error('transport.send_failed');
    });
    sendChain = current.catch(() => {});
    return await current;
  }

  function shouldLogBlock(chatId) {
    const now = Date.now();
    const prev = Number(blockLogMap.get(chatId) || 0);
    if ((now - prev) < rateLimitLogDebounceMs) return false;
    blockLogMap.set(chatId, now);
    if (blockLogMap.size > 5000) blockLogMap.clear();
    return true;
  }

  async function sendWrapped(chatId, payload, options) {
    const outChatId = await resolveChatId(chatId);
    if (!outChatId || outChatId === '[object Promise]') throw new Error('outbound.invalid_chatId');

    const opts = normalizeOpts(options);

    const isAuto = toBool(opts.isAuto, false);
    const manualReply = toBool(opts.manualReply, false);
    const explicitBypass = toBool(opts.bypassRateLimit, false);

    if (!isAuto || manualReply || bypassChatIds.has(outChatId)) {
      opts.bypassRateLimit = 1;
    }

    const bypassRateLimit = toBool(opts.bypassRateLimit, false) || explicitBypass;

    if (ratelimit && typeof ratelimit.check === 'function' && !bypassRateLimit) {
      const checked = ratelimit.check(outChatId, payload, opts) || { ok: true, reason: 'ok', waitMs: 0 };

      if (!checked.ok) {
        if (moduleLog && shouldLogBlock(outChatId)) {
          meta.log('OutboundGatewayCV', 'ratelimit_block chatId=' + outChatId + ' reason=' + String(checked.reason || 'blocked') + ' waitMs=' + String(toInt(checked.waitMs, 0)));
        }
        throw makeBlocked(checked.reason, checked.waitMs);
      }
    }

    if (traceLog || detailLog) {
      meta.log('OutboundGatewayCV', 'og_senddirect chatId=' + outChatId + ' payloadType=' + (typeof payload === 'string' ? 'text' : 'media') + ' baseSend=' + baseSend);
    }

    const res = await runSerializedSend(outChatId, payload, opts);

    if (ratelimit && typeof ratelimit.commit === 'function' && !bypassRateLimit) {
      ratelimit.commit(outChatId, payload, opts);
    }

    if (traceLog || detailLog) {
      meta.log('OutboundGatewayCV', 'send_ok chatId=' + outChatId + ' isAuto=' + (toBool(opts.isAuto, false) ? '1' : '0') + ' bypass=' + (bypassRateLimit ? '1' : '0'));
    }

    return res;
  }

  const published = [];
  for (let i = 0; i < services.length; i += 1) {
    const n = services[i];
    if (!n) continue;
    meta.registerService(n, sendWrapped);
    published.push(n);
  }

  if (moduleLog) {
    meta.log('OutboundGatewayCV', 'ready baseSend=' + baseSend + ' ratelimitService=' + ratelimitService + ' exportServices=' + published.join(',') + ' transportRetryMax=' + String(transportRetryMax) + ' transportGapMs=' + String(transportGapMs));
  }

  return { onMessage: async () => {}, onEvent: async () => {} };
};