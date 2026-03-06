'use strict';

function asText(value, fallback) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return text || String(fallback === undefined || fallback === null ? '' : fallback).trim();
}

function asInt(value, fallback) {
  const parsed = Number.parseInt(String(value === undefined || value === null ? '' : value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBool(value, fallback) {
  const text = asText(value, '').toLowerCase();
  if (!text) return !!fallback;
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true;
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false;
  return !!fallback;
}

function readConf(conf, key, fallback) {
  if (!conf) return fallback;
  if (typeof conf.get === 'function') return conf.get(key, fallback);
  if (Object.prototype.hasOwnProperty.call(conf, key)) return conf[key];
  return fallback;
}

function parseHm(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(asText(text, ''));
  if (!m) return null;
  const hh = Number.parseInt(m[1], 10);
  const mm = Number.parseInt(m[2], 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return (hh * 60) + mm;
}

function parseWindow(text) {
  const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(asText(text, ''));
  if (!m) return null;
  const startMin = parseHm(m[1]);
  const endMin = parseHm(m[2]);
  if (startMin === null || endMin === null || startMin === endMin) return null;
  return { startMin, endMin };
}

function inWindow(minNow, windowItem) {
  if (!windowItem) return false;
  if (windowItem.endMin > windowItem.startMin) {
    return minNow >= windowItem.startMin && minNow < windowItem.endMin;
  }
  return minNow >= windowItem.startMin || minNow < windowItem.endMin;
}

function minutesUntilWindow(minNow, windowItem) {
  if (!windowItem) return 0;
  if (inWindow(minNow, windowItem)) return 0;
  if (windowItem.endMin > windowItem.startMin) {
    if (minNow < windowItem.startMin) return windowItem.startMin - minNow;
    return (1440 - minNow) + windowItem.startMin;
  }
  return windowItem.startMin - minNow;
}

function getLocalParts(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const obj = {};
  const parts = fmt.formatToParts(new Date());
  for (let i = 0; i < parts.length; i += 1) {
    obj[parts[i].type] = parts[i].value;
  }
  const dateKey = asText(obj.year, '1970') + '-' + asText(obj.month, '01') + '-' + asText(obj.day, '01');
  const minNow = (Number.parseInt(asText(obj.hour, '0'), 10) * 60) + Number.parseInt(asText(obj.minute, '0'), 10);
  return { dateKey, minNow };
}

function errText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return String(err.code || err.reason || err.message || err);
}

module.exports = {
  init: async (meta) => {
    const tag = 'RateLimitCV';
    const conf = meta && meta.implConf ? meta.implConf : {};
    const log = meta && typeof meta.log === 'function' ? meta.log : () => {};

    const enabled = asBool(readConf(conf, 'enabled', 1), true);
    const moduleLog = asBool(readConf(conf, 'moduleLog', 1), true);
    const bugLog = asBool(readConf(conf, 'bugLog', 1), true);
    const detailLog = asBool(readConf(conf, 'detailLog', 0), false);
    const traceLog = asBool(readConf(conf, 'traceLog', 0), false);

    const serviceName = asText(readConf(conf, 'serviceName', ''), '');
    if (!serviceName) {
      if (bugLog) log(tag, 'missing_serviceName');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const enforceWindows = asBool(readConf(conf, 'enforceWindows', 0), false);
    const burstWindowMs = Math.max(0, asInt(readConf(conf, 'burstWindowMs', 60000), 60000));
    const burstMaxGlobal = Math.max(0, asInt(readConf(conf, 'burstMaxGlobal', 0), 0));
    const burstMaxPerChat = Math.max(0, asInt(readConf(conf, 'burstMaxPerChat', 0), 0));
    const dailyMaxGlobal = Math.max(0, asInt(readConf(conf, 'dailyMaxGlobal', 0), 0));
    const dailyMaxPerChat = Math.max(0, asInt(readConf(conf, 'dailyMaxPerChat', 0), 0));
    const minGapMsPerChat = Math.max(0, asInt(readConf(conf, 'minGapMsPerChat', 0), 0));

    const globalConfRel = asText(readConf(conf, 'globalConfRel', ''), '');
    const globalLoaded = typeof meta.loadConfRel === 'function' ? (meta.loadConfRel(globalConfRel) || {}) : {};
    const globalConf = globalLoaded && globalLoaded.conf && typeof globalLoaded.conf === 'object' ? globalLoaded.conf : globalLoaded;

    const timeSvc = meta.getService('timezone');
    const serviceTz = timeSvc && typeof timeSvc.getTimeZone === 'function' ? asText(timeSvc.getTimeZone(), '') : asText(timeSvc && timeSvc.timeZone, '');
    const confTz = asText(readConf(globalConf, 'timeZone', ''), '');
    const timeZone = asText(serviceTz, confTz);

    const windows = [];
    const keys = Object.keys(conf);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (String(key).indexOf('window.') !== 0) continue;
      const w = parseWindow(readConf(conf, key, ''));
      if (w) windows.push(w);
    }

    let dateKey = '';
    let globalDailyCount = 0;
    let globalBurst = [];
    const chatDailyCount = new Map();
    const chatBurst = new Map();
    const lastSentAt = new Map();

    function resetDayIfNeeded(nowDateKey) {
      if (dateKey === nowDateKey) return;
      dateKey = nowDateKey;
      globalDailyCount = 0;
      chatDailyCount.clear();
    }

    function pruneBurst(nowMs) {
      if (burstWindowMs <= 0) {
        globalBurst = [];
        chatBurst.clear();
        return;
      }
      const cutoff = nowMs - burstWindowMs;
      globalBurst = globalBurst.filter((x) => Number(x || 0) > cutoff);
      const entries = Array.from(chatBurst.entries());
      for (let i = 0; i < entries.length; i += 1) {
        const chatId = entries[i][0];
        const arr = Array.isArray(entries[i][1]) ? entries[i][1] : [];
        const nextArr = arr.filter((x) => Number(x || 0) > cutoff);
        if (nextArr.length > 0) chatBurst.set(chatId, nextArr);
        else chatBurst.delete(chatId);
      }
    }

    function untilNextWindowMs(minNow) {
      if (windows.length <= 0) return 0;
      let best = null;
      for (let i = 0; i < windows.length; i += 1) {
        const minutes = minutesUntilWindow(minNow, windows[i]);
        if (minutes === 0) return 0;
        if (best === null || minutes < best) best = minutes;
      }
      return Number(best || 0) * 60000;
    }

    function check(chatId, payload, options) {
      try {
        if (!enabled) return { ok: 1 };

        const cid = asText(chatId, '');
        if (!cid) return { ok: 0, reason: 'missing.chatId', waitMs: 0 };

        const opts = options && typeof options === 'object' ? options : {};

        if (asBool(opts.bypassRateLimit, false)) return { ok: 1 };

        const hasIsAuto = Object.prototype.hasOwnProperty.call(opts, 'isAuto');
        if (!hasIsAuto) return { ok: 1 };

        if (asBool(opts.manualReply, false) || !asBool(opts.isAuto, true)) return { ok: 1 };

        const now = Date.now();
        const local = getLocalParts(timeZone);
        resetDayIfNeeded(local.dateKey);
        pruneBurst(now);

        if (enforceWindows && windows.length > 0 && !asBool(opts.bypassWindow, false)) {
          let allowedInWindow = false;
          for (let i = 0; i < windows.length; i += 1) {
            if (inWindow(local.minNow, windows[i])) {
              allowedInWindow = true;
              break;
            }
          }
          if (!allowedInWindow) {
            return { ok: 0, reason: 'window', waitMs: untilNextWindowMs(local.minNow) };
          }
        }

        if (minGapMsPerChat > 0) {
          const lastMs = Number(lastSentAt.get(cid) || 0);
          const waitMs = (lastMs + minGapMsPerChat) - now;
          if (waitMs > 0) return { ok: 0, reason: 'gap', waitMs };
        }

        const chatDaily = Number(chatDailyCount.get(cid) || 0);
        if (dailyMaxGlobal > 0 && globalDailyCount >= dailyMaxGlobal) {
          return { ok: 0, reason: 'daily.global', waitMs: 60000 };
        }
        if (dailyMaxPerChat > 0 && chatDaily >= dailyMaxPerChat) {
          return { ok: 0, reason: 'daily.chat', waitMs: 60000 };
        }

        if (burstWindowMs > 0) {
          if (burstMaxGlobal > 0 && globalBurst.length >= burstMaxGlobal) {
            const oldest = Number(globalBurst[0] || now);
            return { ok: 0, reason: 'burst.global', waitMs: Math.max(0, (oldest + burstWindowMs) - now) };
          }
          const chatArr = chatBurst.get(cid) || [];
          if (burstMaxPerChat > 0 && chatArr.length >= burstMaxPerChat) {
            const oldestChat = Number(chatArr[0] || now);
            return { ok: 0, reason: 'burst.chat', waitMs: Math.max(0, (oldestChat + burstWindowMs) - now) };
          }
        }

        globalDailyCount += 1;
        chatDailyCount.set(cid, chatDaily + 1);
        lastSentAt.set(cid, now);
        if (burstWindowMs > 0) {
          globalBurst.push(now);
          const nextChat = chatBurst.get(cid) || [];
          nextChat.push(now);
          chatBurst.set(cid, nextChat);
        }

        if (traceLog) log(tag, 'allow chatId=' + cid + ' payload=' + (payload === undefined ? '' : '1'));
        return { ok: 1 };
      } catch (err) {
        if (bugLog) log(tag, 'check_error err=' + errText(err));
        return { ok: 1 };
      }
    }

    const api = {
      check,
    };

    meta.registerService(serviceName, api);

    if (moduleLog) {
      log(tag, 'ready enabled=' + (enabled ? 1 : 0) + ' serviceName=' + serviceName + ' windows=' + windows.length + ' burstWindowMs=' + burstWindowMs + ' burstMaxGlobal=' + burstMaxGlobal + ' burstMaxPerChat=' + burstMaxPerChat + ' dailyMaxGlobal=' + dailyMaxGlobal + ' dailyMaxPerChat=' + dailyMaxPerChat + ' minGapMsPerChat=' + minGapMsPerChat);
    }
    if (detailLog) {
      log(tag, 'detail timeZone=' + timeZone + ' globalConfRel=' + globalConfRel);
    }

    return {
      onMessage: async () => {},
      onEvent: async () => {},
    };
  },
};