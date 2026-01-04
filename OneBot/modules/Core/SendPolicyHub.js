// SendPolicyHub.js
// OneBot Core Hub: loads SendPolicy implementation safely.

const path = require('path');

module.exports = {
  id: 'SendPolicy',
  priority: 9218,

  init: (meta) => {
    const log = (tag, msg) => {
      try {
        if (meta && typeof meta.log === 'function') return meta.log(tag, msg);
      } catch (_) {}
      try { console.log(`[${tag}] ${msg}`); } catch (_) {}
    };

    const hubConf = (meta && meta.hubConf) ? meta.hubConf : {};
    const rootDir = (meta && meta.codeRoot) ? meta.codeRoot : process.cwd();

    const implFile = hubConf.implFile || 'Modules/Core/SendPolicyV1.js';

    let implConf = {};
    if (hubConf.implConfig && meta && typeof meta.loadConfRel === 'function') {
      try {
        implConf = meta.loadConfRel(hubConf.implConfig).conf || {};
      } catch (e) {
        log('SendPolicyHub', `WARN: implConfig load failed file=${hubConf.implConfig} err=${e && e.message ? e.message : e}`);
      }
    }

    let impl = null;
    try {
      impl = require(path.join(rootDir, implFile));
    } catch (e) {
      log('SendPolicyHub', `ERROR: impl require failed file=${implFile} err=${e && e.message ? e.message : e}`);
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    let api = {};
    try {
      if (impl && typeof impl.init === 'function') {
        api = impl.init({ ...meta, implConf }) || {};
      } else {
        log('SendPolicyHub', `WARN: impl has no init() file=${implFile}`);
      }
    } catch (e) {
      log('SendPolicyHub', `ERROR: impl init failed file=${implFile} err=${e && e.message ? e.message : e}`);
      api = {};
    }

    return {
      onMessage: (typeof api.onMessage === 'function') ? api.onMessage : (async () => {}),
      onEvent: (typeof api.onEvent === 'function') ? api.onEvent : (async () => {}),
    };
  },
};
