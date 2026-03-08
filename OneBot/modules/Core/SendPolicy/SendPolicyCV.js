'use strict';

function text(v) {
  return String(v == null ? '' : v).trim();
}

function toBool(v, d) {
  if (v === undefined || v === null || v === '') return !!d;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return !!d;
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
      if (moduleLog && meta && typeof meta.log === 'function') {
        meta.log('SendPolicyCV', 'disabled');
      }
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    let globalConf = {};
    try {
      const loaded = typeof meta.loadConfRel === 'function' ? (meta.loadConfRel(text(cfg.globalConfRel)) || {}) : {};
      globalConf = loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
    } catch (err) {
      if (bugLog && meta && typeof meta.log === 'function') {
        meta.log('SendPolicyCV', 'global_conf_load_failed err=' + String(err && err.message ? err.message : err));
      }
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const defaultProfile = text(cfg.defaultProfile || 'normal');
    const serviceName = text(cfg.serviceName || 'sendpolicy.getProfile');

    if (typeof meta.registerService === 'function' && serviceName) {
      meta.registerService(serviceName, (name) => {
        const n = text(name || defaultProfile);
        return {
          name: n,
          defaultProfile,
          sendPrefer: text(globalConf.sendPrefer),
          bypassManual: 1,
        };
      });
    }

    if (moduleLog && meta && typeof meta.log === 'function') {
      meta.log('SendPolicyCV', 'ready enabled=1 serviceName=' + serviceName + ' defaultProfile=' + defaultProfile + ' bypassManual=1');
    }
    if (detailLog && meta && typeof meta.log === 'function') {
      meta.log('SendPolicyCV', 'detail sendPrefer=' + text(globalConf.sendPrefer));
    }
    if (traceLog && meta && typeof meta.log === 'function') {
      meta.log('SendPolicyCV', 'trace active');
    }

    return {
      onMessage: async () => {},
      onEvent: async () => {},
    };
  },
};