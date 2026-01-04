// InboundFilterHub.js
// OneBot Core Hub: loads InboundFilter implementation safely.
// Config: hubConf.implFile (default Modules/Core/InboundFilterV1.js), hubConf.implConfig (optional .conf relative to confRoot)

const path = require('path');

module.exports = {
  id: 'InboundFilter',
  priority: 9680,

  init: (meta) => {
    const log = (tag, msg) => {
      try {
        if (meta && typeof meta.log === 'function') return meta.log(tag, msg);
      } catch (_) {}
      try { console.log(`[${tag}] ${msg}`); } catch (_) {}
    };

    const hubConf = (meta && meta.hubConf) ? meta.hubConf : {};
    const rootDir = (meta && meta.codeRoot) ? meta.codeRoot : process.cwd();

    const implFile = hubConf.implFile || 'Modules/Core/InboundFilterV1.js';

    // Optional implementation config (.conf) relative to confRoot
    let implConf = {};
    if (hubConf.implConfig && meta && typeof meta.loadConfRel === 'function') {
      try {
        implConf = meta.loadConfRel(hubConf.implConfig).conf || {};
      } catch (e) {
        log('InboundFilterHub', `WARN: implConfig load failed file=${hubConf.implConfig} err=${e && e.message ? e.message : e}`);
      }
    }

    let impl = null;
    try {
      impl = require(path.join(rootDir, implFile));
    } catch (e) {
      log('InboundFilterHub', `ERROR: impl require failed file=${implFile} err=${e && e.message ? e.message : e}`);
      return {
        onMessage: async () => {},
        onEvent: async () => {},
      };
    }

    let api = {};
    try {
      if (impl && typeof impl.init === 'function') {
        api = impl.init({ ...meta, implConf }) || {};
      } else {
        log('InboundFilterHub', `WARN: impl has no init() file=${implFile}`);
      }
    } catch (e) {
      log('InboundFilterHub', `ERROR: impl init failed file=${implFile} err=${e && e.message ? e.message : e}`);
      api = {};
    }

    return {
      onMessage: (typeof api.onMessage === 'function') ? api.onMessage : (async () => {}),
      onEvent: (typeof api.onEvent === 'function') ? api.onEvent : (async () => {}),
    };
  },
};
