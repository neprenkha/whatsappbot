'use strict';

// CommandHub.js (Foundation connector)
// - Loads the configured implementation (CommandCV.js) and passes implConf.
// - No business logic here.

const path = require('path');

module.exports = {
  async init(meta) {
    const hubConf = meta.hubConf || {};
    const implRel = String(hubConf.implFile || '').trim();
    const implConfRel = String(hubConf.implConfig || '').trim();

    if (!implRel) {
      meta.log('CommandHub', 'disabled: missing implFile in hub .conf');
      return { enabled: false, onMessage: async () => {}, onEvent: async () => {} };
    }

    const implAbs = path.isAbsolute(implRel) ? implRel : path.join(meta.codeRoot, implRel);
    let impl;
    try {
      impl = require(implAbs);
    } catch (e) {
      meta.log('CommandHub', `disabled: require failed file=${implAbs} err=${String(e && e.message ? e.message : e)}`);
      return { enabled: false, onMessage: async () => {}, onEvent: async () => {} };
    }

    if (!impl || typeof impl.init !== 'function') {
      meta.log('CommandHub', `disabled: impl.init not found file=${implAbs}`);
      return { enabled: false, onMessage: async () => {}, onEvent: async () => {} };
    }

    let implConf = {};
    let implConfPath = '';
    if (implConfRel) {
      try {
        const loaded = meta.loadConfRel(implConfRel);
        implConf = (loaded && loaded.conf) || {};
        implConfPath = (loaded && loaded.absPath) || '';
      } catch (e) {
        meta.log(
          'CommandHub',
          `warn: failed loading implConfig file=${implConfRel} err=${String(e && e.message ? e.message : e)}`
        );
      }
    }

    return await impl.init({ ...meta, implConf, implConfPath });
  }
};
