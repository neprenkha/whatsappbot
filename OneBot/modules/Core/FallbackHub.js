'use strict';

const path = require('path');

module.exports = {
  async init(meta) {
    const hubConf = meta.hubConf || {};
    const implRel = hubConf.implFile || '';
    const implConfRel = hubConf.implConfig || '';
    if (!implRel) {
      meta.log('FallbackHub', 'disabled: missing implFile in hub .conf');
      return { enabled: false };
    }

    // Resolve implementation file path
    const implAbs = path.isAbsolute(implRel) ? implRel : path.join(meta.codeRoot, implRel);
    let impl;
    try {
      impl = require(implAbs);
    } catch (e) {
      meta.log('FallbackHub', `disabled: require failed ${e.message || e}, file=${implAbs}`);
      return { enabled: false };
    }

    if (!impl || typeof impl.init !== 'function') {
      meta.log('FallbackHub', `Disabled: impl.init() Not Found: ${path.basename(implAbs)}`);
      return { enabled: false };
    }

    // Load configuration
    let implConfig = {};
    if (implConfRel) {
      try {
        const loaded = meta.loadConfRel(implConfRel);
        implConfig = (loaded && loaded.conf) || {};
      } catch (e) {
        meta.log('FallbackHub', `warn: failed loading implConfig, file=${implConfRel}, error=${e.message}`);
      }
    }

    const meta2 = { ...meta, implConf: implConfig };
    return await impl.init(meta2);
  }
};