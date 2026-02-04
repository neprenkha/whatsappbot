'use strict';

const path = require('path');

module.exports = {
  id: 'SendPolicy',
  priority: 9218,

  init: (meta) => {
    const log = (tag, msg, details = {}) => {
      try {
        meta.log(tag, `${msg} ${JSON.stringify(details)}`);
      } catch (e) {
        console.error(`[${tag}] ${msg}`);
      }
    };

    const hubConf = meta.hubConf || {};
    const rootDir = meta.codeRoot || process.cwd();
    const implFile = hubConf.implFile || 'Modules/Core/SendPolicyV1.js';

    let implConf = {};
    if (hubConf.implConfig) {
      try {
        implConf = meta.loadConfRel(hubConf.implConfig)?.conf || {};
      } catch (e) {
        log('SendPolicyHub', 'Failed to load implementation config.', { file: hubConf.implConfig, error: e.message });
      }
    }

    let impl;
    try {
      impl = require(path.join(rootDir, implFile));
    } catch (e) {
      log('SendPolicyHub', 'Failed to require implementation file.', { file: implFile, error: e.message });
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    if (!impl || typeof impl.init !== 'function') {
      log('SendPolicyHub', 'Implementation missing init() function.', { file: implFile });
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    try {
      return impl.init({ ...meta, implConf }) || { onMessage: async () => {}, onEvent: async () => {} };
    } catch (e) {
      log('SendPolicyHub', 'Implementation init() failed.', { file: implFile, error: e.message });
      return { onMessage: async () => {}, onEvent: async () => {} };
    }
  },
};