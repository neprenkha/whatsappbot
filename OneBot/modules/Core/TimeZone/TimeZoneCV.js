'use strict';

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function parseBoolStrict(value) {
  if (value === true || value === false) return value;
  const s = text(value).toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return null;
}

function noopHandlers() {
  return { onMessage: async () => {}, onEvent: async () => {} };
}

function canLog(meta) {
  return !!(meta && typeof meta.log === 'function');
}

function log(meta, line) {
  if (canLog(meta)) meta.log('TimeZoneCV', line);
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

function loadGlobalConf(meta, cfg, bugLog) {
  const rel = text(cfg.globalConfRel);
  if (!rel) {
    if (bugLog) log(meta, 'disabled missing_key=globalConfRel');
    return null;
  }
  if (!meta || typeof meta.loadConfRel !== 'function') {
    if (bugLog) log(meta, 'disabled global_conf_loader_unavailable');
    return null;
  }
  try {
    const loaded = meta.loadConfRel(rel);
    return loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : null;
  } catch (e) {
    if (bugLog) log(meta, 'disabled global_conf_load_failed err=' + String(e && e.message ? e.message : e));
    return null;
  }
}

module.exports.init = async function init(meta) {
  const cfg = meta && meta.implConf ? meta.implConf : {};

  const enabled = parseBoolStrict(cfg.enabled);
  const moduleLog = parseBoolStrict(cfg.moduleLog);
  const bugLog = parseBoolStrict(cfg.bugLog);

  const invalidKeys = [];
  if (enabled === null) invalidKeys.push('enabled');
  if (moduleLog === null) invalidKeys.push('moduleLog');
  if (bugLog === null) invalidKeys.push('bugLog');

  if (invalidKeys.length) {
    log(meta, 'disabled invalid_config_keys=' + invalidKeys.join(','));
    return noopHandlers();
  }

  if (!enabled) {
    if (moduleLog) log(meta, 'disabled');
    return noopHandlers();
  }

  const globalConf = loadGlobalConf(meta, cfg, bugLog);
  if (!globalConf) return noopHandlers();

  const timeZone = text(globalConf.timeZone);
  const locale = text(globalConf.locale);
  const hour12 = parseBoolStrict(globalConf.hour12);

  const invalidGlobalKeys = [];
  if (!timeZone) invalidGlobalKeys.push('timeZone');
  if (!locale) invalidGlobalKeys.push('locale');
  if (hour12 === null) invalidGlobalKeys.push('hour12');

  if (invalidGlobalKeys.length) {
    if (bugLog) log(meta, 'disabled invalid_global_config_keys=' + invalidGlobalKeys.join(','));
    return noopHandlers();
  }

  let formatImpl = null;
  try {
    formatImpl = buildFormatter(locale, timeZone, hour12);
  } catch (e) {
    if (bugLog) log(meta, 'disabled formatter_error err=' + String(e && e.message ? e.message : e));
    return noopHandlers();
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

  if (moduleLog) {
    log(meta, 'ready timeZone=' + timeZone + ' locale=' + locale + ' hour12=' + (hour12 ? '1' : '0'));
  }

  return noopHandlers();
};