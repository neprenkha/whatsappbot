'use strict';

const path = require('path');

module.exports = {
  id: 'InboundFilter',
  priority: 9680,

  init: (meta) => {
    const log = (tag, msg, details = {}) => {
      try {
        if (meta && typeof meta.log === 'function') return meta.log(tag, `${msg} ${JSON.stringify(details)}`);
      } catch (_) {
        try { console.log(`[${tag}] ${msg}`, details); } catch (_) {}
      }
    };

    const hubConf = meta.hubConf || {};
    const rootDir = meta.codeRoot || process.cwd();
    const implFile = hubConf.implFile || 'Modules/Core/InboundFilterV1.js';

    // Optional implementation config (.conf)
    let implConf = {};
    if (hubConf.implConfig && typeof meta.loadConfRel === 'function') {
      try {
        implConf = meta.loadConfRel(hubConf.implConfig)?.conf || {};
      } catch (e) {
        log('InboundFilterHub', 'Failed loading implementation config.', { file: hubConf.implConfig, error: e.message });
      }
    }

    let impl = null;
    try {
      impl = require(path.join(rootDir, implFile));
    } catch (e) {
      log('InboundFilterHub', 'Failed to require implementation file.', { file: implFile, error: e.message });
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    let api = {};
    if (impl && typeof impl.init === 'function') {
      try {
        api = impl.init({ ...meta, implConf }) || {};
      } catch (e) {
        log('InboundFilterHub', 'Implementation initialization failed.', { file: implFile, error: e.message });
      }
    } else {
      log('InboundFilterHub', 'Implementation missing init().', { file: implFile });
    }

    return {
      onMessage: api.onMessage || (async () => {}),
      onEvent: api.onEvent || (async () => {}),
    };
  },
};