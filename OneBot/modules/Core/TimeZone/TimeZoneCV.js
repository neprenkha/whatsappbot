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

function loadGlobalConf(meta, cfg, bugLog) {
  const rel = toStr(cfg.globalConfRel, '');
  if (!rel) {
    if (bugLog && meta && typeof meta.log === 'function') {
      meta.log('TimeZoneCV', 'global_conf_missing_key globalConfRel');
    }
    return {};
  }
  if (!meta || typeof meta.loadConfRel !== 'function') {
    if (bugLog && meta && typeof meta.log === 'function') {
      meta.log('TimeZoneCV', 'global_conf_loader_unavailable');
    }
    return {};
  }
  try {
    const loaded = meta.loadConfRel(rel);
    const conf = loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
    return conf;
  } catch (e) {
    if (bugLog && meta && typeof meta.log === 'function') {
      meta.log('TimeZoneCV', 'global_conf_load_failed err=' + String(e && e.message ? e.message : e));
    }
    return {};
  }
}

function buildFormatter(locale, timeZone, hour12) {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12,
  });
}

module.exports.init = async function init(meta) {
  const cfg = meta && meta.implConf ? meta.implConf : {};

  const enabled = toBool(cfg.enabled, true);
  const moduleLog = toBool(cfg.moduleLog, true);
  const bugLog = toBool(cfg.bugLog, true);

  if (!enabled) {
    if (moduleLog && meta && typeof meta.log === 'function') {
      meta.log('TimeZoneCV', 'disabled');
    }
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const globalConf = loadGlobalConf(meta, cfg, bugLog);

  const timeZone = toStr(globalConf.timeZone, 'UTC');
  const locale = toStr(globalConf.locale, 'en-GB');
  const hour12 = toBool(globalConf.hour12, false);

  let formatImpl = null;
  try {
    formatImpl = buildFormatter(locale, timeZone, hour12);
  } catch (e) {
    if (bugLog && meta && typeof meta.log === 'function') {
      meta.log('TimeZoneCV', 'formatter_error using_utc_fallback err=' + String(e && e.message ? e.message : e));
    }
    formatImpl = buildFormatter('en-GB', 'UTC', false);
  }

  const service = {
    timeZone,
    locale,
    hour12,
    now: () => new Date(),
    nowMs: () => Date.now(),
    format: (value) => {
      const d = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(d.getTime())) return '';
      return formatImpl.format(d);
    },
    formatNow: () => formatImpl.format(new Date()),
    isoNow: () => new Date().toISOString(),
  };

  if (meta && typeof meta.registerService === 'function') {
    meta.registerService('timezone', service);
  }

  if (moduleLog && meta && typeof meta.log === 'function') {
    meta.log('TimeZoneCV', 'ready timeZone=' + timeZone + ' locale=' + locale + ' hour12=' + (hour12 ? '1' : '0'));
  }

  return { onMessage: async () => {}, onEvent: async () => {} };
};