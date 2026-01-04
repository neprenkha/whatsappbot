'use strict';

const { toStr, toBool } = require('../Shared/SharedConfV1');

function buildFormatter(locale, timeZone, hour12) {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12
  });
}

function initService(meta) {
  const conf = meta.implConf || {};

  const timeZone = toStr(conf.timeZone, 'Asia/Kuala_Lumpur').trim() || 'Asia/Kuala_Lumpur';
  const locale = toStr(conf.locale, 'en-MY').trim() || 'en-MY';
  const hour12 = toBool(conf.hour12, false);

  const fmt = buildFormatter(locale, timeZone, hour12);

  const tzSvc = {
    tz: timeZone,
    timeZone,
    locale,
    hour12,

    now() {
      return new Date();
    },

    format(date) {
      try {
        return fmt.format(date instanceof Date ? date : new Date(date));
      } catch (_) {
        return String(date);
      }
    },

    formatNow() {
      return tzSvc.format(new Date());
    },

    isoNow() {
      return new Date().toISOString();
    }
  };

  // Register both aliases for compatibility.
  if (typeof meta.registerService === 'function') {
    meta.registerService('tz', tzSvc);
    meta.registerService('timezone', tzSvc);
    meta.registerService('timeZone', tzSvc);
  }

  const sample = tzSvc.formatNow();
  if (meta.log) meta.log(`[TimeZoneV1] ready timeZone=${timeZone} locale=${locale} hour12=${hour12 ? 1 : 0} sample=${sample}`);

  return tzSvc;
}

async function init(meta) {
  initService(meta);
  return {};
}

module.exports = { init };
